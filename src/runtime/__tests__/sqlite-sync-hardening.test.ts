import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { H3Event } from 'h3';
import { initializeSqliteDb, destroySqliteDb, getRawDb, _resetForTest } from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { createD1TestDatabase } from '../../../test/support/d1-test-database';
import { SqliteSyncGatewayAdapter } from '../server/sync/sqlite-sync-gateway-adapter';
import type { PendingOp } from '~~/shared/sync/types';
import { SnapshotResponseSchema, PullResponseSchema } from '~~/shared/sync/schemas';
const scope = { workspaceId: 'hardening' };
const event = {} as H3Event;
const op = (pk: string, payload: Record<string, unknown> = {}): PendingOp => ({
    id: randomUUID(), tableName: 'kv', pk, operation: 'put',
    payload: { id: pk, name: pk, value: 'ok', created_at: 1, updated_at: 1, ...payload },
    stamp: { opId: randomUUID(), deviceId: 'test', clock: 1, hlc: 'legacy:1' },
    createdAt: 1, attempts: 0, status: 'pending',
});
let adapter: SqliteSyncGatewayAdapter;
let d1: ReturnType<typeof createD1TestDatabase> | undefined;
let raw: ReturnType<typeof getRawDb>;
afterEach(async () => { await destroySqliteDb(); d1?.close(); d1 = undefined; });
describe.each(['native', 'd1'])('%s matched sync contract', driver => {
    beforeEach(async () => {
        _resetForTest();
        if (driver === 'd1') d1 = createD1TestDatabase();
        const db = await initializeSqliteDb(d1 ? { driver: 'd1', d1Database: d1.database } : { path: ':memory:' });
        await runMigrations(db);
        raw = d1 ? { prepare: (query: string) => ({ run: (...parameters: unknown[]) => d1!.database.prepare(query).bind(...parameters).run(), get: async (...parameters: unknown[]) => (await d1!.database.prepare(query).bind(...parameters).all()).results?.[0] }) } as unknown as ReturnType<typeof getRawDb> : getRawDb();
        adapter = new SqliteSyncGatewayAdapter();
    });
    it('rejects invalid final payloads without allocating state and persists one normalized row/log value', async () => {
        const invalid = op('bad', { name: 42 });
        expect((await adapter.push(event, { scope, ops: [invalid] })).results[0]).toMatchObject({ success: false, errorCode: 'VALIDATION_ERROR' });
        expect(await raw.prepare('SELECT count(*) AS n FROM change_log').get()).toEqual({ n: 0 });
        expect(await raw.prepare('SELECT count(*) AS n FROM server_version_counter').get()).toEqual({ n: 0 });
        const good = op('good');
        expect((await adapter.push(event, { scope, ops: [good] })).results[0]?.success).toBe(true);
        const row = await raw.prepare('SELECT data_json FROM s_kv').get() as { data_json: string };
        const log = await raw.prepare('SELECT payload_json FROM change_log').get() as { payload_json: string };
        expect(row.data_json).toBe(log.payload_json);
        expect(JSON.parse(row.data_json)).toMatchObject({ clock: 1, hlc: good.stamp.hlc, op_id: good.stamp.opId });
        expect((await adapter.push(event, { scope, ops: [good] })).results[0]).toMatchObject({ success: true, serverVersion: 1 });
    });
    it('acknowledges a lost ACK from 0.0.30 before new normalization', async () => {
        const legacy = op('legacy');
        await raw.prepare(`INSERT INTO change_log (id,workspace_id,server_version,table_name,pk,op,payload_json,clock,hlc,device_id,op_id,created_at)
            VALUES (?, ?, 1, 'kv', ?, 'put', ?, 1, ?, 'test', ?, 1)`).run(randomUUID(),scope.workspaceId,legacy.pk,JSON.stringify(legacy.payload),legacy.stamp.hlc,legacy.stamp.opId);
        await raw.prepare('INSERT INTO server_version_counter VALUES (?,1)').run(scope.workspaceId);
        expect((await adapter.push(event, { scope, ops: [legacy] })).results[0]).toMatchObject({ success: true, serverVersion: 1 });
    });
    it('pages UTF-8 component keys including NUL prefixes and maximum escaped tokens', async () => {
        const keys = ['a', 'a\0b', '\uE000', '😀', '界'.repeat(1024), '\0'.repeat(1024)];
        expect((await adapter.push(event, { scope, ops: keys.map(key => op(key)) })).results.every(result => result.success)).toBe(true);
        const seen: string[] = []; let pageToken: string | undefined;
        do {
            const page = await adapter.snapshot(event, { scope, tables: ['kv'], pageSize: 1, ...(pageToken ? { pageToken } : {}) });
            expect(SnapshotResponseSchema.safeParse(page).success).toBe(true);
            seen.push(...page.items.map(item => item.pk)); pageToken = page.nextPageToken ?? undefined;
        } while (pageToken);
        expect(seen).toEqual([...keys].sort((a,b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    });
    it('retains poison and oversized originals before all-invalid pull progress and snapshot completion', async () => {
        await adapter.push(event, { scope, ops: [op('broken'), op('huge'), op('healthy')] });
        await raw.prepare("UPDATE change_log SET payload_json = '{bad' WHERE pk = 'broken'").run();
        await raw.prepare("UPDATE s_kv SET data_json = '{bad' WHERE id = 'broken'").run();
        const huge = JSON.stringify({ padding: 'x'.repeat(300000) });
        await raw.prepare("UPDATE change_log SET payload_json = ? WHERE pk = 'huge'").run(huge);
        await raw.prepare("UPDATE s_kv SET data_json = ? WHERE id = 'huge'").run(huge);
        const pull = await adapter.pull(event, { scope, cursor: 0, limit: 2 });
        expect(PullResponseSchema.safeParse(pull).success).toBe(true);
        expect(pull).toMatchObject({ changes: [], nextCursor: 2, hasMore: true, unavailable: [
            { pk: 'broken', originalKind: 'put', serverVersion: 1 }, { pk: 'huge', originalKind: 'put', serverVersion: 2 },
        ] });
        const refs = pull.unavailable!.map(marker => marker.evidenceRef);
        expect((await adapter.pull(event, { scope, cursor: 0, limit: 2 })).unavailable!.map(marker => marker.evidenceRef)).toEqual(refs);
        const snapshot = await adapter.snapshot(event, { scope, tables: ['kv'], pageSize: 3 });
        expect(SnapshotResponseSchema.safeParse(snapshot).success).toBe(true);
        expect(snapshot.items.map(item => item.pk)).toEqual(['healthy']);
        expect(snapshot.unavailable?.length).toBe(2);
        expect(snapshot.nextPageToken).toBeNull();
        await raw.prepare('DELETE FROM change_log').run(); await raw.prepare('DELETE FROM sync_snapshots').run();
        expect(await raw.prepare('SELECT count(*) AS n FROM sync_unavailable_records').get()).toEqual({ n: 4 });
    });
});
