import { sql, type Kysely } from 'kysely';

/** Workspace-scoped canonical message keysets, independent of retained logs. */
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS chat_history_revisions (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (workspace_id, thread_id))`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS s_messages_history_order ON s_messages
        (workspace_id, json_extract(data_json, '$.thread_id'), json_extract(data_json, '$.index'), json_extract(data_json, '$.order_key'), id)`.execute(db);
    for (const table of ['s_threads', 's_messages']) for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
        const rowNames = event === 'UPDATE' ? ['OLD', 'NEW'] : [event === 'DELETE' ? 'OLD' : 'NEW'];
        const statements = rowNames.map((row) => {
            const thread = table === 's_threads' ? `${row}.id` : `json_extract(${row}.data_json, '$.thread_id')`;
            return `INSERT INTO chat_history_revisions (workspace_id, thread_id, value)
                SELECT ${row}.workspace_id, ${thread}, 1 WHERE ${thread} IS NOT NULL
                ON CONFLICT (workspace_id, thread_id) DO UPDATE SET value = chat_history_revisions.value + 1;`;
        }).join('\n');
        await sql.raw(`CREATE TRIGGER IF NOT EXISTS ${table}_history_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN ${statements} END`).execute(db);
    }
}
export async function down(db: Kysely<unknown>): Promise<void> {
    for (const table of ['s_threads', 's_messages']) for (const event of ['insert', 'update', 'delete']) {
        await sql.raw(`DROP TRIGGER IF EXISTS ${table}_history_${event}`).execute(db);
    }
    await sql`DROP INDEX IF EXISTS s_messages_history_order`.execute(db);
    await sql`DROP TABLE IF EXISTS chat_history_revisions`.execute(db);
}
