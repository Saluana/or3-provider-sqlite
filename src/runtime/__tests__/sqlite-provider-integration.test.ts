/**
 * Integration tests for SQLite provider wiring across store + sync adapter.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { H3Event } from 'h3';
import { initializeSqliteDb, destroySqliteDb, _resetForTest } from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { SqliteAuthWorkspaceStore } from '../server/auth/sqlite-auth-workspace-store';
import { SqliteSyncGatewayAdapter } from '../server/sync/sqlite-sync-gateway-adapter';
import { createD1TestDatabase } from '../../../test/support/d1-test-database';

const stubEvent = {} as H3Event;

function makeAuthenticatedEvent(userId: string, workspaceId: string): H3Event {
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

describe('sqlite provider integration', () => {
    let store: SqliteAuthWorkspaceStore;
    let adapter: SqliteSyncGatewayAdapter;

    beforeEach(async () => {
        _resetForTest();
        const db = await initializeSqliteDb({ path: ':memory:' });
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

        const opId = randomUUID();
        const push = await adapter.push(stubEvent, {
            scope: { workspaceId },
            ops: [
                {
                    id: randomUUID(),
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
            id: randomUUID(),
            tableName: 'threads',
            operation: 'put' as const,
            pk: `thread-${index}`,
            payload: { id: `thread-${index}`, title: `Thread ${index}` },
            stamp: {
                deviceId: 'cursor-device',
                opId: randomUUID(),
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

        await adapter.updateCursor(makeAuthenticatedEvent(userId, workspaceId), {
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

describe('sqlite provider D1 integration', () => {
    let store: SqliteAuthWorkspaceStore;
    let adapter: SqliteSyncGatewayAdapter;
    let d1: ReturnType<typeof createD1TestDatabase>;

    beforeEach(async () => {
        _resetForTest();
        d1 = createD1TestDatabase();
        const db = await initializeSqliteDb({
            driver: 'd1',
            d1Database: d1.database,
        });
        await runMigrations(db);
        store = new SqliteAuthWorkspaceStore();
        adapter = new SqliteSyncGatewayAdapter();
    });

    afterEach(async () => {
        await destroySqliteDb();
        d1.close();
    });

    it('runs auth provisioning and push/pull through native D1 operations', async () => {
        const { userId } = await store.getOrCreateUser({
            provider: 'clerk',
            providerUserId: 'd1-integration-user',
        });
        const { workspaceId } = await store.getOrCreateDefaultWorkspace(userId);
        const { workspaceId: extraWorkspaceId } = await store.createWorkspace({
            userId,
            name: 'D1 extra workspace',
        });
        await store.updateWorkspace({
            userId,
            workspaceId: extraWorkspaceId,
            name: 'D1 workspace updated',
        });
        await store.removeWorkspace({ userId, workspaceId: extraWorkspaceId });
        const opId = randomUUID();

        const push = await adapter.push(stubEvent, {
            scope: { workspaceId },
            ops: [
                {
                    id: randomUUID(),
                    tableName: 'threads',
                    operation: 'put',
                    pk: 'd1-thread-1',
                    payload: { id: 'd1-thread-1', title: 'D1 integration' },
                    stamp: {
                        deviceId: 'd1-device',
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
        const pull = await adapter.pull(stubEvent, {
            scope: { workspaceId },
            cursor: 0,
            limit: 10,
        });
        const snapshot = await adapter.snapshot(stubEvent, {
            scope: { workspaceId },
            pageSize: 10,
        });
        await adapter.updateCursor(
            makeAuthenticatedEvent(userId, workspaceId),
            {
                scope: { workspaceId },
                deviceId: 'd1-device',
                version: 1,
            }
        );

        expect(push.results[0]?.success).toBe(true);
        expect(pull.changes).toHaveLength(1);
        expect(pull.changes[0]?.stamp.opId).toBe(opId);
        expect(snapshot.items).toContainEqual(
            expect.objectContaining({ tableName: 'threads', pk: 'd1-thread-1' })
        );
        await expect(store.listUserWorkspaces(userId)).resolves.toEqual([
            expect.objectContaining({ id: workspaceId }),
        ]);
    });

    it('keeps D1 push versions contiguous and accepts invites atomically', async () => {
        const { userId } = await store.getOrCreateUser({
            provider: 'clerk',
            providerUserId: 'd1-version-owner',
            email: 'owner@example.com',
        });
        const { workspaceId } = await store.getOrCreateDefaultWorkspace(userId);
        const ops = [1, 2].map((clock) => ({
            id: randomUUID(),
            tableName: 'threads',
            operation: 'put' as const,
            pk: `d1-version-${clock}`,
            payload: { id: `d1-version-${clock}` },
            stamp: {
                deviceId: 'd1-version-device',
                opId: randomUUID(),
                hlc: `2025-01-01T00:00:0${clock}.000Z-0000`,
                clock,
            },
            createdAt: Math.floor(Date.now() / 1000),
            attempts: 0,
            status: 'pending' as const,
        }));

        const firstPush = await adapter.push(stubEvent, {
            scope: { workspaceId },
            ops,
        });
        const replay = await adapter.push(stubEvent, {
            scope: { workspaceId },
            ops: [ops[0]!],
        });

        expect(firstPush.serverVersion).toBe(2);
        expect(firstPush.results.map((result) => result.serverVersion)).toEqual([1, 2]);
        expect(replay).toMatchObject({
            serverVersion: 2,
            results: [{ serverVersion: 1 }],
        });

        const tokenHash = `invite-${randomUUID()}`;
        await store.createInvite({
            workspaceId,
            email: 'invitee@example.com',
            role: 'editor',
            invitedByUserId: userId,
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            tokenHash,
        });
        const accepted = await store.acceptInviteAndProvisionUser({
            provider: 'clerk',
            providerUserId: 'd1-invited-user',
            email: 'Invitee@Example.com',
            workspaceId,
            tokenHash,
        });

        expect(accepted).toMatchObject({ ok: true, role: 'editor' });
        if (!accepted.ok) throw new Error('Expected D1 invite acceptance');
        await expect(
            store.getWorkspaceRole({ userId: accepted.userId, workspaceId })
        ).resolves.toBe('editor');
    });

    it('scopes D1 notifications and rejects fingerprint reuse', async () => {
        const { userId: alice } = await store.getOrCreateUser({
            provider: 'clerk',
            providerUserId: 'd1-alice',
        });
        const { userId: bob } = await store.getOrCreateUser({
            provider: 'clerk',
            providerUserId: 'd1-bob',
        });
        const { workspaceId } = await store.getOrCreateDefaultWorkspace(alice);
        const aliceEvent = makeAuthenticatedEvent(alice, workspaceId);
        const bobEvent = makeAuthenticatedEvent(bob, workspaceId);
        const now = Math.floor(Date.now() / 1000);
        const makeNote = (userId: string, pk: string, opId = randomUUID()) => ({
            id: randomUUID(),
            tableName: 'notifications' as const,
            operation: 'put' as const,
            pk,
            payload: { id: pk, title: pk },
            stamp: {
                deviceId: `${userId}-device`,
                opId,
                hlc: '2025-01-01T00:00:00.000Z-0000',
                clock: 1,
            },
            createdAt: now,
            attempts: 0,
            status: 'pending' as const,
        });

        expect((await adapter.push(aliceEvent, {
            scope: { workspaceId },
            ops: [makeNote(alice, 'd1-note-alice')],
        })).results[0]?.success).toBe(true);
        expect((await adapter.push(bobEvent, {
            scope: { workspaceId },
            ops: [makeNote(bob, 'd1-note-bob')],
        })).results[0]?.success).toBe(true);

        const alicePull = await adapter.pull(aliceEvent, {
            scope: { workspaceId },
            cursor: 0,
            limit: 20,
        });
        expect(alicePull.changes.filter((c) => c.tableName === 'notifications').map((c) => c.pk))
            .toEqual(['d1-note-alice']);

        const sharedOpId = randomUUID();
        const original = {
            id: randomUUID(),
            tableName: 'threads' as const,
            operation: 'put' as const,
            pk: 'd1-fp',
            payload: { id: 'd1-fp', title: 'original' },
            stamp: {
                deviceId: 'd1-fp-device',
                opId: sharedOpId,
                hlc: '2025-01-01T00:00:00.000Z-0000',
                clock: 1,
            },
            createdAt: now,
            attempts: 0,
            status: 'pending' as const,
        };
        await adapter.push(stubEvent, { scope: { workspaceId }, ops: [original] });
        const conflict = await adapter.push(stubEvent, {
            scope: { workspaceId },
            ops: [{
                ...original,
                id: randomUUID(),
                pk: 'd1-fp-other',
                payload: { id: 'd1-fp-other', title: 'other' },
            }],
        });
        expect(conflict.results[0]).toMatchObject({
            success: false,
            errorCode: 'CONFLICT',
        });
    });
});
