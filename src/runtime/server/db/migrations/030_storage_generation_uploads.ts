import { sql, type Kysely } from 'kysely';
import { generationGuardTriggers } from '../storage-generation-guards';
import { GENERATION_UPLOAD_TABLE, generationUploadGuardTriggers } from '../storage-generation-upload-guards';

/** Dormant: no production route or factory registers upload enrollment. */
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql.raw(`CREATE TABLE ${GENERATION_UPLOAD_TABLE} (
        intent_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL, hash TEXT NOT NULL,
        generation_id TEXT NOT NULL, storage_id TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT 'upload' CHECK (purpose IN ('upload','restore')),
        storage_provider_id TEXT NOT NULL, namespace_id TEXT NOT NULL, user_id TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (typeof(size_bytes) = 'integer' AND size_bytes BETWEEN 0 AND 9007199254740991),
        reserved_bytes INTEGER NOT NULL CHECK (typeof(reserved_bytes) = 'integer' AND reserved_bytes >= 0),
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        request_ttl INTEGER NOT NULL, quota_bytes INTEGER,
        state TEXT NOT NULL CHECK (state IN ('reserved','ready','published_pending_metadata','materialized','abandon_claimed','abandoned')),
        ready_receipt_id TEXT, ready_at INTEGER,
        published_generation_id TEXT, published_at INTEGER, materialized_at INTEGER,
        claim_id TEXT UNIQUE, claimed_at INTEGER, deleted_at INTEGER,
        CHECK (typeof(created_at) = 'integer' AND created_at >= 0 AND typeof(expires_at) = 'integer' AND expires_at > created_at),
        CHECK ((state IN ('reserved','ready','published_pending_metadata') AND reserved_bytes = size_bytes)
            OR (state IN ('materialized','abandon_claimed','abandoned') AND reserved_bytes = 0)),
        CHECK ((state = 'reserved' AND ready_receipt_id IS NULL AND ready_at IS NULL)
            OR (state <> 'reserved' AND ready_receipt_id IS NOT NULL AND ready_at IS NOT NULL AND ready_at >= created_at)),
        CHECK ((published_generation_id IS NULL AND published_at IS NULL)
            OR (published_generation_id = generation_id AND published_at IS NOT NULL AND published_at >= ready_at)),
        CHECK (state NOT IN ('published_pending_metadata','materialized') OR published_generation_id IS NOT NULL),
        CHECK (purpose = 'upload' OR (published_generation_id IS NOT NULL AND state NOT IN ('reserved','ready'))),
        CHECK ((state = 'materialized' AND materialized_at IS NOT NULL AND materialized_at >= published_at)
            OR (state <> 'materialized' AND materialized_at IS NULL)),
        CHECK ((state IN ('abandon_claimed','abandoned') AND claim_id IS NOT NULL AND claimed_at IS NOT NULL AND claimed_at >= expires_at AND claimed_at >= ready_at)
            OR (state NOT IN ('abandon_claimed','abandoned') AND claim_id IS NULL AND claimed_at IS NULL)),
        CHECK ((state = 'abandoned' AND deleted_at IS NOT NULL AND deleted_at >= claimed_at)
            OR (state <> 'abandoned' AND deleted_at IS NULL)),
        FOREIGN KEY (intent_id) REFERENCES upload_intents(id) DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY (published_generation_id) REFERENCES storage_object_generations(generation_id) DEFERRABLE INITIALLY DEFERRED
    )`).execute(db);
    await sql.raw(`CREATE UNIQUE INDEX storage_upload_generation_identity ON ${GENERATION_UPLOAD_TABLE}(generation_id) WHERE purpose = 'upload'`).execute(db);
    await sql.raw(`CREATE UNIQUE INDEX storage_upload_target_identity ON ${GENERATION_UPLOAD_TABLE}(storage_id) WHERE purpose = 'upload'`).execute(db);
    await sql.raw(`CREATE UNIQUE INDEX storage_upload_pending_hash ON ${GENERATION_UPLOAD_TABLE}(workspace_id, hash)
        WHERE state IN ('reserved','ready','published_pending_metadata')`).execute(db);
    await sql.raw(`CREATE INDEX storage_upload_recovery ON ${GENERATION_UPLOAD_TABLE}(workspace_id, intent_id)`).execute(db);
    for (const [name, trigger] of Object.entries(generationUploadGuardTriggers())) {
        if (name in generationGuardTriggers()) await sql.raw(`DROP TRIGGER ${name}`).execute(db);
        await sql.raw(trigger).execute(db);
    }
}

export async function down(db: Kysely<unknown>): Promise<void> {
    const result = await sql<{ count: number }>`SELECT count(*) AS count FROM storage_generation_uploads`.execute(db);
    if (result.rows[0]?.count) throw new Error('Managed upload bindings are permanent; cannot roll back this schema.');
    for (const name of Object.keys(generationUploadGuardTriggers())) await sql.raw(`DROP TRIGGER IF EXISTS ${name}`).execute(db);
    await sql.raw(`DROP TABLE ${GENERATION_UPLOAD_TABLE}`).execute(db);
    for (const [name, trigger] of Object.entries(generationGuardTriggers())) {
        if (name in generationUploadGuardTriggers()) await sql.raw(trigger).execute(db);
    }
}
