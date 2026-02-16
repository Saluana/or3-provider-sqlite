import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
    await db.schema
        .createTable('auth_invites')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('workspace_id', 'text', (col) => col.notNull())
        .addColumn('email', 'text', (col) => col.notNull())
        .addColumn('role', 'text', (col) => col.notNull())
        .addColumn('status', 'text', (col) => col.notNull().defaultTo('pending'))
        .addColumn('invited_by_user_id', 'text', (col) => col.notNull())
        .addColumn('token_hash', 'text', (col) => col.notNull())
        .addColumn('expires_at', 'integer', (col) => col.notNull())
        .addColumn('accepted_at', 'integer')
        .addColumn('accepted_user_id', 'text')
        .addColumn('revoked_at', 'integer')
        .addColumn('created_at', 'integer', (col) =>
            col.notNull().defaultTo(sql`(unixepoch())`)
        )
        .addColumn('updated_at', 'integer', (col) =>
            col.notNull().defaultTo(sql`(unixepoch())`)
        )
        .execute();

    await db.schema
        .createIndex('idx_auth_invites_ws_status_exp')
        .ifNotExists()
        .on('auth_invites')
        .columns(['workspace_id', 'status', 'expires_at'])
        .execute();

    await db.schema
        .createIndex('idx_auth_invites_ws_email_status')
        .ifNotExists()
        .on('auth_invites')
        .columns(['workspace_id', 'email', 'status'])
        .execute();

    await db.schema
        .createIndex('idx_auth_invites_ws_token')
        .ifNotExists()
        .on('auth_invites')
        .columns(['workspace_id', 'token_hash'])
        .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('auth_invites').ifExists().execute();
}
