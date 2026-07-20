import { sql, type Kysely } from 'kysely';

/** Persisted upload intents are both one-time authorizations and quota reservations. */
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql`
        CREATE TABLE upload_intents (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            hash TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            reserved_bytes INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'cancelled', 'expired')),
            storage_id TEXT,
            created_at INTEGER NOT NULL,
            consumed_at INTEGER,
            cancelled_at INTEGER
        )
    `.execute(db);
    await sql`CREATE INDEX upload_intents_workspace_status_expiry
        ON upload_intents(workspace_id, status, expires_at, id)`.execute(db);
    await sql`CREATE INDEX upload_intents_workspace_hash_status
        ON upload_intents(workspace_id, hash, status)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('upload_intents').ifExists().execute();
}
