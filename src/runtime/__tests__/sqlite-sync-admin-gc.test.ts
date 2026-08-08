/**
 * Tests for the SQLite sync admin GC actions and maintenance state.
 *
 * Covers: advertised actions, workspace-not-resolved guard, real change-log and
 * tombstone GC via runAction, maintenance state transitions, and workspace
 * enumeration used by the in-process scheduler.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { H3Event } from 'h3';
import { getSqliteDb, getRawDb, destroySqliteDb, _resetForTest } from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { SqliteSyncGatewayAdapter } from '../server/sync/sqlite-sync-gateway-adapter';
import { sqliteSyncAdminAdapter } from '../server/admin/adapters/sync-sqlite';
import {
    beginSyncMaintenanceRun,
    completeSyncMaintenanceRun,
    failSyncMaintenanceRun,
    getSyncMaintenanceState,
    _resetSyncMaintenanceStateForTest,
} from '../server/sync/maintenance-state';
import type { PendingOp } from '~~/shared/sync/types';

const WORKSPACE_ID = 'ws-admin-gc';
const stubEvent = {} as H3Event;

function makeOp(overrides: Partial<PendingOp> & { tableName: string; pk: string }): PendingOp {
    return {
        id: randomUUID(),
        tableName: overrides.tableName,
        operation: overrides.operation ?? 'put',
        pk: overrides.pk,
        payload: overrides.payload ?? { id: overrides.pk, title: 'test' },
        stamp: {
            deviceId: overrides.stamp?.deviceId ?? 'device-a',
            opId: overrides.stamp?.opId ?? randomUUID(),
            hlc: overrides.stamp?.hlc ?? '2025-01-01T00:00:00.000Z-0000',
            clock: overrides.stamp?.clock ?? 1,
        },
        createdAt: Math.floor(Date.now() / 1000),
        attempts: 0,
        status: 'pending',
    };
}

function makeSessionEvent(userId: string, workspaceId: string): H3Event {
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

function makeActionContext(workspaceId: string) {
    return {
        provider: 'sqlite',
        enabled: true,
        session: {
            authenticated: true,
            user: { id: 'user-a' },
            workspace: { id: workspaceId },
        },
    } as never;
}

describe('SQLite sync admin GC', () => {
    let adapter: SqliteSyncGatewayAdapter;

    beforeEach(async () => {
        _resetForTest();
        _resetSyncMaintenanceStateForTest();
        const db = getSqliteDb({ path: ':memory:' });
        await runMigrations(db);
        adapter = new SqliteSyncGatewayAdapter();
    });

    afterEach(async () => {
        await destroySqliteDb();
        _resetSyncMaintenanceStateForTest();
    });

    it('advertises the GC actions and maintenance details', async () => {
        const status = await sqliteSyncAdminAdapter.getStatus(stubEvent, {
            enabled: true,
            provider: 'sqlite',
        } as never);

        expect(status.actions.map((action) => action.id)).toEqual([
            'sync.gc-change-log',
            'sync.gc-tombstones',
        ]);
        expect(status.details?.maintenance).toMatchObject({
            enabled: true,
            state: 'idle',
        });
    });

    it('keeps the workspace-not-resolved 400', async () => {
        await expect(
            sqliteSyncAdminAdapter.runAction!(
                stubEvent,
                'sync.gc-change-log',
                {},
                { session: {} } as never
            )
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects unknown actions with 400', async () => {
        await expect(
            sqliteSyncAdminAdapter.runAction!(
                stubEvent,
                'sync.unknown',
                {},
                makeActionContext(WORKSPACE_ID)
            )
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('executes a real change-log GC and records maintenance state', async () => {
        const ops = Array.from({ length: 5 }, (_, index) =>
            makeOp({ tableName: 'threads', pk: `t-${index}` })
        );
        await adapter.push(stubEvent, { scope: { workspaceId: WORKSPACE_ID }, ops });

        // Device cursor at 3 — entries 1..3 are behind it, 4..5 are not.
        await adapter.updateCursor(makeSessionEvent('user-a', WORKSPACE_ID), {
            scope: { workspaceId: WORKSPACE_ID },
            deviceId: 'device-a',
            version: 3,
        });

        // Backdate all change_log entries to make them age-eligible.
        const raw = getRawDb();
        raw.prepare('UPDATE change_log SET created_at = 0 WHERE workspace_id = ?').run(WORKSPACE_ID);

        const result = await sqliteSyncAdminAdapter.runAction!(
            stubEvent,
            'sync.gc-change-log',
            {},
            makeActionContext(WORKSPACE_ID)
        );

        expect(result).toMatchObject({ ok: true, actionId: 'sync.gc-change-log' });

        const remaining = raw
            .prepare('SELECT COUNT(*) as cnt FROM change_log WHERE workspace_id = ?')
            .get(WORKSPACE_ID) as { cnt: number };
        expect(remaining.cnt).toBe(2);

        const maintenance = getSyncMaintenanceState();
        expect(maintenance.state).toBe('idle');
        expect(maintenance.lastRun).toBeDefined();
        expect(typeof maintenance.backlog).toBe('number');
    });

    it('executes a real tombstone GC', async () => {
        const putOp = makeOp({ tableName: 'threads', pk: 't-1' });
        await adapter.push(stubEvent, { scope: { workspaceId: WORKSPACE_ID }, ops: [putOp] });
        const delOp = makeOp({
            tableName: 'threads',
            pk: 't-1',
            operation: 'delete',
            stamp: {
                clock: 2,
                hlc: '2025-01-01T00:00:01.000Z-0000',
                deviceId: 'device-a',
                opId: randomUUID(),
            },
        });
        await adapter.push(stubEvent, { scope: { workspaceId: WORKSPACE_ID }, ops: [delOp] });

        await adapter.updateCursor(makeSessionEvent('user-a', WORKSPACE_ID), {
            scope: { workspaceId: WORKSPACE_ID },
            deviceId: 'device-a',
            version: 2,
        });

        const raw = getRawDb();
        raw.prepare('UPDATE tombstones SET created_at = 0 WHERE workspace_id = ?').run(WORKSPACE_ID);

        const result = await sqliteSyncAdminAdapter.runAction!(
            stubEvent,
            'sync.gc-tombstones',
            {},
            makeActionContext(WORKSPACE_ID)
        );

        expect(result).toMatchObject({ ok: true, actionId: 'sync.gc-tombstones' });

        const remaining = raw
            .prepare('SELECT COUNT(*) as cnt FROM tombstones WHERE workspace_id = ?')
            .get(WORKSPACE_ID) as { cnt: number };
        expect(remaining.cnt).toBe(0);
    });

    it('records a failed maintenance state when GC throws', async () => {
        const mismatchedEvent = {
            context: {
                __or3_session_context_test: {
                    authenticated: true,
                    workspace: { id: 'other-workspace' },
                },
            },
        } as unknown as H3Event;

        await expect(
            sqliteSyncAdminAdapter.runAction!(
                mismatchedEvent,
                'sync.gc-change-log',
                {},
                makeActionContext(WORKSPACE_ID)
            )
        ).rejects.toMatchObject({ statusCode: 403 });

        const maintenance = getSyncMaintenanceState();
        expect(maintenance.state).toBe('failed');
        expect(maintenance.lastError).toBeDefined();
    });

    it('maintenance state transitions idle -> running -> idle/failed', () => {
        _resetSyncMaintenanceStateForTest();
        expect(getSyncMaintenanceState().state).toBe('idle');

        beginSyncMaintenanceRun();
        expect(getSyncMaintenanceState().state).toBe('running');

        completeSyncMaintenanceRun({
            lastRun: '2025-01-01T00:00:00.000Z',
            backlog: 0,
        });
        expect(getSyncMaintenanceState()).toMatchObject({
            state: 'idle',
            lastRun: '2025-01-01T00:00:00.000Z',
            backlog: 0,
            lastError: undefined,
        });

        beginSyncMaintenanceRun();
        failSyncMaintenanceRun('boom');
        expect(getSyncMaintenanceState()).toMatchObject({
            state: 'failed',
            lastError: 'boom',
        });
    });

    it('listWorkspaceIds enumerates only non-deleted workspaces', async () => {
        const raw = getRawDb();
        raw.prepare(
            `INSERT INTO workspaces (id, name, owner_user_id) VALUES (?, ?, ?)`
        ).run('ws-1', 'One', 'user-1');
        raw.prepare(
            `INSERT INTO workspaces (id, name, owner_user_id, deleted) VALUES (?, ?, ?, 1)`
        ).run('ws-2', 'Two', 'user-1');
        raw.prepare(
            `INSERT INTO workspaces (id, name, owner_user_id) VALUES (?, ?, ?)`
        ).run('ws-3', 'Three', 'user-1');

        const ids = await adapter.listWorkspaceIds();
        expect(ids).toEqual(['ws-1', 'ws-3']);
    });
});
