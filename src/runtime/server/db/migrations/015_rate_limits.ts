import { sql, type Kysely } from 'kysely';

/** Durable deployment-wide fixed-window request budgets. */
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql`
        CREATE TABLE IF NOT EXISTS rate_limits (
            key TEXT PRIMARY KEY,
            count INTEGER NOT NULL,
            window_started_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        )
    `.execute(db);
    await sql`
        CREATE INDEX IF NOT EXISTS rate_limits_expiry
        ON rate_limits(expires_at)
    `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await sql`DROP TABLE IF EXISTS rate_limits`.execute(db);
}
