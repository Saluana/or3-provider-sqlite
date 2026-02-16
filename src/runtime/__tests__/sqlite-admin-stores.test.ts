import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSqliteDb, destroySqliteDb, _resetForTest } from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { SqliteAuthWorkspaceStore } from '../server/auth/sqlite-auth-workspace-store';
import {
    createSqliteAdminUserStore,
    createSqliteWorkspaceAccessStore,
    createSqliteWorkspaceSettingsStore,
} from '../server/admin/stores/sqlite-store';

describe('sqlite admin stores', () => {
    beforeEach(async () => {
        _resetForTest();
        const db = getSqliteDb({ path: ':memory:' });
        await runMigrations(db);
    });

    afterEach(async () => {
        await destroySqliteDb();
    });

    it('lists and manages workspace membership', async () => {
        const authStore = new SqliteAuthWorkspaceStore();
        const accessStore = createSqliteWorkspaceAccessStore();

        const { userId: ownerUserId } = await authStore.getOrCreateUser({
            provider: 'basic-auth',
            providerUserId: 'owner-1',
            email: 'owner@example.com',
        });
        const { workspaceId } = await authStore.createWorkspace({
            userId: ownerUserId,
            name: 'Admin Workspace',
        });

        await accessStore.upsertMember({
            workspaceId,
            emailOrProviderId: 'member@example.com',
            role: 'viewer',
        });

        const members = await accessStore.listMembers({ workspaceId });
        expect(members.some((m) => m.email === 'member@example.com')).toBe(true);

        const workspaces = await accessStore.listWorkspaces({
            page: 1,
            perPage: 20,
        });
        expect(workspaces.total).toBe(1);
        expect(workspaces.items[0]?.id).toBe(workspaceId);
    });

    it('persists workspace settings', async () => {
        const authStore = new SqliteAuthWorkspaceStore();
        const settingsStore = createSqliteWorkspaceSettingsStore();

        const { userId } = await authStore.getOrCreateUser({
            provider: 'basic-auth',
            providerUserId: 'owner-2',
        });
        const { workspaceId } = await authStore.createWorkspace({
            userId,
            name: 'Settings Workspace',
        });

        await settingsStore.set(workspaceId, 'guest_access_enabled', 'true');
        const value = await settingsStore.get(workspaceId, 'guest_access_enabled');
        expect(value).toBe('true');
    });

    it('grants and revokes deployment admin users', async () => {
        const authStore = new SqliteAuthWorkspaceStore();
        const adminStore = createSqliteAdminUserStore();

        const { userId } = await authStore.getOrCreateUser({
            provider: 'basic-auth',
            providerUserId: 'admin-1',
            email: 'admin@example.com',
        });

        await adminStore.grantAdmin({ userId });
        expect(await adminStore.isAdmin({ userId })).toBe(true);

        const admins = await adminStore.listAdmins();
        expect(admins.some((admin) => admin.userId === userId)).toBe(true);

        await adminStore.revokeAdmin({ userId });
        expect(await adminStore.isAdmin({ userId })).toBe(false);
    });
});
