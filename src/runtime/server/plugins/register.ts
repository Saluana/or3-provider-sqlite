/**
 * Nitro plugin: registers SQLite AuthWorkspaceStore + SyncGatewayAdapter.
 *
 * Runs migrations at startup for local runtimes and on the first Worker
 * request for D1, then registers the relevant adapters.
 * Skips registration when auth/sync are disabled or active sync provider is not sqlite.
 */
import { defineNitroPlugin } from 'nitropack/runtime/plugin';
import { registerAuthWorkspaceStore } from '~~/server/auth/store/registry';
import { registerProviderAdminAdapter } from '~~/server/admin/providers/registry';
import { registerAdminStoreProvider } from '~~/server/admin/stores/registry';
import { registerSyncGatewayAdapter } from '~~/server/sync/gateway/registry';
import { registerWebhookStore } from '~~/server/utils/webhooks/store/registry';
import { registerConnectStore } from '~~/server/connect/store/registry';
import { registerRateLimitProvider } from '~~/server/utils/rate-limit/registry';
import { createSqliteAuthWorkspaceStore } from '../auth/sqlite-auth-workspace-store';
import { createSqliteSyncGatewayAdapter } from '../sync/sqlite-sync-gateway-adapter';
import { createSqliteWebhookStore } from '../webhooks/sqlite-webhook-store';
import {
    createSqliteAdminUserStore,
    createSqliteWorkspaceAccessStore,
    createSqliteWorkspaceSettingsStore,
} from '../admin/stores/sqlite-store';
import { sqliteSyncAdminAdapter } from '../admin/adapters/sync-sqlite';
import { createSqliteConnectStore } from '../connect/sqlite-connect-store';
import { getSqliteDriver, initializeSqliteDb } from '../db/kysely';
import { runMigrations } from '../db/migrate';
import { sqliteRateLimitProvider } from '../rate-limit/sqlite-provider';
import { useRuntimeConfig } from '#imports';

const SQLITE_PROVIDER_ID = 'sqlite';
let d1RuntimeInitialization: Promise<void> | undefined;

type RuntimeConfigWithSync = {
    auth?: { enabled?: boolean };
    sync?: { enabled?: boolean; provider?: string };
    connect?: { enabled?: boolean; provider?: string };
};

export default defineNitroPlugin(async (nitroApp) => {
    const config = useRuntimeConfig() as RuntimeConfigWithSync;
    if (!config.auth?.enabled) return;
    const syncSelected =
        config.sync?.enabled === true &&
        config.sync?.provider === SQLITE_PROVIDER_ID;
    const connectSelected =
        config.connect?.enabled === true &&
        config.connect?.provider === SQLITE_PROVIDER_ID;
    if (!syncSelected && !connectSelected) return;

    const driver = getSqliteDriver();
    if (driver === 'd1' && connectSelected) {
        throw new Error(
            '[or3-sqlite] Cloudflare D1 supports Auth and Sync, but OR3 Connect ' +
                'still requires a synchronous SQLite runtime. Set OR3_CONNECT_ENABLED=false ' +
                'or choose better-sqlite3, Bun, or Turso.'
        );
    }

    registerAuthWorkspaceStore({
        id: SQLITE_PROVIDER_ID,
        order: 100,
        create: createSqliteAuthWorkspaceStore,
    });
    registerRateLimitProvider(SQLITE_PROVIDER_ID, sqliteRateLimitProvider);

    if (syncSelected) {
        registerSyncGatewayAdapter({
            id: SQLITE_PROVIDER_ID,
            order: 100,
            create: createSqliteSyncGatewayAdapter,
        });
    }

    if (connectSelected) {
        registerConnectStore({
            id: SQLITE_PROVIDER_ID,
            order: 100,
            create: createSqliteConnectStore,
        });
    }

    if (driver !== 'd1') {
        registerWebhookStore({
            id: SQLITE_PROVIDER_ID,
            order: 100,
            create: createSqliteWebhookStore,
        });
    } else {
        console.warn(
            '[or3-sqlite] Webhook persistence is unavailable with Cloudflare D1.'
        );
    }

    registerAdminStoreProvider({
        id: SQLITE_PROVIDER_ID,
        createWorkspaceAccessStore: createSqliteWorkspaceAccessStore,
        createWorkspaceSettingsStore: createSqliteWorkspaceSettingsStore,
        createAdminUserStore: createSqliteAdminUserStore,
        getCapabilities: () => ({
            supportsServerSideAdmin: driver !== 'd1',
            supportsUserSearch: driver !== 'd1',
            supportsWorkspaceList: driver !== 'd1',
            supportsWorkspaceManagement: driver !== 'd1',
            supportsDeploymentAdminGrants: driver !== 'd1',
        }),
    });

    registerProviderAdminAdapter(sqliteSyncAdminAdapter);

    // D1 bindings can be read from `cloudflare:workers` during module setup,
    // but their I/O must happen inside a Worker request context. Keep normal
    // runtimes eager and make D1 initialization/migrations first-request work.
    if (driver === 'd1') {
        nitroApp.hooks.hook('request', async () => {
            d1RuntimeInitialization ??= initializeSqliteDb().then(runMigrations);
            await d1RuntimeInitialization;
        });
        return;
    }

    // Nitro 2 invokes plugins synchronously, so registration happens before
    // initialization awaits for strict provider validation to observe it.
    const db = await initializeSqliteDb();
    await runMigrations(db);
});
