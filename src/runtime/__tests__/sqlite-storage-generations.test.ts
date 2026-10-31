import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { H3Event } from 'h3';
import type { ChatGenerationAdmissionEnvelope } from '~~/shared/chat/background-history';
import { _resetForTest, destroySqliteDb, getRawDb, initializeSqliteDb } from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { SqliteExternalStorageGenerationCoordinator } from '../server/storage/sqlite-generation-coordinator';
import { generationGuardTriggers, GENERATION_PROOF_ROWS, GENERATION_PROOF_EDGES } from '../server/db/storage-generation-guards';
import { SqliteSyncGatewayAdapter } from '../server/sync/sqlite-sync-gateway-adapter';
import { emitWebhookSystemHook } from '~~/server/utils/webhooks/runtime';

vi.mock('~~/server/utils/webhooks/runtime', () => ({ emitWebhookSystemHook: vi.fn() }));

const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);
const key = { workspaceId: 'workspace', hash, generationId: 'generation-1' };
const registration = { ...key, storageId: 'namespace/immutable/generation-1', sizeBytes: 10 };
const claim = { ...key, claimId: 'claim-1', retentionSeconds: 0 };
let directory: string;
let filename: string;
let raw: Database.Database;
let coordinator: SqliteExternalStorageGenerationCoordinator;
let now: number;

beforeEach(async () => {
    _resetForTest();
    directory = await mkdtemp(join(tmpdir(), 'or3-generation-'));
    filename = join(directory, 'database.sqlite');
    const db = await initializeSqliteDb({ path: filename, synchronous: 'FULL' });
    await runMigrations(db);
    raw = getRawDb() as Database.Database;
    now = 1000;
    raw.function('unixepoch', () => now);
    coordinator = new SqliteExternalStorageGenerationCoordinator({ storageProviderId: 'filesystem' });
    vi.mocked(emitWebhookSystemHook).mockClear();
});

afterEach(async () => {
    vi.unstubAllEnvs();
    await destroySqliteDb();
    await rm(directory, { recursive: true, force: true });
});

function source(table = 's_messages', id = 'source', data: unknown = { file_hashes: [hash] }, workspace = key.workspaceId, replace = false): void {
    raw.prepare(`INSERT ${replace ? 'OR REPLACE' : ''} INTO ${table} (workspace_id,id,data_json) VALUES (?,?,?)`)
        .run(workspace, id, typeof data === 'string' ? data : JSON.stringify(data));
}

function metadata(data: unknown = { hash, storage_id: registration.storageId, size_bytes: 10 }, id = hash, workspace = key.workspaceId): void {
    source('s_file_meta', id, data, workspace);
}

function intent(id = 'intent', workspace = key.workspaceId, value = hash, expires = now + 10, replace = false): void {
    raw.prepare(`INSERT ${replace ? 'OR REPLACE' : ''} INTO upload_intents
        (id,workspace_id,hash,mime_type,size_bytes,reserved_bytes,expires_at,status,created_at)
        VALUES (?,?,?,'text/plain',10,10,?,'active',?)`).run(id, workspace, value, expires, now);
}

