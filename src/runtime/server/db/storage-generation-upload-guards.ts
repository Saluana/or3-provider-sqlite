import {
    GENERATION_TABLE, HEAD_TABLE, generationGuardTriggers, generationHashSql,
    generationReferencesSql, validGenerationHashSql, validGenerationObjectSql, validGenerationReferencesSql,
} from './storage-generation-guards';

export const GENERATION_UPLOAD_TABLE = 'storage_generation_uploads';
/** Accounting holds have no automatic expiry. Credentials have their own deadline. */
export const GENERATION_UPLOAD_HOLD_EXPIRY = Number.MAX_SAFE_INTEGER;
export const GENERATION_UPLOAD_MAX_TTL_SECONDS = 900;
export const GENERATION_UPLOAD_MAX_PENDING = 128;

function projected(row: string, binding: string): string {
    return `${row}.id = ${binding}.intent_id AND ${row}.workspace_id = ${binding}.workspace_id
        AND ${row}.hash = ${binding}.hash AND ${row}.mime_type = ${binding}.mime_type
        AND ${row}.size_bytes = ${binding}.size_bytes AND ${row}.storage_id IS ${binding}.storage_id
        AND ${row}.expires_at = ${GENERATION_UPLOAD_HOLD_EXPIRY} AND ${row}.created_at = ${binding}.created_at
        AND (( ${binding}.state IN ('reserved','ready','published_pending_metadata') AND ${row}.status = 'active'
                AND ${row}.reserved_bytes = ${binding}.size_bytes AND ${row}.consumed_at IS NULL AND ${row}.cancelled_at IS NULL)
            OR (${binding}.state = 'materialized' AND ${row}.status = 'consumed' AND ${row}.reserved_bytes = 0
                AND ${row}.consumed_at IS ${binding}.materialized_at AND ${row}.cancelled_at IS NULL)
            OR (${binding}.state IN ('abandon_claimed','abandoned') AND ${row}.status = 'cancelled' AND ${row}.reserved_bytes = 0
                AND ${row}.cancelled_at IS ${binding}.claimed_at AND ${row}.consumed_at IS NULL))`;
}

