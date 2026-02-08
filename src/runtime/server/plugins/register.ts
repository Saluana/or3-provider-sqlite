/**
 * Nitro plugin: registers SQLite AuthWorkspaceStore + SyncGatewayAdapter.
 *
 * Runs migrations on first load, then registers both adapters.
 * Skips registration when auth is disabled (local-only mode).
 */
import { registerAuthWorkspaceStore } from '~~/server/auth/store/registry';
import { registerSyncGatewayAdapter } from '~~/server/sync/gateway/registry';
import { createSqliteAuthWorkspaceStore } from '../auth/sqlite-auth-workspace-store';
import { createSqliteSyncGatewayAdapter } from '../sync/sqlite-sync-gateway-adapter';
import { getSqliteDb } from '../db/kysely';
import { runMigrations } from '../db/migrate';
import { useRuntimeConfig } from '#imports';

const SQLITE_PROVIDER_ID = 'sqlite';

export default defineNitroPlugin(async () => {
    const config = useRuntimeConfig();
    if (!config.auth?.enabled) return;

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
});
