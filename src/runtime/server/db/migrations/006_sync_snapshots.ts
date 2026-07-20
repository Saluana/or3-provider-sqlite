/**
 * Migration 006: Durable, consistent sync snapshot pages.
 *
 * - Stores the winning operation ID on materialized rows and tombstones.
 * - Adds immutable snapshot headers/items for pagination across requests.
 * - Backfills deterministic operation IDs for existing materialized state.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

const SYNCED_TABLES = [
    ['s_threads', 'threads'],
    ['s_messages', 'messages'],
    ['s_projects', 'projects'],
    ['s_posts', 'posts'],
    ['s_kv', 'kv'],
    ['s_file_meta', 'file_meta'],
    ['s_notifications', 'notifications'],
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
    for (const [materializedTable, tableName] of SYNCED_TABLES) {
        await sql.raw(
            `ALTER TABLE "${materializedTable}" ADD COLUMN op_id TEXT NOT NULL DEFAULT ''`
        ).execute(db);

        await sql.raw(`
            UPDATE "${materializedTable}" AS materialized
            SET op_id = COALESCE(
                (
                    SELECT change.op_id
                    FROM change_log AS change
                    WHERE change.workspace_id = materialized.workspace_id
                      AND change.table_name = '${tableName}'
                      AND change.pk = materialized.id
                      AND change.op = CASE WHEN materialized.deleted <> 0 THEN 'delete' ELSE 'put' END
                      AND change.clock = materialized.clock
                      AND change.hlc = materialized.hlc
                    ORDER BY change.server_version DESC
                    LIMIT 1
                ),
                'legacy:${tableName}:' || materialized.id || ':' || materialized.clock || ':' || materialized.hlc
            )
            WHERE materialized.op_id = ''
        `).execute(db);
    }

    await sql.raw(
        `ALTER TABLE tombstones ADD COLUMN hlc TEXT NOT NULL DEFAULT ''`
    ).execute(db);
    await sql.raw(
        `ALTER TABLE tombstones ADD COLUMN op_id TEXT NOT NULL DEFAULT ''`
    ).execute(db);

    await sql.raw(`
        UPDATE tombstones AS tombstone
        SET
            hlc = COALESCE(
                (
                    SELECT change.hlc
                    FROM change_log AS change
                    WHERE change.workspace_id = tombstone.workspace_id
                      AND change.table_name = tombstone.table_name
                      AND change.pk = tombstone.pk
                      AND change.op = 'delete'
                      AND change.server_version = tombstone.server_version
                    LIMIT 1
                ),
                CASE WHEN tombstone.hlc <> '' THEN tombstone.hlc ELSE 'legacy:0' END
            ),
            op_id = COALESCE(
                (
                    SELECT change.op_id
                    FROM change_log AS change
                    WHERE change.workspace_id = tombstone.workspace_id
                      AND change.table_name = tombstone.table_name
                      AND change.pk = tombstone.pk
                      AND change.op = 'delete'
                      AND change.server_version = tombstone.server_version
                    LIMIT 1
                ),
                'legacy:tombstone:' || tombstone.table_name || ':' || tombstone.pk || ':' || tombstone.clock
            )
        WHERE tombstone.hlc = '' OR tombstone.op_id = ''
    `).execute(db);

    await sql.raw(`
        CREATE TABLE sync_snapshots (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            high_watermark INTEGER NOT NULL,
            tables_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        )
    `).execute(db);
    await sql.raw(`
        CREATE INDEX idx_sync_snapshots_expires
        ON sync_snapshots(expires_at)
    `).execute(db);

    await sql.raw(`
        CREATE TABLE sync_snapshot_items (
            snapshot_id TEXT NOT NULL,
            table_name TEXT NOT NULL,
            pk TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('row', 'tombstone')),
            payload_json TEXT,
            clock INTEGER NOT NULL,
            hlc TEXT NOT NULL,
            op_id TEXT NOT NULL,
            server_deleted_at INTEGER,
            PRIMARY KEY (snapshot_id, table_name, pk, kind),
            FOREIGN KEY (snapshot_id) REFERENCES sync_snapshots(id) ON DELETE CASCADE
        ) WITHOUT ROWID
    `).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('sync_snapshot_items').ifExists().execute();
    await db.schema.dropTable('sync_snapshots').ifExists().execute();
    // SQLite cannot drop the additive revision columns without rebuilding all
    // materialized tables. They are safe to retain during a forward repair.
}
