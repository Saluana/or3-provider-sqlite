import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initializeSqliteDb, destroySqliteDb, _resetForTest } from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { SqliteAuthWorkspaceStore } from '../server/auth/sqlite-auth-workspace-store';
import {
    createSqliteAdminUserStore,
    createSqliteWorkspaceAccessStore,
    createSqliteWorkspaceSettingsStore,
} from '../server/admin/stores/sqlite-store';
import { verifyAdminStoreProviderContract } from '~~/shared/testing/contracts/admin';

describe('sqlite admin stores', () => {
    beforeEach(async () => {
        _resetForTest();
        const db = await initializeSqliteDb({ path: ':memory:' });
        await runMigrations(db);
    });

    afterEach(async () => {
        await destroySqliteDb();
    });

    it('implements the complete shared admin provider contract', () => {
        expect(() => verifyAdminStoreProviderContract({
            name: 'sqlite',
            workspaceAccess: createSqliteWorkspaceAccessStore(),
            workspaceSettings: createSqliteWorkspaceSettingsStore(),
            adminUsers: createSqliteAdminUserStore(),
            capabilities: {
                supportsServerSideAdmin: true,
                supportsUserSearch: true,
                supportsWorkspaceList: true,
                supportsWorkspaceManagement: true,
                supportsDeploymentAdminGrants: true,
            },
        })).not.toThrow();
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

        await settingsStore.set(workspaceId, 'guest_access_enabled', 'false');
        expect(await settingsStore.get(workspaceId, 'guest_access_enabled')).toBe('false');
        expect(await settingsStore.get(workspaceId, 'missing')).toBeNull();
    });

    it('supports workspace create, soft-delete, restore, search, and member removal', async () => {
        const authStore = new SqliteAuthWorkspaceStore();
        const accessStore = createSqliteWorkspaceAccessStore();
        const { userId } = await authStore.getOrCreateUser({
            provider: 'basic-auth',
            providerUserId: 'lifecycle-owner',
            email: 'lifecycle-owner@example.com',
        });
        const { workspaceId } = await accessStore.createWorkspace({
            name: 'Lifecycle Contract',
            description: 'contract sentinel',
            ownerUserId: userId,
        });
        await accessStore.upsertMember({
            workspaceId,
            emailOrProviderId: 'temporary@example.com',
            role: 'viewer',
        });
        const temporary = (await accessStore.listMembers({ workspaceId }))
            .find((member) => member.email === 'temporary@example.com');
        expect(temporary).toBeDefined();

        await accessStore.setMemberRole({
            workspaceId,
            userId: temporary!.userId,
            role: 'editor',
        });
        expect(await accessStore.searchUsers({ query: 'temporary', limit: 5 }))
            .toEqual([expect.objectContaining({ userId: temporary!.userId })]);
        await accessStore.removeMember({ workspaceId, userId: temporary!.userId });
        expect(await accessStore.listMembers({ workspaceId }))
            .not.toEqual(expect.arrayContaining([expect.objectContaining({ userId: temporary!.userId })]));

        await accessStore.softDeleteWorkspace({ workspaceId, deletedAt: 1234 });
        expect(await accessStore.getWorkspace({ workspaceId }))
            .toMatchObject({ deleted: true, deletedAt: 1234 });
        expect((await accessStore.listWorkspaces({
            page: 1, perPage: 20, includeDeleted: false,
        })).items).toEqual([]);

        await accessStore.restoreWorkspace({ workspaceId });
        expect(await accessStore.getWorkspace({ workspaceId }))
            .toMatchObject({ deleted: false });
    });

    it('prevents removing or demoting the last owner', async () => {
        const authStore = new SqliteAuthWorkspaceStore();
        const accessStore = createSqliteWorkspaceAccessStore();
        const { userId: ownerUserId } = await authStore.getOrCreateUser({
            provider: 'basic-auth',
            providerUserId: 'only-owner',
            email: 'only-owner@example.com',
        });
        const { workspaceId } = await authStore.createWorkspace({
            userId: ownerUserId,
            name: 'Protected Workspace',
        });

        await expect(
            accessStore.setMemberRole({
                workspaceId,
                userId: ownerUserId,
                role: 'viewer',
            })
        ).rejects.toThrow(/last workspace owner/i);
        await expect(
            accessStore.removeMember({
                workspaceId,
                userId: ownerUserId,
            })
        ).rejects.toThrow(/last workspace owner/i);

        const members = await accessStore.listMembers({ workspaceId });
        expect(members).toEqual([
            expect.objectContaining({
                userId: ownerUserId,
                role: 'owner',
            }),
        ]);
    });

    it('transfers primary ownership when the current owner is demoted', async () => {
        const authStore = new SqliteAuthWorkspaceStore();
        const accessStore = createSqliteWorkspaceAccessStore();
        const { userId: ownerUserId } = await authStore.getOrCreateUser({
            provider: 'basic-auth',
            providerUserId: 'original-owner',
            email: 'original-owner@example.com',
        });
        const { workspaceId } = await authStore.createWorkspace({
            userId: ownerUserId,
            name: 'Transfer Workspace',
        });
        await accessStore.upsertMember({
            workspaceId,
            emailOrProviderId: 'replacement-owner@example.com',
            role: 'owner',
        });
        const replacement = (
            await accessStore.listMembers({ workspaceId })
        ).find((member) => member.email === 'replacement-owner@example.com');
        expect(replacement).toBeDefined();

        await accessStore.setMemberRole({
            workspaceId,
            userId: ownerUserId,
            role: 'editor',
        });

        const workspace = await accessStore.getWorkspace({ workspaceId });
        expect(workspace?.ownerUserId).toBe(replacement?.userId);
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
        await adminStore.grantAdmin({ userId });
        expect(await adminStore.isAdmin({ userId })).toBe(true);

        const admins = await adminStore.listAdmins();
        expect(admins.some((admin) => admin.userId === userId)).toBe(true);

        await adminStore.revokeAdmin({ userId });
        await adminStore.revokeAdmin({ userId });
        expect(await adminStore.isAdmin({ userId })).toBe(false);
    });
});
