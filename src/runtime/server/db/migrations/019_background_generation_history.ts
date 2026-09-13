import { sql, type Kysely } from 'kysely';

/**
 * Generation identity, durable history phase, and accumulated reasoning on
 * background jobs. Reasoning is kept distinct from request reasoning config.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql`
        ALTER TABLE background_jobs
        ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''
    `.execute(db);
    await sql`
        ALTER TABLE background_jobs
        ADD COLUMN generation_id TEXT
    `.execute(db);
    await sql`
        ALTER TABLE background_jobs
        ADD COLUMN history_phase TEXT
    `.execute(db);
    await sql`
        ALTER TABLE background_jobs
        ADD COLUMN sync_provider_id TEXT
    `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await sql`ALTER TABLE background_jobs DROP COLUMN sync_provider_id`.execute(db);
    await sql`ALTER TABLE background_jobs DROP COLUMN history_phase`.execute(db);
    await sql`ALTER TABLE background_jobs DROP COLUMN generation_id`.execute(db);
    await sql`ALTER TABLE background_jobs DROP COLUMN reasoning`.execute(db);
}
