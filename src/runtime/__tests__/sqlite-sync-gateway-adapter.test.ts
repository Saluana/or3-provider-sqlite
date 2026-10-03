/**
 * Unit tests for SqliteSyncGatewayAdapter.
 *
 * Covers push idempotency, LWW, pull pagination, cursor updates, and GC safety.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSqliteDb, getRawDb, destroySqliteDb, _resetForTest } from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { SqliteSyncGatewayAdapter } from '../server/sync/sqlite-sync-gateway-adapter';
import type {
    PendingOp,
    PullRequest,
    PushBatch,
    SnapshotItem,
    SnapshotResponse,
} from '~~/shared/sync/types';
import type { H3Event } from 'h3';
import { verifySyncContract } from '~~/shared/testing/contracts/sync';
import { incomingRevisionWins } from '~~/shared/sync/revision';
import { SqliteBackgroundJobProvider } from '../server/background-jobs/sqlite-provider';
import { reconcileBackgroundJobHistory } from '~~/server/utils/background-jobs/history';
import { registerSyncGatewayAdapter } from '~~/server/sync/gateway/registry';
import type { CanonicalGenerationSnapshot, ChatGenerationAdmissionEnvelope } from '~~/shared/chat/background-history';
import type { RequestUsage } from '~~/shared/chat/compaction';

const WORKSPACE_ID = 'ws-test-1';
const DEVICE_A = 'device-a';
const DEVICE_B = 'device-b';

// Stub H3Event — adapter doesn't use it for SQLite (no token resolution needed)
const stubEvent = {} as H3Event;

let adapter: SqliteSyncGatewayAdapter;

function makeOp(overrides: Partial<PendingOp> & { tableName: string; pk: string }): PendingOp {
    return {
        id: randomUUID(),
        tableName: overrides.tableName,
        operation: overrides.operation ?? 'put',
        pk: overrides.pk,
        payload: overrides.payload ?? { id: overrides.pk, title: 'test' },
        stamp: {
            deviceId: overrides.stamp?.deviceId ?? DEVICE_A,
            opId: overrides.stamp?.opId ?? randomUUID(),
            hlc: overrides.stamp?.hlc ?? '2025-01-01T00:00:00.000Z-0000',
            clock: overrides.stamp?.clock ?? 1,
        },
        createdAt: Math.floor(Date.now() / 1000),
        attempts: 0,
        status: 'pending',
    };
}

function makeBatch(ops: PendingOp[]): PushBatch {
    return {
        scope: { workspaceId: WORKSPACE_ID },
        ops,
    };
}

function setWorkspaceVersion(version: number, workspaceId = WORKSPACE_ID): void {
    getRawDb().prepare(
        `INSERT INTO server_version_counter (workspace_id, value) VALUES (?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET value = excluded.value`
    ).run(workspaceId, version);
}

function makeSessionEvent(userId: string, workspaceId = WORKSPACE_ID): H3Event {
    return {
        context: {
            __or3_session_context_test: {
                authenticated: true,
                user: { id: userId },
                workspace: { id: workspaceId },
            },
        },
    } as unknown as H3Event;
}

beforeEach(async () => {
    _resetForTest();
    const db = await initializeSqliteDb({ path: ':memory:' });
    await runMigrations(db);
    adapter = new SqliteSyncGatewayAdapter();
});

afterEach(async () => {
    await destroySqliteDb();
});

describe('SqliteSyncGatewayAdapter', () => {
    describe.runIf(process.env.OR3_CANONICAL_ARTIFACTS === 'true')('source-built canonical history reader', () => {
        it('reads materialized workspace rows after log deletion, pages legacy ties both ways, and rechecks revocation', async () => {
            const artifactDb = await import('../../../dist/runtime/server/db/kysely.js');
            const artifactMigrations = await import('../../../dist/runtime/server/db/migrate.js');
            const artifact = await import('../../../dist/runtime/server/sync/sqlite-sync-gateway-adapter.js');
            const reader = new artifact.SqliteSyncGatewayAdapter();
            await artifactMigrations.runMigrations(await artifactDb.initializeSqliteDb({ path: ':memory:' }));
            try {
                const raw = artifactDb.getRawDb();
                raw.prepare('INSERT INTO workspaces (id, name, owner_user_id) VALUES (?, ?, ?)').run(WORKSPACE_ID, 'Disposable canonical', 'canonical-user');
                raw.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)').run('canonical-member', WORKSPACE_ID, 'canonical-user', 'owner');
                const actor = { userId: 'canonical-user', workspaceId: WORKSPACE_ID };
                const metadata = { branch_mode: 'compacted', root_thread_id: 'root', summary_message_id: 'summary',
                    parent_thread_id: 'root', anchor_message_id: 'anchor', anchor_index: 9 };
                const rows = [makeOp({ tableName: 'threads', pk: 'canonical-thread', payload: { id: 'canonical-thread', ...metadata } }),
                    ...Array.from({ length: 140 }, (_, index) => makeOp({ tableName: 'messages', pk: `canonical-${String(index).padStart(3, '0')}`,
                        payload: { id: `canonical-${String(index).padStart(3, '0')}`, thread_id: 'canonical-thread', index: Math.floor(index / 2),
                            ...(index % 2 ? { order_key: 'ordered' } : {}), role: 'assistant', clock: 1, data: { content: `evidence ${index}` } } }))];
                await reader.push(stubEvent, makeBatch(rows));
                // Content history is independent from retained replication logs.
                raw.exec('DELETE FROM change_log');
                const before = await reader.readChatHistory(actor, { kind: 'thread', thread_id: 'canonical-thread' });
                expect(before.thread).toMatchObject(metadata);
                const first = await reader.readChatHistory(actor, { kind: 'thread_page', thread_id: 'canonical-thread', limit: 100 });
                const second = await reader.readChatHistory(actor, { kind: 'thread_page', thread_id: 'canonical-thread', limit: 100, cursor: first.next_cursor });
                expect([...first.messages!, ...second.messages!].map((row) => row.id)).toEqual(rows.slice(1).map((row) => row.pk));
                const { encodeCanonicalChatSeek } = await import('~~/shared/chat/history-reader');
                const backward = await reader.readChatHistory(actor, { kind: 'thread_page', thread_id: 'canonical-thread', limit: 2,
                    cursor: encodeCanonicalChatSeek({ thread_id: 'canonical-thread', backward: true, key: [1, '', 'canonical-002'] }) });
                expect(backward.messages!.map((row) => row.id)).toEqual(['canonical-001', 'canonical-000']);
                const byId = await reader.readChatHistory(actor, { kind: 'messages', message_ids: ['canonical-000', 'unknown'] });
                expect(byId.messages).toHaveLength(1);
                const foreign = await reader.readChatHistory({ ...actor, workspaceId: 'foreign' }, { kind: 'messages', message_ids: ['canonical-000'] }).catch((error: Error) => error.message);
                expect(foreign).toContain('Forbidden');
                const canceled = new AbortController(); canceled.abort();
                await expect(reader.readChatHistory(actor, { kind: 'thread', thread_id: 'canonical-thread' }, canceled.signal)).rejects.toThrow();
                raw.prepare("UPDATE s_messages SET clock = clock + 1 WHERE workspace_id = ? AND id = 'canonical-000'").run(WORKSPACE_ID);
                const after = await reader.readChatHistory(actor, { kind: 'thread', thread_id: 'canonical-thread' });
                expect(after.revision).not.toBe(before.revision);
                const plan = raw.prepare(`EXPLAIN QUERY PLAN SELECT id FROM s_messages WHERE workspace_id = ?
                    AND json_extract(data_json, '$.thread_id') = ? ORDER BY json_extract(data_json, '$.index'),
                    COALESCE(json_extract(data_json, '$.order_key'), ''), id LIMIT 100`).all(WORKSPACE_ID, 'canonical-thread');
                expect(JSON.stringify(plan)).toContain('s_messages_history_order');
                expect(JSON.stringify(plan)).not.toContain('TEMP B-TREE');
                raw.prepare("DELETE FROM workspace_members WHERE id = 'canonical-member'").run();
                await expect(reader.readChatHistory(actor, { kind: 'messages', message_ids: ['canonical-000'] })).rejects.toThrow('Forbidden');
            } finally { await artifactDb.destroySqliteDb(); }
        });
    });
    describe('durable background usage finalization', () => {
        let directory: string;
        let databasePath: string;
        const actor = { userId: 'usage-owner', workspaceId: WORKSPACE_ID };
        const usage: RequestUsage = {
            prompt_tokens: 400, completion_tokens: 35, model: 'test-model', request_id: 'request-1',
            iteration: 1, measured_at: 1_800_000_000_000, prefix_message_count: 4,
            prefix_hash: 'prefix-1', configuration_hash: 'config-1', input_estimate_tokens: 390,
        };
        function admission(): ChatGenerationAdmissionEnvelope {
            return {
                version: 1, kind: 'new-turn', admissionId: 'usage-admission', generationId: 'usage-generation',
                workspaceId: WORKSPACE_ID, threadId: 'usage-thread', messageId: 'usage-assistant',
                thread: { id: 'usage-thread', clock: 1, title: 'Usage conversation' },
                userMessage: { id: 'usage-user', thread_id: 'usage-thread', role: 'user', clock: 1, data: { content: 'question' } },
                assistantMessage: { id: 'usage-assistant', thread_id: 'usage-thread', role: 'assistant', clock: 1,
                    pending: true, data: { content: '', generation_id: 'usage-generation', compaction: { version: 1, marker: 'retained' }, custom_metadata: { keep: true } } },
            };
        }
        const snapshot = (status: CanonicalGenerationSnapshot['status'] = 'complete'): CanonicalGenerationSnapshot => ({
            status, content: 'canonical answer', reasoning: 'canonical reason', usage, completedAt: 1_800_000_000_000,
            toolCalls: [{ id: 'call-1', name: 'tool', status: 'complete', result: 'result' }],
            error: status === 'error' ? 'upstream interrupted' : undefined,
        });
        async function reopen() {
            await destroySqliteDb();
            await runMigrations(await initializeSqliteDb({ path: databasePath }));
            adapter = new SqliteSyncGatewayAdapter();
            registerSyncGatewayAdapter({ id: 'sqlite', create: () => adapter });
        }
        async function readCanonical() {
            const pulled = await adapter.pull(makeSessionEvent(actor.userId), {
                scope: { workspaceId: WORKSPACE_ID }, cursor: 0, limit: 100,
            });
            const page = await adapter.snapshot(makeSessionEvent(actor.userId), {
                scope: { workspaceId: WORKSPACE_ID }, pageSize: 100,
            });
            const item = page.items.find((entry: SnapshotItem) => entry.kind === 'row' && entry.pk === 'usage-assistant');
            const last = pulled.changes.filter((entry) => entry.pk === 'usage-assistant').at(-1);
            expect(item?.kind).toBe('row');
            if (!item || item.kind !== 'row') throw new Error('Missing canonical assistant');
            expect(last?.payload).toEqual(item.payload);
            return item.payload;
        }
        beforeEach(async () => {
            await destroySqliteDb();
            directory = await mkdtemp(join(tmpdir(), 'or3-sqlite-finalization-'));
            databasePath = join(directory, 'history.sqlite');
            await reopen();
            getRawDb().prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)')
                .run('usage-membership', WORKSPACE_ID, actor.userId, 'owner');
        });
        afterEach(async () => {
            await destroySqliteDb();
            await rm(directory, { recursive: true, force: true });
        });

        it.each(['complete', 'error', 'aborted'] as const)('reconciles real persisted %s jobs through host history and canonical pull/snapshot', async (status) => {
            let jobs = new SqliteBackgroundJobProvider();
            const history = admission();
            const id = await jobs.createJob({
                userId: actor.userId, threadId: history.threadId, messageId: history.messageId,
                generationId: history.generationId, model: 'test-model', kind: 'chat',
                syncProviderId: 'sqlite', historyPhase: 'admission_pending', execution: {
                    version: 1, workspaceId: WORKSPACE_ID, history, body: { messages: [] },
                    referer: 'https://example.test', apiKeyCiphertext: 'test-only-not-a-credential',
                },
            });
            expect(await reconcileBackgroundJobHistory(jobs, (await jobs.getJob(id, actor.userId))!)).toBe('ready');
            await jobs.updateJob(id, { usage: { ...usage, prompt_tokens: 150, iteration: 0, request_id: 'request-0' } });
            await jobs.updateJob(id, { usage });
            await jobs.updateJob(id, { usage });
            const terminal = snapshot(status);
            await jobs.saveTerminalSnapshot(id, { ...terminal, usage: undefined });
            await reopen();
            jobs = new SqliteBackgroundJobProvider();
            expect(await reconcileBackgroundJobHistory(jobs, (await jobs.getJob(id, actor.userId))!)).toBe('committed');
            await reopen();
            const canonical = await readCanonical();
            expect(canonical).toMatchObject({ pending: false, data: {
                usage, content: terminal.content, reasoning_text: terminal.reasoning, tool_calls: terminal.toolCalls,
                generation_id: history.generationId, generation_state: status === 'error' ? 'failed' : status,
                compaction: { version: 1, marker: 'retained' }, custom_metadata: { keep: true },
            } });
            expect(await adapter.finalizeChatGeneration(actor, { admission: history, snapshot: terminal }))
                .toMatchObject({ status: 'committed', replayed: true });
        });

        it.each([undefined, { prompt_tokens: 12 }, { ...usage, completion_tokens: -1 }])('ignores missing/malformed terminal usage (%j) and preserves unrelated metadata', async (invalid) => {
            const history = admission();
            await adapter.admitChatGeneration(actor, history);
            await adapter.finalizeChatGeneration(actor, { admission: history, snapshot: { ...snapshot(), usage: invalid } as CanonicalGenerationSnapshot });
            await reopen();
            expect(await readCanonical()).toMatchObject({ data: { content: 'canonical answer', custom_metadata: { keep: true } } });
            expect((await readCanonical()).data).not.toHaveProperty('usage');
        });

        it('persists terminal-only usage through the actual gateway finalizer', async () => {
            const history = admission();
            await adapter.admitChatGeneration(actor, history);
            await adapter.finalizeChatGeneration(actor, { admission: history, snapshot: snapshot() });
            await reopen();
            expect(await readCanonical()).toMatchObject({ data: { usage, custom_metadata: { keep: true } } });
        });

        it('ignores invalid new usage rather than erasing an existing measured request', async () => {
            const history = admission();
            history.assistantMessage.data = { ...(history.assistantMessage.data as object), usage };
            await adapter.admitChatGeneration(actor, history);
            await adapter.finalizeChatGeneration(actor, { admission: history, snapshot: { ...snapshot(), usage: { ...usage, prompt_tokens: -1 } } });
            expect(await readCanonical()).toMatchObject({ data: { usage } });
        });

        it('rejects unauthorized actors and workspace mismatches without committing usage', async () => {
            const history = admission();
            await adapter.admitChatGeneration(actor, history);
            for (const intruder of [{ ...actor, userId: 'intruder' }, { ...actor, workspaceId: 'other-workspace' }]) {
                await expect(adapter.finalizeChatGeneration(intruder, { admission: history, snapshot: snapshot() })).rejects.toThrow();
            }
            getRawDb().prepare("UPDATE workspace_members SET role = 'viewer' WHERE id = 'usage-membership'").run();
            await expect(adapter.finalizeChatGeneration(actor, { admission: history, snapshot: snapshot() })).rejects.toThrow('Forbidden');
            expect((await readCanonical()).data).not.toHaveProperty('usage');
        });

        it.each(['newer_generation', 'edited', 'deleted'] as const)('does not overwrite %s canonical history with late usage', async (reason) => {
            const history = admission();
            await adapter.admitChatGeneration(actor, history);
            const current = await readCanonical();
            await adapter.push(stubEvent, makeBatch([makeOp({
                tableName: 'messages', pk: history.messageId, operation: reason === 'deleted' ? 'delete' : 'put',
                payload: { ...current, clock: 5, data: { ...(current.data as object),
                    content: 'newer answer', generation_id: reason === 'newer_generation' ? 'other-generation' : history.generationId,
                    usage: { ...usage, prompt_tokens: 900, request_id: 'newer-request' },
                } }, stamp: { clock: 5, hlc: 'zzzz-newer', deviceId: DEVICE_B, opId: randomUUID() },
            })]));
            expect(await adapter.finalizeChatGeneration(actor, { admission: history, snapshot: snapshot() }))
                .toMatchObject({ status: 'superseded', reason });
            const row = getRawDb().prepare('SELECT data_json, deleted FROM s_messages WHERE workspace_id = ? AND id = ?')
                .get(WORKSPACE_ID, history.messageId) as { data_json: string; deleted: number };
            if (reason === 'deleted') expect(row.deleted).toBe(1);
            else expect(JSON.parse(row.data_json)).toMatchObject({ data: { content: 'newer answer', usage: { prompt_tokens: 900 } } });
        });
    });
    it('executes the shared bootstrap and revision contract', async () => {
        await verifySyncContract({
            name: 'sqlite',
            async reset() {},
            async seedMaterialized(items, highWatermark) {
                const ops = items.map((item) => makeOp({
                    tableName: item.tableName,
                    pk: item.pk,
                    operation: item.kind === 'tombstone' ? 'delete' : 'put',
                    payload: item.kind === 'row' ? item.payload : undefined,
                    stamp: {
                        deviceId: DEVICE_A,
                        opId: item.revision.opId,
                        hlc: item.revision.hlc,
                        clock: item.revision.clock,
                    },
                }));
                await adapter.push(stubEvent, makeBatch(ops));
                setWorkspaceVersion(highWatermark);
            },
            async bootstrap() {
                const items: SnapshotItem[] = [];
                let pageToken: string | undefined;
                let highWatermark = 0;
                do {
                    const page = await adapter.snapshot(stubEvent, {
                        scope: { workspaceId: WORKSPACE_ID }, pageSize: 1, pageToken,
                    });
                    items.push(...page.items);
                    highWatermark = page.highWatermark;
                    pageToken = page.nextPageToken ?? undefined;
                } while (pageToken);
                return { items, highWatermark };
            },
            async resolveWinner(left, right) {
                return incomingRevisionWins(left, right) ? left : right;
            },
        });
    });
    describe('push', () => {
        it('assigns monotonic server versions', async () => {
            const op1 = makeOp({ tableName: 'threads', pk: 't-1' });
            const op2 = makeOp({ tableName: 'threads', pk: 't-2' });

            const result = await adapter.push(stubEvent, makeBatch([op1, op2]));

            expect(result.results.length).toBe(2);
            expect(result.results[0]!.success).toBe(true);
            expect(result.results[0]!.serverVersion).toBe(1);
            expect(result.results[1]!.success).toBe(true);
            expect(result.results[1]!.serverVersion).toBe(2);
            expect(result.serverVersion).toBe(2);
        });

        it('preserves contiguous versioning across batches', async () => {
            const op1 = makeOp({ tableName: 'threads', pk: 't-1' });
            await adapter.push(stubEvent, makeBatch([op1]));

            const op2 = makeOp({ tableName: 'threads', pk: 't-2' });
            const result = await adapter.push(stubEvent, makeBatch([op2]));

            expect(result.results[0]!.serverVersion).toBe(2);
        });

        it('is idempotent on duplicate op_id', async () => {
            const op = makeOp({ tableName: 'threads', pk: 't-1' });

            const first = await adapter.push(stubEvent, makeBatch([op]));
            const second = await adapter.push(stubEvent, makeBatch([op]));

            expect(first.results[0]!.serverVersion).toBe(1);
            expect(second.results[0]!.success).toBe(true);
            expect(second.results[0]!.serverVersion).toBe(1);
            // No new version allocated
            expect(second.serverVersion).toBe(1);
        });

        it('acknowledges a lost response and returns the newer live winner', async () => {
            const original = makeOp({
                tableName: 'threads', pk: 'replay-live',
                payload: { id: 'replay-live', title: 'original' },
                stamp: { clock: 1, hlc: '1000-a', deviceId: DEVICE_A, opId: randomUUID() },
            });
            await adapter.push(stubEvent, makeBatch([original]));
            const newer = makeOp({
                tableName: 'threads', pk: 'replay-live',
                payload: { id: 'replay-live', title: 'newer' },
                stamp: { clock: 2, hlc: '2000-b', deviceId: DEVICE_B, opId: randomUUID() },
            });
            await adapter.push(stubEvent, makeBatch([newer]));

            const replay = await adapter.push(stubEvent, makeBatch([original]));
            expect(replay.results[0]).toMatchObject({
                success: true, replayed: true, applied: false, serverVersion: 1,
                winner: {
                    kind: 'put',
                    payload: { id: 'replay-live', title: 'newer' },
                    revision: { clock: 2, hlc: '2000-b', opId: newer.stamp.opId },
                },
            });
            expect(replay.serverVersion).toBe(2);
        });

        it('returns a tombstone winner for replayed and newly stale puts', async () => {
            const original = makeOp({
                tableName: 'threads', pk: 'replay-deleted',
                stamp: { clock: 1, hlc: '1000-a', deviceId: DEVICE_A, opId: randomUUID() },
            });
            await adapter.push(stubEvent, makeBatch([original]));
            const deletion = makeOp({
                tableName: 'threads', pk: 'replay-deleted', operation: 'delete',
                stamp: { clock: 3, hlc: '3000-b', deviceId: DEVICE_B, opId: randomUUID() },
            });
            await adapter.push(stubEvent, makeBatch([deletion]));

            const replay = await adapter.push(stubEvent, makeBatch([original]));
            expect(replay.results[0]).toMatchObject({
                success: true, replayed: true, applied: false,
                winner: { kind: 'delete', revision: {
                    clock: 3, hlc: '3000-b', opId: deletion.stamp.opId,
                } },
            });
            const stale = makeOp({
                tableName: 'threads', pk: 'replay-deleted',
                stamp: { clock: 2, hlc: '2000-c', deviceId: DEVICE_A, opId: randomUUID() },
            });
            const staleResult = await adapter.push(stubEvent, makeBatch([stale]));
            expect(staleResult.results[0]).toMatchObject({
                success: true, applied: false,
                winner: { kind: 'delete', revision: {
                    clock: 3, hlc: '3000-b', opId: deletion.stamp.opId,
                } },
            });

            // Tombstone GC may remove the side table before the old op_id is
            // replayed. The deleted materialized row still names the winner.
            getRawDb().prepare(
                'DELETE FROM tombstones WHERE workspace_id = ? AND table_name = ? AND pk = ?'
            ).run(WORKSPACE_ID, 'threads', 'replay-deleted');
            const afterGc = await adapter.push(stubEvent, makeBatch([original]));
            expect(afterGc.results[0]).toMatchObject({
                success: true, replayed: true, applied: false,
                winner: { kind: 'delete', revision: {
                    clock: 3, hlc: '3000-b', opId: deletion.stamp.opId,
                } },
            });
        });

        it('rejects invalid table names', async () => {
            const op = makeOp({ tableName: 'evil_table' as string, pk: 'x-1' });

            const result = await adapter.push(stubEvent, makeBatch([op]));

            expect(result.results[0]!.success).toBe(false);
            expect(result.results[0]!.errorCode).toBe('VALIDATION_ERROR');
        });

        it('handles mixed idempotent and new ops', async () => {
            const existingOp = makeOp({ tableName: 'threads', pk: 't-1' });
            await adapter.push(stubEvent, makeBatch([existingOp]));

            const newOp = makeOp({ tableName: 'threads', pk: 't-2' });
            const result = await adapter.push(
                stubEvent,
                makeBatch([existingOp, newOp])
            );

            expect(result.results[0]!.serverVersion).toBe(1); // idempotent
            expect(result.results[1]!.serverVersion).toBe(2); // new
        });

        it('treats duplicate op_id inside the same batch as idempotent', async () => {
            const sharedOpId = randomUUID();
            const first = makeOp({
                tableName: 'threads',
                pk: 't-dup',
                stamp: {
                    clock: 1,
                    hlc: '2025-01-01T00:00:00.000Z-0000',
                    deviceId: DEVICE_A,
                    opId: sharedOpId,
                },
            });
            const second = makeOp({
                tableName: 'threads',
                pk: 't-dup',
                payload: first.payload,
                stamp: {
                    clock: 1,
                    hlc: '2025-01-01T00:00:00.000Z-0000',
                    deviceId: DEVICE_A,
                    opId: sharedOpId,
                },
            });

            const result = await adapter.push(stubEvent, makeBatch([first, second]));

            expect(result.results.length).toBe(2);
            expect(result.results[0]!.success).toBe(true);
            expect(result.results[1]!.success).toBe(true);
            expect(result.results[0]!.serverVersion).toBe(1);
            expect(result.results[1]!.serverVersion).toBe(1);
            expect(result.serverVersion).toBe(1);
        });

        it('rejects conflicting duplicate op_ids without allocating a version', async () => {
            const sharedOpId = randomUUID();
            const first = makeOp({
                tableName: 'threads',
                pk: 't-conflict',
                payload: { id: 't-conflict', title: 'first' },
                stamp: {
                    clock: 1,
                    hlc: '2025-01-01T00:00:00.000Z-0000',
                    deviceId: DEVICE_A,
                    opId: sharedOpId,
                },
            });
            const second = makeOp({
                tableName: 'threads',
                pk: 't-conflict',
                operation: 'delete',
                stamp: {
                    clock: 2,
                    hlc: '2025-01-01T00:00:01.000Z-0000',
                    deviceId: DEVICE_A,
                    opId: sharedOpId,
                },
            });

            const result = await adapter.push(stubEvent, makeBatch([first, second]));

            expect(result.results).toHaveLength(2);
            expect(result.results.every((entry) =>
                !entry.success && entry.errorCode === 'CONFLICT'
            )).toBe(true);
            expect(result.serverVersion).toBe(0);
            expect(getRawDb().prepare('SELECT COUNT(*) AS count FROM change_log').get())
                .toEqual({ count: 0 });
        });

        it('isolates malformed operations and rejects logical-key mutation', async () => {
            const invalidTable = makeOp({ tableName: 'evil_table', pk: 'bad' });
            const keyMutation = makeOp({
                tableName: 'threads',
                pk: 't-key',
                payload: { id: 'different-key', title: 'bad' },
            });
            const workspaceMutation = makeOp({
                tableName: 'threads',
                pk: 't-workspace',
                payload: {
                    id: 't-workspace',
                    workspace_id: 'ws-other',
                    title: 'bad',
                },
            });
            const valid = makeOp({
                tableName: 'threads',
                pk: 't-valid',
                payload: { id: 't-valid', title: 'valid' },
            });

            const result = await adapter.push(
                stubEvent,
                makeBatch([invalidTable, keyMutation, workspaceMutation, valid])
            );

            expect(result.results[0]).toMatchObject({
                success: false,
                errorCode: 'VALIDATION_ERROR',
            });
            expect(result.results[1]).toMatchObject({
                success: false,
                errorCode: 'VALIDATION_ERROR',
            });
            expect(result.results[1]!.error).toContain("'id' must match operation pk");
            expect(result.results[2]).toMatchObject({
                success: false,
                errorCode: 'VALIDATION_ERROR',
            });
            expect(result.results[2]!.error).toContain("'workspace_id' is immutable");
            expect(result.results[3]).toMatchObject({ success: true, serverVersion: 1 });
            expect(result.serverVersion).toBe(1);
            const row = getRawDb()
                .prepare('SELECT data_json FROM s_threads WHERE id = ?')
                .get('t-valid') as { data_json: string };
            expect(JSON.parse(row.data_json)).toMatchObject({ id: 't-valid', title: 'valid' });
            expect(getRawDb().prepare('SELECT COUNT(*) AS count FROM change_log').get())
                .toEqual({ count: 1 });
        });

        it('accepts payloads below 256KB and rejects larger operations', async () => {
            const accepted = makeOp({
                tableName: 'threads',
                pk: 't-large-accepted',
                payload: {
                    id: 't-large-accepted',
                    title: 'x'.repeat(120 * 1024),
                },
            });
            const rejected = makeOp({
                tableName: 'threads',
                pk: 't-large-rejected',
                payload: {
                    id: 't-large-rejected',
                    title: 'x'.repeat(257 * 1024),
                },
            });

            const result = await adapter.push(
                stubEvent,
                makeBatch([accepted, rejected])
            );

            expect(result.results[0]).toMatchObject({ success: true });
            expect(result.results[1]).toMatchObject({
                success: false,
                errorCode: 'VALIDATION_ERROR',
            });
            expect(result.results[1]!.error).toContain(
                'Payload too large for threads'
            );
        });
    });

    describe('LWW', () => {
        it('higher clock wins', async () => {
            const op1 = makeOp({
                tableName: 'threads',
                pk: 't-1',
                payload: { id: 't-1', title: 'first' },
                stamp: { clock: 1, hlc: '2025-01-01T00:00:00.000Z-0000', deviceId: DEVICE_A, opId: randomUUID() },
            });
            const op2 = makeOp({
                tableName: 'threads',
                pk: 't-1',
                payload: { id: 't-1', title: 'second' },
                stamp: { clock: 2, hlc: '2025-01-01T00:00:00.000Z-0000', deviceId: DEVICE_B, opId: randomUUID() },
            });

            await adapter.push(stubEvent, makeBatch([op1]));
            await adapter.push(stubEvent, makeBatch([op2]));

            // Verify materialized table has the second write
            const raw = getRawDb();
            const row = raw
                .prepare('SELECT data_json, clock FROM s_threads WHERE id = ?')
                .get('t-1') as { data_json: string; clock: number };

            expect(row.clock).toBe(2);
            expect(JSON.parse(row.data_json).title).toBe('second');
        });

        it('equal clock → hlc tie-break', async () => {
            const op1 = makeOp({
                tableName: 'threads',
                pk: 't-1',
                payload: { id: 't-1', title: 'first' },
                stamp: { clock: 1, hlc: '2025-01-01T00:00:00.000Z-0001', deviceId: DEVICE_A, opId: randomUUID() },
            });
            const op2 = makeOp({
                tableName: 'threads',
                pk: 't-1',
                payload: { id: 't-1', title: 'second' },
                stamp: { clock: 1, hlc: '2025-01-01T00:00:00.000Z-0002', deviceId: DEVICE_B, opId: randomUUID() },
            });

            await adapter.push(stubEvent, makeBatch([op1]));
            await adapter.push(stubEvent, makeBatch([op2]));

            const raw = getRawDb();
            const row = raw
                .prepare('SELECT data_json FROM s_threads WHERE id = ?')
                .get('t-1') as { data_json: string };

            expect(JSON.parse(row.data_json).title).toBe('second');
        });

        it('lower clock does not overwrite', async () => {
            const op1 = makeOp({
                tableName: 'threads',
                pk: 't-1',
                payload: { id: 't-1', title: 'newer' },
                stamp: { clock: 5, hlc: '2025-01-01T00:00:00.000Z-0000', deviceId: DEVICE_A, opId: randomUUID() },
            });
            const op2 = makeOp({
                tableName: 'threads',
                pk: 't-1',
                payload: { id: 't-1', title: 'older' },
                stamp: { clock: 3, hlc: '2025-01-01T00:00:00.000Z-0000', deviceId: DEVICE_B, opId: randomUUID() },
            });

            await adapter.push(stubEvent, makeBatch([op1]));
            await adapter.push(stubEvent, makeBatch([op2]));

            const raw = getRawDb();
            const row = raw
                .prepare('SELECT data_json, clock FROM s_threads WHERE id = ?')
                .get('t-1') as { data_json: string; clock: number };

            expect(row.clock).toBe(5);
            expect(JSON.parse(row.data_json).title).toBe('newer');
        });
    });

    describe('delete + tombstone', () => {
        it('creates tombstone on delete', async () => {
            const putOp = makeOp({
                tableName: 'threads',
                pk: 't-1',
                payload: { id: 't-1', title: 'test' },
            });
            await adapter.push(stubEvent, makeBatch([putOp]));

            const beforeDelete = Math.floor(Date.now() / 1000);
            const delOp = makeOp({
                tableName: 'threads',
                pk: 't-1',
                operation: 'delete',
                payload: { deleted_at: 1 },
                stamp: { clock: 2, hlc: '2025-01-01T00:00:01.000Z-0000', deviceId: DEVICE_A, opId: randomUUID() },
            });
            await adapter.push(stubEvent, makeBatch([delOp]));

            const authored = getRawDb().prepare(
                'SELECT deleted_at FROM tombstones WHERE workspace_id = ? AND table_name = ? AND pk = ?'
            ).get(WORKSPACE_ID, 'threads', 't-1') as { deleted_at: number };
            expect(authored.deleted_at).toBeGreaterThanOrEqual(beforeDelete);

            const raw = getRawDb();
            const tombstone = raw
                .prepare('SELECT * FROM tombstones WHERE pk = ?')
                .get('t-1') as { table_name: string; pk: string } | undefined;

            expect(tombstone).toBeDefined();
            expect(tombstone!.table_name).toBe('threads');

            // Materialized row should be marked deleted
            const row = raw
                .prepare('SELECT deleted FROM s_threads WHERE id = ?')
                .get('t-1') as { deleted: number };

            expect(row.deleted).toBe(1);
        });

        it('keeps a single tombstone row per (workspace, table, pk)', async () => {
            await adapter.push(
                stubEvent,
                makeBatch([makeOp({ tableName: 'threads', pk: 't-repeat' })])
            );

            await adapter.push(
                stubEvent,
                makeBatch([
                    makeOp({
                        tableName: 'threads',
                        pk: 't-repeat',
                        operation: 'delete',
                        stamp: {
                            clock: 2,
                            hlc: '2025-01-01T00:00:01.000Z-0000',
                            deviceId: DEVICE_A,
                            opId: randomUUID(),
                        },
                    }),
                ])
            );

            await adapter.push(
                stubEvent,
                makeBatch([
                    makeOp({
                        tableName: 'threads',
                        pk: 't-repeat',
                        operation: 'delete',
                        stamp: {
                            clock: 3,
                            hlc: '2025-01-01T00:00:02.000Z-0000',
                            deviceId: DEVICE_B,
                            opId: randomUUID(),
                        },
                    }),
                ])
            );

            const raw = getRawDb();
            const rows = raw
                .prepare(
                    `SELECT COUNT(*) as cnt, MAX(clock) as max_clock
                     FROM tombstones
                     WHERE workspace_id = ? AND table_name = ? AND pk = ?`
                )
                .get(WORKSPACE_ID, 'threads', 't-repeat') as {
                cnt: number;
                max_clock: number;
            };

            expect(rows.cnt).toBe(1);
            expect(rows.max_clock).toBe(3);
        });
    });

    describe('workspace isolation', () => {
        it('allows same record id in different workspaces', async () => {
            const sharedPk = 'shared-id';
            const opA = makeOp({ tableName: 'threads', pk: sharedPk });
            const opB = makeOp({ tableName: 'threads', pk: sharedPk });

            const resultA = await adapter.push(stubEvent, {
                scope: { workspaceId: 'ws-A' },
                ops: [opA],
            });
            const resultB = await adapter.push(stubEvent, {
                scope: { workspaceId: 'ws-B' },
                ops: [opB],
            });

            expect(resultA.results[0]!.success).toBe(true);
            expect(resultB.results[0]!.success).toBe(true);

            const raw = getRawDb();
            const count = raw
                .prepare(
                    `SELECT COUNT(*) as cnt
                     FROM s_threads
                     WHERE id = ? AND workspace_id IN ('ws-A', 'ws-B')`
                )
                .get(sharedPk) as { cnt: number };

            expect(count.cnt).toBe(2);
        });
    });

    describe('pull', () => {
        it('returns changes after cursor', async () => {
            const op1 = makeOp({ tableName: 'threads', pk: 't-1' });
            const op2 = makeOp({ tableName: 'threads', pk: 't-2' });
            const op3 = makeOp({ tableName: 'messages', pk: 'm-1' });

            await adapter.push(stubEvent, makeBatch([op1, op2, op3]));

            const pullReq: PullRequest = {
                scope: { workspaceId: WORKSPACE_ID },
                cursor: 1, // after first
                limit: 10,
            };

            const result = await adapter.pull(stubEvent, pullReq);

            expect(result.changes.length).toBe(2);
            expect(result.changes[0]!.serverVersion).toBe(2);
            expect(result.changes[1]!.serverVersion).toBe(3);
            expect(result.hasMore).toBe(false);
            expect(result.nextCursor).toBe(3);
        });

        it('respects limit and hasMore', async () => {
            // Push 5 ops
            const ops = Array.from({ length: 5 }, (_, i) =>
                makeOp({ tableName: 'threads', pk: `t-${i}` })
            );
            await adapter.push(stubEvent, makeBatch(ops));

            const result = await adapter.pull(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                cursor: 0,
                limit: 3,
            });

            expect(result.changes.length).toBe(3);
            expect(result.hasMore).toBe(true);
            expect(result.nextCursor).toBe(3);
        });

        it('uses safe default limit when limit is undefined or NaN', async () => {
            const ops = Array.from({ length: 3 }, (_, i) =>
                makeOp({ tableName: 'threads', pk: `t-default-${i}` })
            );
            await adapter.push(stubEvent, makeBatch(ops));

            const undefinedLimit = await adapter.pull(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                cursor: 0,
                limit: undefined as unknown as number,
            });
            const nanLimit = await adapter.pull(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                cursor: 0,
                limit: Number.NaN,
            });

            expect(undefinedLimit.changes.length).toBe(3);
            expect(undefinedLimit.hasMore).toBe(false);
            expect(nanLimit.changes.length).toBe(3);
            expect(nanLimit.hasMore).toBe(false);
        });

        it('clamps non-positive limits to 1', async () => {
            const ops = Array.from({ length: 5 }, (_, i) =>
                makeOp({ tableName: 'threads', pk: `t-min-${i}` })
            );
            await adapter.push(stubEvent, makeBatch(ops));

            const result = await adapter.pull(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                cursor: 0,
                limit: 0,
            });

            expect(result.changes.length).toBe(1);
            expect(result.hasMore).toBe(true);
            expect(result.nextCursor).toBe(1);
        });

        it('filters by table', async () => {
            const ops = [
                makeOp({ tableName: 'threads', pk: 't-1' }),
                makeOp({ tableName: 'messages', pk: 'm-1' }),
                makeOp({ tableName: 'threads', pk: 't-2' }),
            ];
            await adapter.push(stubEvent, makeBatch(ops));

            const result = await adapter.pull(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                cursor: 0,
                limit: 10,
                tables: ['threads'],
            });

            expect(result.changes.length).toBe(2);
            expect(result.changes.every((c) => c.tableName === 'threads')).toBe(true);
        });

        it('returns empty for no new changes', async () => {
            const result = await adapter.pull(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                cursor: 0,
                limit: 10,
            });

            expect(result.changes.length).toBe(0);
            expect(result.hasMore).toBe(false);
            expect(result.nextCursor).toBe(0);
        });

        it('includes payload in pull response', async () => {
            const op = makeOp({
                tableName: 'threads',
                pk: 't-1',
                payload: { id: 't-1', title: 'Hello' },
            });
            await adapter.push(stubEvent, makeBatch([op]));

            const result = await adapter.pull(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                cursor: 0,
                limit: 10,
            });

            expect(result.changes[0]!.payload).toEqual({ id: 't-1', title: 'Hello' });
            expect(result.changes[0]!.stamp.opId).toBe(op.stamp.opId);
        });
    });

    describe('snapshot', () => {
        async function collectRemainingPages(first: SnapshotResponse): Promise<{
            pages: SnapshotResponse[];
            items: SnapshotItem[];
        }> {
            const pages = [first];
            const items = [...first.items];
            let pageToken = first.nextPageToken;

            while (pageToken) {
                const page = await adapter.snapshot(stubEvent, {
                    scope: { workspaceId: WORKSPACE_ID },
                    pageSize: 2,
                    pageToken,
                });
                pages.push(page);
                items.push(...page.items);
                pageToken = page.nextPageToken;
            }

            return { pages, items };
        }

        it('bootstraps unchanged materialized rows after their original change-log entries are pruned', async () => {
            const unchanged = makeOp({
                tableName: 'messages',
                pk: 'message-retained',
                payload: { id: 'message-retained', body: 'still here', deleted: false },
            });
            await adapter.push(stubEvent, makeBatch([unchanged]));

            const raw = getRawDb();
            raw.prepare('DELETE FROM change_log WHERE workspace_id = ?').run(WORKSPACE_ID);
            expect(
                (raw.prepare('SELECT COUNT(*) AS count FROM change_log').get() as { count: number }).count
            ).toBe(0);

            const page = await adapter.snapshot(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                pageSize: 10,
            });

            expect(page.highWatermark).toBe(1);
            expect(page.items).toContainEqual(expect.objectContaining({
                kind: 'row',
                tableName: 'messages',
                pk: 'message-retained',
                payload: expect.objectContaining({ id: 'message-retained', body: 'still here' }),
                revision: { opId: unchanged.stamp.opId, hlc: unchanged.stamp.hlc, clock: 1 },
            }));
        });

        it('returns every canonical live row and required tombstone exactly once across bounded pages', async () => {
            const message = makeOp({ tableName: 'messages', pk: 'message-a' });
            const project = makeOp({ tableName: 'projects', pk: 'project-deleted' });
            const threadB = makeOp({ tableName: 'threads', pk: 'thread-b' });
            const threadA = makeOp({ tableName: 'threads', pk: 'thread-a' });
            const deletion = makeOp({
                tableName: 'projects',
                pk: 'project-deleted',
                operation: 'delete',
                stamp: {
                    clock: 2,
                    hlc: '2025-01-01T00:00:01.000Z-0000',
                    deviceId: DEVICE_A,
                    opId: randomUUID(),
                },
            });

            await adapter.push(
                stubEvent,
                makeBatch([threadB, message, project, threadA, deletion])
            );

            const first = await adapter.snapshot(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                pageSize: 2,
            });
            const { pages, items } = await collectRemainingPages(first);

            expect(pages).toHaveLength(2);
            expect(pages.every((page) => page.items.length <= 2)).toBe(true);
            expect(new Set(pages.map((page) => page.snapshotId))).toEqual(
                new Set([first.snapshotId])
            );
            expect(new Set(pages.map((page) => page.highWatermark))).toEqual(
                new Set([5])
            );
            expect(items.map((item) => `${item.tableName}:${item.pk}:${item.kind}`)).toEqual([
                'messages:message-a:row',
                'projects:project-deleted:tombstone',
                'threads:thread-a:row',
                'threads:thread-b:row',
            ]);
            expect(new Set(items.map((item) => `${item.tableName}:${item.pk}`)).size).toBe(4);

            const messageItem = items[0];
            expect(messageItem).toMatchObject({
                kind: 'row',
                revision: {
                    clock: message.stamp.clock,
                    hlc: message.stamp.hlc,
                    opId: message.stamp.opId,
                },
            });
            const tombstone = items[1];
            expect(tombstone).toMatchObject({
                kind: 'tombstone',
                revision: {
                    clock: deletion.stamp.clock,
                    hlc: deletion.stamp.hlc,
                    opId: deletion.stamp.opId,
                },
            });
            expect(
                tombstone?.kind === 'tombstone' && tombstone.serverDeletedAt
            ).toEqual(expect.any(Number));
        });

        it('keeps later pages pinned to the first-page high-watermark while writes continue', async () => {
            const originalThread = makeOp({
                tableName: 'threads',
                pk: 'thread-a',
                payload: { id: 'thread-a', title: 'before snapshot' },
            });
            const originalMessage = makeOp({
                tableName: 'messages',
                pk: 'message-a',
            });
            const originalProject = makeOp({
                tableName: 'projects',
                pk: 'project-a',
            });
            await adapter.push(
                stubEvent,
                makeBatch([originalThread, originalMessage, originalProject])
            );

            const first = await adapter.snapshot(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                pageSize: 1,
            });
            expect(first.highWatermark).toBe(3);
            expect(first.items).toHaveLength(1);
            expect(first.nextPageToken).not.toBeNull();

            const updateThread = makeOp({
                tableName: 'threads',
                pk: 'thread-a',
                payload: { id: 'thread-a', title: 'after snapshot' },
                stamp: {
                    clock: 2,
                    hlc: '2025-01-01T00:00:02.000Z-0000',
                    deviceId: DEVICE_B,
                    opId: randomUUID(),
                },
            });
            const newNotification = makeOp({
                tableName: 'notifications',
                pk: 'notification-after',
            });
            const deleteProject = makeOp({
                tableName: 'projects',
                pk: 'project-a',
                operation: 'delete',
                stamp: {
                    clock: 2,
                    hlc: '2025-01-01T00:00:03.000Z-0000',
                    deviceId: DEVICE_B,
                    opId: randomUUID(),
                },
            });
            await adapter.push(
                makeSessionEvent('user-snapshot'),
                makeBatch([updateThread, newNotification, deleteProject])
            );

            const pages = [first];
            const items = [...first.items];
            let pageToken = first.nextPageToken;
            while (pageToken) {
                const page = await adapter.snapshot(stubEvent, {
                    scope: { workspaceId: WORKSPACE_ID },
                    pageSize: 1,
                    pageToken,
                });
                pages.push(page);
                items.push(...page.items);
                pageToken = page.nextPageToken;
            }

            expect(pages).toHaveLength(3);
            expect(pages.every((page) => page.highWatermark === 3)).toBe(true);
            expect(pages.every((page) => page.snapshotId === first.snapshotId)).toBe(true);
            expect(items.map((item) => `${item.tableName}:${item.pk}:${item.kind}`)).toEqual([
                'messages:message-a:row',
                'projects:project-a:row',
                'threads:thread-a:row',
            ]);
            expect(items).not.toContainEqual(
                expect.objectContaining({ pk: 'notification-after' })
            );
            expect(items.find((item) => item.pk === 'thread-a')).toMatchObject({
                kind: 'row',
                payload: { id: 'thread-a', title: 'before snapshot' },
                revision: { opId: originalThread.stamp.opId },
            });

            const replay = await adapter.pull(makeSessionEvent('user-snapshot'), {
                scope: { workspaceId: WORKSPACE_ID },
                cursor: first.highWatermark,
                limit: 10,
            });
            expect(replay.changes.map((change) => change.stamp.opId)).toEqual([
                updateThread.stamp.opId,
                newNotification.stamp.opId,
                deleteProject.stamp.opId,
            ]);
        });
    });

    describe('canonical storage queries', () => {
        it('reads live metadata from materialized state after logs are pruned and ignores a losing delete', async () => {
            const hash = `sha256:${'a'.repeat(64)}`;
            const put = makeOp({
                tableName: 'file_meta',
                pk: hash,
                payload: {
                    hash,
                    name: 'live.png',
                    mime_type: 'image/png',
                    kind: 'image',
                    size_bytes: 321,
                    storage_id: 'object-1',
                    deleted: false,
                },
                stamp: {
                    clock: 5,
                    hlc: '2025-01-01T00:00:05.000Z-0000',
                    deviceId: DEVICE_A,
                    opId: randomUUID(),
                },
            });
            const losingDelete = makeOp({
                tableName: 'file_meta',
                pk: hash,
                operation: 'delete',
                stamp: {
                    clock: 4,
                    hlc: '2025-01-01T00:00:04.000Z-0000',
                    deviceId: DEVICE_B,
                    opId: randomUUID(),
                },
            });
            await adapter.push(stubEvent, makeBatch([put]));
            await adapter.push(stubEvent, makeBatch([losingDelete]));
            getRawDb().prepare('DELETE FROM change_log WHERE workspace_id = ?').run(WORKSPACE_ID);

            const page = await adapter.queryCanonicalStorage(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                kind: 'live_metadata',
                hash,
                limit: 1,
            });

            expect(page).toEqual({
                items: [{
                    kind: 'metadata',
                    hash: 'a'.repeat(64),
                    sizeBytes: 321,
                    storageId: 'object-1',
                    mimeType: 'image/png',
                    name: 'live.png',
                    fileKind: 'image',
                    updatedAt: expect.any(Number),
                }],
                hasMore: false,
            });
        });

        it('accepts a zero-byte upload reservation', async () => {
            const now = Math.floor(Date.now() / 1000);
            await expect(adapter.reserveUploadIntent(stubEvent, {
                intentId: 'intent-empty',
                workspaceId: WORKSPACE_ID,
                hash: `sha256:${'d'.repeat(64)}`,
                mimeType: 'application/octet-stream',
                sizeBytes: 0,
                expiresAt: now + 60,
            })).resolves.toBeUndefined();
            expect(getRawDb().prepare(
                'SELECT size_bytes FROM upload_intents WHERE id = ?',
            ).get('intent-empty')).toMatchObject({ size_bytes: 0 });
        });

        it('keyset-pages canonical reference edges with a strict response bound', async () => {
            const hashes = ['a', 'b', 'c'].map((letter) => `sha256:${letter.repeat(64)}`);
            await adapter.push(stubEvent, makeBatch([
                makeOp({
                    tableName: 'messages',
                    pk: 'message-1',
                    payload: { id: 'message-1', file_hashes: JSON.stringify(hashes.slice(0, 2)), deleted: false },
                }),
                makeOp({
                    tableName: 'posts',
                    pk: 'post-1',
                    payload: { id: 'post-1', file_hashes: JSON.stringify(hashes.slice(2)), deleted: false },
                }),
            ]));

            const found: string[] = [];
            let cursor: string | undefined;
            do {
                const page = await adapter.queryCanonicalStorage(stubEvent, {
                    scope: { workspaceId: WORKSPACE_ID },
                    kind: 'reference_edges',
                    cursor,
                    limit: 1,
                });
                expect(page.items.length).toBeLessThanOrEqual(1);
                found.push(...page.items.map((item) => item.kind === 'reference' ? item.hash : 'wrong'));
                cursor = page.nextCursor;
            } while (cursor);

            expect(found).toEqual(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
        });

        it('pages active persisted reservations and excludes expired/cancelled rows', async () => {
            const now = Math.floor(Date.now() / 1000);
            await adapter.reserveUploadIntent(stubEvent, {
                intentId: 'intent-active', workspaceId: WORKSPACE_ID, hash: `sha256:${'a'.repeat(64)}`,
                mimeType: 'image/png', sizeBytes: 12, expiresAt: now + 60,
            });
            await adapter.reserveUploadIntent(stubEvent, {
                intentId: 'intent-cancel', workspaceId: WORKSPACE_ID, hash: `sha256:${'b'.repeat(64)}`,
                mimeType: 'image/png', sizeBytes: 20, expiresAt: now + 60,
            });
            await adapter.cancelUploadIntent(stubEvent, { workspaceId: WORKSPACE_ID, intentId: 'intent-cancel' });
            await expect(adapter.queryCanonicalStorage(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                kind: 'active_reservations',
                limit: 10,
                now,
            })).resolves.toEqual({
                items: [{
                    kind: 'reservation', reservationId: 'intent-active', hash: 'a'.repeat(64),
                    sizeBytes: 12, expiresAt: now + 60,
                }],
                hasMore: false,
            });
        });

        it('atomically rejects concurrent reservations that collectively exceed quota', async () => {
            const now = Math.floor(Date.now() / 1000);
            const reserve = (intentId: string, hash: string) => adapter.reserveUploadIntent(stubEvent, {
                intentId, workspaceId: WORKSPACE_ID, hash, mimeType: 'image/png', sizeBytes: 60,
                expiresAt: now + 60, workspaceQuotaBytes: 100,
            });
            const results = await Promise.allSettled([
                reserve('intent-a', `sha256:${'a'.repeat(64)}`),
                reserve('intent-b', `sha256:${'b'.repeat(64)}`),
            ]);
            expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
            expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
            const row = getRawDb().prepare(`SELECT COALESCE(SUM(reserved_bytes), 0) AS total
                FROM upload_intents WHERE status = 'active'`).get() as { total: number };
            expect(row.total).toBe(60);
        });

        it('consumes an intent once and rejects replay or metadata mismatch', async () => {
            const now = Math.floor(Date.now() / 1000);
            const request = {
                intentId: 'intent-commit', workspaceId: WORKSPACE_ID,
                hash: `sha256:${'c'.repeat(64)}`, mimeType: 'image/png', sizeBytes: 10,
                expiresAt: now + 60,
            };
            await adapter.reserveUploadIntent(stubEvent, request);
            await expect(adapter.consumeUploadIntent(stubEvent, {
                ...request, sizeBytes: 11, storageId: 'object-1',
            })).rejects.toMatchObject({ statusCode: 409 });
            await expect(adapter.consumeUploadIntent(stubEvent, {
                ...request, storageId: 'object-1',
            })).resolves.toBeUndefined();
            await expect(adapter.consumeUploadIntent(stubEvent, {
                ...request, storageId: 'object-1',
            })).rejects.toMatchObject({ statusCode: 409 });
        });
    });

    describe('workspace scope authorization', () => {
        it('rejects access when resolved session workspace differs from sync scope', async () => {
            const scopedEvent = {
                context: {
                    __or3_session_context_test: {
                        authenticated: true,
                        workspace: { id: 'ws-allowed' },
                    },
                },
            } as unknown as H3Event;

            await expect(
                adapter.pull(scopedEvent, {
                    scope: { workspaceId: 'ws-other' },
                    cursor: 0,
                    limit: 10,
                })
            ).rejects.toMatchObject({ statusCode: 403 });
        });

        it('allows access when resolved session workspace matches sync scope', async () => {
            const scopedEvent = {
                context: {
                    __or3_session_context_test: {
                        authenticated: true,
                        workspace: { id: WORKSPACE_ID },
                    },
                },
            } as unknown as H3Event;

            await adapter.push(scopedEvent, makeBatch([makeOp({ tableName: 'threads', pk: 't-auth' })]));
            const result = await adapter.pull(scopedEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                cursor: 0,
                limit: 10,
            });

            expect(result.changes.length).toBe(1);
            expect(result.changes[0]!.pk).toBe('t-auth');
        });
    });

    describe('updateCursor', () => {
        it('requires an authenticated device owner', async () => {
            setWorkspaceVersion(1);
            await expect(adapter.updateCursor(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID }, deviceId: DEVICE_A, version: 1,
            })).rejects.toMatchObject({ statusCode: 401 });
        });

        it('creates cursor on first call', async () => {
            setWorkspaceVersion(5);
            await adapter.updateCursor(makeSessionEvent('user-a'), {
                scope: { workspaceId: WORKSPACE_ID },
                deviceId: DEVICE_A,
                version: 5,
            });

            const raw = getRawDb();
            const row = raw
                .prepare(
                    'SELECT last_seen_version FROM device_cursors WHERE workspace_id = ? AND device_id = ?'
                )
                .get(WORKSPACE_ID, DEVICE_A) as { last_seen_version: number };

            expect(row.last_seen_version).toBe(5);
        });

        it('rejects a regressing cursor and preserves the prior value', async () => {
            setWorkspaceVersion(10);
            await adapter.updateCursor(makeSessionEvent('user-a'), {
                scope: { workspaceId: WORKSPACE_ID },
                deviceId: DEVICE_A,
                version: 10,
            });

            await expect(adapter.updateCursor(makeSessionEvent('user-a'), {
                scope: { workspaceId: WORKSPACE_ID }, deviceId: DEVICE_A, version: 5,
            })).rejects.toMatchObject({ statusCode: 409 });

            const raw = getRawDb();
            const row = raw
                .prepare(
                    'SELECT last_seen_version FROM device_cursors WHERE workspace_id = ? AND device_id = ?'
                )
                .get(WORKSPACE_ID, DEVICE_A) as { last_seen_version: number };

            expect(row.last_seen_version).toBe(10);
        });

        it('tracks separate cursors per device', async () => {
            setWorkspaceVersion(10);
            await adapter.updateCursor(makeSessionEvent('user-a'), {
                scope: { workspaceId: WORKSPACE_ID },
                deviceId: DEVICE_A,
                version: 10,
            });

            await adapter.updateCursor(makeSessionEvent('user-a'), {
                scope: { workspaceId: WORKSPACE_ID },
                deviceId: DEVICE_B,
                version: 5,
            });

            const raw = getRawDb();
            const rowA = raw
                .prepare(
                    'SELECT last_seen_version FROM device_cursors WHERE workspace_id = ? AND device_id = ?'
                )
                .get(WORKSPACE_ID, DEVICE_A) as { last_seen_version: number };
            const rowB = raw
                .prepare(
                    'SELECT last_seen_version FROM device_cursors WHERE workspace_id = ? AND device_id = ?'
                )
                .get(WORKSPACE_ID, DEVICE_B) as { last_seen_version: number };

            expect(rowA.last_seen_version).toBe(10);
            expect(rowB.last_seen_version).toBe(5);
        });

        it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
            'rejects malformed cursor version %s',
            async (version) => {
                setWorkspaceVersion(10);
                await expect(adapter.updateCursor(makeSessionEvent('user-a'), {
                    scope: { workspaceId: WORKSPACE_ID }, deviceId: DEVICE_A, version,
                })).rejects.toMatchObject({ statusCode: 400 });
            }
        );

        it('rejects a cursor beyond the workspace maximum', async () => {
            setWorkspaceVersion(4);
            await expect(adapter.updateCursor(makeSessionEvent('user-a'), {
                scope: { workspaceId: WORKSPACE_ID }, deviceId: DEVICE_A, version: 5,
            })).rejects.toMatchObject({ statusCode: 400 });
        });

        it('binds a device cursor to its first authenticated owner', async () => {
            setWorkspaceVersion(5);
            await adapter.updateCursor(makeSessionEvent('user-a'), {
                scope: { workspaceId: WORKSPACE_ID }, deviceId: DEVICE_A, version: 3,
            });
            await expect(adapter.updateCursor(makeSessionEvent('user-b'), {
                scope: { workspaceId: WORKSPACE_ID }, deviceId: DEVICE_A, version: 4,
            })).rejects.toMatchObject({ statusCode: 403 });
        });

        it('rejects a cross-workspace cursor claim', async () => {
            setWorkspaceVersion(5, 'ws-other');
            await expect(adapter.updateCursor(makeSessionEvent('user-a'), {
                scope: { workspaceId: 'ws-other' }, deviceId: DEVICE_A, version: 1,
            })).rejects.toMatchObject({ statusCode: 403 });
        });
    });

    describe('GC', () => {
        it('gcChangeLog deletes only old history acknowledged by every device', async () => {
            // Push some ops
            const ops = Array.from({ length: 5 }, (_, i) =>
                makeOp({ tableName: 'threads', pk: `t-${i}` })
            );
            await adapter.push(stubEvent, makeBatch(ops));

            // Set device cursors — device A at 3, device B at 5
            await adapter.updateCursor(makeSessionEvent('user-a'), {
                scope: { workspaceId: WORKSPACE_ID },
                deviceId: DEVICE_A,
                version: 3,
            });
            await adapter.updateCursor(makeSessionEvent('user-a'), {
                scope: { workspaceId: WORKSPACE_ID },
                deviceId: DEVICE_B,
                version: 5,
            });

            // Backdate change_log entries to make them eligible
            const raw = getRawDb();
            raw.prepare(
                'UPDATE change_log SET created_at = 0 WHERE workspace_id = ?'
            ).run(WORKSPACE_ID);

            await adapter.gcChangeLog(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                retentionSeconds: 3600,
            });

            const remaining = raw
                .prepare('SELECT COUNT(*) as cnt FROM change_log WHERE workspace_id = ?')
                .get(WORKSPACE_ID) as { cnt: number };

            expect(remaining.cnt).toBe(2);

            const snapshot = await adapter.snapshot(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                pageSize: 10,
            });
            expect(snapshot.items.filter((item) => item.kind === 'row')).toHaveLength(5);
        });

        it('gcChangeLog preserves entries within retention window', async () => {
            const ops = Array.from({ length: 3 }, (_, i) =>
                makeOp({ tableName: 'threads', pk: `t-${i}` })
            );
            await adapter.push(stubEvent, makeBatch(ops));

            await adapter.updateCursor(makeSessionEvent('user-a'), {
                scope: { workspaceId: WORKSPACE_ID },
                deviceId: DEVICE_A,
                version: 3,
            });

            // Don't backdate — entries are recent
            await adapter.gcChangeLog(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                retentionSeconds: 86400, // 24 hours
            });

            const raw = getRawDb();
            const remaining = raw
                .prepare('SELECT COUNT(*) as cnt FROM change_log WHERE workspace_id = ?')
                .get(WORKSPACE_ID) as { cnt: number };

            expect(remaining.cnt).toBe(3); // nothing deleted
        });

        it('gcChangeLog collects old history when no active device cursor exists', async () => {
            await adapter.push(stubEvent, makeBatch([
                makeOp({ tableName: 'threads', pk: 'no-cursor-1' }),
                makeOp({ tableName: 'threads', pk: 'no-cursor-2' }),
            ]));
            const raw = getRawDb();
            raw.prepare('UPDATE change_log SET created_at = 0 WHERE workspace_id = ?').run(WORKSPACE_ID);

            await adapter.gcChangeLog(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID }, retentionSeconds: 3600,
            });

            const remaining = raw
                .prepare('SELECT COUNT(*) AS cnt FROM change_log WHERE workspace_id = ?')
                .get(WORKSPACE_ID) as { cnt: number };
            expect(remaining.cnt).toBe(0);
        });

        it('expires a stale cursor instead of allowing it to pin old history forever', async () => {
            await adapter.push(stubEvent, makeBatch([
                makeOp({ tableName: 'threads', pk: 'stale-cursor-1' }),
                makeOp({ tableName: 'threads', pk: 'stale-cursor-2' }),
            ]));
            await adapter.updateCursor(makeSessionEvent('user-a'), {
                scope: { workspaceId: WORKSPACE_ID }, deviceId: DEVICE_A, version: 0,
            });
            const raw = getRawDb();
            raw.prepare('UPDATE change_log SET created_at = 0 WHERE workspace_id = ?').run(WORKSPACE_ID);
            raw.prepare('UPDATE device_cursors SET updated_at = 0 WHERE workspace_id = ?').run(WORKSPACE_ID);

            await adapter.gcChangeLog(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID }, retentionSeconds: 3600,
            });

            const remaining = raw
                .prepare('SELECT COUNT(*) AS cnt FROM change_log WHERE workspace_id = ?')
                .get(WORKSPACE_ID) as { cnt: number };
            const cursors = raw
                .prepare('SELECT COUNT(*) AS cnt FROM device_cursors WHERE workspace_id = ?')
                .get(WORKSPACE_ID) as { cnt: number };
            expect(remaining.cnt).toBe(0);
            expect(cursors.cnt).toBe(0);
        });

        it('gcTombstones deletes old tombstones acknowledged by every device', async () => {
            // Create a delete to produce a tombstone
            const putOp = makeOp({ tableName: 'threads', pk: 't-1' });
            await adapter.push(stubEvent, makeBatch([putOp]));

            const delOp = makeOp({
                tableName: 'threads',
                pk: 't-1',
                operation: 'delete',
                stamp: { clock: 2, hlc: '2025-01-01T00:00:01.000Z-0000', deviceId: DEVICE_A, opId: randomUUID() },
            });
            await adapter.push(stubEvent, makeBatch([delOp]));

            // Cursor is ahead and the tombstone is old, so the legacy collector
            // would have deleted it.
            await adapter.updateCursor(makeSessionEvent('user-a'), {
                scope: { workspaceId: WORKSPACE_ID },
                deviceId: DEVICE_A,
                version: 2,
            });

            const raw = getRawDb();
            raw.prepare('UPDATE tombstones SET created_at = 0 WHERE workspace_id = ?').run(WORKSPACE_ID);

            await adapter.gcTombstones(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                retentionSeconds: 3600,
            });

            const remaining = raw
                .prepare('SELECT COUNT(*) as cnt FROM tombstones WHERE workspace_id = ?')
                .get(WORKSPACE_ID) as { cnt: number };

            expect(remaining.cnt).toBe(0);
        });

        it.each([0, 1, 3599, 3600.5, 31536001])(
            'rejects unsafe retention window %s before collection',
            async (retentionSeconds) => {
                await expect(adapter.gcTombstones(stubEvent, {
                    scope: { workspaceId: WORKSPACE_ID }, retentionSeconds,
                })).rejects.toMatchObject({ statusCode: 400 });
                await expect(adapter.gcChangeLog(stubEvent, {
                    scope: { workspaceId: WORKSPACE_ID }, retentionSeconds,
                })).rejects.toMatchObject({ statusCode: 400 });
            }
        );
    });

    describe('notification ownership', () => {
        it('binds user_id, rejects spoofed owners, and scopes pull/snapshot', async () => {
            const alice = makeSessionEvent('user-alice');
            const bob = makeSessionEvent('user-bob');
            const aliceNote = makeOp({
                tableName: 'notifications',
                pk: 'note-alice',
                payload: { id: 'note-alice', title: 'alice note' },
            });
            const bobNote = makeOp({
                tableName: 'notifications',
                pk: 'note-bob',
                payload: { id: 'note-bob', title: 'bob note' },
            });
            const spoofed = makeOp({
                tableName: 'notifications',
                pk: 'note-spoof',
                payload: { id: 'note-spoof', title: 'spoof', user_id: 'user-bob' },
            });

            const alicePush = await adapter.push(alice, makeBatch([aliceNote]));
            const bobPush = await adapter.push(bob, makeBatch([bobNote]));
            const spoofPush = await adapter.push(alice, makeBatch([spoofed]));
            const anonymous = await adapter.push(stubEvent, makeBatch([
                makeOp({
                    tableName: 'notifications',
                    pk: 'note-anon',
                    payload: { id: 'note-anon', title: 'anon' },
                }),
            ]));

            expect(alicePush.results[0]?.success).toBe(true);
            expect(bobPush.results[0]?.success).toBe(true);
            expect(spoofPush.results[0]).toMatchObject({
                success: false,
                errorCode: 'UNAUTHORIZED',
            });
            expect(anonymous.results[0]).toMatchObject({
                success: false,
                errorCode: 'UNAUTHORIZED',
            });

            const alicePull = await adapter.pull(alice, {
                scope: { workspaceId: WORKSPACE_ID },
                cursor: 0,
                limit: 50,
            });
            const bobPull = await adapter.pull(bob, {
                scope: { workspaceId: WORKSPACE_ID },
                cursor: 0,
                limit: 50,
            });
            expect(alicePull.changes.filter((c) => c.tableName === 'notifications').map((c) => c.pk))
                .toEqual(['note-alice']);
            expect(bobPull.changes.filter((c) => c.tableName === 'notifications').map((c) => c.pk))
                .toEqual(['note-bob']);
            expect(alicePull.oldestRetainedVersion).toBe(1);
            expect(alicePull.requiresSnapshot).toBe(false);

            const collectSnapshot = async (event: H3Event) => {
                const items: SnapshotItem[] = [];
                let pageToken: string | undefined;
                do {
                    const page: SnapshotResponse = await adapter.snapshot(event, {
                        scope: { workspaceId: WORKSPACE_ID },
                        pageSize: 20,
                        pageToken,
                    });
                    items.push(...page.items);
                    pageToken = page.nextPageToken ?? undefined;
                } while (pageToken);
                return items.filter((item) => item.tableName === 'notifications');
            };
            expect((await collectSnapshot(alice)).map((item) => item.pk)).toEqual(['note-alice']);
            expect((await collectSnapshot(bob)).map((item) => item.pk)).toEqual(['note-bob']);
            expect(await collectSnapshot(stubEvent)).toEqual([]);
        });

        it('rejects deleting another user notification without allocating a version', async () => {
            const alice = makeSessionEvent('user-alice');
            const bob = makeSessionEvent('user-bob');
            await adapter.push(alice, makeBatch([
                makeOp({
                    tableName: 'notifications',
                    pk: 'note-owned',
                    payload: { id: 'note-owned', title: 'mine' },
                }),
            ]));
            const before = getRawDb()
                .prepare('SELECT value FROM server_version_counter WHERE workspace_id = ?')
                .get(WORKSPACE_ID) as { value: number };

            const result = await adapter.push(bob, makeBatch([
                makeOp({
                    tableName: 'notifications',
                    pk: 'note-owned',
                    operation: 'delete',
                }),
            ]));
            expect(result.results[0]).toMatchObject({
                success: false,
                errorCode: 'UNAUTHORIZED',
            });
            const after = getRawDb()
                .prepare('SELECT value FROM server_version_counter WHERE workspace_id = ?')
                .get(WORKSPACE_ID) as { value: number };
            expect(after.value).toBe(before.value);
        });
    });

    describe('idempotency fingerprint and LWW', () => {
        it('rejects reuse of a processed op_id with a different fingerprint', async () => {
            const opId = randomUUID();
            const original = makeOp({
                tableName: 'threads',
                pk: 't-fp',
                payload: { id: 't-fp', title: 'original' },
                stamp: {
                    clock: 1,
                    hlc: '2025-01-01T00:00:00.000Z-0000',
                    deviceId: DEVICE_A,
                    opId,
                },
            });
            await adapter.push(stubEvent, makeBatch([original]));
            const reused = makeOp({
                tableName: 'threads',
                pk: 't-fp-other',
                payload: { id: 't-fp-other', title: 'different' },
                stamp: {
                    clock: 9,
                    hlc: '2025-01-01T00:00:09.000Z-0000',
                    deviceId: DEVICE_B,
                    opId,
                },
            });
            const result = await adapter.push(stubEvent, makeBatch([reused]));
            expect(result.results[0]).toMatchObject({
                success: false,
                errorCode: 'CONFLICT',
            });
            expect(result.serverVersion).toBe(1);
        });

        it('returns applied false and the winning payload for an LWW loser', async () => {
            const winnerOpId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
            const loserOpId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
            const winner = makeOp({
                tableName: 'threads',
                pk: 't-lww',
                payload: { id: 't-lww', title: 'winner' },
                stamp: {
                    clock: 4,
                    hlc: '2025-01-01T00:00:04.000Z-0000',
                    deviceId: DEVICE_A,
                    opId: winnerOpId,
                },
            });
            await adapter.push(stubEvent, makeBatch([winner]));
            const loser = makeOp({
                tableName: 'threads',
                pk: 't-lww',
                payload: { id: 't-lww', title: 'loser' },
                stamp: {
                    clock: 4,
                    hlc: '2025-01-01T00:00:04.000Z-0000',
                    deviceId: DEVICE_B,
                    opId: loserOpId,
                },
            });
            const result = await adapter.push(stubEvent, makeBatch([loser]));
            expect(result.results[0]).toMatchObject({
                success: true,
                applied: false,
                payload: { id: 't-lww', title: 'winner' },
            });
            const row = getRawDb()
                .prepare('SELECT data_json, op_id FROM s_threads WHERE id = ?')
                .get('t-lww') as { data_json: string; op_id: string };
            expect(JSON.parse(row.data_json).title).toBe('winner');
            expect(row.op_id).toBe(winnerOpId);
        });

        it('rejects a stale put against an orphan tombstone', async () => {
            await adapter.push(stubEvent, makeBatch([
                makeOp({ tableName: 'threads', pk: 't-orphan' }),
            ]));
            await adapter.push(stubEvent, makeBatch([
                makeOp({
                    tableName: 'threads',
                    pk: 't-orphan',
                    operation: 'delete',
                    stamp: {
                        clock: 5,
                        hlc: '2025-01-01T00:00:05.000Z-0000',
                        deviceId: DEVICE_A,
                        opId: randomUUID(),
                    },
                }),
            ]));
            getRawDb().prepare('DELETE FROM s_threads WHERE id = ?').run('t-orphan');
            const stale = makeOp({
                tableName: 'threads',
                pk: 't-orphan',
                payload: { id: 't-orphan', title: 'resurrect' },
                stamp: {
                    clock: 1,
                    hlc: '2025-01-01T00:00:01.000Z-0000',
                    deviceId: DEVICE_B,
                    opId: randomUUID(),
                },
            });
            const result = await adapter.push(stubEvent, makeBatch([stale]));
            expect(result.results[0]).toMatchObject({
                success: true,
                applied: false,
            });
            const row = getRawDb()
                .prepare('SELECT id FROM s_threads WHERE id = ?')
                .get('t-orphan');
            expect(row).toBeUndefined();
        });
    });
});
