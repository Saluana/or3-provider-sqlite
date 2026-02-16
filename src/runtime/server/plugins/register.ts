/**
 * Nitro plugin: registers SQLite AuthWorkspaceStore + SyncGatewayAdapter.
 *
 * Runs migrations on first load, then registers both adapters.
 * Skips registration when auth/sync are disabled or active sync provider is not sqlite.
 */
import { registerAuthWorkspaceStore } from '~~/server/auth/store/registry';
import { registerProviderAdminAdapter } from '~~/server/admin/providers/registry';
import { registerAdminStoreProvider } from '~~/server/admin/stores/registry';
import { registerSyncGatewayAdapter } from '~~/server/sync/gateway/registry';
import { createSqliteAuthWorkspaceStore } from '../auth/sqlite-auth-workspace-store';
import { createSqliteSyncGatewayAdapter } from '../sync/sqlite-sync-gateway-adapter';
import {
    createSqliteAdminUserStore,
    createSqliteWorkspaceAccessStore,
    createSqliteWorkspaceSettingsStore,
} from '../admin/stores/sqlite-store';
import { sqliteSyncAdminAdapter } from '../admin/adapters/sync-sqlite';
import { getSqliteDb } from '../db/kysely';
import { runMigrations } from '../db/migrate';
import { useRuntimeConfig } from '#imports';

const SQLITE_PROVIDER_ID = 'sqlite';
type RuntimeConfigWithSync = {
    auth?: { enabled?: boolean };
    sync?: { enabled?: boolean; provider?: string };
};

export default defineNitroPlugin(async () => {
    const config = useRuntimeConfig() as RuntimeConfigWithSync;
    if (!config.auth?.enabled) return;
    if (!config.sync?.enabled) return;
    if (config.sync?.provider !== SQLITE_PROVIDER_ID) return;

    // Initialize DB and run migrations
    const db = getSqliteDb();
    await runMigrations(db);

    registerAuthWorkspaceStore({
        id: SQLITE_PROVIDER_ID,
        order: 100,
        create: createSqliteAuthWorkspaceStore,
    });

    registerSyncGatewayAdapter({
        id: SQLITE_PROVIDER_ID,
        order: 100,
        create: createSqliteSyncGatewayAdapter,
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
});
