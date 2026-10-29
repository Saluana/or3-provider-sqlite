import { sql, type Kysely } from 'kysely';

/** Cover pending-history shutdown counts without reading stored response blobs. */
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql`CREATE INDEX background_jobs_history_status
        ON background_jobs(history_phase, status)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await sql`DROP INDEX IF EXISTS background_jobs_history_status`.execute(db);
}
