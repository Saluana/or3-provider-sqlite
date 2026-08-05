import { sql, type Kysely } from 'kysely';

/** Compound indexes for account-and-workspace-bound Connect operations. */
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql`
        CREATE INDEX connect_environments_user_workspace_status_updated
        ON connect_environments(user_id, workspace_id, status, updated_at)
    `.execute(db);
    await sql`
        CREATE INDEX connect_environments_user_workspace_control_token
        ON connect_environments(user_id, workspace_id, control_token_hash)
    `.execute(db);
    await sql`
        CREATE INDEX connect_environments_user_workspace_id
        ON connect_environments(user_id, workspace_id, id)
    `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await sql`
        DROP INDEX IF EXISTS connect_environments_user_workspace_id
    `.execute(db);
    await sql`
        DROP INDEX IF EXISTS connect_environments_user_workspace_control_token
    `.execute(db);
    await sql`
        DROP INDEX IF EXISTS connect_environments_user_workspace_status_updated
    `.execute(db);
}
