import { sql, type Kysely } from 'kysely';
import { ensureMigrationTextColumn } from '../migration-schema';

/** Optional last measured request; existing jobs remain unmeasured. */
export async function up(db: Kysely<unknown>): Promise<void> {
    await ensureMigrationTextColumn(db, 'background_jobs', 'usage_json');
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await sql`ALTER TABLE background_jobs DROP COLUMN usage_json`.execute(db);
}
