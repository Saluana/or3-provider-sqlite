/**
 * Integration tests for SQLite provider wiring across store + sync adapter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { H3Event } from 'h3';
import { getSqliteDb, destroySqliteDb, _resetForTest } from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { SqliteAuthWorkspaceStore } from '../server/auth/sqlite-auth-workspace-store';
import { SqliteSyncGatewayAdapter } from '../server/sync/sqlite-sync-gateway-adapter';

const stubEvent = {} as H3Event;

describe('sqlite provider integration', () => {
    let store: SqliteAuthWorkspaceStore;
    let adapter: SqliteSyncGatewayAdapter;

    beforeEach(async () => {
        _resetForTest();
        const db = getSqliteDb({ path: ':memory:' });
        await runMigrations(db);
        store = new SqliteAuthWorkspaceStore();
        adapter = new SqliteSyncGatewayAdapter();
    });

    afterEach(async () => {
        await destroySqliteDb();
    });

    it('runs push -> pull sync flow for a provisioned workspace', async () => {
        const { userId } = await store.getOrCreateUser({
            provider: 'basic-auth',
            providerUserId: 'integration-user',
        });
        const { workspaceId } = await store.getOrCreateDefaultWorkspace(userId);

        const opId = crypto.randomUUID();
        const push = await adapter.push(stubEvent, {
            scope: { workspaceId },
            ops: [
                {
                    id: crypto.randomUUID(),
                    tableName: 'threads',
                    operation: 'put',
                    pk: 'thread-1',
                    payload: { id: 'thread-1', title: 'integration' },
                    stamp: {
                        deviceId: 'device-1',
                        opId,
                        hlc: '2025-01-01T00:00:00.000Z-0000',
                        clock: 1,
                    },
                    createdAt: Math.floor(Date.now() / 1000),
                    attempts: 0,
                    status: 'pending',
                },
            ],
        });

        expect(push.results[0]?.success).toBe(true);

        const pull = await adapter.pull(stubEvent, {
            scope: { workspaceId },
            cursor: 0,
            limit: 10,
        });

        expect(pull.changes.length).toBe(1);
        expect(pull.changes[0]?.pk).toBe('thread-1');
        expect(pull.changes[0]?.stamp.opId).toBe(opId);
        expect(pull.nextCursor).toBe(push.serverVersion);
    });

    it('persists workspace CRUD state and active workspace switching', async () => {
        const { userId } = await store.getOrCreateUser({
            provider: 'basic-auth',
            providerUserId: 'workspace-flow-user',
        });

        const { workspaceId: ws1 } = await store.createWorkspace({
            userId,
            name: 'Workspace One',
        });
        const { workspaceId: ws2 } = await store.createWorkspace({
            userId,
            name: 'Workspace Two',
        });

        await store.updateWorkspace({
            userId,
            workspaceId: ws1,
            name: 'Workspace One Updated',
        });
        await store.setActiveWorkspace({
            userId,
            workspaceId: ws2,
        });
        await store.removeWorkspace({
            userId,
            workspaceId: ws2,
        });

        const workspaces = await store.listUserWorkspaces(userId);
        expect(workspaces.length).toBe(1);
        expect(workspaces[0]?.id).toBe(ws1);
        expect(workspaces[0]?.name).toBe('Workspace One Updated');
        expect(workspaces[0]?.isActive).toBe(true);
    });

    it('supports cursor update and change-log retention guardrails', async () => {
        const { userId } = await store.getOrCreateUser({
            provider: 'basic-auth',
            providerUserId: 'cursor-user',
        });
        const { workspaceId } = await store.getOrCreateDefaultWorkspace(userId);

        const ops = Array.from({ length: 3 }, (_, index) => ({
            id: crypto.randomUUID(),
            tableName: 'threads',
            operation: 'put' as const,
            pk: `thread-${index}`,
            payload: { id: `thread-${index}`, title: `Thread ${index}` },
            stamp: {
                deviceId: 'cursor-device',
                opId: crypto.randomUUID(),
                hlc: `2025-01-01T00:00:0${index}.000Z-0000`,
                clock: index + 1,
            },
            createdAt: Math.floor(Date.now() / 1000),
            attempts: 0,
            status: 'pending' as const,
        }));

        await adapter.push(stubEvent, {
            scope: { workspaceId },
            ops,
        });

        await adapter.updateCursor(stubEvent, {
            scope: { workspaceId },
            deviceId: 'cursor-device',
            version: 2,
        });

        await adapter.gcChangeLog(stubEvent, {
            scope: { workspaceId },
            retentionSeconds: 86400,
        });

        const pull = await adapter.pull(stubEvent, {
            scope: { workspaceId },
            cursor: 0,
            limit: 10,
        });
        expect(pull.changes.length).toBe(3);
    });
});
