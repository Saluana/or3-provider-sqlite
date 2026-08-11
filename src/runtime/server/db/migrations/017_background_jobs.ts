import { sql, type Kysely } from 'kysely';

/** Durable background chat and workflow execution state. */
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql`
        CREATE TABLE IF NOT EXISTS background_jobs (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            model TEXT NOT NULL,
            kind TEXT,
            status TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            chunks_received INTEGER NOT NULL DEFAULT 0,
            started_at INTEGER NOT NULL,
            last_activity_at INTEGER NOT NULL,
            completed_at INTEGER,
            error TEXT,
            tool_calls_json TEXT,
            workflow_state_json TEXT,
            execution_json TEXT,
            idempotency_key TEXT UNIQUE,
            lease_owner TEXT,
            lease_expires_at INTEGER,
            attempts INTEGER NOT NULL DEFAULT 0
        )
    `.execute(db);
    await sql`
        CREATE INDEX IF NOT EXISTS background_jobs_active
        ON background_jobs(status, last_activity_at)
    `.execute(db);
    await sql`
        CREATE INDEX IF NOT EXISTS background_jobs_user_active
        ON background_jobs(user_id, status)
    `.execute(db);
    await sql`
        CREATE INDEX IF NOT EXISTS background_jobs_claim
        ON background_jobs(status, lease_expires_at, started_at)
    `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await sql`DROP TABLE IF EXISTS background_jobs`.execute(db);
}
