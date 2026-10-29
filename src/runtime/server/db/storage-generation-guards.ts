/** Dormant managed-generation barriers. All identifiers below are internal constants. */
export const GENERATION_TABLE = 'storage_object_generations';
export const HEAD_TABLE = 'storage_object_heads';
export const MAX_GENERATION_PAYLOAD_BYTES = 256 * 1024;
export const MAX_GENERATION_ROW_EDGES = 1000;
export const GENERATION_PROOF_ROWS = 1000;
export const GENERATION_PROOF_EDGES = 10000;

/** Do not trim: whitespace and unknown prefixes are invalid, never invisible aliases. */
export function generationHashSql(value: string): string {
    return `(CASE WHEN lower(substr(${value}, 1, 7)) = 'sha256:' THEN lower(substr(${value}, 8))
        WHEN lower(substr(${value}, 1, 4)) = 'md5:' THEN lower(substr(${value}, 5)) ELSE lower(${value}) END)`;
}

export function validGenerationHashSql(value: string): string {
    const hash = generationHashSql(value);
    return `(typeof(${value}) = 'text' AND length(CAST(${value} AS BLOB)) = length(${value})
        AND ${hash} NOT GLOB '*[^0-9a-f]*'
        AND ((length(${value}) IN (32, 64) AND length(${hash}) = length(${value}))
            OR (length(${value}) = 71 AND lower(substr(${value}, 1, 7)) = 'sha256:' AND length(${hash}) = 64)
            OR (length(${value}) = 36 AND lower(substr(${value}, 1, 4)) = 'md5:' AND length(${hash}) = 32)))`;
}

/** JSON path labels containing NUL can shadow exact keys in SQLite. */
export function validGenerationObjectSql(json: string): string {
    return `(CASE WHEN typeof(${json}) <> 'text' OR length(CAST(${json} AS BLOB)) > ${MAX_GENERATION_PAYLOAD_BYTES}
        OR json_valid(${json}) IS NOT 1 THEN 0
        WHEN json_type(${json}) <> 'object' THEN 0
        WHEN EXISTS (SELECT 1 FROM json_each(${json}) WHERE instr(key, char(0)) > 0) THEN 0
        WHEN EXISTS (SELECT 1 FROM json_each(${json}) GROUP BY key HAVING count(*) > 1) THEN 0
        ELSE 1 END)`;
}

export function generationReferencesSql(json: string): string {
    return `(CASE WHEN json_type(${json}, '$.file_hashes') IS NULL OR json_type(${json}, '$.file_hashes') = 'null' THEN '[]'
        ELSE json_extract(${json}, '$.file_hashes') END)`;
}

export function validGenerationReferencesSql(json: string): string {
    const refs = generationReferencesSql(json);
    return `(CASE WHEN ${validGenerationObjectSql(json)} = 0 THEN 0
        WHEN json_type(${json}, '$.fileHashes') IS NOT NULL THEN 0
        WHEN json_type(${json}, '$.file_hashes') IS NULL OR json_type(${json}, '$.file_hashes') = 'null' THEN 1
        WHEN json_type(${json}, '$.file_hashes') NOT IN ('text', 'array') THEN 0
        WHEN json_valid(${refs}) IS NOT 1 THEN 0
        WHEN json_type(${refs}) <> 'array' OR json_array_length(${refs}) > ${MAX_GENERATION_ROW_EDGES} THEN 0
        WHEN EXISTS (SELECT 1 FROM json_each(${refs}) WHERE type <> 'text' OR NOT ${validGenerationHashSql('value')}) THEN 0
        ELSE 1 END)`;
}

function safeReferencesSql(json: string): string {
    return `(CASE WHEN ${validGenerationReferencesSql(json)} = 1 THEN ${generationReferencesSql(json)} ELSE '[]' END)`;
}

function metadataStorageSql(json: string): string {
    return `coalesce(json_extract(${json}, '$.storage_id'), json_extract(${json}, '$.storageId'))`;
}

