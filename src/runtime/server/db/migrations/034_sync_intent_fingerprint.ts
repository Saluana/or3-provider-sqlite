import { type Kysely, sql } from 'kysely';
import { ensureMigrationTextColumn } from '../migration-schema';
export async function up(db: Kysely<unknown>): Promise<void> {
    await ensureMigrationTextColumn(db, 'change_log', 'intent_fingerprint');
}
export async function down(db: Kysely<unknown>): Promise<void> {
    await sql`ALTER TABLE change_log DROP COLUMN intent_fingerprint`.execute(db);
}
