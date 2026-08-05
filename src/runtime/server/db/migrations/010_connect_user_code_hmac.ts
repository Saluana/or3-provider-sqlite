import { sql, type Kysely } from 'kysely';

/**
 * Purges legacy readable pairing phrases.
 *
 * Device authorizations are ten-minute, retryable setup records. Their former
 * unkeyed hashes cannot be upgraded to the server-keyed HMAC without retaining
 * the plaintext, so an upgrade deliberately invalidates in-flight records.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
    const columns = await sql<{ name: string }>`
        PRAGMA table_info(connect_device_authorizations)
    `.execute(db);
    if (!columns.rows.some((column) => column.name === 'user_code_display')) {
        return;
    }

    await sql`DROP INDEX IF EXISTS connect_authorizations_status_expiry`.execute(db);
    await sql`DROP INDEX IF EXISTS connect_authorizations_user_code`.execute(db);
    await sql`DROP INDEX IF EXISTS connect_authorizations_environment`.execute(db);
    await sql`
        ALTER TABLE connect_device_authorizations
        RENAME TO connect_device_authorizations_legacy
    `.execute(db);
    await createSecureAuthorizationTable(db);
    await sql`DROP TABLE connect_device_authorizations_legacy`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    const columns = await sql<{ name: string }>`
        PRAGMA table_info(connect_device_authorizations)
    `.execute(db);
    if (columns.rows.some((column) => column.name === 'user_code_display')) {
        return;
    }

    await sql`DROP INDEX IF EXISTS connect_authorizations_status_expiry`.execute(db);
    await sql`DROP INDEX IF EXISTS connect_authorizations_user_code`.execute(db);
    await sql`DROP INDEX IF EXISTS connect_authorizations_environment`.execute(db);
    await sql`
        ALTER TABLE connect_device_authorizations
        RENAME TO connect_device_authorizations_secure
    `.execute(db);
    await sql`
        CREATE TABLE connect_device_authorizations (
            id TEXT PRIMARY KEY,
            device_code_hash TEXT NOT NULL UNIQUE,
            user_code_hash TEXT NOT NULL,
            user_code_display TEXT NOT NULL,
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
    await createAuthorizationIndexes(db);
    await sql`DROP TABLE connect_device_authorizations_secure`.execute(db);
}

async function createSecureAuthorizationTable(
    db: Kysely<unknown>
): Promise<void> {
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
