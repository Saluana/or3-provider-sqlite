import { sql, type Kysely } from 'kysely';

/** Adds the bounded credential-delivery lease without losing pending requests. */
export async function up(db: Kysely<unknown>): Promise<void> {
    const columns = await authorizationColumns(db);
    if (columns.has('credential_redeliver_until')) return;

    await dropAuthorizationIndexes(db);
    await sql`
        ALTER TABLE connect_device_authorizations
        RENAME TO connect_device_authorizations_before_redelivery
    `.execute(db);
    await createRedeliveryTable(db);
    await sql`
        INSERT INTO connect_device_authorizations (
            id, device_code_hash, user_code_hash, status, host_json,
            approved_user_id, approved_workspace_id, environment_id,
            credential_ciphertext, expires_at, created_at, updated_at
        )
        SELECT
            id, device_code_hash, user_code_hash, status, host_json,
            approved_user_id, approved_workspace_id, environment_id,
            credential_ciphertext, expires_at, created_at, updated_at
        FROM connect_device_authorizations_before_redelivery
    `.execute(db);
    await sql`
        DROP TABLE connect_device_authorizations_before_redelivery
    `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    const columns = await authorizationColumns(db);
    if (!columns.has('credential_redeliver_until')) return;

    await dropAuthorizationIndexes(db);
    await sql`
        ALTER TABLE connect_device_authorizations
        RENAME TO connect_device_authorizations_with_redelivery
    `.execute(db);
    await sql`
        CREATE TABLE connect_device_authorizations (
            id TEXT PRIMARY KEY,
            device_code_hash TEXT NOT NULL UNIQUE,
            user_code_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK (
                status IN (
                    'pending', 'provisioning', 'approved',
                    'denied', 'consumed', 'expired'
                )
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
        INSERT INTO connect_device_authorizations (
            id, device_code_hash, user_code_hash, status, host_json,
            approved_user_id, approved_workspace_id, environment_id,
            credential_ciphertext, expires_at, created_at, updated_at
        )
        SELECT
            id, device_code_hash, user_code_hash,
            CASE WHEN status = 'delivering' THEN 'approved' ELSE status END,
            host_json, approved_user_id, approved_workspace_id, environment_id,
            credential_ciphertext, expires_at, created_at, updated_at
        FROM connect_device_authorizations_with_redelivery
    `.execute(db);
    await createAuthorizationIndexes(db);
    await sql`
        DROP TABLE connect_device_authorizations_with_redelivery
    `.execute(db);
}

async function authorizationColumns(
    db: Kysely<unknown>
): Promise<Set<string>> {
    const result = await sql<{ name: string }>`
        PRAGMA table_info(connect_device_authorizations)
    `.execute(db);
    return new Set(result.rows.map((column) => column.name));
}

async function createRedeliveryTable(db: Kysely<unknown>): Promise<void> {
    await sql`
        CREATE TABLE connect_device_authorizations (
            id TEXT PRIMARY KEY,
            device_code_hash TEXT NOT NULL UNIQUE,
            user_code_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK (
                status IN (
                    'pending', 'provisioning', 'approved', 'delivering',
                    'denied', 'consumed', 'expired'
                )
            ),
            host_json TEXT NOT NULL,
            approved_user_id TEXT,
            approved_workspace_id TEXT,
            environment_id TEXT,
            credential_ciphertext TEXT,
            credential_delivery_started_at INTEGER,
            credential_redeliver_until INTEGER,
            expires_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `.execute(db);
    await createAuthorizationIndexes(db);
}

async function dropAuthorizationIndexes(db: Kysely<unknown>): Promise<void> {
    await sql`DROP INDEX IF EXISTS connect_authorizations_status_expiry`.execute(db);
    await sql`DROP INDEX IF EXISTS connect_authorizations_user_code`.execute(db);
    await sql`DROP INDEX IF EXISTS connect_authorizations_environment`.execute(db);
}

async function createAuthorizationIndexes(db: Kysely<unknown>): Promise<void> {
    await sql`
        CREATE INDEX connect_authorizations_status_expiry
        ON connect_device_authorizations(status, expires_at)
    `.execute(db);
    await sql`
        CREATE INDEX connect_authorizations_user_code
        ON connect_device_authorizations(user_code_hash, created_at)
    `.execute(db);
    await sql`
        CREATE INDEX connect_authorizations_environment
        ON connect_device_authorizations(environment_id)
    `.execute(db);
}
