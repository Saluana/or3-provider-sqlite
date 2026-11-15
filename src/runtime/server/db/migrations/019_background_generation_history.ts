import { sql, type Kysely } from 'kysely';
import { ensureMigrationTextColumn } from '../migration-schema';

/**
 * Generation identity, durable history phase, and accumulated reasoning on
 * background jobs. Reasoning is kept distinct from request reasoning config.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
    await ensureMigrationTextColumn(db, 'background_jobs', 'reasoning', true);
    for (const column of ['generation_id', 'history_phase', 'sync_provider_id']) {
        await ensureMigrationTextColumn(db, 'background_jobs', column);
    }
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await sql`ALTER TABLE background_jobs DROP COLUMN sync_provider_id`.execute(db);
    await sql`ALTER TABLE background_jobs DROP COLUMN history_phase`.execute(db);
    await sql`ALTER TABLE background_jobs DROP COLUMN generation_id`.execute(db);
    await sql`ALTER TABLE background_jobs DROP COLUMN reasoning`.execute(db);
}
