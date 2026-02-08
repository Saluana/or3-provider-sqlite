/**
 * Unit tests for SqliteSyncGatewayAdapter.
 *
 * Covers push idempotency, LWW, pull pagination, cursor updates, and GC.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSqliteDb, getRawDb, destroySqliteDb, _resetForTest } from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { SqliteSyncGatewayAdapter } from '../server/sync/sqlite-sync-gateway-adapter';
import type { PendingOp, PushBatch, PullRequest } from '~~/shared/sync/types';
import type { H3Event } from 'h3';

const WORKSPACE_ID = 'ws-test-1';
const DEVICE_A = 'device-a';
const DEVICE_B = 'device-b';

// Stub H3Event — adapter doesn't use it for SQLite (no token resolution needed)
const stubEvent = {} as H3Event;

let adapter: SqliteSyncGatewayAdapter;

function makeOp(overrides: Partial<PendingOp> & { tableName: string; pk: string }): PendingOp {
    return {
        id: crypto.randomUUID(),
        tableName: overrides.tableName,
        operation: overrides.operation ?? 'put',
        pk: overrides.pk,
        payload: overrides.payload ?? { id: overrides.pk, title: 'test' },
        stamp: {
            deviceId: overrides.stamp?.deviceId ?? DEVICE_A,
            opId: overrides.stamp?.opId ?? crypto.randomUUID(),
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

beforeEach(async () => {
    _resetForTest();
    const db = getSqliteDb({ path: ':memory:' });
    await runMigrations(db);
    adapter = new SqliteSyncGatewayAdapter();
});

afterEach(async () => {
    await destroySqliteDb();
});

describe('SqliteSyncGatewayAdapter', () => {
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
            const sharedOpId = crypto.randomUUID();
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
                stamp: {
                    clock: 1,
                    hlc: '2025-01-01T00:00:00.000Z-0001',
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
    });

    describe('LWW', () => {
        it('higher clock wins', async () => {
            const op1 = makeOp({
                tableName: 'threads',
                pk: 't-1',
                payload: { id: 't-1', title: 'first' },
                stamp: { clock: 1, hlc: '2025-01-01T00:00:00.000Z-0000', deviceId: DEVICE_A, opId: crypto.randomUUID() },
            });
            const op2 = makeOp({
                tableName: 'threads',
                pk: 't-1',
                payload: { id: 't-1', title: 'second' },
                stamp: { clock: 2, hlc: '2025-01-01T00:00:00.000Z-0000', deviceId: DEVICE_B, opId: crypto.randomUUID() },
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
                stamp: { clock: 1, hlc: '2025-01-01T00:00:00.000Z-0001', deviceId: DEVICE_A, opId: crypto.randomUUID() },
            });
            const op2 = makeOp({
                tableName: 'threads',
                pk: 't-1',
                payload: { id: 't-1', title: 'second' },
                stamp: { clock: 1, hlc: '2025-01-01T00:00:00.000Z-0002', deviceId: DEVICE_B, opId: crypto.randomUUID() },
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
                stamp: { clock: 5, hlc: '2025-01-01T00:00:00.000Z-0000', deviceId: DEVICE_A, opId: crypto.randomUUID() },
            });
            const op2 = makeOp({
                tableName: 'threads',
                pk: 't-1',
                payload: { id: 't-1', title: 'older' },
                stamp: { clock: 3, hlc: '2025-01-01T00:00:00.000Z-0000', deviceId: DEVICE_B, opId: crypto.randomUUID() },
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

            const delOp = makeOp({
                tableName: 'threads',
                pk: 't-1',
                operation: 'delete',
                stamp: { clock: 2, hlc: '2025-01-01T00:00:01.000Z-0000', deviceId: DEVICE_A, opId: crypto.randomUUID() },
            });
            await adapter.push(stubEvent, makeBatch([delOp]));

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
                            opId: crypto.randomUUID(),
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
                            opId: crypto.randomUUID(),
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

    describe('updateCursor', () => {
        it('creates cursor on first call', async () => {
            await adapter.updateCursor(stubEvent, {
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

        it('only moves cursor forward', async () => {
            await adapter.updateCursor(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                deviceId: DEVICE_A,
                version: 10,
            });

            // Try to move backward
            await adapter.updateCursor(stubEvent, {
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

            expect(row.last_seen_version).toBe(10);
        });

        it('tracks separate cursors per device', async () => {
            await adapter.updateCursor(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                deviceId: DEVICE_A,
                version: 10,
            });

            await adapter.updateCursor(stubEvent, {
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
    });

    describe('GC', () => {
        it('gcChangeLog deletes entries below min cursor and older than retention', async () => {
            // Push some ops
            const ops = Array.from({ length: 5 }, (_, i) =>
                makeOp({ tableName: 'threads', pk: `t-${i}` })
            );
            await adapter.push(stubEvent, makeBatch(ops));

            // Set device cursors — device A at 3, device B at 5
            await adapter.updateCursor(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                deviceId: DEVICE_A,
                version: 3,
            });
            await adapter.updateCursor(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                deviceId: DEVICE_B,
                version: 5,
            });

            // Backdate change_log entries to make them eligible
            const raw = getRawDb();
            raw.prepare(
                'UPDATE change_log SET created_at = 0 WHERE workspace_id = ?'
            ).run(WORKSPACE_ID);

            // GC with 1 second retention (all entries are old enough)
            await adapter.gcChangeLog(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                retentionSeconds: 1,
            });

            // Only entries below min cursor (3) should be deleted
            const remaining = raw
                .prepare('SELECT COUNT(*) as cnt FROM change_log WHERE workspace_id = ?')
                .get(WORKSPACE_ID) as { cnt: number };

            // server_versions 1,2 deleted (< 3), 3,4,5 remain
            expect(remaining.cnt).toBe(3);
        });

        it('gcChangeLog preserves entries within retention window', async () => {
            const ops = Array.from({ length: 3 }, (_, i) =>
                makeOp({ tableName: 'threads', pk: `t-${i}` })
            );
            await adapter.push(stubEvent, makeBatch(ops));

            await adapter.updateCursor(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                deviceId: DEVICE_A,
                version: 5, // ahead of all
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

        it('gcTombstones respects min cursor', async () => {
            // Create a delete to produce a tombstone
            const putOp = makeOp({ tableName: 'threads', pk: 't-1' });
            await adapter.push(stubEvent, makeBatch([putOp]));

            const delOp = makeOp({
                tableName: 'threads',
                pk: 't-1',
                operation: 'delete',
                stamp: { clock: 2, hlc: '2025-01-01T00:00:01.000Z-0000', deviceId: DEVICE_A, opId: crypto.randomUUID() },
            });
            await adapter.push(stubEvent, makeBatch([delOp]));

            // Cursor behind tombstone's server_version
            await adapter.updateCursor(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                deviceId: DEVICE_A,
                version: 1, // tombstone is at sv=2
            });

            const raw = getRawDb();
            raw.prepare('UPDATE tombstones SET created_at = 0 WHERE workspace_id = ?').run(WORKSPACE_ID);

            await adapter.gcTombstones(stubEvent, {
                scope: { workspaceId: WORKSPACE_ID },
                retentionSeconds: 1,
            });

            // Tombstone at sv=2 should NOT be deleted because min cursor is 1
            const remaining = raw
                .prepare('SELECT COUNT(*) as cnt FROM tombstones WHERE workspace_id = ?')
                .get(WORKSPACE_ID) as { cnt: number };

            expect(remaining.cnt).toBe(1);
        });
    });
});
