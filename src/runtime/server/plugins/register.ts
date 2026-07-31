/**
 * Nitro plugin: registers SQLite AuthWorkspaceStore + SyncGatewayAdapter.
 *
 * Runs migrations on first load, then registers both adapters.
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
import { getSqliteDb } from '../db/kysely';
import { runMigrations } from '../db/migrate';
import { sqliteRateLimitProvider } from '../rate-limit/sqlite-provider';
import { useRuntimeConfig } from '#imports';

const SQLITE_PROVIDER_ID = 'sqlite';
type RuntimeConfigWithSync = {
    auth?: { enabled?: boolean };
    sync?: { enabled?: boolean; provider?: string };
    connect?: { enabled?: boolean; provider?: string };
};

export default defineNitroPlugin(async () => {
    const config = useRuntimeConfig() as RuntimeConfigWithSync;
    if (!config.auth?.enabled) return;
    const syncSelected =
        config.sync?.enabled === true &&
        config.sync?.provider === SQLITE_PROVIDER_ID;
    const connectSelected =
        config.connect?.enabled === true &&
        config.connect?.provider === SQLITE_PROVIDER_ID;
    if (!syncSelected && !connectSelected) return;

    // Initialize the DB before publishing provider factories.
    const db = getSqliteDb();

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

    registerWebhookStore({
        id: SQLITE_PROVIDER_ID,
        order: 100,
        create: createSqliteWebhookStore,
    });

    registerAdminStoreProvider({
        id: SQLITE_PROVIDER_ID,
        createWorkspaceAccessStore: createSqliteWorkspaceAccessStore,
        createWorkspaceSettingsStore: createSqliteWorkspaceSettingsStore,
        createAdminUserStore: createSqliteAdminUserStore,
        getCapabilities: () => ({
            supportsServerSideAdmin: true,
            supportsUserSearch: true,
            supportsWorkspaceList: true,
            supportsWorkspaceManagement: true,
            supportsDeploymentAdminGrants: true,
        }),
    });

    registerProviderAdminAdapter(sqliteSyncAdminAdapter);

    // Nitro 2 invokes plugins synchronously, so registration must happen before
    // the first await for strict provider validation to observe this provider.
    await runMigrations(db);
});
