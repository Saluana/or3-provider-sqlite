/**
 * Migration 005: Admin store support tables.
 */
import type { Kysely } from 'kysely';
import type { Or3SqliteDb } from '../schema';

export async function up(db: Kysely<Or3SqliteDb>): Promise<void> {
    await db.schema
        .createTable('admin_users')
        .ifNotExists()
        .addColumn('user_id', 'text', (col) => col.notNull().primaryKey())
        .addColumn('created_at', 'integer', (col) => col.notNull())
        .addColumn('created_by_user_id', 'text')
        .execute();

    await db.schema
        .createTable('admin_workspace_settings')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.notNull().primaryKey())
        .addColumn('workspace_id', 'text', (col) => col.notNull())
        .addColumn('key', 'text', (col) => col.notNull())
        .addColumn('value', 'text', (col) => col.notNull())
        .addColumn('updated_at', 'integer', (col) => col.notNull())
        .execute();

    await db.schema
        .createIndex('idx_admin_workspace_settings_workspace_key')
        .ifNotExists()
        .on('admin_workspace_settings')
        .columns(['workspace_id', 'key'])
        .unique()
        .execute();

    await db.schema
        .createIndex('idx_admin_workspace_settings_workspace')
        .ifNotExists()
        .on('admin_workspace_settings')
        .column('workspace_id')
        .execute();
}

export async function down(db: Kysely<Or3SqliteDb>): Promise<void> {
    await db.schema
        .dropIndex('idx_admin_workspace_settings_workspace')
        .ifExists()
        .execute();

    await db.schema
        .dropIndex('idx_admin_workspace_settings_workspace_key')
        .ifExists()
        .execute();

    await db.schema.dropTable('admin_workspace_settings').ifExists().execute();
    await db.schema.dropTable('admin_users').ifExists().execute();
}
