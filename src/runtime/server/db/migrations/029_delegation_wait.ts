import { sql, type Kysely } from 'kysely';

/** Find due parked parents without scanning unrelated response bodies. */
export async function up(db: Kysely<unknown>): Promise<void> {
    // The SQLite and D1 migrators do not wrap DDL in a transaction. Each step
    // must therefore tolerate a restart after any earlier step committed.
    const columns = new Set((await sql<{ name: string }>`PRAGMA table_info(background_jobs)`.execute(db)).rows.map((row) => row.name));
    if (!columns.has('delegation_admission_digest')) await sql`ALTER TABLE background_jobs ADD COLUMN delegation_admission_digest TEXT`.execute(db);
    if (!columns.has('delegation_parent_id')) await sql`ALTER TABLE background_jobs ADD COLUMN delegation_parent_id TEXT`.execute(db);
    if (!columns.has('delegation_history_retry_at')) await sql`ALTER TABLE background_jobs ADD COLUMN delegation_history_retry_at INTEGER NOT NULL DEFAULT 0`.execute(db);
    if (!columns.has('delegation_wait_active')) await sql`ALTER TABLE background_jobs ADD COLUMN delegation_wait_active INTEGER NOT NULL DEFAULT 0 CHECK (delegation_wait_active IN (0, 1))`.execute(db);
    if (!columns.has('delegation_wait_deadline')) await sql`ALTER TABLE background_jobs ADD COLUMN delegation_wait_deadline INTEGER`.execute(db);
    // Preserve unreadable legacy execution bytes separately before any JSON
    // index or recovery scan sees them. The neutral marker keeps the job
    // parked; it never supplies a reconstructed request or outcome.
    await sql`CREATE TABLE IF NOT EXISTS background_job_execution_quarantine (
        job_id TEXT PRIMARY KEY REFERENCES background_jobs(id) ON DELETE RESTRICT,
        execution_json TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER
    )`.execute(db);
    await sql`INSERT INTO background_job_execution_quarantine (job_id, execution_json, lease_owner, lease_expires_at)
        SELECT id, execution_json, lease_owner, lease_expires_at FROM background_jobs
        WHERE execution_json IS NOT NULL AND json_valid(execution_json) = 0
        ON CONFLICT(job_id) DO NOTHING`.execute(db);
    const conflict = await sql<{ job_id: string }>`SELECT evidence.job_id FROM background_job_execution_quarantine AS evidence
        JOIN background_jobs AS job ON job.id = evidence.job_id
        WHERE job.execution_json IS NOT NULL AND json_valid(job.execution_json) = 0
          AND job.execution_json IS NOT evidence.execution_json LIMIT 1`.execute(db);
    if (conflict.rows.length) throw new Error('Conflicting quarantined background job execution evidence');
    await sql`UPDATE background_jobs SET execution_json = '{"version":1,"delegationQuarantinedAt":0}',
        delegation_wait_active = 1, delegation_wait_deadline = NULL, lease_owner = NULL, lease_expires_at = NULL
        WHERE id IN (SELECT job_id FROM background_job_execution_quarantine)`.execute(db);
    await sql`UPDATE background_jobs SET delegation_wait_active = 1, delegation_wait_deadline =
        CASE WHEN json_type(execution_json, '$.delegationWait.deadlineAt') = 'integer'
            THEN json_extract(execution_json, '$.delegationWait.deadlineAt') ELSE NULL END
        WHERE json_type(execution_json, '$.delegationWait') IS NOT NULL`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS background_jobs_delegation_deadline ON background_jobs(delegation_wait_deadline, started_at, id)
        WHERE delegation_wait_active = 1 AND status = 'streaming'
          AND (json_type(execution_json, '$.delegationWait') IS NOT 'object' OR
            (json_extract(execution_json, '$.delegationWait.version') = 1 AND
              (json_type(execution_json, '$.delegationQuarantinedAt') IS NOT NULL OR
               json_extract(execution_json, '$.delegationWait.deadlineAt') IS NOT delegation_wait_deadline)))`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS background_jobs_delegation_terminal_damage ON background_jobs(started_at, id)
        WHERE delegation_wait_active = 1 AND status != 'streaming'
          AND (json_type(execution_json, '$.delegationWait') IS NOT 'object' OR
            (json_extract(execution_json, '$.delegationWait.version') = 1 AND
              (json_type(execution_json, '$.delegationQuarantinedAt') IS NOT NULL OR
               json_extract(execution_json, '$.delegationWait.deadlineAt') IS NOT delegation_wait_deadline)))`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS background_jobs_delegation_missing_wait ON background_jobs(started_at, id)
        WHERE delegation_wait_active = 1 AND json_type(execution_json, '$.delegationWait') IS NULL`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS background_jobs_delegation_parent ON background_jobs(delegation_parent_id, id)
        WHERE delegation_parent_id IS NOT NULL`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS background_jobs_delegation_due
        ON background_jobs(json_extract(execution_json, '$.delegationWait.nextCheckAt'), started_at, id)
        WHERE json_type(execution_json, '$.delegationWait') IS NOT NULL`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS background_jobs_delegation_invalid_due ON background_jobs(started_at, id)
        WHERE json_extract(execution_json, '$.version') = 1
          AND json_type(execution_json, '$.delegationWait') IS NOT NULL
          AND json_extract(execution_json, '$.delegationWait.version') = 1
          AND json_type(execution_json, '$.delegationQuarantinedAt') IS NULL
          AND (COALESCE(json_type(execution_json, '$.delegationWait.nextCheckAt'), 'missing') NOT IN ('integer', 'real')
            OR json_extract(execution_json, '$.delegationWait.nextCheckAt') < 0
            OR json_extract(execution_json, '$.delegationWait.nextCheckAt') > 9007199254740991
            OR json_extract(execution_json, '$.delegationWait.nextCheckAt') != CAST(json_extract(execution_json, '$.delegationWait.nextCheckAt') AS INTEGER))`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS background_jobs_delegation_unsupported ON background_jobs(started_at, id)
        WHERE json_type(execution_json, '$.delegationWait') IS NOT NULL
          AND (json_extract(execution_json, '$.version') IS NOT 1
            OR json_extract(execution_json, '$.delegationWait.version') IS NOT 1)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS background_jobs_delegation_quarantined ON background_jobs(started_at, id)
        WHERE json_type(execution_json, '$.delegationQuarantinedAt') IS NOT NULL`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS background_jobs_delegation_history_due
        ON background_jobs(history_phase, delegation_history_retry_at, started_at, id)
        WHERE history_phase IN ('admission_pending', 'finalization_pending')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await sql`DROP INDEX IF EXISTS background_jobs_delegation_deadline`.execute(db);
    await sql`DROP INDEX IF EXISTS background_jobs_delegation_terminal_damage`.execute(db);
    await sql`DROP INDEX IF EXISTS background_jobs_delegation_missing_wait`.execute(db);
    await sql`DROP INDEX IF EXISTS background_jobs_delegation_history_due`.execute(db);
    await sql`DROP INDEX IF EXISTS background_jobs_delegation_quarantined`.execute(db);
    await sql`DROP INDEX IF EXISTS background_jobs_delegation_unsupported`.execute(db);
    await sql`DROP INDEX IF EXISTS background_jobs_delegation_invalid_due`.execute(db);
    await sql`DROP INDEX IF EXISTS background_jobs_delegation_due`.execute(db);
    await sql`DROP INDEX IF EXISTS background_jobs_delegation_parent`.execute(db);
    // Restore exact bytes on rollback, without reviving stale worker leases.
    await sql`UPDATE background_jobs SET execution_json = (
        SELECT execution_json FROM background_job_execution_quarantine AS evidence
        WHERE evidence.job_id = background_jobs.id)
        WHERE id IN (SELECT job_id FROM background_job_execution_quarantine)`.execute(db);
    await sql`DROP TABLE background_job_execution_quarantine`.execute(db);
    await sql`ALTER TABLE background_jobs DROP COLUMN delegation_wait_deadline`.execute(db);
    await sql`ALTER TABLE background_jobs DROP COLUMN delegation_wait_active`.execute(db);
    await sql`ALTER TABLE background_jobs DROP COLUMN delegation_parent_id`.execute(db);
    await sql`ALTER TABLE background_jobs DROP COLUMN delegation_history_retry_at`.execute(db);
    await sql`ALTER TABLE background_jobs DROP COLUMN delegation_admission_digest`.execute(db);
}
