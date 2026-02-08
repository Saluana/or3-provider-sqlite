/**
 * Migration 002: Sync infrastructure + synced entity tables.
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

export async function up(db: Kysely<unknown>): Promise<void> {
    // Server version counter (one row per workspace)
    await db.schema
        .createTable('server_version_counter')
        .ifNotExists()
        .addColumn('workspace_id', 'text', (col) => col.primaryKey())
        .addColumn('value', 'integer', (col) => col.notNull().defaultTo(0))
        .execute();

    // Change log
    await db.schema
        .createTable('change_log')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('workspace_id', 'text', (col) => col.notNull())
        .addColumn('server_version', 'integer', (col) => col.notNull())
        .addColumn('table_name', 'text', (col) => col.notNull())
        .addColumn('pk', 'text', (col) => col.notNull())
        .addColumn('op', 'text', (col) => col.notNull())
        .addColumn('payload_json', 'text')
        .addColumn('clock', 'integer', (col) => col.notNull())
        .addColumn('hlc', 'text', (col) => col.notNull())
        .addColumn('device_id', 'text', (col) => col.notNull())
        .addColumn('op_id', 'text', (col) => col.notNull())
        .addColumn('created_at', 'integer', (col) =>
            col.notNull().defaultTo(sql`(unixepoch())`)
        )
        .execute();

    await db.schema
        .createIndex('idx_change_log_ws_sv')
        .ifNotExists()
        .on('change_log')
        .columns(['workspace_id', 'server_version'])
        .execute();

    await db.schema
        .createIndex('idx_change_log_op_id')
        .ifNotExists()
        .on('change_log')
        .columns(['op_id'])
        .unique()
        .execute();

    // Device cursors
    await db.schema
        .createTable('device_cursors')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('workspace_id', 'text', (col) => col.notNull())
        .addColumn('device_id', 'text', (col) => col.notNull())
        .addColumn('last_seen_version', 'integer', (col) => col.notNull().defaultTo(0))
        .addColumn('updated_at', 'integer', (col) =>
            col.notNull().defaultTo(sql`(unixepoch())`)
        )
        .execute();

    await db.schema
        .createIndex('idx_device_cursors_ws_device')
        .ifNotExists()
        .on('device_cursors')
        .columns(['workspace_id', 'device_id'])
        .unique()
        .execute();

    await db.schema
        .createIndex('idx_device_cursors_ws_version')
        .ifNotExists()
        .on('device_cursors')
        .columns(['workspace_id', 'last_seen_version'])
        .execute();

    // Tombstones
    await db.schema
        .createTable('tombstones')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('workspace_id', 'text', (col) => col.notNull())
        .addColumn('table_name', 'text', (col) => col.notNull())
        .addColumn('pk', 'text', (col) => col.notNull())
        .addColumn('deleted_at', 'integer', (col) => col.notNull())
        .addColumn('clock', 'integer', (col) => col.notNull())
        .addColumn('server_version', 'integer', (col) => col.notNull())
        .addColumn('created_at', 'integer', (col) =>
            col.notNull().defaultTo(sql`(unixepoch())`)
        )
        .execute();

    await db.schema
        .createIndex('idx_tombstones_ws_sv')
        .ifNotExists()
        .on('tombstones')
        .columns(['workspace_id', 'server_version'])
        .execute();

    await db.schema
        .createIndex('idx_tombstones_ws_table_pk')
        .ifNotExists()
        .on('tombstones')
        .columns(['workspace_id', 'table_name', 'pk'])
        .unique()
        .execute();

    // Synced entity tables (materialized views of latest state)
    for (const tableName of SYNCED_TABLES) {
        await db.schema
            .createTable(tableName)
            .ifNotExists()
            .addColumn('id', 'text', (col) => col.notNull())
            .addColumn('workspace_id', 'text', (col) => col.notNull())
            .addColumn('data_json', 'text', (col) => col.notNull())
            .addColumn('clock', 'integer', (col) => col.notNull().defaultTo(0))
            .addColumn('hlc', 'text', (col) => col.notNull().defaultTo(''))
            .addColumn('device_id', 'text', (col) => col.notNull().defaultTo(''))
            .addColumn('deleted', 'integer', (col) => col.notNull().defaultTo(0))
            .addColumn('created_at', 'integer', (col) =>
                col.notNull().defaultTo(sql`(unixepoch())`)
            )
            .addColumn('updated_at', 'integer', (col) =>
                col.notNull().defaultTo(sql`(unixepoch())`)
            )
            .addPrimaryKeyConstraint(`${tableName}_pk`, ['workspace_id', 'id'])
            .execute();

        await db.schema
            .createIndex(`idx_${tableName}_ws`)
            .ifNotExists()
            .on(tableName)
            .columns(['workspace_id'])
            .execute();
    }
}

export async function down(db: Kysely<unknown>): Promise<void> {
    for (const tableName of [...SYNCED_TABLES].reverse()) {
        await db.schema.dropTable(tableName).ifExists().execute();
    }
    await db.schema.dropTable('tombstones').ifExists().execute();
    await db.schema.dropTable('device_cursors').ifExists().execute();
    await db.schema.dropTable('change_log').ifExists().execute();
    await db.schema.dropTable('server_version_counter').ifExists().execute();
}
