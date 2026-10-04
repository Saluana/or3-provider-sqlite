import { sql, type Kysely } from 'kysely';

/** Optional last measured request; existing jobs remain unmeasured. */
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql`ALTER TABLE background_jobs ADD COLUMN usage_json TEXT`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await sql`ALTER TABLE background_jobs DROP COLUMN usage_json`.execute(db);
}
