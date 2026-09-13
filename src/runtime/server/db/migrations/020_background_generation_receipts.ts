import { sql, type Kysely } from 'kysely';

/** Durable replay receipts for canonical background-history transactions. */
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql`
        CREATE TABLE background_generation_receipts (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            stage TEXT NOT NULL CHECK(stage IN ('admission', 'finalization')),
            fingerprint TEXT NOT NULL,
            outcome TEXT NOT NULL,
            server_version INTEGER,
            created_at INTEGER NOT NULL,
            UNIQUE(workspace_id, generation_id, stage)
        )
    `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await sql`DROP TABLE IF EXISTS background_generation_receipts`.execute(db);
}
