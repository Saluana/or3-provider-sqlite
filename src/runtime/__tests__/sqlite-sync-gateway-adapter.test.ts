/**
 * Unit tests for SqliteSyncGatewayAdapter.
 *
 * Covers push idempotency, LWW, pull pagination, cursor updates, and GC safety.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
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
import { compareSyncRevision } from '~~/shared/sync/revision';

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
                return compareSyncRevision(left, right) >= 0 ? left : right;
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
                stubEvent,
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

            const replay = await adapter.pull(stubEvent, {
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
                    updatedAt: expect.any(Number),
                }],
                hasMore: false,
            });
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
});
