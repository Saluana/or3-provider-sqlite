import { sql, type Kysely } from 'kysely';

/** Adds the additive runtime binding used by Runs-compatible Connect hosts. */
export async function up(db: Kysely<unknown>): Promise<void> {
    const result = await sql<{ name: string }>`
        PRAGMA table_info(connect_environments)
    `.execute(db);
    const columns = new Set(result.rows.map((column) => column.name));
    if (!columns.has('driver')) {
        await sql`
            ALTER TABLE connect_environments
            ADD COLUMN driver TEXT
        `.execute(db);
    }
    if (!columns.has('runtime')) {
        await sql`
            ALTER TABLE connect_environments
            ADD COLUMN runtime TEXT
        `.execute(db);
    }
    if (!columns.has('base_path')) {
        await sql`
            ALTER TABLE connect_environments
            ADD COLUMN base_path TEXT
        `.execute(db);
    }
}

export async function down(db: Kysely<unknown>): Promise<void> {
    // SQLite cannot drop columns portably without rebuilding a live Connect
    // table. The fields are nullable and additive, so retaining them on a
    // downgrade is safer than risking data loss.
    void db;
}
