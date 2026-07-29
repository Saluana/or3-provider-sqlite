import { sql, type Kysely } from 'kysely';

/** Durable device authorization and enrolled-computer records for OR3 Connect. */
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql`
        CREATE TABLE connect_device_authorizations (
            id TEXT PRIMARY KEY,
            device_code_hash TEXT NOT NULL UNIQUE,
            user_code_hash TEXT NOT NULL,
            user_code_display TEXT NOT NULL,
            status TEXT NOT NULL CHECK (
                status IN ('pending', 'approved', 'denied', 'consumed', 'expired')
            ),
            host_json TEXT NOT NULL,
            approved_user_id TEXT,
            approved_workspace_id TEXT,
            environment_id TEXT,
            credential_ciphertext TEXT,
            expires_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `.execute(db);
    await sql`
        CREATE INDEX connect_authorizations_status_expiry
        ON connect_device_authorizations(status, expires_at)
    `.execute(db);
    await sql`
        CREATE INDEX connect_authorizations_user_code
        ON connect_device_authorizations(user_code_hash, created_at)
    `.execute(db);

    await sql`
        CREATE TABLE connect_environments (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            name TEXT NOT NULL,
            platform TEXT NOT NULL,
            architecture TEXT NOT NULL,
            host_id TEXT,
            signing_public_key TEXT,
            noise_public_key TEXT,
            hostname TEXT NOT NULL,
            tunnel_id TEXT NOT NULL,
            dns_record_id TEXT NOT NULL,
            control_token_hash TEXT NOT NULL UNIQUE,
            access_credential_ciphertext TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'error')),
            last_seen_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            revoked_at INTEGER
        )
    `.execute(db);
    await sql`
        CREATE INDEX connect_environments_user_status
        ON connect_environments(user_id, status, updated_at)
    `.execute(db);
    await sql`
        CREATE INDEX connect_environments_workspace_status
        ON connect_environments(workspace_id, status, updated_at)
    `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('connect_environments').ifExists().execute();
    await db.schema
        .dropTable('connect_device_authorizations')
        .ifExists()
        .execute();
}
