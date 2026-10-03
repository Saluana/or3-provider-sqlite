import { sql, type Kysely } from 'kysely';
import { up as installCanonicalHistory } from './022_canonical_chat_reader';

/** Match the reader's legacy missing-order-key normalization exactly. */
export async function up(db: Kysely<unknown>): Promise<void> {
    // Canonical rows deliberately have no workspace FK: retained orphan rows
    // can still be garbage-collected after workspace retirement. Revision
    // bookkeeping must preserve that existing sync lifecycle contract.
    for (const table of ['s_threads', 's_messages']) for (const event of ['insert', 'update', 'delete']) {
        await sql.raw(`DROP TRIGGER IF EXISTS ${table}_history_${event}`).execute(db);
    }
    await sql`CREATE TABLE chat_history_revisions_v2 (
        workspace_id TEXT NOT NULL, thread_id TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (workspace_id, thread_id))`.execute(db);
    await sql`INSERT INTO chat_history_revisions_v2 SELECT workspace_id, thread_id, value FROM chat_history_revisions`.execute(db);
    await sql`DROP TABLE chat_history_revisions`.execute(db);
    await sql`ALTER TABLE chat_history_revisions_v2 RENAME TO chat_history_revisions`.execute(db);
    await installCanonicalHistory(db);
    await sql`DROP INDEX IF EXISTS s_messages_history_order`.execute(db);
    await sql`CREATE INDEX s_messages_history_order ON s_messages
        (workspace_id, json_extract(data_json, '$.thread_id'), json_extract(data_json, '$.index'),
        COALESCE(json_extract(data_json, '$.order_key'), ''), id)`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
    await sql`DROP INDEX IF EXISTS s_messages_history_order`.execute(db);
    await sql`CREATE INDEX s_messages_history_order ON s_messages
        (workspace_id, json_extract(data_json, '$.thread_id'), json_extract(data_json, '$.index'),
        json_extract(data_json, '$.order_key'), id)`.execute(db);
}
