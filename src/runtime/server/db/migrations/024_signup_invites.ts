import { sql, type Kysely } from 'kysely';

/** Additive: signup invitations never join an existing workspace. Millisecond dates. */
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql`CREATE TABLE signup_invites (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending', expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL, created_by_admin TEXT NOT NULL,
        revoked_at INTEGER, accepted_at INTEGER, user_id TEXT, workspace_id TEXT,
        accepted_provider TEXT, accepted_provider_user_id TEXT,
        retain_until INTEGER NOT NULL
    )`.execute(db);
    await sql`CREATE INDEX signup_invites_created ON signup_invites(created_at, id)`.execute(db);
    await sql`CREATE INDEX signup_invites_retention ON signup_invites(retain_until)`.execute(db);
    await sql`CREATE INDEX users_normalized_email ON users(lower(trim(email)))`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('signup_invites').execute();
    await sql`DROP INDEX users_normalized_email`.execute(db);
}
