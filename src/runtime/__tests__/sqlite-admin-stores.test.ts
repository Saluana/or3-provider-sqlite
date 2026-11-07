import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initializeSqliteDb, getSqliteDb, destroySqliteDb, _resetForTest } from '../server/db/kysely';
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
        const db = await initializeSqliteDb({ path: ':memory:' });
        await runMigrations(db);
    });

    afterEach(async () => {
        await destroySqliteDb();
    });

    // Failure inventory: contact is not completion; failures retain last success;
    // summaries are user/workspace scoped, bounded, monotonic, and contain no payloads.
    it('retains independent completed sync and classified failure observations', async () => {
        const auth = new SqliteAuthWorkspaceStore();
        const { userId } = await auth.getOrCreateUser({ provider: 'basic-auth', providerUserId: 'observer' });
        const { workspaceId } = await auth.createWorkspace({ userId, name: 'Observed' });
        const store = createSqliteWorkspaceAccessStore();
        expect(await store.getCustomerSyncObservations!({ userId })).toEqual([]);
        await store.recordSyncObservation!({ userId, workspaceId, operation: 'pull', observedAt: 2000, outcome: 'success' });
        await store.recordSyncObservation!({ userId, workspaceId, operation: 'push', observedAt: 3000, outcome: 'failure', code: 'provider_failed' });
        await store.recordSyncObservation!({ userId, workspaceId, operation: 'pull', observedAt: 1000, outcome: 'success' });
        expect(await store.getCustomerSyncObservations!({ userId })).toEqual([{
            workspaceId, lastSuccessAt: 2000, lastSuccessOperation: 'pull', lastFailureAt: 3000, lastFailureCode: 'provider_failed',
        }]);
        expect(await store.getCustomerSyncObservations!({ userId: 'other' })).toEqual([]);
        await runMigrations(getSqliteDb());
        expect((await store.getCustomerSyncObservations!({ userId }))[0]?.lastSuccessAt).toBe(2000);
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

        await getSqliteDb().updateTable('workspaces')
            .set({ created_at: 1_700_000_000 }).where('id', '=', workspaceId).execute();
        const workspaces = await accessStore.listWorkspaces({
            page: 1,
            perPage: 20,
        });
        expect(workspaces.total).toBe(1);
        expect(workspaces.items[0]).toMatchObject({ id: workspaceId, createdAt: 1_700_000_000_000 });
        expect(await accessStore.getWorkspace({ workspaceId }))
            .toMatchObject({ createdAt: 1_700_000_000_000 });
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

    it('compares and sets workspace settings atomically', async () => {
        const authStore = new SqliteAuthWorkspaceStore();
        const settingsStore = createSqliteWorkspaceSettingsStore();
        const competingStore = createSqliteWorkspaceSettingsStore();
        const { userId } = await authStore.getOrCreateUser({
            provider: 'basic-auth',
            providerUserId: 'cas-owner',
        });
        const { workspaceId } = await authStore.createWorkspace({
            userId,
            name: 'CAS Workspace',
        });

        const competing = await Promise.all([
            settingsStore.compareAndSet!(workspaceId, 'race', null, 'left'),
            competingStore.compareAndSet!(workspaceId, 'race', null, 'right'),
        ]);
        expect(competing.filter(Boolean)).toHaveLength(1);
        expect(['left', 'right']).toContain(await settingsStore.get(workspaceId, 'race'));

        expect(await settingsStore.compareAndSet!(workspaceId, 'setup', null, 'one')).toBe(true);
        expect(await settingsStore.compareAndSet!(workspaceId, 'setup', null, 'stale')).toBe(false);
        expect(await settingsStore.compareAndSet!(workspaceId, 'setup', 'one', 'two')).toBe(true);
        expect(await settingsStore.compareAndSet!(workspaceId, 'setup', 'one', 'stale')).toBe(false);
        expect(await settingsStore.get(workspaceId, 'setup')).toBe('two');
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

        await getSqliteDb().updateTable('admin_users')
            .set({ created_at: 1_700_000_000 }).where('user_id', '=', userId).execute();
        const admins = await adminStore.listAdmins();
        expect(admins).toContainEqual(expect.objectContaining({
            userId, createdAt: 1_700_000_000_000,
        }));

        await adminStore.revokeAdmin({ userId });
        await adminStore.revokeAdmin({ userId });
        expect(await adminStore.isAdmin({ userId })).toBe(false);
    });

    it('reads customers without provisioning and pages stably', async () => {
        const authStore = new SqliteAuthWorkspaceStore();
        type Page = { items: Array<{ userId: string }>; nextCursor: string | null };
        const accessStore = createSqliteWorkspaceAccessStore() as ReturnType<typeof createSqliteWorkspaceAccessStore> & {
            listCustomers(input: { query?: string; cursor?: string | null; limit: number }): Promise<Page>;
            getCustomersByIds(input: { userIds: string[] }): Promise<Array<{ userId: string }>>;
            getCustomerWorkspaces(input: { userId: string }): Promise<Array<Record<string, unknown>>>;
        };
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            const { userId } = await authStore.getOrCreateUser({ provider: 'basic-auth', providerUserId: `c-${i}`, email: `customer_${i}@example.com` });
            ids.push(userId);
        }
        await getSqliteDb().updateTable('users').set({ created_at: 1_700_000_000 }).execute();
        const { workspaceId } = await authStore.createWorkspace({ userId: ids[0]!, name: 'Retained' });
        await accessStore.upsertMember({ workspaceId, emailOrProviderId: 'customer_1@example.com', role: 'editor' });
        await accessStore.softDeleteWorkspace({ workspaceId, deletedAt: 123 });
        const count = async () => ({
            users: (await getSqliteDb().selectFrom('users').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n,
            workspaces: (await getSqliteDb().selectFrom('workspaces').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n,
        });
        const before = await count();
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
            const page: Page = await accessStore.listCustomers({ limit: 2, cursor });
            seen.push(...page.items.map((item: { userId: string }) => item.userId));
            cursor = page.nextCursor;
        } while (cursor);
        expect(seen.sort()).toEqual([...ids].sort());
        expect((await accessStore.listCustomers({ query: 'customer_3', limit: 50 })).items.map((item) => item.userId)).toEqual([ids[3]]);
        // LIKE wildcards in the query are literal.
        expect((await accessStore.listCustomers({ query: '%', limit: 50 })).items).toEqual([]);
        expect((await accessStore.getCustomersByIds({ userIds: [ids[2]!, 'missing'] })).map((item) => item.userId)).toEqual([ids[2]]);
        const owned = await accessStore.getCustomerWorkspaces({ userId: ids[0]! });
        expect(owned).toEqual([expect.objectContaining({ id: workspaceId, role: 'owner', deleted: true, deletedAt: 123, memberCount: 2, lastContactAt: null })]);
        expect(await accessStore.getCustomerWorkspaces({ userId: ids[1]! })).toEqual([expect.objectContaining({ id: workspaceId, role: 'editor' })]);
        expect(await accessStore.getCustomerWorkspaces({ userId: 'missing' })).toEqual([]);
        await expect(accessStore.listCustomers({ limit: 2, cursor: 'not-a-cursor' })).rejects.toThrow();
        expect(await count()).toEqual(before);
    });
});
