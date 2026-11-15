/**
 * Migration 007: bind device cursors to the authenticated user that created
 * them. Legacy rows remain unbound until their next authenticated update.
 */
import type { Kysely } from 'kysely';
import { ensureMigrationTextColumn } from '../migration-schema';

export async function up(db: Kysely<unknown>): Promise<void> {
    await ensureMigrationTextColumn(db, 'device_cursors', 'owner_user_id');
}

export async function down(_db: Kysely<unknown>): Promise<void> {
    // SQLite cannot safely drop this column on all supported versions.
}
