/**
 * Migration runner for the SQLite provider.
 * Runs all migrations in order on module init.
 */
import { type Kysely, type Migration, type MigrationProvider, Migrator } from 'kysely';
import type { Or3SqliteDb } from './schema';
import * as m001 from './migrations/001_init';
import * as m002 from './migrations/002_sync_tables';
import * as m003 from './migrations/003_sync_hardening';

const migrations: Record<string, Migration> = {
    '001_init': m001,
    '002_sync_tables': m002,
    '003_sync_hardening': m003,
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
