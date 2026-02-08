/**
 * Unit tests for SqliteAuthWorkspaceStore.
 *
 * Uses in-memory SQLite for fast isolated tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSqliteDb, destroySqliteDb, _resetForTest } from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { SqliteAuthWorkspaceStore } from '../server/auth/sqlite-auth-workspace-store';

let store: SqliteAuthWorkspaceStore;

beforeEach(async () => {
    _resetForTest();
    const db = getSqliteDb({ path: ':memory:' });
    await runMigrations(db);
    store = new SqliteAuthWorkspaceStore();
});

afterEach(async () => {
    await destroySqliteDb();
});

describe('SqliteAuthWorkspaceStore', () => {
    describe('getOrCreateUser', () => {
        it('creates a new user on first call', async () => {
            const result = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
                email: 'test@example.com',
                displayName: 'Test User',
            });

            expect(result.userId).toBeDefined();
            expect(typeof result.userId).toBe('string');
        });

        it('returns same userId for same provider identity (idempotent)', async () => {
            const first = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const second = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            expect(second.userId).toBe(first.userId);
        });

        it('creates different users for different provider IDs', async () => {
            const a = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const b = await store.getOrCreateUser({
                provider: 'clerk',
                providerUserId: 'user-1',
            });

            expect(a.userId).not.toBe(b.userId);
        });

        it('creates different users for different provider user IDs', async () => {
            const a = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const b = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-2',
            });

            expect(a.userId).not.toBe(b.userId);
        });
    });

    describe('getOrCreateDefaultWorkspace', () => {
        it('creates a default workspace on first call', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const result = await store.getOrCreateDefaultWorkspace(userId);

            expect(result.workspaceId).toBeDefined();
            expect(result.workspaceName).toBe('My Workspace');
        });

        it('returns same workspace on subsequent calls', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const first = await store.getOrCreateDefaultWorkspace(userId);
            const second = await store.getOrCreateDefaultWorkspace(userId);

            expect(second.workspaceId).toBe(first.workspaceId);
        });

        it('sets active workspace for user', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const { workspaceId } = await store.getOrCreateDefaultWorkspace(userId);

            const workspaces = await store.listUserWorkspaces(userId);
            const active = workspaces.find((w) => w.isActive);
            expect(active?.id).toBe(workspaceId);
        });
    });

    describe('getWorkspaceRole', () => {
        it('returns owner for workspace creator', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const { workspaceId } = await store.getOrCreateDefaultWorkspace(userId);
            const role = await store.getWorkspaceRole({ userId, workspaceId });

            expect(role).toBe('owner');
        });

        it('returns null for non-member', async () => {
            const { userId: userA } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-a',
            });
            const { userId: userB } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-b',
            });

            const { workspaceId } = await store.getOrCreateDefaultWorkspace(userA);
            const role = await store.getWorkspaceRole({ userId: userB, workspaceId });

            expect(role).toBeNull();
        });
    });

    describe('workspace CRUD', () => {
        it('creates and lists workspaces', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            await store.createWorkspace({ userId, name: 'WS 1', description: 'First' });
            await store.createWorkspace({ userId, name: 'WS 2' });

            const workspaces = await store.listUserWorkspaces(userId);
            expect(workspaces.length).toBe(2);
            expect(workspaces.map((w) => w.name).sort()).toEqual(['WS 1', 'WS 2']);
        });

        it('updates workspace metadata', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const { workspaceId } = await store.createWorkspace({
                userId,
                name: 'Old Name',
            });

            await store.updateWorkspace({
                userId,
                workspaceId,
                name: 'New Name',
                description: 'Updated',
            });

            const workspaces = await store.listUserWorkspaces(userId);
            const ws = workspaces.find((w) => w.id === workspaceId);
            expect(ws?.name).toBe('New Name');
            expect(ws?.description).toBe('Updated');
        });

        it('rejects update from viewer', async () => {
            const { userId: owner } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'owner',
            });

            const { workspaceId } = await store.createWorkspace({
                userId: owner,
                name: 'Test',
            });

            // Add viewer directly via DB
            const db = getSqliteDb();
            const { userId: viewer } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'viewer',
            });

            await db
                .insertInto('workspace_members')
                .values({
                    id: crypto.randomUUID(),
                    workspace_id: workspaceId,
                    user_id: viewer,
                    role: 'viewer',
                    created_at: Math.floor(Date.now() / 1000),
                })
                .execute();

            await expect(
                store.updateWorkspace({
                    userId: viewer,
                    workspaceId,
                    name: 'Hacked',
                })
            ).rejects.toThrow('insufficient workspace role');
        });

        it('soft deletes and re-homes active workspace', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const { workspaceId: ws1 } = await store.createWorkspace({
                userId,
                name: 'WS 1',
            });
            const { workspaceId: ws2 } = await store.createWorkspace({
                userId,
                name: 'WS 2',
            });

            await store.setActiveWorkspace({ userId, workspaceId: ws1 });
            await store.removeWorkspace({ userId, workspaceId: ws1 });

            const workspaces = await store.listUserWorkspaces(userId);
            expect(workspaces.length).toBe(1);
            expect(workspaces[0]!.id).toBe(ws2);
        });

        it('rejects remove from non-owner', async () => {
            const { userId: owner } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'owner',
            });
            const { userId: editor } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'editor',
            });

            const { workspaceId } = await store.createWorkspace({
                userId: owner,
                name: 'Test',
            });

            const db = getSqliteDb();
            await db
                .insertInto('workspace_members')
                .values({
                    id: crypto.randomUUID(),
                    workspace_id: workspaceId,
                    user_id: editor,
                    role: 'editor',
                    created_at: Math.floor(Date.now() / 1000),
                })
                .execute();

            await expect(
                store.removeWorkspace({ userId: editor, workspaceId })
            ).rejects.toThrow('only owner');
        });
    });

    describe('setActiveWorkspace', () => {
        it('sets active workspace for member', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const { workspaceId: ws1 } = await store.createWorkspace({
                userId,
                name: 'WS 1',
            });
            const { workspaceId: ws2 } = await store.createWorkspace({
                userId,
                name: 'WS 2',
            });

            await store.setActiveWorkspace({ userId, workspaceId: ws2 });

            const workspaces = await store.listUserWorkspaces(userId);
            const active = workspaces.find((w) => w.isActive);
            expect(active?.id).toBe(ws2);
        });

        it('rejects for non-member', async () => {
            const { userId: userA } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-a',
            });
            const { userId: userB } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-b',
            });

            const { workspaceId } = await store.createWorkspace({
                userId: userA,
                name: 'Private',
            });

            await expect(
                store.setActiveWorkspace({ userId: userB, workspaceId })
            ).rejects.toThrow('not a member');
        });
    });
});
