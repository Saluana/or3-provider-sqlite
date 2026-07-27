import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { H3Event } from 'h3';
import type { Kysely } from 'kysely';
import {
    _resetForTest,
    destroySqliteDb,
    getRawDb,
    getSqliteDb,
} from '../server/db/kysely';
import * as m001 from '../server/db/migrations/001_init';
import * as m002 from '../server/db/migrations/002_sync_tables';
import * as m003 from '../server/db/migrations/003_sync_hardening';
import * as m004 from '../server/db/migrations/004_auth_invites';
import * as m005 from '../server/db/migrations/005_admin_stores';
import * as m006 from '../server/db/migrations/006_sync_snapshots';
import { SqliteSyncGatewayAdapter } from '../server/sync/sqlite-sync-gateway-adapter';
import { runMigrations } from '../server/db/migrate';

const WORKSPACE_ID = 'legacy-workspace';
const stubEvent = {} as H3Event;

beforeEach(() => {
    _resetForTest();
});

afterEach(async () => {
    await destroySqliteDb();
});

describe('SQLite sync snapshot migration', () => {
    it('is repeatable and retains one ledger entry per schema migration', async () => {
        const db = getSqliteDb({ path: ':memory:' });
        await runMigrations(db);
        const before = getRawDb().prepare(
            'SELECT name FROM kysely_migration ORDER BY name'
        ).all() as Array<{ name: string }>;
        await runMigrations(db);
        const after = getRawDb().prepare(
            'SELECT name FROM kysely_migration ORDER BY name'
        ).all() as Array<{ name: string }>;
        expect(after).toEqual(before);
        expect(after.map((row) => row.name)).toContain('006_sync_snapshots');
        expect(after.map((row) => row.name)).toContain('008_upload_intents');
    });

    it('backfills stable revision IDs for pre-snapshot live rows and tombstones', async () => {
        const db = getSqliteDb({ path: ':memory:' });
        const migrationDb = db as unknown as Kysely<unknown>;
        await m001.up(migrationDb);
        await m002.up(migrationDb);
        await m003.up(migrationDb);
        await m004.up(migrationDb);
        await m005.up(db);

        const raw = getRawDb();
        raw.prepare(`
            INSERT INTO server_version_counter (workspace_id, value)
            VALUES (?, 2)
        `).run(WORKSPACE_ID);
        raw.prepare(`
            INSERT INTO change_log (
                id, workspace_id, server_version, table_name, pk, op,
                payload_json, clock, hlc, device_id, op_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            'change-live',
            WORKSPACE_ID,
            1,
            'threads',
            'thread-live',
            'put',
            JSON.stringify({ id: 'thread-live', title: 'legacy live' }),
            2,
            'legacy-hlc-live',
            'legacy-device',
            'legacy-op-live',
            1
        );
        raw.prepare(`
            INSERT INTO s_threads (
                id, workspace_id, data_json, clock, hlc, device_id,
                deleted, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
        `).run(
            'thread-live',
            WORKSPACE_ID,
            JSON.stringify({ id: 'thread-live', title: 'legacy live' }),
            2,
            'legacy-hlc-live',
            'legacy-device',
            1,
            1
        );

        raw.prepare(`
            INSERT INTO change_log (
                id, workspace_id, server_version, table_name, pk, op,
                payload_json, clock, hlc, device_id, op_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
        `).run(
            'change-delete',
            WORKSPACE_ID,
            2,
            'projects',
            'project-deleted',
            'delete',
            3,
            'legacy-hlc-delete',
            'legacy-device',
            'legacy-op-delete',
            2
        );
        raw.prepare(`
            INSERT INTO s_projects (
                id, workspace_id, data_json, clock, hlc, device_id,
                deleted, created_at, updated_at
            ) VALUES (?, ?, '{}', ?, ?, ?, 1, ?, ?)
        `).run(
            'project-deleted',
            WORKSPACE_ID,
            3,
            'legacy-hlc-delete',
            'legacy-device',
            2,
            2
        );
        raw.prepare(`
            INSERT INTO tombstones (
                id, workspace_id, table_name, pk, deleted_at,
                clock, server_version, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            'tombstone-delete',
            WORKSPACE_ID,
            'projects',
            'project-deleted',
            2,
            3,
            2,
            2
        );

        await m006.up(migrationDb);

        expect(
            raw.prepare('SELECT op_id FROM s_threads WHERE workspace_id = ?')
                .get(WORKSPACE_ID)
        ).toMatchObject({ op_id: 'legacy-op-live' });
        expect(
            raw.prepare('SELECT hlc, op_id FROM tombstones WHERE workspace_id = ?')
                .get(WORKSPACE_ID)
        ).toMatchObject({
            hlc: 'legacy-hlc-delete',
            op_id: 'legacy-op-delete',
        });

        const snapshot = await new SqliteSyncGatewayAdapter().snapshot(stubEvent, {
            scope: { workspaceId: WORKSPACE_ID },
            pageSize: 10,
        });
        expect(snapshot.highWatermark).toBe(2);
        expect(snapshot.nextPageToken).toBeNull();
        expect(snapshot.items).toEqual([
            expect.objectContaining({
                kind: 'tombstone',
                tableName: 'projects',
                pk: 'project-deleted',
                revision: {
                    clock: 3,
                    hlc: 'legacy-hlc-delete',
                    opId: 'legacy-op-delete',
                },
            }),
            expect.objectContaining({
                kind: 'row',
                tableName: 'threads',
                pk: 'thread-live',
                revision: {
                    clock: 2,
                    hlc: 'legacy-hlc-live',
                    opId: 'legacy-op-live',
                },
            }),
        ]);
    });
});
