/** Startup wiring must make account storage usable without enabling transfer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteAuthWorkspaceStore } from '../server/auth/sqlite-auth-workspace-store';
import type * as ChatRuntime from '../../shims/or3-chat-test-runtime';
import register from '../server/plugins/register';
import * as sqliteDb from '../server/db/kysely';
import { createD1TestDatabase } from '../../../test/support/d1-test-database';

const registrations = vi.hoisted(() => ({
    workspaces: new Map<string, { create: () => SqliteAuthWorkspaceStore }>(),
    sync: new Set<string>(),
    connect: new Set<string>(),
    jobs: new Set<string>(),
}));

// Canonical-history tests use the actual pinned registry through this exact
// alias. Startup wiring still records the factory without replacing any store.
vi.mock('~~/server/sync/gateway/registry', () => ({
    registerSyncGatewayAdapter: (entry: { id: string }) => registrations.sync.add(entry.id),
}));

// The standalone suite supplies Chat registries through one existing shim.
// Capture the actual factories registered by the plugin, not substitute stores.
vi.mock('../../shims/or3-chat-test-runtime', async (importOriginal) => ({
    ...await importOriginal<typeof ChatRuntime>(),
    registerAuthWorkspaceStore: (entry: {
        id: string;
        create: () => SqliteAuthWorkspaceStore;
    }) => registrations.workspaces.set(entry.id, entry),
    registerSyncGatewayAdapter: (entry: { id: string }) =>
        registrations.sync.add(entry.id),
    registerConnectStore: (entry: { id: string }) =>
        registrations.connect.add(entry.id),
    registerBackgroundJobProvider: (id: string) => registrations.jobs.add(id),
    registerRateLimitProvider: () => {},
    registerProviderAdminAdapter: () => {},
    registerAdminStoreProvider: () => {},
    registerWebhookStore: () => {},
    registerPluginConnectionStore: () => {},
}));

function config() {
    return {
        auth: { enabled: true, provider: 'basic-auth' },
        sync: { enabled: false, provider: 'sqlite' },
        connect: { enabled: false, provider: 'sqlite' },
        backgroundJobs: { enabled: false, storageProvider: 'sqlite' },
        public: { sync: { provider: 'sqlite' }, storage: { provider: 'fs' } },
    };
}

async function start() {
    const requests: Array<() => Promise<void>> = [];
    await register({
        hooks: {
            hook: (name: string, handler: () => Promise<void>) => {
                if (name === 'request') requests.push(handler);
            },
        },
    } as unknown as Parameters<typeof register>[0]);
    return requests;
}

async function provision(provider: string) {
    const entry = registrations.workspaces.get('sqlite');
    expect(entry, 'startup must register SQLite account workspace storage').toBeDefined();
    const store = entry!.create();
    const identity = { provider, providerUserId: `${provider}-startup-user` };
    const { userId } = await store.getOrCreateUser(identity);
    const { workspaceId } = await store.getOrCreateDefaultWorkspace(userId);
    expect(await store.getUser(identity)).toMatchObject({ userId });
    expect(await store.listUserWorkspaces(userId)).toEqual([
        expect.objectContaining({ id: workspaceId, isActive: true }),
    ]);
}

describe('SQLite Nitro startup registration', () => {
    let runtime: ReturnType<typeof config>;

    beforeEach(() => {
        sqliteDb._resetForTest();
        for (const registry of Object.values(registrations)) registry.clear();
        runtime = config();
        vi.stubGlobal('useRuntimeConfig', () => runtime);
        vi.stubEnv('OR3_SQLITE_DRIVER', 'better-sqlite3');
        vi.stubEnv('OR3_SQLITE_DB_PATH', ':memory:');
        vi.stubEnv('OR3_SQLITE_STRICT', 'false');
    });

    afterEach(async () => {
        await sqliteDb.destroySqliteDb();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it.each(['basic-auth', 'clerk'])(
        'provisions %s accounts with conversation transfer disabled',
        async (provider) => {
            runtime.auth.provider = provider;
            await start();
            await provision(provider);
            expect(registrations.sync.size).toBe(0);
            expect(registrations.connect.size).toBe(0);
            expect(runtime.sync.enabled).toBe(false);
        }
    );

    it('retains the SQLite sync gateway when transfer is enabled', async () => {
        runtime.sync.enabled = true;
        await start();
        expect(registrations.sync.has('sqlite')).toBe(true);
        expect(registrations.workspaces.has('sqlite')).toBe(true);
        expect(() => sqliteDb.getSqliteDb()).not.toThrow();
    });

    it.each(['connect', 'backgroundJobs'] as const)(
        'retains SQLite %s activation with another workspace provider',
        async (role) => {
            runtime.sync.provider = 'convex';
            runtime[role].enabled = true;
            await start();
            expect(registrations.workspaces.has('sqlite')).toBe(true);
            expect(role === 'connect'
                ? registrations.connect.has('sqlite')
                : registrations.jobs.has('sqlite')).toBe(true);
            expect(registrations.sync.size).toBe(0);
            expect(() => sqliteDb.getSqliteDb()).not.toThrow();
        }
    );

    it('leaves all SQLite roles inactive when accounts are disabled', async () => {
        runtime.auth.enabled = false;
        runtime.sync.enabled = true;
        runtime.connect.enabled = true;
        runtime.backgroundJobs.enabled = true;
        await start();
        for (const registry of Object.values(registrations)) expect(registry.size).toBe(0);
        expect(() => sqliteDb.getSqliteDb()).toThrow('SQLite DB not initialized');
    });

    it('does not initialize an entirely unselected SQLite provider', async () => {
        runtime.sync.provider = 'convex';
        await start();
        for (const registry of Object.values(registrations)) expect(registry.size).toBe(0);
        expect(() => sqliteDb.getSqliteDb()).toThrow('SQLite DB not initialized');
    });

    it('registers D1 workspace storage before initializing in request context', async () => {
        vi.stubEnv('OR3_SQLITE_DRIVER', 'd1');
        const d1 = createD1TestDatabase();
        const initialize = sqliteDb.initializeSqliteDb;
        const initialization = vi.spyOn(sqliteDb, 'initializeSqliteDb')
            .mockImplementation(() => initialize({ driver: 'd1', d1Database: d1.database }));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const requests = await start();
            expect(registrations.workspaces.has('sqlite')).toBe(true);
            expect(registrations.sync.size).toBe(0);
            expect(initialization).not.toHaveBeenCalled();
            expect(() => sqliteDb.getSqliteDb()).toThrow('SQLite DB not initialized');
            expect(requests).toHaveLength(1);
            await requests[0]!();
            await provision('clerk');
            await requests[0]!();
            expect(initialization).toHaveBeenCalledTimes(1);
        } finally {
            await sqliteDb.destroySqliteDb();
            d1.close();
        }
    });

    it('continues to reject synchronous Connect persistence with D1', async () => {
        vi.stubEnv('OR3_SQLITE_DRIVER', 'd1');
        runtime.connect.enabled = true;
        await expect(start()).rejects.toThrow('still requires a synchronous SQLite runtime');
        expect(registrations.workspaces.size).toBe(0);
        expect(() => sqliteDb.getSqliteDb()).toThrow('SQLite DB not initialized');
    });
});
