import { sql, type Kysely } from 'kysely';

/**
 * Adds durable provisioning/revocation work with lease-based claiming.
 *
 * SQLite cannot widen CHECK constraints in place, so both Connect tables are
 * rebuilt transactionally while preserving active environments and approved
 * credentials.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
    const environmentColumns = await tableColumns(db, 'connect_environments');
    if (environmentColumns.has('lifecycle_claim_token')) return;

    await dropConnectIndexes(db);
    await sql`
        ALTER TABLE connect_device_authorizations
        RENAME TO connect_device_authorizations_before_lifecycle
    `.execute(db);
    await sql`
        ALTER TABLE connect_environments
        RENAME TO connect_environments_before_lifecycle
    `.execute(db);
    await createAuthorizationTable(db, true);
    await createEnvironmentTable(db, true);
    await sql`
        INSERT INTO connect_device_authorizations (
            id, device_code_hash, user_code_hash, status, host_json,
            approved_user_id, approved_workspace_id, environment_id,
            credential_ciphertext, credential_delivery_started_at,
            credential_redeliver_until, expires_at, created_at, updated_at
        )
        SELECT
            id, device_code_hash, user_code_hash, status, host_json,
            approved_user_id, approved_workspace_id, environment_id,
            credential_ciphertext, credential_delivery_started_at,
            credential_redeliver_until, expires_at, created_at, updated_at
        FROM connect_device_authorizations_before_lifecycle
    `.execute(db);
    await sql`
        INSERT INTO connect_environments (
            id, user_id, workspace_id, name, platform, architecture,
            host_id, signing_public_key, noise_public_key, hostname,
            tunnel_id, dns_record_id, control_token_hash,
            access_credential_ciphertext, status, lifecycle_attempts,
            lifecycle_next_attempt_at, last_seen_at, created_at, updated_at,
            revoked_at
        )
        SELECT
            id, user_id, workspace_id, name, platform, architecture,
            host_id, signing_public_key, noise_public_key, hostname,
            tunnel_id, dns_record_id, control_token_hash,
            access_credential_ciphertext, status, 0, 0, last_seen_at,
            created_at, updated_at, revoked_at
        FROM connect_environments_before_lifecycle
    `.execute(db);
    await sql`
        DROP TABLE connect_device_authorizations_before_lifecycle
    `.execute(db);
    await sql`DROP TABLE connect_environments_before_lifecycle`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    const environmentColumns = await tableColumns(db, 'connect_environments');
    if (!environmentColumns.has('lifecycle_claim_token')) return;

    await dropConnectIndexes(db);
    await sql`
        ALTER TABLE connect_device_authorizations
        RENAME TO connect_device_authorizations_with_lifecycle
    `.execute(db);
    await sql`
        ALTER TABLE connect_environments
        RENAME TO connect_environments_with_lifecycle
    `.execute(db);
    await createAuthorizationTable(db, false);
    await createEnvironmentTable(db, false);
    await sql`
        INSERT INTO connect_device_authorizations (
            id, device_code_hash, user_code_hash, status, host_json,
            approved_user_id, approved_workspace_id, environment_id,
            credential_ciphertext, credential_delivery_started_at,
            credential_redeliver_until, expires_at, created_at, updated_at
        )
        SELECT
            id, device_code_hash, user_code_hash,
            CASE WHEN status = 'provisioning' THEN 'expired' ELSE status END,
            host_json, approved_user_id, approved_workspace_id, environment_id,
            credential_ciphertext, credential_delivery_started_at,
            credential_redeliver_until, expires_at, created_at, updated_at
        FROM connect_device_authorizations_with_lifecycle
    `.execute(db);
    await sql`
        INSERT INTO connect_environments (
            id, user_id, workspace_id, name, platform, architecture,
            host_id, signing_public_key, noise_public_key, hostname,
            tunnel_id, dns_record_id, control_token_hash,
            access_credential_ciphertext, status, last_seen_at, created_at,
            updated_at, revoked_at
        )
        SELECT
            id, user_id, workspace_id, name, platform, architecture,
            host_id, signing_public_key, noise_public_key, hostname,
            tunnel_id, dns_record_id, control_token_hash,
            access_credential_ciphertext,
            CASE
                WHEN status = 'provisioning' THEN 'error'
                WHEN status = 'revoking' THEN 'revoked'
                ELSE status
            END,
            last_seen_at, created_at, updated_at, revoked_at
        FROM connect_environments_with_lifecycle
    `.execute(db);
    await sql`
        DROP TABLE connect_device_authorizations_with_lifecycle
    `.execute(db);
    await sql`DROP TABLE connect_environments_with_lifecycle`.execute(db);
}

async function tableColumns(
    db: Kysely<unknown>,
    table: string
): Promise<Set<string>> {
    const result = await sql<{ name: string }>`
        PRAGMA table_info(${sql.raw(table)})
    `.execute(db);
    return new Set(result.rows.map((column) => column.name));
}

async function createAuthorizationTable(
    db: Kysely<unknown>,
    lifecycle: boolean
): Promise<void> {
    const statuses = lifecycle
        ? "'pending', 'provisioning', 'approved', 'delivering', 'denied', 'consumed', 'expired'"
        : "'pending', 'approved', 'delivering', 'denied', 'consumed', 'expired'";
    await sql`
        CREATE TABLE connect_device_authorizations (
            id TEXT PRIMARY KEY,
            device_code_hash TEXT NOT NULL UNIQUE,
            user_code_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN (${sql.raw(statuses)})),
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

async function createEnvironmentTable(
    db: Kysely<unknown>,
    lifecycle: boolean
): Promise<void> {
    if (!lifecycle) {
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
                status TEXT NOT NULL CHECK (
                    status IN ('active', 'revoked', 'error')
                ),
                last_seen_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                revoked_at INTEGER
            )
        `.execute(db);
        await createEnvironmentIndexes(db, false);
        return;
    }
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
            authorization_id TEXT,
            hostname TEXT NOT NULL,
            tunnel_id TEXT NOT NULL,
            dns_record_id TEXT NOT NULL,
            control_token_hash TEXT NOT NULL UNIQUE,
            access_credential_ciphertext TEXT NOT NULL,
            tunnel_secret_ciphertext TEXT,
            status TEXT NOT NULL CHECK (
                status IN (
                    'provisioning', 'active', 'revoking', 'revoked', 'error'
                )
            ),
            lifecycle_attempts INTEGER NOT NULL DEFAULT 0,
            lifecycle_next_attempt_at INTEGER NOT NULL DEFAULT 0,
            lifecycle_claim_token TEXT,
            lifecycle_claimed_until INTEGER,
            provisioning_deadline_at INTEGER,
            lifecycle_error TEXT,
            last_seen_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            revoked_at INTEGER
        )
    `.execute(db);
    await createEnvironmentIndexes(db, true);
}

async function dropConnectIndexes(db: Kysely<unknown>): Promise<void> {
    const names = [
        'connect_authorizations_status_expiry',
        'connect_authorizations_user_code',
        'connect_authorizations_environment',
        'connect_environments_user_status',
        'connect_environments_workspace_status',
        'connect_environments_user_workspace_status_updated',
        'connect_environments_user_workspace_control_token',
        'connect_environments_user_workspace_id',
        'connect_environments_lifecycle_due',
    ];
    for (const name of names) {
        await sql`DROP INDEX IF EXISTS ${sql.raw(name)}`.execute(db);
    }
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

async function createEnvironmentIndexes(
    db: Kysely<unknown>,
    lifecycle: boolean
): Promise<void> {
    await sql`
        CREATE INDEX connect_environments_user_status
        ON connect_environments(user_id, status, updated_at)
    `.execute(db);
    await sql`
        CREATE INDEX connect_environments_workspace_status
        ON connect_environments(workspace_id, status, updated_at)
    `.execute(db);
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
    if (lifecycle) {
        await sql`
            CREATE INDEX connect_environments_lifecycle_due
            ON connect_environments(
                status, lifecycle_next_attempt_at, lifecycle_claimed_until
            )
        `.execute(db);
    }
}
