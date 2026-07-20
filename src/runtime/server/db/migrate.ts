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

const migrations: Record<string, Migration> = {
    '001_init': m001,
    '002_sync_tables': m002,
    '003_sync_hardening': m003,
    '004_auth_invites': m004,
    '005_admin_stores': m005,
    '006_sync_snapshots': m006,
    '007_device_cursor_ownership': m007,
    '008_upload_intents': m008,
};

class StaticMigrationProvider implements MigrationProvider {
    async getMigrations(): Promise<Record<string, Migration>> {
        return migrations;
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
}