describe('dormant managed storage generation coordinator', () => {
    it('keeps runtime deletion capabilities absent and empty-schema legacy writers unchanged', async () => {
        source('s_messages', 'legacy', { file_hashes: [' legacy alias '] });
        metadata({ malformed: true }, 'legacy-id');
        const adapter = new SqliteSyncGatewayAdapter();
        expect(adapter.capabilities).not.toHaveProperty('externalStorageGenerations');
        expect(adapter).not.toHaveProperty('storageGenerationCoordinator');
        expect(raw.prepare('SELECT count(*) AS n FROM storage_object_generations').get()).toEqual({ n: 0 });
    });

    it('registers, claims, replays after reopen, and never reopens an irreversible generation', async () => {
        expect(await coordinator.registerVerifiedGeneration(registration)).toMatchObject({ status: 'registered', generation: { state: 'verified', createdAt: 1000 } });
        expect(await coordinator.registerVerifiedGeneration(registration)).toMatchObject({ status: 'replayed' });
        expect(await coordinator.claimGeneration(claim)).toMatchObject({ status: 'claimed', generation: { claimId: claim.claimId, claimedAt: 1000 } });
        expect(await coordinator.claimGeneration({ ...claim, claimId: 'different' })).toEqual({ status: 'blocked', reason: 'claim_conflict' });
        await destroySqliteDb();
        await initializeSqliteDb({ path: filename, synchronous: 'FULL' });
        coordinator = new SqliteExternalStorageGenerationCoordinator({ storageProviderId: 'filesystem' });
        expect(await coordinator.claimGeneration(claim)).toMatchObject({ status: 'replayed', generation: { state: 'claimed' } });
        await expect(coordinator.completeDeletion({ ...claim, workspaceId: 'other' })).rejects.toThrow(/mismatch/);
        expect(await coordinator.completeDeletion(claim)).toMatchObject({ status: 'deleted' });
        expect(await coordinator.completeDeletion(claim)).toMatchObject({ status: 'replayed' });
        expect(await coordinator.registerVerifiedGeneration(registration)).toMatchObject({ status: 'replayed', generation: { state: 'deleted' } });
        await expect(coordinator.registerVerifiedGeneration({ ...registration, generationId: 'reuse-target' })).rejects.toThrow(/reused/);
        await expect(coordinator.registerVerifiedGeneration({ ...registration, storageId: 'new-target' })).rejects.toThrow(/reused/);
    });

    it('requires proven local durability and its own outer commit without changing defaults', async () => {
        raw.pragma('synchronous = NORMAL');
        await expect(coordinator.registerVerifiedGeneration(registration)).rejects.toThrow(/FULL/);
        expect(raw.pragma('synchronous', { simple: true })).toBe(1);
        raw.pragma('synchronous = FULL');
        await coordinator.registerVerifiedGeneration(registration);
        raw.pragma('synchronous = NORMAL');
        await expect(coordinator.claimGeneration(claim)).rejects.toThrow(/FULL/);
        raw.pragma('synchronous = FULL');
        raw.exec('BEGIN IMMEDIATE');
        await expect(coordinator.claimGeneration(claim)).rejects.toThrow(/outer transaction/);
        await expect(coordinator.getGeneration(key)).rejects.toThrow(/outer transaction/);
        raw.exec('ROLLBACK');
        raw.pragma('foreign_keys = OFF');
        await expect(coordinator.claimGeneration(claim)).rejects.toThrow(/foreign_keys/);
        raw.pragma('foreign_keys = ON');
        raw.pragma('journal_mode = DELETE');
        await expect(coordinator.claimGeneration(claim)).rejects.toThrow(/WAL/);
        const memory = new Database(':memory:');
        try {
            const ephemeral = new SqliteExternalStorageGenerationCoordinator({ storageProviderId: 'filesystem', database: memory });
            await expect(ephemeral.registerVerifiedGeneration(registration)).rejects.toThrow(/file-backed/);
        } finally { memory.close(); }
    });

    it.each(['d1', 'turso'])('explicitly refuses the %s driver', async driver => {
        await destroySqliteDb();
        vi.stubEnv('OR3_SQLITE_DRIVER', driver);
        expect(() => new SqliteExternalStorageGenerationCoordinator({ storageProviderId: 'filesystem' })).toThrow(/unsupported/);
    });

    it.each(['s_messages', 's_posts', 's_file_meta'])('forbids adoption of existing live or tombstoned %s rows', async table => {
        source(table, table === 's_file_meta' ? hash : 'existing', table === 's_file_meta' ? { hash } : { file_hashes: [hash] });
        await expect(coordinator.registerVerifiedGeneration(registration)).rejects.toThrow(/adoption/);
        raw.prepare(`UPDATE ${table} SET deleted = 1`).run();
        await expect(coordinator.registerVerifiedGeneration(registration)).rejects.toThrow(/adoption/);
    });

    it('binds source-first references to the verified head, then rejects claimed/deleted hash references', async () => {
        await coordinator.registerVerifiedGeneration(registration);
        source('s_messages', 'first', { file_hashes: [`SHA256:${hash.toUpperCase()}`] });
        expect(await coordinator.claimGeneration(claim)).toEqual({ status: 'blocked', reason: 'in_use' });
        raw.exec('DELETE FROM s_messages');
        await coordinator.claimGeneration(claim);
        for (const table of ['s_messages', 's_posts']) {
            expect(() => source(table)).toThrow(/CLAIMED/);
            expect(() => source(table, 'null', { file_hashes: null })).not.toThrow();
            expect(() => source(table, 'absent', { content: 'no attachment' })).not.toThrow();
        }
        expect(() => metadata()).toThrow(/MISMATCH/);
        expect(() => intent()).toThrow(/BLOCKED/);
        await coordinator.completeDeletion(claim);
        expect(() => source()).toThrow(/CLAIMED/);
    });

    it('permits a distinct verified replacement while an old claim only finalizes its own target', async () => {
        await coordinator.registerVerifiedGeneration(registration);
        await expect(coordinator.registerVerifiedGeneration({ ...registration, generationId: 'g2', storageId: 'target2' })).rejects.toThrow(/claimed/);
        await coordinator.claimGeneration(claim);
        const next = { ...registration, generationId: 'g2', storageId: 'target2' };
        await coordinator.registerVerifiedGeneration(next);
        source();
        metadata({ hash, storage_id: next.storageId, size_bytes: 10 });
        expect(() => raw.prepare('UPDATE s_file_meta SET data_json = ?').run(JSON.stringify({ hash, storage_id: registration.storageId, size_bytes: 10 }))).toThrow(/MISMATCH/);
        await coordinator.completeDeletion(claim);
        expect(await coordinator.getGeneration(next)).toMatchObject({ state: 'verified', storageId: 'target2' });
        expect(await coordinator.claimGeneration({ ...claim, generationId: 'g2', claimId: 'claim2' })).toEqual({ status: 'blocked', reason: 'in_use' });
    });

    it.each(['s_messages', 's_posts', 's_file_meta'])('rejects raw claimed %s restores and identity-changing updates', async table => {
        await coordinator.registerVerifiedGeneration(registration);
        const id = table === 's_file_meta' ? hash : 'restore';
        const data = table === 's_file_meta' ? { hash, storage_id: registration.storageId, size_bytes: 10 } : { file_hashes: [hash] };
        raw.prepare(`INSERT INTO ${table}(workspace_id,id,data_json,deleted) VALUES (?,?,?,1)`)
            .run(key.workspaceId, id, JSON.stringify(data));
        await coordinator.claimGeneration(claim);
        expect(() => raw.prepare(`UPDATE ${table} SET deleted = 0 WHERE id = ?`).run(id)).toThrow(/GENERATION/);
        if (table !== 's_file_meta') {
            source(table, 'unrelated', { file_hashes: null });
            expect(() => raw.prepare(`UPDATE ${table} SET data_json = ? WHERE id = 'unrelated'`).run(JSON.stringify(data))).toThrow(/CLAIMED/);
            source(table, 'foreign', data, 'foreign');
            expect(() => raw.prepare(`UPDATE ${table} SET workspace_id = ? WHERE id = 'foreign'`).run(key.workspaceId)).toThrow(/CLAIMED/);
        }
        expect(raw.prepare(`SELECT deleted FROM ${table} WHERE id = ? AND workspace_id = ?`).get(id, key.workspaceId)).toEqual({ deleted: 1 });
    });

    it.each(['s_messages', 's_posts'])('rejects ambiguous and malformed references in %s, including raw JSON path attacks', async table => {
        await coordinator.registerVerifiedGeneration(registration);
        await coordinator.claimGeneration(claim);
        const invalid = [
            '{', '[]', { file_hashes: 1 }, { file_hashes: {} }, { file_hashes: 'null' },
            { file_hashes: [null] }, { file_hashes: [hash + ' '] }, { file_hashes: ['\t' + hash] },
            { file_hashes: ['\u00a0' + hash] }, { file_hashes: [hash + '\n'] }, { file_hashes: ['unknown:' + hash] },
            { file_hashes: [hash + '\u0000'] }, { fileHashes: [hash] },
            `{"file_hashes":[],"file_hashes":["${hash}"]}`,
            `{"file_hashes\\u0000shadow":[],"file_hashes":["${hash}"]}`,
        ];
        for (const data of invalid) expect(() => source(table, 'bad', data)).toThrow(/UNKNOWN_REFERENCES/);
        expect(() => source(table, 'string-refs', { file_hashes: JSON.stringify([hash]) })).toThrow(/CLAIMED/);
        expect(() => source(table, 'legacy-md5', { file_hashes: ['md5:' + 'c'.repeat(32)] })).not.toThrow();
    });

    it('rejects incomplete, conflicting, stale or cross-workspace metadata identities without NULL bypass', async () => {
        await coordinator.registerVerifiedGeneration(registration);
        const valid = { hash, storage_id: registration.storageId, size_bytes: 10 };
        for (const data of [{}, { hash }, { ...valid, hash: null }, { ...valid, storage_id: null },
            { ...valid, size_bytes: null }, { ...valid, size_bytes: '10' }, { ...valid, storageId: registration.storageId },
            { ...valid, sizeBytes: 10 }, { ...valid, hash: otherHash }, { ...valid, storage_id: 'other' },
            `{"hash":"${hash}","hash":"${otherHash}","storage_id":"${registration.storageId}","size_bytes":10}`]) {
            expect(() => metadata(data)).toThrow(/METADATA/);
        }
        expect(() => metadata(valid, hash, 'foreign')).toThrow(/METADATA/);
        expect(() => metadata({ hash }, otherHash)).toThrow(/METADATA/);
        for (const invalid of [hash + ' ', '\t' + hash, '\u00a0' + hash, 'unknown:' + hash]) {
            expect(() => metadata({ hash: invalid }, invalid)).toThrow(/METADATA/);
            expect(() => intent('bad', key.workspaceId, invalid)).toThrow(/BLOCKED/);
        }
        metadata();
        expect(() => raw.prepare('UPDATE s_file_meta SET workspace_id = ?').run('foreign')).toThrow(/METADATA/);
    });

    it.each(['delete', 'update', 'replace', 'move'])('refreshes OLD source retention on %s using server time with recursive triggers OFF', async method => {
        raw.pragma('recursive_triggers = OFF');
        await coordinator.registerVerifiedGeneration(registration);
        source();
        now = 1100;
        if (method === 'delete') raw.exec('DELETE FROM s_messages');
        if (method === 'update') raw.prepare('UPDATE s_messages SET data_json = ?, updated_at = 0').run('{"file_hashes":null}');
        if (method === 'replace') source('s_messages', 'source', { file_hashes: null }, key.workspaceId, true);
        if (method === 'move') raw.prepare('UPDATE s_messages SET workspace_id = ?').run('other');
        expect(await coordinator.getGeneration(key)).toMatchObject({ lastActivityAt: 1100 });
        expect(await coordinator.claimGeneration({ ...claim, retentionSeconds: 10 })).toEqual({ status: 'blocked', reason: 'retention' });
        now = 1110;
        expect(await coordinator.claimGeneration({ ...claim, retentionSeconds: 10 })).toMatchObject({ status: 'claimed' });
    });

    it('refreshes metadata tombstones and globally replaced upload intent activity', async () => {
        raw.pragma('recursive_triggers = OFF');
        await coordinator.registerVerifiedGeneration(registration);
        metadata();
        now = 1100;
        raw.exec('UPDATE s_file_meta SET deleted = 1, updated_at = 0');
        expect(await coordinator.getGeneration(key)).toMatchObject({ lastActivityAt: 1100 });
        intent();
        expect(await coordinator.claimGeneration(claim)).toEqual({ status: 'blocked', reason: 'active_upload' });
        now = 1200;
        intent('intent', 'foreign', otherHash, now + 10, true);
        expect(await coordinator.getGeneration(key)).toMatchObject({ lastActivityAt: 1200 });
        expect(await coordinator.claimGeneration({ ...claim, retentionSeconds: 1 })).toEqual({ status: 'blocked', reason: 'retention' });
    });

    it('uses expiration as an activity floor and validates retention and clock regression', async () => {
        await coordinator.registerVerifiedGeneration(registration);
        intent();
        now = 1011;
        expect(await coordinator.claimGeneration({ ...claim, retentionSeconds: 2 })).toEqual({ status: 'blocked', reason: 'retention' });
        for (const retentionSeconds of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            await expect(coordinator.claimGeneration({ ...claim, retentionSeconds })).rejects.toThrow(/retention/);
        }
        now = 1012;
        expect(await coordinator.claimGeneration({ ...claim, retentionSeconds: 2 })).toMatchObject({ status: 'claimed', generation: { lastActivityAt: 1010 } });
        now = 1000;
        await expect(coordinator.completeDeletion(claim)).rejects.toThrow(/clock regressed/);
    });

    it('checks every exact guard despite an up-to-date migration ledger', async () => {
        await coordinator.registerVerifiedGeneration(registration);
        const name = 's_messages_generation_guard_insert';
        raw.exec(`DROP TRIGGER ${name}`);
        await expect(coordinator.claimGeneration(claim)).rejects.toThrow(/integrity/);
        await expect(coordinator.getGeneration(key)).rejects.toThrow(/integrity/);
        await expect(coordinator.registerVerifiedGeneration({ ...registration, hash: otherHash, generationId: 'g2', storageId: 'target2' })).rejects.toThrow(/integrity/);
        raw.exec(`CREATE TRIGGER ${name} BEFORE INSERT ON s_messages BEGIN SELECT 1; END`);
        await expect(coordinator.claimGeneration(claim)).rejects.toThrow(/integrity/);
        raw.exec(`DROP TRIGGER ${name}`);
        raw.exec(generationGuardTriggers()[name]!);
        expect(await coordinator.claimGeneration(claim)).toMatchObject({ status: 'claimed' });
    });

    it('retains permanent generation identities against raw REPLACE and reversal with recursive triggers OFF', async () => {
        raw.pragma('recursive_triggers = OFF');
        await coordinator.registerVerifiedGeneration(registration);
        await coordinator.claimGeneration(claim);
        await coordinator.completeDeletion(claim);
        expect(() => raw.exec('INSERT OR REPLACE INTO storage_object_generations SELECT * FROM storage_object_generations')).toThrow(/REUSE/);
        expect(() => raw.exec("UPDATE storage_object_generations SET state = 'verified', claim_id = NULL, claimed_at = NULL, deleted_at = NULL")).toThrow(/IMMUTABLE/);
        expect(() => raw.exec('DELETE FROM storage_object_generations')).toThrow(/PERMANENT/);
        expect(() => raw.exec('INSERT OR REPLACE INTO storage_object_heads SELECT * FROM storage_object_heads')).toThrow(/CONFLICT/);
    });

    it('does not allow NULL lifecycle timestamps to bypass SQL CHECK constraints', async () => {
        await coordinator.registerVerifiedGeneration(registration);
        expect(() => raw.exec("UPDATE storage_object_generations SET state='claimed', claim_id='incomplete', claimed_at=NULL")).toThrow(/CHECK/);
        await coordinator.claimGeneration(claim);
        expect(() => raw.exec("UPDATE storage_object_generations SET state='deleted', deleted_at=NULL")).toThrow(/CHECK/);
        expect(await coordinator.getGeneration(key)).toMatchObject({ state: 'claimed', claimId: claim.claimId });
    });

    it('bounds proof rows and edges and refuses unknown preexisting references', async () => {
        // Corrupt materialized rows predate managed registration; no normal writer bypass.
        source('s_messages', 'corrupt', { file_hashes: ['unparseable-legacy-reference'] });
        await expect(coordinator.registerVerifiedGeneration(registration)).rejects.toThrow(/unknown_references/);
        raw.exec('DELETE FROM s_messages');
        await coordinator.registerVerifiedGeneration(registration);
        raw.transaction(() => {
            for (let i = 0; i <= GENERATION_PROOF_ROWS; i++) source('s_messages', String(i), { file_hashes: null });
        })();
        expect(await coordinator.claimGeneration(claim)).toEqual({ status: 'blocked', reason: 'proof_incomplete' });
        raw.exec('DELETE FROM s_messages');
        for (let i = 0; i <= GENERATION_PROOF_EDGES / 1000; i++) source('s_posts', String(i), { file_hashes: Array(1000).fill(otherHash) });
        expect(await coordinator.claimGeneration(claim)).toEqual({ status: 'blocked', reason: 'proof_incomplete' });
    });

    it('rolls back an entire sync push, version allocations and webhook publication when a raw guard aborts', async () => {
        await coordinator.registerVerifiedGeneration(registration);
        await coordinator.claimGeneration(claim);
        const adapter = new SqliteSyncGatewayAdapter();
        const ops = ['safe', 'unsafe'].map((id, index) => ({
            id, tableName: 'messages', operation: 'put' as const, pk: id,
            payload: { id, file_hashes: index ? [hash] : null },
            stamp: { deviceId: 'device', opId: id, hlc: '2026-10-10T00:00:00.000Z-0000', clock: index + 1 },
            createdAt: now, attempts: 0, status: 'pending' as const,
        }));
        await expect(adapter.push({} as H3Event, { scope: { workspaceId: key.workspaceId }, ops })).rejects.toThrow(/CLAIMED/);
        expect(raw.prepare('SELECT count(*) AS n FROM s_messages').get()).toEqual({ n: 0 });
        expect(raw.prepare('SELECT count(*) AS n FROM change_log').get()).toEqual({ n: 0 });
        expect(raw.prepare('SELECT * FROM server_version_counter').all()).toEqual([]);
        expect(emitWebhookSystemHook).not.toHaveBeenCalled();
    });

    it('guards production server-authored background history and rolls back its admission receipt', async () => {
        await coordinator.registerVerifiedGeneration(registration);
        await coordinator.claimGeneration(claim);
        raw.prepare('INSERT INTO workspaces(id,name,owner_user_id) VALUES (?,?,?)').run(key.workspaceId, 'Test', 'owner');
        raw.prepare('INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES (?,?,?,?)').run('member', key.workspaceId, 'owner', 'owner');
        const admission: ChatGenerationAdmissionEnvelope = {
            version: 1, kind: 'new-turn', admissionId: 'admission', generationId: 'chat-generation',
            workspaceId: key.workspaceId, threadId: 'thread', messageId: 'assistant',
            thread: { id: 'thread', clock: 1 },
            userMessage: { id: 'user', thread_id: 'thread', role: 'user', clock: 1, file_hashes: [hash], data: { content: 'question' } },
            assistantMessage: { id: 'assistant', thread_id: 'thread', role: 'assistant', clock: 1, pending: true, file_hashes: null, data: { content: '' } },
        };
        const adapter = new SqliteSyncGatewayAdapter();
        await expect(adapter.admitChatGeneration({ userId: 'owner', workspaceId: key.workspaceId }, admission)).rejects.toThrow(/CLAIMED/);
        for (const table of ['s_threads', 's_messages', 'change_log', 'server_version_counter', 'background_generation_receipts']) {
            expect(raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        }
        expect(emitWebhookSystemHook).not.toHaveBeenCalled();
    });
});

const nativeModule = createRequire(import.meta.url).resolve('better-sqlite3');
function rawWorker(script: string, shared?: SharedArrayBuffer): Worker {
    return new Worker(`const {parentPort, workerData} = require('node:worker_threads');
        const Database = require(workerData.nativeModule);
        const db = new Database(workerData.filename);
        db.pragma('busy_timeout = 5000'); db.pragma('synchronous = FULL'); db.pragma('foreign_keys = ON');
        const hash = workerData.hash; const workspace = workerData.workspace;
        const flags = workerData.shared && new Int32Array(workerData.shared);
        ${script}`, { eval: true, workerData: { nativeModule, filename, hash, workspace: key.workspaceId, shared } });
}
function message(worker: Worker): Promise<unknown> {
    return new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
}

describe('real independent SQLite connection serialization and recovery', () => {
    it('a raw writer holding the database lock wins before a waiting claim', async () => {
        await coordinator.registerVerifiedGeneration(registration);
        const worker = rawWorker(`db.exec('BEGIN IMMEDIATE');
            db.prepare('INSERT INTO s_messages(workspace_id,id,data_json) VALUES (?,?,?)').run(workspace,'racer',JSON.stringify({file_hashes:[hash]}));
            parentPort.postMessage('locked'); setTimeout(() => { db.exec('COMMIT'); db.close(); }, 150);`);
        expect(await message(worker)).toBe('locked');
        expect(await coordinator.claimGeneration(claim)).toEqual({ status: 'blocked', reason: 'in_use' });
        await worker.terminate();
    });

    it('a real raw metadata restore wins before a waiting claim and pins its verified target', async () => {
        await coordinator.registerVerifiedGeneration(registration);
        metadata();
        raw.exec('UPDATE s_file_meta SET deleted = 1');
        const worker = rawWorker(`db.exec('BEGIN IMMEDIATE');
            db.prepare('UPDATE s_file_meta SET deleted=0 WHERE workspace_id=? AND id=?').run(workspace,hash);
            parentPort.postMessage('locked'); setTimeout(() => { db.exec('COMMIT'); db.close(); }, 150);`);
        expect(await message(worker)).toBe('locked');
        expect(await coordinator.claimGeneration(claim)).toEqual({ status: 'blocked', reason: 'in_use' });
        await worker.terminate();
    });

    it('a production claim holding the lock rejects a simultaneous old raw writer after commit', async () => {
        await coordinator.registerVerifiedGeneration(registration);
        const shared = new SharedArrayBuffer(8);
        const flags = new Int32Array(shared);
        const worker = rawWorker(`parentPort.postMessage('ready'); Atomics.wait(flags,0,0);
            Atomics.store(flags,1,1); Atomics.notify(flags,1);
            try { db.prepare('INSERT INTO s_posts(workspace_id,id,data_json) VALUES (?,?,?)').run(workspace,'racer',JSON.stringify({file_hashes:[hash]})); parentPort.postMessage('unsafe-success'); }
            catch (error) { parentPort.postMessage(error.message); } finally { db.close(); }`, shared);
        expect(await message(worker)).toBe('ready');
        const result = message(worker);
        const prepare = raw.prepare.bind(raw);
        const spy = vi.spyOn(raw, 'prepare').mockImplementation((sql: string) => {
            if (sql.includes("SET state = 'claimed'")) {
                Atomics.store(flags, 0, 1); Atomics.notify(flags, 0);
                if (Atomics.load(flags, 1) === 0) Atomics.wait(flags, 1, 0, 1000);
            }
            return prepare(sql);
        });
        try { expect(await coordinator.claimGeneration(claim)).toMatchObject({ status: 'claimed' }); }
        finally { spy.mockRestore(); }
        expect(await result).toMatch(/CLAIMED/);
        await worker.terminate();
    });

    it('rolls back an interrupted uncommitted claim and preserves a later committed retry', async () => {
        await coordinator.registerVerifiedGeneration(registration);
        const worker = rawWorker(`db.exec('BEGIN IMMEDIATE');
            db.prepare("UPDATE storage_object_generations SET state='claimed',claim_id='crashed',claimed_at=unixepoch() WHERE generation_id='generation-1'").run();
            parentPort.postMessage('uncommitted'); setInterval(() => {}, 1000);`);
        expect(await message(worker)).toBe('uncommitted');
        await worker.terminate();
        expect(await coordinator.getGeneration(key)).toMatchObject({ state: 'verified' });
        expect(await coordinator.claimGeneration(claim)).toMatchObject({ status: 'claimed' });
        const second = new Database(filename);
        try { expect(second.prepare('SELECT state,claim_id FROM storage_object_generations').get()).toEqual({ state: 'claimed', claim_id: claim.claimId }); }
        finally { second.close(); }
    });
});
