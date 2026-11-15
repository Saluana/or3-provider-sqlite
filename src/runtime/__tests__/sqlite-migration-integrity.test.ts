import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sql, Migrator, type Migration, type Kysely } from 'kysely';
import {
    _resetForTest,
    destroySqliteDb,
    getRawDb,
    initializeSqliteDb,
} from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { down as rollbackStorage } from '../server/db/migrations/030_storage_generations';
import { down as rollbackObservations } from '../server/db/migrations/032_sync_observations';
import { down as rollbackUploads } from '../server/db/migrations/031_storage_generation_uploads';
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
    const historicalProvider = {
        async getMigrations(): Promise<Record<string, Migration>> {
            const files = await readdir(new URL('../server/db/migrations/', import.meta.url));
            return Object.fromEntries(await Promise.all(files.filter(file => file.endsWith('.ts')).map(async file =>
                [file.slice(0, -3), await import(`../server/db/migrations/${file.slice(0, -3)}.ts`) as Migration])));
        },
    };
    async function migrateThrough(db: Kysely<unknown>, name: string) {
        const result = await new Migrator({ db, provider: historicalProvider }).migrateTo(name);
        if (result.error) throw result.error;
    }

    it.each([
        ['005_admin_stores', "ALTER TABLE s_threads ADD COLUMN op_id TEXT NOT NULL DEFAULT ''"],
        ['006_sync_snapshots', 'ALTER TABLE device_cursors ADD COLUMN owner_user_id TEXT'],
        ['018_background_admission_cancels', "ALTER TABLE background_jobs ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''"],
        ['020_background_generation_receipts', 'ALTER TABLE background_jobs ADD COLUMN usage_json TEXT'],
    ])('resumes a historical additive migration after %s', async (base, partial) => {
        const db = await initializeSqliteDb({ path: ':memory:' });
        await migrateThrough(db as unknown as Kysely<unknown>, base!);
        getRawDb().exec(partial!);
        await expect(runMigrations(db)).resolves.toBeUndefined();
        await expect(runMigrations(db)).resolves.toBeUndefined();
    });

    it('repairs legacy tool IDs with indexed updates across growing tables and never reruns completed 033', async () => {
        const db = await initializeSqliteDb({ path: ':memory:' });
        await migrateThrough(db as unknown as Kysely<unknown>, '032_sync_observations');
        const raw = getRawDb();
        raw.exec("INSERT INTO sync_snapshots VALUES ('snapshot', 'ws', 1, '[]', 1, 9999999999)");
        const kv = raw.prepare('INSERT INTO s_kv (id, workspace_id, data_json, op_id) VALUES (?, ?, ?, ?)');
        const items = raw.prepare("INSERT INTO sync_snapshot_items (snapshot_id, table_name, pk, kind, payload_json, clock, hlc, op_id) VALUES ('snapshot', 'kv', ?, 'row', ?, 1, 'hlc', ?)");
        const tombstones = raw.prepare("INSERT INTO tombstones (id, workspace_id, table_name, pk, deleted_at, clock, server_version, op_id) VALUES (?, 'ws', 'kv', ?, 1, 1, 1, ?)");
        raw.transaction(() => {
            for (let n = 0; n < 1100; n++) {
                const id = `key-${n}`;
                const opId = n < 600 ? `background-tool:${n.toString(16).padStart(4, '0').repeat(16)}` : `valid-${n}`;
                const payload = JSON.stringify({ id, op_id: opId });
                kv.run(id, 'ws', payload, opId);
                items.run(id, payload, opId);
                tombstones.run(id, id, opId);
            }
        })();
        const plans: string[] = [];
        const prepare = raw.prepare.bind(raw);
        const spy = vi.spyOn(raw, 'prepare').mockImplementation(query => {
            const statement = prepare(query);
            if (/^UPDATE "?(s_kv|sync_snapshot_items|tombstones)"? SET/i.test(query)) {
                const run = statement.run.bind(statement);
                vi.spyOn(statement, 'run').mockImplementation((...parameters) => {
                    const plan = prepare(`EXPLAIN QUERY PLAN ${query}`).all(...parameters) as { detail: string }[];
                    plans.push(...plan.map(row => row.detail));
                    return run(...parameters);
                });
            }
            return statement;
        });
        await runMigrations(db);
        spy.mockRestore();
        for (const table of ['s_kv', 'sync_snapshot_items', 'tombstones']) {
            expect(raw.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE op_id LIKE 'background-tool:%'`).get()).toEqual({ count: 0 });
            expect(raw.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE op_id LIKE 'valid-%'`).get()).toEqual({ count: 500 });
        }
        expect(raw.prepare("SELECT op_id, data_json FROM s_kv WHERE id = 'key-0'").get()).toEqual({
            op_id: '00000000-0000-4000-8000-000000000000',
            data_json: '{"id":"key-0","op_id":"00000000-0000-4000-8000-000000000000"}',
        });
        expect(plans.length).toBeGreaterThan(0);
        expect(plans.every(plan => /SEARCH .* USING .*INDEX/.test(plan))).toBe(true);
        const late = 'background-tool:' + 'a'.repeat(64);
        kv.run('late', 'ws', '{"id":"late"}', late);
        await runMigrations(db);
        expect(raw.prepare("SELECT op_id FROM s_kv WHERE id = 'late'").get()).toEqual({ op_id: late });
    });

    it('rolls back a destructive rebuild and its ledger before restarting', async () => {
        const db = await initializeSqliteDb({ path: ':memory:' });
        await migrateThrough(db as unknown as Kysely<unknown>, '002_sync_tables');
        const raw = getRawDb();
        raw.exec(`INSERT INTO s_threads (id, workspace_id, data_json) VALUES ('original', 'ws', '{"id":"original"}')`);
        const prepare = raw.prepare.bind(raw);
        const spy = vi.spyOn(raw, 'prepare').mockImplementation(query => {
            const statement = prepare(query);
            if (query === 'DROP TABLE "s_threads"') {
                const run = statement.run.bind(statement);
                vi.spyOn(statement, 'run').mockImplementation((...parameters) => {
                    run(...parameters);
                    throw new Error('injected rebuild interruption');
                });
            }
            return statement;
        });
        await expect(runMigrations(db)).rejects.toThrow('injected rebuild interruption');
        spy.mockRestore();
        expect(raw.prepare('SELECT id, data_json FROM s_threads').all()).toEqual([{ id: 'original', data_json: '{"id":"original"}' }]);
        expect(raw.prepare("SELECT name FROM kysely_migration WHERE name > '002_sync_tables'").all()).toEqual([]);
        await expect(runMigrations(db)).resolves.toBeUndefined();
        expect(raw.prepare('SELECT id FROM s_threads').all()).toEqual([{ id: 'original' }]);
    });

    it('preserves a historical interrupted rebuild for explicit recovery', async () => {
        const db = await initializeSqliteDb({ path: ':memory:' });
        await migrateThrough(db as unknown as Kysely<unknown>, '002_sync_tables');
        const raw = getRawDb();
        raw.exec(`INSERT INTO s_threads (id, workspace_id, data_json) VALUES ('preserved', 'ws', '{}')`);
        raw.exec('ALTER TABLE s_threads RENAME TO s_threads__new');
        await expect(runMigrations(db)).rejects.toThrow(/recover.*s_threads__new/i);
        expect(raw.prepare('SELECT id FROM s_threads__new').all()).toEqual([{ id: 'preserved' }]);
    });

    it('atomically preserves original execution bytes across native migration interruptions', async () => {
        const db = await initializeSqliteDb({ path: ':memory:' });
        await runMigrations(db);
        await rollbackObservations(db as unknown as Kysely<unknown>);
        await rollbackUploads(db as unknown as Kysely<unknown>);
        await rollbackStorage(db as unknown as Kysely<unknown>);
        await rollbackDelegation(db as unknown as Kysely<unknown>);
        const raw = getRawDb();
        raw.prepare("DELETE FROM kysely_migration WHERE name >= '029_delegation_wait'").run();
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
        expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'background_job_execution_quarantine'").all()).toEqual([]);
        raw.exec('DROP TRIGGER interrupt_delegation_migration');
        // Also interrupt after the replacement and several index creations.
        raw.exec('CREATE TABLE background_jobs_delegation_invalid_due (id INTEGER)');
        await expect(runMigrations(db)).rejects.toThrow(/background_jobs_delegation_invalid_due/);
        expect(raw.prepare("SELECT execution_json, lease_owner FROM background_jobs WHERE id = 'interrupted'").get())
            .toEqual({ execution_json: malformed, lease_owner: 'worker' });
        expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'background_job_execution_quarantine'").all()).toEqual([]);
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
            await rollbackObservations(db as unknown as Kysely<unknown>);
            await rollbackUploads(db as unknown as Kysely<unknown>);
            await rollbackStorage(db as unknown as Kysely<unknown>);
            await rollbackDelegation(db as unknown as Kysely<unknown>);
            await sql`DELETE FROM kysely_migration WHERE name >= '029_delegation_wait'`.execute(db);
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
            await rollbackObservations(db as unknown as Kysely<unknown>);
            await rollbackUploads(db as unknown as Kysely<unknown>);
            await rollbackStorage(db as unknown as Kysely<unknown>);
            await rollbackDelegation(db as unknown as Kysely<unknown>);
            const raw = getRawDb();
            raw.prepare("DELETE FROM kysely_migration WHERE name >= '029_delegation_wait'").run();
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
            await rollbackObservations(db as unknown as Kysely<unknown>);
            await rollbackUploads(db as unknown as Kysely<unknown>);
            await rollbackStorage(db as unknown as Kysely<unknown>);
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
    it.each([
        'CREATE TABLE storage_object_generations',
        'CREATE TRIGGER storage_generation_no_delete',
        'CREATE TABLE storage_generation_uploads',
        'DROP TRIGGER upload_intents_generation_guard_insert',
        'CREATE TABLE sync_observations',
        'CREATE INDEX idx_users_admin_created_id',
    ])('resumes the published delegation schema after interruption at %s', async (interruption) => {
        const directory = await mkdtemp(join(tmpdir(), 'or3-storage-upgrade-'));
        const path = join(directory, 'upgrade.sqlite');
        try {
            let db = await initializeSqliteDb({ path });
            await runMigrations(db);
            await rollbackObservations(db as unknown as Kysely<unknown>);
            await rollbackUploads(db as unknown as Kysely<unknown>);
            await rollbackStorage(db as unknown as Kysely<unknown>);
            await sql`DELETE FROM kysely_migration WHERE name > '029_delegation_wait'`.execute(db);
            const raw = getRawDb();
            raw.exec(`INSERT INTO background_jobs
                (id, user_id, thread_id, message_id, model, status, started_at, last_activity_at, execution_json)
                VALUES ('preserved', 'owner', 'thread', 'message', 'model', 'streaming', 1, 1, '{"version":1}')`);
            const prepare = raw.prepare.bind(raw);
            const spy = vi.spyOn(raw, 'prepare').mockImplementation((query: string) => {
                const statement = prepare(query);
                if (query.startsWith(interruption)) {
                    const run = statement.run.bind(statement);
                    vi.spyOn(statement, 'run').mockImplementation((...parameters: unknown[]) => {
                        run(...parameters);
                        throw new Error('injected storage migration interruption');
                    });
                }
                return statement;
            });
            await expect(runMigrations(db)).rejects.toThrow('injected storage migration interruption');
            spy.mockRestore();
            await destroySqliteDb();
            db = await initializeSqliteDb({ path });
            await expect(runMigrations(db)).resolves.toBeUndefined();
            await expect(runMigrations(db)).resolves.toBeUndefined();
            expect(getRawDb().prepare("SELECT execution_json FROM background_jobs WHERE id = 'preserved'").get())
                .toEqual({ execution_json: '{"version":1}' });
            expect(getRawDb().prepare("SELECT name FROM kysely_migration WHERE name > '029_delegation_wait' ORDER BY name").all())
                .toEqual([{ name: '030_storage_generations' }, { name: '031_storage_generation_uploads' }, { name: '032_sync_observations' }, { name: '033_tool_result_operation_ids' }]);
        } finally {
            vi.restoreAllMocks();
            await destroySqliteDb();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('refuses a preexisting incompatible storage table without recording the migration', async () => {
        const db = await initializeSqliteDb({ path: ':memory:' });
        await runMigrations(db);
        await rollbackObservations(db as unknown as Kysely<unknown>);
        await rollbackUploads(db as unknown as Kysely<unknown>);
        await rollbackStorage(db as unknown as Kysely<unknown>);
        await sql`DELETE FROM kysely_migration WHERE name > '029_delegation_wait'`.execute(db);
        await sql`CREATE TABLE storage_object_generations (unrelated TEXT)`.execute(db);
        await expect(runMigrations(db)).rejects.toThrow(/incompatible.*storage_object_generations/i);
        expect(getRawDb().prepare("SELECT name FROM kysely_migration WHERE name > '029_delegation_wait'").all()).toEqual([]);
    });

    // Interrupted DDL must resume only matching schema. A same-named table or
    // index with another definition must survive unchanged and block startup.
    it.each([
        ['sync_observations', 'CREATE TABLE sync_observations (unrelated TEXT)'],
        ['idx_users_admin_created_id', 'CREATE INDEX idx_users_admin_created_id ON users (email)'],
    ])('refuses incompatible diagnostic schema %s without recording the migration', async (name, statement) => {
        const db = await initializeSqliteDb({ path: ':memory:' });
        await runMigrations(db);
        await rollbackObservations(db as unknown as Kysely<unknown>);
        const raw = getRawDb();
        raw.prepare("DELETE FROM kysely_migration WHERE name >= '032_sync_observations'").run();
        raw.exec(statement);

        await expect(runMigrations(db)).rejects.toThrow(`Incompatible migration schema: ${name}`);
        expect(raw.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name)).toEqual({ sql: statement });
        expect(raw.prepare("SELECT name FROM kysely_migration WHERE name = '032_sync_observations'").all()).toEqual([]);
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
