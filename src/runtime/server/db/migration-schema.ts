import { sql, type Kysely } from 'kysely';

/** Resume nontransactional SQLite/D1 DDL without trusting an unrelated schema. */
export async function ensureMigrationSchema(
    db: Kysely<unknown>,
    statement: string,
    previousTrigger?: string,
): Promise<void> {
    const match = /^CREATE (?:UNIQUE )?(TABLE|INDEX|TRIGGER) (\w+)/.exec(statement);
    if (!match) throw new Error('Unsupported migration schema statement');
    const [, kind, name] = match;
    const existing = (await sql<{ type: string; sql: string | null }>`
        SELECT type, sql FROM sqlite_master WHERE name = ${name}
    `.execute(db)).rows;
    if (existing.length) {
        const current = existing[0];
        if (existing.length !== 1 || !current || current.type !== kind?.toLowerCase()) {
            throw new Error(`Incompatible migration schema: ${name}`);
        }
        if (current.sql?.trim() === statement.trim()) return;
        // Only replace the exact preceding guard. A restart after DROP resumes
        // at CREATE; a restart after CREATE recognizes the final definition.
        if (kind !== 'TRIGGER' || !previousTrigger || current.sql?.trim() !== previousTrigger.trim()) {
            throw new Error(`Incompatible migration schema: ${name}`);
        }
        await sql.raw(`DROP TRIGGER ${name}`).execute(db);
    }
    await sql.raw(statement).execute(db);
}

/** Historical additive steps may already be durable without a ledger entry. */
export async function ensureMigrationTextColumn(
    db: Kysely<unknown>, table: string, name: string, required = false,
): Promise<void> {
    const columns = (await sql<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>`
        PRAGMA table_info(${sql.id(table)})
    `.execute(db)).rows;
    if (!columns.length) throw new Error(`Missing migration table: ${table}`);
    const column = columns.find(column => column.name === name);
    if (column) {
        if (column.type.toUpperCase() !== 'TEXT' || column.notnull !== Number(required)
            || column.dflt_value !== (required ? "''" : null) || column.pk !== 0) {
            throw new Error(`Incompatible migration column: ${table}.${name}`);
        }
        return;
    }
    await sql`ALTER TABLE ${sql.id(table)} ADD COLUMN ${sql.id(name)} ${sql.raw(required ? "TEXT NOT NULL DEFAULT ''" : 'TEXT')}`.execute(db);
}
