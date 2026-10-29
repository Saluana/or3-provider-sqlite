import { sql, type Kysely } from 'kysely';

/** Keep quota proportional to retained immutable content, not visible metadata.
 * Logical deletes/receipt expiry cannot release physical storage charges. External
 * storage deletion remains fail-closed; this ledger deliberately never decrements.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql`CREATE TABLE retained_storage (
        workspace_id TEXT NOT NULL, hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        PRIMARY KEY(workspace_id, hash)
    )`.execute(db);
    await sql`CREATE TABLE storage_usage (
        workspace_id TEXT PRIMARY KEY, used_bytes INTEGER NOT NULL
    )`.execute(db);
    await sql`CREATE TRIGGER retained_storage_insert AFTER INSERT ON retained_storage BEGIN
        INSERT INTO storage_usage(workspace_id, used_bytes) VALUES(NEW.workspace_id, NEW.size_bytes)
        ON CONFLICT(workspace_id) DO UPDATE SET used_bytes = used_bytes + NEW.size_bytes;
    END`.execute(db);
    await sql`CREATE TRIGGER retained_storage_update AFTER UPDATE OF size_bytes ON retained_storage BEGIN
        UPDATE storage_usage SET used_bytes = used_bytes + NEW.size_bytes - OLD.size_bytes
        WHERE workspace_id = NEW.workspace_id;
    END`.execute(db);

    // Missing-size tombstones carry no new charge. Malformed known sizes fail
    // closed by consuming the safe integer ceiling rather than releasing space.
    const hash = (id: string) => `lower(CASE WHEN instr(trim(${id}), ':') > 0
        THEN substr(trim(${id}), instr(trim(${id}), ':') + 1) ELSE trim(${id}) END)`;
    const size = (data: string) => `CASE WHEN typeof(COALESCE(json_extract(${data}, '$.size_bytes'), json_extract(${data}, '$.sizeBytes'))) IN ('integer','real')
        AND COALESCE(json_extract(${data}, '$.size_bytes'), json_extract(${data}, '$.sizeBytes')) BETWEEN 0 AND 9007199254740991
        AND COALESCE(json_extract(${data}, '$.size_bytes'), json_extract(${data}, '$.sizeBytes')) = CAST(COALESCE(json_extract(${data}, '$.size_bytes'), json_extract(${data}, '$.sizeBytes')) AS INTEGER)
        THEN CAST(COALESCE(json_extract(${data}, '$.size_bytes'), json_extract(${data}, '$.sizeBytes')) AS INTEGER)
        ELSE 9007199254740991 END`;
    const known = (data: string) => `(json_type(${data}, '$.size_bytes') IS NOT NULL OR json_type(${data}, '$.sizeBytes') IS NOT NULL)`;
    for (const operation of ['INSERT', 'UPDATE'] as const) {
        await sql.raw(`CREATE TRIGGER file_meta_retained_${operation.toLowerCase()} AFTER ${operation} ON s_file_meta
            WHEN ${known('NEW.data_json')} BEGIN
            INSERT INTO retained_storage(workspace_id, hash, size_bytes)
            VALUES(NEW.workspace_id, ${hash('NEW.id')}, ${size('NEW.data_json')})
            ON CONFLICT(workspace_id, hash) DO UPDATE SET size_bytes = MAX(size_bytes, excluded.size_bytes);
        END`).execute(db);
        await sql.raw(`CREATE TRIGGER upload_retained_${operation.toLowerCase()} AFTER ${operation} ON upload_intents
            WHEN NEW.status = 'consumed' BEGIN
            INSERT INTO retained_storage(workspace_id, hash, size_bytes)
            VALUES(NEW.workspace_id, NEW.hash, NEW.size_bytes)
            ON CONFLICT(workspace_id, hash) DO UPDATE SET size_bytes = MAX(size_bytes, excluded.size_bytes);
        END`).execute(db);
    }
    await sql.raw(`INSERT INTO retained_storage(workspace_id, hash, size_bytes)
        SELECT workspace_id, ${hash('id')}, ${size('data_json')} FROM s_file_meta WHERE ${known('data_json')}
        ON CONFLICT(workspace_id, hash) DO UPDATE SET size_bytes = MAX(size_bytes, excluded.size_bytes)`).execute(db);
    await sql`INSERT INTO retained_storage(workspace_id, hash, size_bytes)
        SELECT workspace_id, hash, size_bytes FROM upload_intents WHERE status = 'consumed'
        ON CONFLICT(workspace_id, hash) DO UPDATE SET size_bytes = MAX(size_bytes, excluded.size_bytes)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    for (const name of ['file_meta_retained_insert', 'file_meta_retained_update', 'upload_retained_insert',
        'upload_retained_update', 'retained_storage_insert', 'retained_storage_update']) {
        await sql.raw(`DROP TRIGGER IF EXISTS ${name}`).execute(db);
    }
    await sql`DROP TABLE IF EXISTS retained_storage`.execute(db);
    await sql`DROP TABLE IF EXISTS storage_usage`.execute(db);
}
