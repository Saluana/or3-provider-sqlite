import { sql, type Kysely } from 'kysely';

/** Adds bounded retention and unclaimed-activation lifecycle indexes. */
export async function up(db: Kysely<unknown>): Promise<void> {
    const columns = await sql<{ name: string }>`
        PRAGMA table_info(connect_environments)
    `.execute(db);
    const names = new Set(columns.rows.map((column) => column.name));
    if (!names.has('activation_deadline_at')) {
        await sql`
            ALTER TABLE connect_environments
            ADD COLUMN activation_deadline_at INTEGER
        `.execute(db);
    }
    if (!names.has('activation_claimed_at')) {
        await sql`
            ALTER TABLE connect_environments
            ADD COLUMN activation_claimed_at INTEGER
        `.execute(db);
    }
    if (!names.has('relay_authenticator')) {
        await sql`
            ALTER TABLE connect_environments
            ADD COLUMN relay_authenticator TEXT
        `.execute(db);
    }
    await sql`
        CREATE INDEX IF NOT EXISTS connect_authorizations_status_updated
        ON connect_device_authorizations(status, updated_at, id)
    `.execute(db);
    await sql`
        CREATE INDEX IF NOT EXISTS connect_environments_status_updated
        ON connect_environments(status, updated_at, id)
    `.execute(db);
    await sql`
        CREATE INDEX IF NOT EXISTS connect_environments_activation_due
        ON connect_environments(
            status, activation_claimed_at, activation_deadline_at, id
        )
    `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await sql`DROP INDEX IF EXISTS connect_environments_activation_due`.execute(db);
    await sql`DROP INDEX IF EXISTS connect_environments_status_updated`.execute(db);
    await sql`DROP INDEX IF EXISTS connect_authorizations_status_updated`.execute(db);
    // SQLite cannot drop these columns on all supported versions. Leaving
    // nullable compatibility columns is safer than rebuilding live tables.
}
