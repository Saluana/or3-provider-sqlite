/**
 * Migration 003: Harden sync storage keys and tombstone uniqueness.
 *
 * - Materialized sync tables move to composite PK (workspace_id, id)
 * - Tombstones enforce one row per (workspace_id, table_name, pk)
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

const SYNCED_TABLES = [
    's_threads',
    's_messages',
    's_projects',
    's_posts',
    's_kv',
    's_file_meta',
    's_notifications',
] as const;

async function rebuildSyncedTable(
    db: Kysely<unknown>,
    tableName: (typeof SYNCED_TABLES)[number]
): Promise<void> {
    const nextTable = `${tableName}__new`;

    await sql.raw(`DROP TABLE IF EXISTS "${nextTable}"`).execute(db);

    await sql.raw(`
        CREATE TABLE "${nextTable}" (
            id TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            data_json TEXT NOT NULL,
            clock INTEGER NOT NULL DEFAULT 0,
            hlc TEXT NOT NULL DEFAULT '',
            device_id TEXT NOT NULL DEFAULT '',
            deleted INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
            PRIMARY KEY (workspace_id, id)
        )
    `).execute(db);

    await sql.raw(`
        INSERT INTO "${nextTable}" (
            id, workspace_id, data_json, clock, hlc, device_id, deleted, created_at, updated_at
        )
        SELECT id, workspace_id, data_json, clock, hlc, device_id, deleted, created_at, updated_at
        FROM "${tableName}"
    `).execute(db);

    await sql.raw(`DROP TABLE "${tableName}"`).execute(db);
    await sql.raw(`ALTER TABLE "${nextTable}" RENAME TO "${tableName}"`).execute(db);
    await sql.raw(
        `CREATE INDEX IF NOT EXISTS "idx_${tableName}_ws" ON "${tableName}" (workspace_id)`
    ).execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
    // Keep only the newest tombstone per logical key before unique indexing.
    await sql.raw(`
        DELETE FROM tombstones
        WHERE rowid IN (
            SELECT rowid
            FROM (
                SELECT
                    rowid,
                    ROW_NUMBER() OVER (
                        PARTITION BY workspace_id, table_name, pk
                        ORDER BY clock DESC, server_version DESC, created_at DESC, rowid DESC
                    ) AS rn
                FROM tombstones
            ) ranked
            WHERE rn > 1
        )
    `).execute(db);

    await sql.raw(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tombstones_ws_table_pk
        ON tombstones(workspace_id, table_name, pk)
    `).execute(db);

    for (const tableName of SYNCED_TABLES) {
        await rebuildSyncedTable(db, tableName);
    }
}

export async function down(_db: Kysely<unknown>): Promise<void> {
    // No-op: this migration is intentionally non-reversible.
}
