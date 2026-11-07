import { sql, type Kysely } from 'kysely';
import { ensureMigrationSchema } from '../migration-schema';

export async function up(db: Kysely<unknown>): Promise<void> {
    await ensureMigrationSchema(db, `CREATE TABLE sync_observations (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        last_success_at INTEGER, last_success_operation TEXT,
        last_failure_at INTEGER, last_failure_code TEXT,
        PRIMARY KEY (user_id, workspace_id)
    )`);
    // The customer directory keyset order otherwise sorts the complete users table.
    await ensureMigrationSchema(db, 'CREATE INDEX idx_users_admin_created_id ON users (created_at DESC, id DESC)');
}
export async function down(db: Kysely<unknown>): Promise<void> {
    await sql`DROP INDEX idx_users_admin_created_id`.execute(db);
    await sql`DROP TABLE sync_observations`.execute(db);
}
