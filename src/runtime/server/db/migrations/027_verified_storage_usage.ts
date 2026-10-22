import { sql, type Kysely } from 'kysely';

/** Client-synced metadata is descriptive, never evidence of retained bytes.
 * Consumed upload receipts are persisted even after their replay TTL expires.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
    await sql`DROP TRIGGER IF EXISTS file_meta_retained_insert`.execute(db);
    await sql`DROP TRIGGER IF EXISTS file_meta_retained_update`.execute(db);
    // Reconcile metadata-inflated maxima while retaining every verified upload.
    // The migration transaction excludes concurrent commits and reservations.
    await sql`DELETE FROM retained_storage`.execute(db);
    await sql`DELETE FROM storage_usage`.execute(db);
    await sql`INSERT INTO retained_storage(workspace_id, hash, size_bytes)
        SELECT workspace_id, hash, MAX(size_bytes) FROM upload_intents
        WHERE status = 'consumed' GROUP BY workspace_id, hash`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
    // Do not restore authority to caller-authored metadata on rollback.
}
