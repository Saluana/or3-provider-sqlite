import { type Kysely, sql } from 'kysely';
import { ensureMigrationSchema, ensureMigrationTextColumn } from '../migration-schema';
export async function up(db: Kysely<unknown>): Promise<void> {
    await ensureMigrationTextColumn(db, 'sync_snapshot_items', 'source_payload_json');
    // No source FK: unresolved evidence outlives history GC and snapshot expiry.
    await ensureMigrationSchema(db, `CREATE TABLE sync_unavailable_records (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL,
        source TEXT NOT NULL,
        locator TEXT NOT NULL,
        revision TEXT NOT NULL,
        payload_json TEXT,
        metadata_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_op_id TEXT,
        UNIQUE (workspace_id, source, locator, revision)
    )`);
    await ensureMigrationSchema(db, 'CREATE INDEX idx_sync_unavailable_workspace ON sync_unavailable_records (workspace_id, created_at, id)');
}
export async function down(db: Kysely<unknown>): Promise<void> {
    await sql`DROP TABLE sync_unavailable_records`.execute(db);
    await sql`ALTER TABLE sync_snapshot_items DROP COLUMN source_payload_json`.execute(db);
}
