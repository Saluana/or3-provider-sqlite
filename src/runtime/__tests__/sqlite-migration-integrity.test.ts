import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sql, type Kysely } from 'kysely';
import {
    _resetForTest,
    destroySqliteDb,
    getRawDb,
    initializeSqliteDb,
} from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { down as rollbackDelegation } from '../server/db/migrations/029_delegation_wait';
import { SqliteBackgroundJobProvider } from '../server/background-jobs/sqlite-provider';
import { createD1TestDatabase } from '../../../test/support/d1-test-database';

beforeEach(() => {
    _resetForTest();
});

afterEach(async () => {
    await destroySqliteDb();
    vi.unstubAllGlobals();
});

describe('SQLite migration integrity boundaries', () => {
    it('resumes a migration interrupted after preserving malformed execution bytes', async () => {
        const db = await initializeSqliteDb({ path: ':memory:' });
        await runMigrations(db);
        await rollbackDelegation(db as unknown as Kysely<unknown>);
        const raw = getRawDb();
        raw.prepare("DELETE FROM kysely_migration WHERE name = '029_delegation_wait'").run();
        const malformed = '{"private":';
        raw.prepare(`INSERT INTO background_jobs
            (id, user_id, thread_id, message_id, model, status, started_at, last_activity_at, execution_json, lease_owner, lease_expires_at)
            VALUES ('interrupted', 'owner', 'thread', 'message', 'model', 'streaming', 1, 1, ?, 'worker', 100)`)
            .run(malformed);
        raw.exec(`CREATE TRIGGER interrupt_delegation_migration BEFORE UPDATE OF execution_json ON background_jobs
            BEGIN SELECT RAISE(ABORT, 'injected migration interruption'); END`);

        await expect(runMigrations(db)).rejects.toThrow('injected migration interruption');
        expect(raw.prepare("SELECT execution_json, lease_owner FROM background_jobs WHERE id = 'interrupted'").get())
            .toEqual({ execution_json: malformed, lease_owner: 'worker' });
        expect(raw.prepare("SELECT execution_json FROM background_job_execution_quarantine WHERE job_id = 'interrupted'").get())
            .toEqual({ execution_json: malformed });
        raw.exec('DROP TRIGGER interrupt_delegation_migration');
        // Also interrupt after the replacement and several index creations.
        raw.exec('CREATE TABLE background_jobs_delegation_invalid_due (id INTEGER)');
        await expect(runMigrations(db)).rejects.toThrow(/background_jobs_delegation_invalid_due/);
        expect(raw.prepare("SELECT execution_json, lease_owner, delegation_wait_active FROM background_jobs WHERE id = 'interrupted'").get())
            .toEqual({ execution_json: '{"version":1,"delegationQuarantinedAt":0}', lease_owner: null, delegation_wait_active: 1 });
        expect(raw.prepare("SELECT execution_json FROM background_job_execution_quarantine WHERE job_id = 'interrupted'").get())
            .toEqual({ execution_json: malformed });
        raw.exec('DROP TABLE background_jobs_delegation_invalid_due');

        await expect(runMigrations(db)).resolves.toBeUndefined();
        expect(raw.prepare("SELECT execution_json, lease_owner, delegation_wait_active FROM background_jobs WHERE id = 'interrupted'").get())
            .toEqual({ execution_json: '{"version":1,"delegationQuarantinedAt":0}', lease_owner: null, delegation_wait_active: 1 });
        expect(raw.prepare("SELECT execution_json, lease_owner FROM background_job_execution_quarantine WHERE job_id = 'interrupted'").get())
            .toEqual({ execution_json: malformed, lease_owner: 'worker' });
    });

    it('resumes the same interrupted migration through the D1 dialect', async () => {
        const d1 = createD1TestDatabase();
        try {
            const db = await initializeSqliteDb({ driver: 'd1', d1Database: d1.database });
            await runMigrations(db);
            await rollbackDelegation(db as unknown as Kysely<unknown>);
            await sql`DELETE FROM kysely_migration WHERE name = '029_delegation_wait'`.execute(db);
            const malformed = '{"private":';
            await sql`INSERT INTO background_jobs
                (id, user_id, thread_id, message_id, model, status, started_at, last_activity_at, execution_json)
                VALUES ('interrupted', 'owner', 'thread', 'message', 'model', 'streaming', 1, 1, ${malformed})`.execute(db);
            await sql`CREATE TRIGGER interrupt_delegation_migration BEFORE UPDATE OF execution_json ON background_jobs
                BEGIN SELECT RAISE(ABORT, 'injected migration interruption'); END`.execute(db);
            await expect(runMigrations(db)).rejects.toThrow('injected migration interruption');
            await sql`DROP TRIGGER interrupt_delegation_migration`.execute(db);
            await expect(runMigrations(db)).resolves.toBeUndefined();
            const evidence = await sql<{ execution_json: string }>`SELECT execution_json
                FROM background_job_execution_quarantine WHERE job_id = 'interrupted'`.execute(db);
            expect(evidence.rows).toEqual([{ execution_json: malformed }]);
            const job = await sql<{ delegation_wait_active: number; lease_owner: string | null }>`SELECT delegation_wait_active, lease_owner
                FROM background_jobs WHERE id = 'interrupted'`.execute(db);
            expect(job.rows).toEqual([{ delegation_wait_active: 1, lease_owner: null }]);
        } finally {
            await destroySqliteDb();
            d1.close();
        }
    });

    it('preserves malformed legacy job executions while healthy jobs remain recoverable', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'or3-corrupt-job-migration-'));
        const path = join(directory, 'jobs.sqlite');
        try {
            let db = await initializeSqliteDb({ path });
            await runMigrations(db);
            await rollbackDelegation(db as unknown as Kysely<unknown>);
            const raw = getRawDb();
            raw.prepare("DELETE FROM kysely_migration WHERE name = '029_delegation_wait'").run();
            const now = Date.now();
            const insert = raw.prepare(`INSERT INTO background_jobs
                (id, user_id, thread_id, message_id, model, status, started_at, last_activity_at,
                 completed_at, execution_json, generation_id, history_phase, lease_owner, lease_expires_at)
                VALUES (?, 'owner', 'thread', ?, 'model', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            const malformed = '{"body":"private fixture",';
            const malformedTerminal = '[not valid';
            const healthyExecution = JSON.stringify({ version: 1, body: { model: 'model', messages: [] } });
            insert.run('bad-active', 'message-a', 'streaming', now, now, null, malformed, 'gen-a', 'admission_pending', 'old-worker', now + 60_000);
            insert.run('bad-terminal', 'message-b', 'complete', now - 172_800_000, now - 172_800_000, now - 172_800_000, malformedTerminal, 'gen-b', 'finalization_pending', null, null);
            insert.run('healthy', 'message-c', 'streaming', now, now, null, healthyExecution, null, null, null, null);

            await expect(runMigrations(db)).resolves.toBeUndefined();
            const quarantined = raw.prepare(`SELECT job_id, execution_json, lease_owner, lease_expires_at
                FROM background_job_execution_quarantine ORDER BY job_id`).all();
            expect(quarantined).toEqual([
                { job_id: 'bad-active', execution_json: malformed, lease_owner: 'old-worker', lease_expires_at: now + 60_000 },
                { job_id: 'bad-terminal', execution_json: malformedTerminal, lease_owner: null, lease_expires_at: null },
            ]);
            const provider = new SqliteBackgroundJobProvider();
            expect(await provider.claimJob('bad-active', 'replay', now, now + 60_000)).toBeNull();
            expect(await provider.claimNextJob('healthy-worker', now, now + 60_000)).toMatchObject({ id: 'healthy' });
            expect(await provider.getPendingHistoryJobs(20)).toEqual([]);
            expect(await provider.getShutdownBlockerCount()).toBe(3);
            vi.stubGlobal('useRuntimeConfig', () => ({ backgroundJobs: { completedJobRetentionMs: 1 } }));
            await provider.cleanupExpired();
            await destroySqliteDb();
            db = await initializeSqliteDb({ path });
            await runMigrations(db);
            expect(getRawDb().prepare('SELECT job_id, execution_json FROM background_job_execution_quarantine ORDER BY job_id').all())
                .toEqual([{ job_id: 'bad-active', execution_json: malformed }, { job_id: 'bad-terminal', execution_json: malformedTerminal }]);
            expect(await new SqliteBackgroundJobProvider().getShutdownBlockerCount()).toBe(3);
            await rollbackDelegation(db as unknown as Kysely<unknown>);
            expect(getRawDb().prepare("SELECT id, execution_json FROM background_jobs WHERE id LIKE 'bad-%' ORDER BY id").all())
                .toEqual([{ id: 'bad-active', execution_json: malformed }, { id: 'bad-terminal', execution_json: malformedTerminal }]);
            expect(getRawDb().prepare("SELECT lease_owner, lease_expires_at FROM background_jobs WHERE id = 'bad-active'").get())
                .toEqual({ lease_owner: null, lease_expires_at: null });
        } finally {
            await destroySqliteDb();
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('refuses to start from a database created by a newer migration set', async () => {
        const db = await initializeSqliteDb({ path: ':memory:' });
        await runMigrations(db);
        const raw = getRawDb();
        raw.prepare(
            'INSERT INTO kysely_migration (name, timestamp) VALUES (?, ?)'
        ).run('999_future_release', new Date().toISOString());

        await expect(runMigrations(db)).rejects.toThrow(
            /corrupted migrations|previously executed migration/i
        );

        expect(
            raw
                .prepare(
                    "SELECT COUNT(*) AS count FROM kysely_migration WHERE name = '999_future_release'"
                )
                .get()
        ).toMatchObject({ count: 1 });
    });

    it('fails closed when the migration ledger is current but required schema is missing', async () => {
        const db = await initializeSqliteDb({ path: ':memory:' });
        await runMigrations(db);
        const raw = getRawDb();
        raw.exec('DROP TABLE upload_intents');

        await expect(runMigrations(db)).rejects.toThrow(
            /schema integrity check failed.*upload_intents/i
        );
    });
});
