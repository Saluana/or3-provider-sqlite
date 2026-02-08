/**
 * Migration 001: Auth and workspace tables.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
    await db.schema
        .createTable('users')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('email', 'text')
        .addColumn('display_name', 'text')
        .addColumn('active_workspace_id', 'text')
        .addColumn('created_at', 'integer', (col) =>
            col.notNull().defaultTo(sql`(unixepoch())`)
        )
        .execute();

    await db.schema
        .createTable('auth_accounts')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('user_id', 'text', (col) => col.notNull())
        .addColumn('provider', 'text', (col) => col.notNull())
        .addColumn('provider_user_id', 'text', (col) => col.notNull())
        .addColumn('created_at', 'integer', (col) =>
            col.notNull().defaultTo(sql`(unixepoch())`)
        )
        .execute();

    await db.schema
        .createIndex('idx_auth_accounts_provider_uid')
        .ifNotExists()
        .on('auth_accounts')
        .columns(['provider', 'provider_user_id'])
        .unique()
        .execute();

    await db.schema
        .createTable('workspaces')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('description', 'text')
        .addColumn('owner_user_id', 'text', (col) => col.notNull())
        .addColumn('created_at', 'integer', (col) =>
            col.notNull().defaultTo(sql`(unixepoch())`)
        )
        .addColumn('deleted', 'integer', (col) => col.notNull().defaultTo(0))
        .addColumn('deleted_at', 'integer')
        .execute();

    await db.schema
        .createTable('workspace_members')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('workspace_id', 'text', (col) => col.notNull())
        .addColumn('user_id', 'text', (col) => col.notNull())
        .addColumn('role', 'text', (col) => col.notNull().defaultTo('editor'))
        .addColumn('created_at', 'integer', (col) =>
            col.notNull().defaultTo(sql`(unixepoch())`)
        )
        .execute();

    await db.schema
        .createIndex('idx_workspace_members_ws_user')
        .ifNotExists()
        .on('workspace_members')
        .columns(['workspace_id', 'user_id'])
        .unique()
        .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('workspace_members').ifExists().execute();
    await db.schema.dropTable('workspaces').ifExists().execute();
    await db.schema.dropTable('auth_accounts').ifExists().execute();
    await db.schema.dropTable('users').ifExists().execute();
}
