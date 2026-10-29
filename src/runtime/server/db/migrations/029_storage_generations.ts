import { sql, type Kysely } from 'kysely';
import { GENERATION_TABLE, HEAD_TABLE, generationGuardTriggers } from '../storage-generation-guards';

/** Dormant foundation: no runtime creates managed rows or advertises this protocol. */
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql.raw(`CREATE TABLE ${GENERATION_TABLE} (
        generation_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        storage_provider_id TEXT NOT NULL,
        storage_id TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL CHECK (typeof(size_bytes) = 'integer' AND size_bytes BETWEEN 0 AND 9007199254740991),
        state TEXT NOT NULL CHECK (state IN ('verified', 'claimed', 'deleted')),
        created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
        last_activity_at INTEGER NOT NULL CHECK (typeof(last_activity_at) = 'integer' AND last_activity_at BETWEEN 0 AND 9007199254740991),
        claim_id TEXT UNIQUE,
        claimed_at INTEGER CHECK (claimed_at IS NULL OR (typeof(claimed_at) = 'integer' AND claimed_at BETWEEN 0 AND 9007199254740991)),
        deleted_at INTEGER CHECK (deleted_at IS NULL OR (typeof(deleted_at) = 'integer' AND deleted_at BETWEEN 0 AND 9007199254740991)),
        UNIQUE (workspace_id, hash, generation_id),
        CHECK (last_activity_at >= created_at),
        CHECK ((state = 'verified' AND claim_id IS NULL AND claimed_at IS NULL AND deleted_at IS NULL)
            OR (state = 'claimed' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL AND claimed_at >= last_activity_at AND deleted_at IS NULL)
            OR (state = 'deleted' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL AND deleted_at IS NOT NULL
                AND claimed_at >= last_activity_at AND deleted_at >= claimed_at))
    )`).execute(db);
    await sql.raw(`CREATE TABLE ${HEAD_TABLE} (
        workspace_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        generation_id TEXT NOT NULL UNIQUE,
        PRIMARY KEY (workspace_id, hash),
        FOREIGN KEY (workspace_id, hash, generation_id)
            REFERENCES ${GENERATION_TABLE}(workspace_id, hash, generation_id) ON DELETE RESTRICT
    )`).execute(db);
    await sql.raw(`CREATE INDEX storage_generations_workspace_hash ON ${GENERATION_TABLE}(workspace_id, hash)`).execute(db);
    for (const trigger of Object.values(generationGuardTriggers())) await sql.raw(trigger).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    const result = await sql<{ count: number }>`SELECT count(*) AS count FROM storage_object_generations`.execute(db);
    if (result.rows[0]?.count) throw new Error('Managed generation barriers are permanent; cannot roll back this schema.');
    for (const name of Object.keys(generationGuardTriggers())) await sql.raw(`DROP TRIGGER IF EXISTS ${name}`).execute(db);
    await sql.raw(`DROP TABLE ${HEAD_TABLE}`).execute(db);
    await sql.raw(`DROP TABLE ${GENERATION_TABLE}`).execute(db);
}