/** Migration 025 only: the original migration remains reproducible. */
export function generationUploadGuardTriggers(): Record<string, string> {
    const table = GENERATION_UPLOAD_TABLE;
    const triggers: Record<string, string> = {};
    const add = (name: string, sql: string) => { triggers[name] = `CREATE TRIGGER ${name} ${sql}`; };
    const bindingIdentity = `binding.generation_id = NEW.generation_id AND binding.workspace_id = NEW.workspace_id
        AND binding.hash = NEW.hash AND binding.storage_provider_id = NEW.storage_provider_id
        AND binding.storage_id = NEW.storage_id AND binding.size_bytes = NEW.size_bytes`;
    const publication = `${bindingIdentity} AND binding.purpose = 'upload' AND binding.state = 'published_pending_metadata'
        AND binding.published_generation_id = NEW.generation_id`;
    add('storage_upload_no_replace', `BEFORE INSERT ON ${table}
        WHEN EXISTS (SELECT 1 FROM ${table} WHERE intent_id = NEW.intent_id)
            OR (NEW.purpose = 'upload' AND (EXISTS (SELECT 1 FROM ${table} WHERE generation_id = NEW.generation_id OR storage_id = NEW.storage_id)
                OR EXISTS (SELECT 1 FROM ${GENERATION_TABLE} WHERE generation_id = NEW.generation_id OR storage_id = NEW.storage_id)))
        BEGIN SELECT RAISE(ABORT, 'STORAGE_UPLOAD_IDENTITY_REUSE'); END`);
    add('storage_upload_restore_identity', `BEFORE INSERT ON ${table}
        WHEN NEW.purpose = 'restore' AND NOT EXISTS (
            SELECT 1 FROM ${table} origin JOIN ${GENERATION_TABLE} generation ON generation.generation_id = origin.generation_id
            JOIN ${HEAD_TABLE} head ON head.generation_id = generation.generation_id
            WHERE origin.purpose = 'upload' AND origin.state = 'materialized'
                AND origin.generation_id = NEW.generation_id AND origin.workspace_id = NEW.workspace_id AND origin.hash = NEW.hash
                AND origin.namespace_id = NEW.namespace_id AND origin.storage_provider_id = NEW.storage_provider_id
                AND origin.storage_id = NEW.storage_id AND origin.size_bytes = NEW.size_bytes AND origin.mime_type = NEW.mime_type
                AND origin.ready_receipt_id = NEW.ready_receipt_id AND NEW.published_generation_id = NEW.generation_id
                AND generation.state = 'verified' AND NEW.state = 'published_pending_metadata')
        BEGIN SELECT RAISE(ABORT, 'STORAGE_UPLOAD_RESTORE_IDENTITY'); END`);
    add('storage_upload_no_delete', `BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT, 'STORAGE_UPLOAD_PERMANENT'); END`);
    add('storage_upload_immutable', `BEFORE UPDATE ON ${table}
        WHEN NEW.intent_id IS NOT OLD.intent_id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.purpose IS NOT OLD.purpose
            OR NEW.hash IS NOT OLD.hash OR NEW.generation_id IS NOT OLD.generation_id
            OR NEW.storage_provider_id IS NOT OLD.storage_provider_id OR NEW.namespace_id IS NOT OLD.namespace_id
            OR NEW.storage_id IS NOT OLD.storage_id OR NEW.user_id IS NOT OLD.user_id
            OR NEW.mime_type IS NOT OLD.mime_type OR NEW.size_bytes IS NOT OLD.size_bytes
            OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
            OR NEW.request_ttl IS NOT OLD.request_ttl OR NEW.quota_bytes IS NOT OLD.quota_bytes
            OR (OLD.ready_receipt_id IS NOT NULL AND (NEW.ready_receipt_id IS NOT OLD.ready_receipt_id OR NEW.ready_at IS NOT OLD.ready_at))
            OR (OLD.published_at IS NOT NULL AND (NEW.published_at IS NOT OLD.published_at OR NEW.published_generation_id IS NOT OLD.published_generation_id))
            OR (OLD.claim_id IS NOT NULL AND (NEW.claim_id IS NOT OLD.claim_id OR NEW.claimed_at IS NOT OLD.claimed_at))
            OR (OLD.materialized_at IS NOT NULL AND NEW.materialized_at IS NOT OLD.materialized_at)
            OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT OLD.deleted_at)
            OR NOT (NEW.state = OLD.state OR (OLD.state = 'reserved' AND NEW.state = 'ready')
                OR (OLD.state = 'ready' AND NEW.state IN ('published_pending_metadata','abandon_claimed'))
                OR (OLD.state = 'published_pending_metadata' AND NEW.state IN ('materialized','abandon_claimed'))
                OR (OLD.state = 'abandon_claimed' AND NEW.state = 'abandoned'))
        BEGIN SELECT RAISE(ABORT, 'STORAGE_UPLOAD_IMMUTABLE'); END`);
    add('storage_upload_publication_deadline', `BEFORE UPDATE ON ${table}
        WHEN NEW.state = 'published_pending_metadata' AND OLD.state <> NEW.state
            AND (OLD.state <> 'ready' OR OLD.expires_at <= unixepoch() OR OLD.created_at > unixepoch())
        BEGIN SELECT RAISE(ABORT, 'STORAGE_UPLOAD_EXPIRED'); END`);
    add('storage_upload_materialization_proof', `BEFORE UPDATE ON ${table}
        WHEN NEW.state = 'materialized' AND OLD.state <> NEW.state
            AND NOT EXISTS (SELECT 1 FROM s_file_meta metadata
                JOIN ${HEAD_TABLE} head ON head.workspace_id = metadata.workspace_id AND head.hash = ${generationHashSql('metadata.id')}
                JOIN ${GENERATION_TABLE} generation ON generation.generation_id = head.generation_id
                WHERE metadata.workspace_id = NEW.workspace_id AND ${generationHashSql('metadata.id')} = NEW.hash
                    AND metadata.deleted = 0 AND head.generation_id = NEW.generation_id AND generation.state = 'verified'
                    AND ${validGenerationObjectSql('metadata.data_json')} = 1
                    AND json_type(metadata.data_json, '$.storage_id') IS NOT 'null'
                    AND json_type(metadata.data_json, '$.storageId') IS NOT 'null'
                    AND NOT (json_type(metadata.data_json, '$.storage_id') IS NOT NULL AND json_type(metadata.data_json, '$.storageId') IS NOT NULL)
                    AND NOT (json_type(metadata.data_json, '$.size_bytes') IS NOT NULL AND json_type(metadata.data_json, '$.sizeBytes') IS NOT NULL)
                    AND coalesce(json_extract(metadata.data_json, '$.storage_id'), json_extract(metadata.data_json, '$.storageId')) = NEW.storage_id
                    AND typeof(coalesce(json_extract(metadata.data_json, '$.size_bytes'), json_extract(metadata.data_json, '$.sizeBytes'))) = 'integer'
                    AND coalesce(json_extract(metadata.data_json, '$.size_bytes'), json_extract(metadata.data_json, '$.sizeBytes')) = NEW.size_bytes)
        BEGIN SELECT RAISE(ABORT, 'STORAGE_UPLOAD_MATERIALIZATION_PROOF_REQUIRED'); END`);
    add('storage_upload_abandon_generation', `BEFORE UPDATE ON ${table}
        WHEN NEW.state IN ('abandon_claimed','abandoned') AND NEW.published_generation_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM ${GENERATION_TABLE} generation
                WHERE generation.generation_id = NEW.published_generation_id AND generation.claim_id = NEW.claim_id
                    AND generation.state = CASE WHEN NEW.state = 'abandoned' THEN 'deleted' ELSE 'claimed' END)
        BEGIN SELECT RAISE(ABORT, 'STORAGE_UPLOAD_GENERATION_NOT_CLAIMED'); END`);

    // The old trusted registration method must not bypass permanent enrollment.
    add('storage_upload_generation_enrollment', `BEFORE INSERT ON ${GENERATION_TABLE}
        WHEN EXISTS (SELECT 1 FROM ${table} WHERE (workspace_id = NEW.workspace_id AND hash = NEW.hash)
            OR generation_id = NEW.generation_id OR storage_id = NEW.storage_id)
            AND NOT EXISTS (SELECT 1 FROM ${table} binding WHERE ${publication})
        BEGIN SELECT RAISE(ABORT, 'STORAGE_UPLOAD_BOUND_PUBLICATION_REQUIRED'); END`);
    add('storage_upload_generation_claim_identity', `BEFORE UPDATE ON ${GENERATION_TABLE}
        WHEN NEW.claim_id IS NOT NULL AND EXISTS (SELECT 1 FROM ${table} binding
            WHERE binding.claim_id = NEW.claim_id AND NOT (${bindingIdentity}))
        BEGIN SELECT RAISE(ABORT, 'STORAGE_UPLOAD_CLAIM_REUSE'); END`);
    for (const event of ['INSERT', 'UPDATE']) {
        add(`storage_upload_head_${event.toLowerCase()}`, `BEFORE ${event} ON ${HEAD_TABLE}
            WHEN EXISTS (SELECT 1 FROM ${table} WHERE workspace_id = NEW.workspace_id AND hash = NEW.hash)
                AND NOT EXISTS (SELECT 1 FROM ${table} WHERE workspace_id = NEW.workspace_id AND hash = NEW.hash
                    AND generation_id = NEW.generation_id AND published_generation_id = NEW.generation_id AND purpose = 'upload'
                    AND state IN ('published_pending_metadata','materialized'))
            BEGIN SELECT RAISE(ABORT, 'STORAGE_UPLOAD_BOUND_HEAD_REQUIRED'); END`);

        // Narrow exception for the exact immutable reservation projection only.
        const oldName = `upload_intents_generation_guard_${event.toLowerCase()}`;
        const old = generationGuardTriggers()[oldName]!;
        triggers[oldName] = old.replace("WHEN NEW.status = 'active' AND EXISTS", `WHEN NEW.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM ${table} binding WHERE ${projected('NEW', 'binding')}) AND EXISTS`);
        add(`storage_upload_ledger_${event.toLowerCase()}`, `BEFORE ${event} ON upload_intents
            WHEN (EXISTS (SELECT 1 FROM ${table} WHERE intent_id = NEW.id
                OR (workspace_id = NEW.workspace_id AND hash = ${generationHashSql('NEW.hash')}))
                OR (${validGenerationHashSql('NEW.hash')} IS NOT 1 AND EXISTS (SELECT 1 FROM ${table} WHERE workspace_id = NEW.workspace_id)))
                AND NOT EXISTS (SELECT 1 FROM ${table} binding WHERE ${projected('NEW', 'binding')})
            BEGIN SELECT RAISE(ABORT, 'STORAGE_UPLOAD_LEDGER_FENCED'); END`);
        add(`storage_upload_metadata_${event.toLowerCase()}`, `BEFORE ${event} ON s_file_meta
            WHEN NEW.deleted = 0 AND (
                EXISTS (SELECT 1 FROM ${table} WHERE workspace_id = NEW.workspace_id AND (hash = ${generationHashSql('NEW.id')}
                    OR ${validGenerationHashSql('NEW.id')} IS NOT 1 OR ${validGenerationObjectSql('NEW.data_json')} = 0))
                OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.data_json) THEN NEW.data_json ELSE '{}' END) field
                    JOIN ${table} binding ON (field.key IN ('storage_id','storageId') AND field.value = binding.storage_id)
                        OR (field.key = 'hash' AND binding.workspace_id = NEW.workspace_id AND ${generationHashSql('field.value')} = binding.hash)))
            BEGIN
                SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ${HEAD_TABLE} head JOIN ${GENERATION_TABLE} generation ON generation.generation_id = head.generation_id
                    WHERE head.workspace_id = NEW.workspace_id AND head.hash = ${generationHashSql('NEW.id')} AND generation.state = 'verified')
                    THEN RAISE(ABORT, 'STORAGE_UPLOAD_PENDING_METADATA') END;
                SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ${table} binding JOIN ${HEAD_TABLE} head ON head.generation_id = binding.generation_id
                    WHERE head.workspace_id = NEW.workspace_id AND head.hash = ${generationHashSql('NEW.id')} AND binding.state = 'published_pending_metadata')
                    AND NOT EXISTS (SELECT 1 FROM s_file_meta prior WHERE prior.workspace_id = NEW.workspace_id AND prior.id = NEW.id AND prior.deleted = 0)
                    THEN RAISE(ABORT, 'STORAGE_UPLOAD_RESTORE_RESERVATION_REQUIRED') END;
            END`);
        for (const source of ['s_messages', 's_posts']) {
            add(`${source}_upload_${event.toLowerCase()}`, `BEFORE ${event} ON ${source}
                WHEN NEW.deleted = 0 AND EXISTS (SELECT 1 FROM ${table} WHERE workspace_id = NEW.workspace_id)
                BEGIN
                    SELECT CASE WHEN ${validGenerationReferencesSql('NEW.data_json')} = 0 THEN RAISE(ABORT, 'STORAGE_UPLOAD_UNKNOWN_REFERENCES') END;
                    SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(${generationReferencesSql('NEW.data_json')}) edge
                        JOIN ${table} binding ON binding.workspace_id = NEW.workspace_id AND binding.hash = ${generationHashSql('edge.value')}
                        WHERE NOT EXISTS (SELECT 1 FROM ${HEAD_TABLE} head JOIN ${GENERATION_TABLE} generation ON generation.generation_id = head.generation_id
                            WHERE head.workspace_id = NEW.workspace_id AND head.hash = binding.hash AND generation.state = 'verified'
                                AND (EXISTS (SELECT 1 FROM s_file_meta metadata WHERE metadata.workspace_id = head.workspace_id
                                    AND ${generationHashSql('metadata.id')} = head.hash AND metadata.deleted = 0)
                                    OR EXISTS (SELECT 1 FROM ${table} hold JOIN upload_intents ledger ON ledger.id = hold.intent_id
                                        WHERE hold.generation_id = head.generation_id AND hold.state = 'published_pending_metadata'
                                            AND ${projected('ledger', 'hold')}))))
                        THEN RAISE(ABORT, 'STORAGE_UPLOAD_PENDING_REFERENCE') END;
                END`);
        }
        add(`storage_upload_materialize_${event.toLowerCase()}`, `AFTER ${event} ON s_file_meta WHEN NEW.deleted = 0
            BEGIN
                UPDATE ${table} SET state = 'materialized', reserved_bytes = 0, materialized_at = unixepoch()
                    WHERE workspace_id = NEW.workspace_id AND hash = ${generationHashSql('NEW.id')}
                        AND state = 'published_pending_metadata'
                        AND generation_id IN (SELECT generation_id FROM ${HEAD_TABLE} WHERE workspace_id = NEW.workspace_id AND hash = ${generationHashSql('NEW.id')});
                UPDATE upload_intents SET status = 'consumed', reserved_bytes = 0,
                    consumed_at = (SELECT materialized_at FROM ${table} WHERE intent_id = upload_intents.id)
                    WHERE id IN (SELECT intent_id FROM ${table} WHERE workspace_id = NEW.workspace_id AND hash = ${generationHashSql('NEW.id')}
                        AND state = 'materialized') AND status = 'active';
            END`);
    }
    add('storage_upload_ledger_old_identity', `BEFORE UPDATE ON upload_intents
        WHEN EXISTS (SELECT 1 FROM ${table} WHERE intent_id = OLD.id) AND NEW.id IS NOT OLD.id
        BEGIN SELECT RAISE(ABORT, 'STORAGE_UPLOAD_LEDGER_FENCED'); END`);
    add('storage_upload_ledger_delete', `BEFORE DELETE ON upload_intents
        WHEN EXISTS (SELECT 1 FROM ${table} WHERE intent_id = OLD.id)
        BEGIN SELECT RAISE(ABORT, 'STORAGE_UPLOAD_LEDGER_PERMANENT'); END`);
    add('storage_upload_ledger_replace', `BEFORE INSERT ON upload_intents
        WHEN EXISTS (SELECT 1 FROM ${table} WHERE intent_id = NEW.id)
            AND EXISTS (SELECT 1 FROM upload_intents WHERE id = NEW.id)
        BEGIN SELECT RAISE(ABORT, 'STORAGE_UPLOAD_LEDGER_REUSE'); END`);
    return triggers;
}
