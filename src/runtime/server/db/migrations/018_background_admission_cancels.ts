import { sql, type Kysely } from 'kysely';

/**
 * Durable admission cancellations. Creation and cancellation both check this
 * table so a Stop that arrives before the job row commits cannot launch work.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql`
        CREATE TABLE IF NOT EXISTS background_admission_cancels (
            user_id TEXT NOT NULL,
            admission_id TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, admission_id)
        )
    `.execute(db);
    await sql`
        CREATE INDEX IF NOT EXISTS background_admission_cancels_expiry
        ON background_admission_cancels(expires_at)
    `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await sql`DROP TABLE IF EXISTS background_admission_cancels`.execute(db);
}
