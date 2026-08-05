/**
 * Migration runner for the SQLite provider.
 * Runs all migrations in order on module init.
 */
import { type Kysely, type Migration, type MigrationProvider, Migrator } from 'kysely';
import type { Or3SqliteDb } from './schema';
import * as m001 from './migrations/001_init';
import * as m002 from './migrations/002_sync_tables';
import * as m003 from './migrations/003_sync_hardening';
import * as m004 from './migrations/004_auth_invites';
import * as m005 from './migrations/005_admin_stores';
import * as m006 from './migrations/006_sync_snapshots';
import * as m007 from './migrations/007_device_cursor_ownership';
import * as m008 from './migrations/008_upload_intents';
import * as m009 from './migrations/009_or3_connect';
import * as m010 from './migrations/010_connect_user_code_hmac';
import * as m011 from './migrations/011_connect_environment_scope_indexes';
import * as m012 from './migrations/012_connect_credential_redelivery';
import * as m013 from './migrations/013_connect_environment_lifecycle';
import * as m014 from './migrations/014_connect_retention_activation';
import * as m015 from './migrations/015_rate_limits';
import * as m016 from './migrations/016_connect_runtime_binding';

const REQUIRED_SCHEMA_TABLES = [
    'users',
    'auth_accounts',
    'workspaces',
    'workspace_members',
    'server_version_counter',
    'change_log',
    'device_cursors',
    'tombstones',
    's_threads',
    's_messages',
    's_projects',
    's_posts',
    's_kv',
    's_file_meta',
    's_notifications',
    'auth_invites',
    'admin_users',
    'admin_workspace_settings',
    'sync_snapshots',
    'sync_snapshot_items',
    'upload_intents',
    'connect_device_authorizations',
    'connect_environments',
    'rate_limits',
] as const;

const migrations: Record<string, Migration> = {
    '001_init': m001,
    '002_sync_tables': m002,
    '003_sync_hardening': m003,
    '004_auth_invites': m004,
    '005_admin_stores': m005,
    '006_sync_snapshots': m006,
    '007_device_cursor_ownership': m007,
    '008_upload_intents': m008,
    '009_or3_connect': m009,
    '010_connect_user_code_hmac': m010,
    '011_connect_environment_scope_indexes': m011,
    '012_connect_credential_redelivery': m012,
    '013_connect_environment_lifecycle': m013,
    '014_connect_retention_activation': m014,
    '015_rate_limits': m015,
    '016_connect_runtime_binding': m016,
};

class StaticMigrationProvider implements MigrationProvider {
    async getMigrations(): Promise<Record<string, Migration>> {
        return migrations;
    }
}

async function assertLatestSchemaIntegrity(
    db: Kysely<Or3SqliteDb>
): Promise<void> {
    const tables = await db.introspection.getTables({
        withInternalKyselyTables: true,
    });
    const tableNames = new Set(tables.map((table) => table.name));
    const missing = REQUIRED_SCHEMA_TABLES.filter(
        (tableName) => !tableNames.has(tableName)
    );
    if (missing.length > 0) {
        throw new Error(
            `SQLite schema integrity check failed; required tables are missing: ${missing.join(', ')}`
        );
    }
}

/**
 * Run all pending migrations. Safe to call repeatedly.
 */
export async function runMigrations(db: Kysely<Or3SqliteDb>): Promise<void> {
    const migrator = new Migrator({
        db,
        provider: new StaticMigrationProvider(),
    });

    const { error, results } = await migrator.migrateToLatest();

    if (results?.length) {
        for (const r of results) {
            if (r.status === 'Success') {
                console.log(`[or3-sqlite] migration "${r.migrationName}" applied`);
            } else if (r.status === 'Error') {
                console.error(`[or3-sqlite] migration "${r.migrationName}" failed`);
            }
        }
    }

    if (error) {
        console.error('[or3-sqlite] migration error:', error);
        throw error;
    }

    await assertLatestSchemaIntegrity(db);
}