function sourceTouch(table: string, row: 'OLD' | 'NEW' | 'prior', prior = false): string {
    const match = `${row}.deleted = 0 AND ${row}.workspace_id = ${GENERATION_TABLE}.workspace_id
        AND (${validGenerationReferencesSql(`${row}.data_json`)} = 0
            OR ${GENERATION_TABLE}.hash IN (SELECT ${generationHashSql('value')} FROM json_each(${safeReferencesSql(`${row}.data_json`)})))`;
    return `UPDATE ${GENERATION_TABLE} SET last_activity_at = max(last_activity_at, unixepoch())
        WHERE state = 'verified' AND generation_id IN (SELECT generation_id FROM ${HEAD_TABLE})
        AND ${prior ? `EXISTS (SELECT 1 FROM ${table} prior WHERE ${table === 'upload_intents' ? '' : 'prior.workspace_id = NEW.workspace_id AND '}prior.id = NEW.id AND ${match})` : `(${match})`};`;
}

function keyTouch(table: string, row: 'OLD' | 'NEW' | 'prior', prior = false): string {
    const column = table === 's_file_meta' ? 'id' : 'hash';
    const match = `${row}.workspace_id = ${GENERATION_TABLE}.workspace_id
        AND ${generationHashSql(`${row}.${column}`)} = ${GENERATION_TABLE}.hash
        ${table === 'upload_intents' ? `AND ${row}.status = 'active'` : ''}`;
    return `UPDATE ${GENERATION_TABLE} SET last_activity_at = max(last_activity_at, unixepoch())
        WHERE state = 'verified' AND generation_id IN (SELECT generation_id FROM ${HEAD_TABLE})
        AND ${prior ? `EXISTS (SELECT 1 FROM ${table} prior WHERE ${table === 'upload_intents' ? '' : 'prior.workspace_id = NEW.workspace_id AND '}prior.id = NEW.id AND ${match})` : `(${match})`};`;
}

