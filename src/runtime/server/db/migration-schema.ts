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