/** Exact SQL is also checked inside every coordinator mutation transaction. */
export function generationGuardTriggers(): Record<string, string> {
    const triggers: Record<string, string> = {};
    const add = (name: string, clause: string) => { triggers[name] = `CREATE TRIGGER ${name} ${clause}`; };
    add('storage_generation_no_replace', `BEFORE INSERT ON ${GENERATION_TABLE}
        WHEN EXISTS (SELECT 1 FROM ${GENERATION_TABLE} WHERE generation_id = NEW.generation_id OR storage_id = NEW.storage_id)
        BEGIN SELECT RAISE(ABORT, 'STORAGE_GENERATION_IDENTITY_REUSE'); END`);
    add('storage_generation_no_delete', `BEFORE DELETE ON ${GENERATION_TABLE}
        BEGIN SELECT RAISE(ABORT, 'STORAGE_GENERATION_PERMANENT'); END`);
    add('storage_generation_immutable', `BEFORE UPDATE ON ${GENERATION_TABLE}
        WHEN NEW.generation_id IS NOT OLD.generation_id OR NEW.workspace_id IS NOT OLD.workspace_id
            OR NEW.hash IS NOT OLD.hash OR NEW.storage_id IS NOT OLD.storage_id
            OR NEW.storage_provider_id IS NOT OLD.storage_provider_id OR NEW.size_bytes IS NOT OLD.size_bytes
            OR NEW.created_at IS NOT OLD.created_at OR NEW.last_activity_at < OLD.last_activity_at
            OR (OLD.state = 'verified' AND NEW.state = 'deleted')
            OR (OLD.state <> 'verified' AND NEW.last_activity_at IS NOT OLD.last_activity_at)
            OR (OLD.state <> 'verified' AND (NEW.claim_id IS NOT OLD.claim_id OR NEW.claimed_at IS NOT OLD.claimed_at))
            OR (OLD.state = 'claimed' AND NEW.state NOT IN ('claimed', 'deleted'))
            OR (OLD.state = 'deleted' AND (NEW.state <> 'deleted' OR NEW.deleted_at IS NOT OLD.deleted_at))
        BEGIN SELECT RAISE(ABORT, 'STORAGE_GENERATION_IMMUTABLE'); END`);
    add('storage_generation_head_insert', `BEFORE INSERT ON ${HEAD_TABLE}
        WHEN EXISTS (SELECT 1 FROM ${HEAD_TABLE} WHERE workspace_id = NEW.workspace_id AND hash = NEW.hash)
            OR NOT EXISTS (SELECT 1 FROM ${GENERATION_TABLE} WHERE generation_id = NEW.generation_id
                AND workspace_id = NEW.workspace_id AND hash = NEW.hash AND state = 'verified')
        BEGIN SELECT RAISE(ABORT, 'STORAGE_GENERATION_HEAD_CONFLICT'); END`);
    add('storage_generation_head_update', `BEFORE UPDATE ON ${HEAD_TABLE}
        WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.hash IS NOT OLD.hash
            OR NOT EXISTS (SELECT 1 FROM ${GENERATION_TABLE} WHERE generation_id = OLD.generation_id AND state IN ('claimed', 'deleted'))
            OR NOT EXISTS (SELECT 1 FROM ${GENERATION_TABLE} WHERE generation_id = NEW.generation_id
                AND workspace_id = NEW.workspace_id AND hash = NEW.hash AND state = 'verified')
        BEGIN SELECT RAISE(ABORT, 'STORAGE_GENERATION_HEAD_CONFLICT'); END`);
    add('storage_generation_head_no_delete', `BEFORE DELETE ON ${HEAD_TABLE}
        BEGIN SELECT RAISE(ABORT, 'STORAGE_GENERATION_HEAD_PERMANENT'); END`);

    for (const table of ['s_messages', 's_posts']) {
        for (const event of ['INSERT', 'UPDATE']) {
            add(`${table}_generation_guard_${event.toLowerCase()}`, `BEFORE ${event} ON ${table}
                WHEN NEW.deleted = 0 AND EXISTS (SELECT 1 FROM ${HEAD_TABLE} WHERE workspace_id = NEW.workspace_id)
                BEGIN
                    SELECT CASE WHEN ${validGenerationReferencesSql('NEW.data_json')} = 0
                        THEN RAISE(ABORT, 'STORAGE_GENERATION_UNKNOWN_REFERENCES') END;
                    SELECT CASE WHEN EXISTS (
                        SELECT 1 FROM json_each(${generationReferencesSql('NEW.data_json')}) edge
                        JOIN ${HEAD_TABLE} head ON head.workspace_id = NEW.workspace_id AND head.hash = ${generationHashSql('edge.value')}
                        JOIN ${GENERATION_TABLE} generation ON generation.generation_id = head.generation_id
                        WHERE generation.state <> 'verified') THEN RAISE(ABORT, 'STORAGE_GENERATION_CLAIMED') END;
                END`);
        }
    }

    const knownMetadata = `EXISTS (SELECT 1 FROM ${HEAD_TABLE} WHERE workspace_id = NEW.workspace_id
            AND (hash = ${generationHashSql('NEW.id')} OR ${validGenerationHashSql('NEW.id')} IS NOT 1
                OR CASE WHEN ${validGenerationObjectSql('NEW.data_json')} = 0 THEN 1
                    WHEN json_type(NEW.data_json, '$.hash') IS NOT NULL THEN
                        ${validGenerationHashSql("json_extract(NEW.data_json, '$.hash')")} IS NOT 1
                        OR ${generationHashSql("json_extract(NEW.data_json, '$.hash')")} IS NOT ${generationHashSql('NEW.id')}
                    ELSE 0 END))
        OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.data_json) THEN NEW.data_json ELSE '{}' END) field
            JOIN ${GENERATION_TABLE} generation ON generation.storage_id = field.value
            WHERE field.key IN ('storage_id', 'storageId') AND field.type = 'text')`;
    for (const event of ['INSERT', 'UPDATE']) {
        add(`s_file_meta_generation_guard_${event.toLowerCase()}`, `BEFORE ${event} ON s_file_meta
            WHEN NEW.deleted = 0 AND (${knownMetadata})
            BEGIN
                SELECT CASE WHEN ${validGenerationObjectSql('NEW.data_json')} = 0
                    THEN RAISE(ABORT, 'STORAGE_GENERATION_INVALID_METADATA') END;
                SELECT CASE WHEN (json_type(NEW.data_json, '$.storage_id') IS NOT NULL AND json_type(NEW.data_json, '$.storageId') IS NOT NULL)
                    OR (json_type(NEW.data_json, '$.size_bytes') IS NOT NULL AND json_type(NEW.data_json, '$.sizeBytes') IS NOT NULL)
                    THEN RAISE(ABORT, 'STORAGE_GENERATION_AMBIGUOUS_METADATA') END;
                SELECT CASE WHEN NOT EXISTS (
                    SELECT 1 FROM ${HEAD_TABLE} head JOIN ${GENERATION_TABLE} generation ON generation.generation_id = head.generation_id
                    WHERE head.workspace_id = NEW.workspace_id AND head.hash = ${generationHashSql('NEW.id')}
                        AND generation.state = 'verified' AND ${validGenerationHashSql('NEW.id')}
                        AND ${validGenerationHashSql("json_extract(NEW.data_json, '$.hash')")}
                        AND ${generationHashSql("json_extract(NEW.data_json, '$.hash')")} = head.hash
                        AND typeof(${metadataStorageSql('NEW.data_json')}) = 'text'
                        AND ${metadataStorageSql('NEW.data_json')} = generation.storage_id
                        AND typeof(coalesce(json_extract(NEW.data_json, '$.size_bytes'), json_extract(NEW.data_json, '$.sizeBytes'))) = 'integer'
                        AND coalesce(json_extract(NEW.data_json, '$.size_bytes'), json_extract(NEW.data_json, '$.sizeBytes')) = generation.size_bytes
                ) THEN RAISE(ABORT, 'STORAGE_GENERATION_METADATA_MISMATCH') END;
            END`);
        add(`upload_intents_generation_guard_${event.toLowerCase()}`, `BEFORE ${event} ON upload_intents
            WHEN NEW.status = 'active' AND EXISTS (SELECT 1 FROM ${HEAD_TABLE} head
                JOIN ${GENERATION_TABLE} generation ON generation.generation_id = head.generation_id
                WHERE head.workspace_id = NEW.workspace_id AND (${validGenerationHashSql('NEW.hash')} IS NOT 1
                    OR (head.hash = ${generationHashSql('NEW.hash')} AND generation.state <> 'verified')))
            BEGIN SELECT RAISE(ABORT, 'STORAGE_GENERATION_UPLOAD_BLOCKED'); END`);
    }
    add('s_file_meta_generation_identity_update', `BEFORE UPDATE ON s_file_meta
        WHEN (NEW.workspace_id IS NOT OLD.workspace_id OR NEW.id IS NOT OLD.id)
            AND EXISTS (SELECT 1 FROM ${HEAD_TABLE} WHERE workspace_id = OLD.workspace_id AND hash = ${generationHashSql('OLD.id')})
        BEGIN SELECT RAISE(ABORT, 'STORAGE_GENERATION_METADATA_IDENTITY'); END`);

    for (const table of ['s_messages', 's_posts', 's_file_meta', 'upload_intents']) {
        const touch = table === 's_messages' || table === 's_posts' ? sourceTouch : keyTouch;
        // REPLACE may suppress DELETE triggers on old connections. Observe the
        // overwritten row BEFORE INSERT regardless of recursive_triggers.
        add(`${table}_generation_replace_activity`, `BEFORE INSERT ON ${table} BEGIN ${touch(table, 'prior', true)} END`);
        for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
            const rows = event === 'UPDATE' ? ['OLD', 'NEW'] as const : event === 'DELETE' ? ['OLD'] as const : ['NEW'] as const;
            add(`${table}_generation_activity_${event.toLowerCase()}`, `AFTER ${event} ON ${table}
                BEGIN ${rows.map(row => touch(table, row)).join('\n')} END`);
        }
    }
    return triggers;
}

export function canonicalGuardSql(sql: string): string {
    return sql.trim().replace(/;$/, '');
}
