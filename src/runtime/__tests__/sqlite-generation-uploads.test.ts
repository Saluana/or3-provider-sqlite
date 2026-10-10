import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { H3Event } from 'h3';
import { _resetForTest, destroySqliteDb, getRawDb, initializeSqliteDb } from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { GENERATION_PROOF_ROWS, canonicalGuardSql, generationGuardTriggers } from '../server/db/storage-generation-guards';
import {
    GENERATION_UPLOAD_MAX_PENDING, GENERATION_UPLOAD_MAX_TTL_SECONDS, generationUploadGuardTriggers,
} from '../server/db/storage-generation-upload-guards';
import { SqliteExternalStorageGenerationCoordinator } from '../server/storage/sqlite-generation-coordinator';
import { SqliteExternalStorageGenerationUploadCoordinator } from '../server/storage/sqlite-generation-upload-coordinator';
import { SqliteSyncGatewayAdapter } from '../server/sync/sqlite-sync-gateway-adapter';

const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);
const key = { workspaceId: 'workspace', hash, generationId: 'generation-1', intentId: 'intent-1', userId: 'owner' };
const request = {
    ...key, namespaceId: 'namespace', storageId: 'namespace/immutable/generation-1',
    mimeType: 'text/plain', sizeBytes: 10, expiresInSeconds: 60, workspaceQuotaBytes: 100,
};
const ready = { ...key, storageId: request.storageId, readyReceiptId: 'trusted-ready-receipt' };
const publication = { ...ready, sizeBytes: request.sizeBytes };
const claim = { ...key, claimId: 'abandon-claim-1', retentionSeconds: 0 };
const restoreRequest = { ...key, intentId: 'restore-1', expiresInSeconds: 60, workspaceQuotaBytes: 100 };
const restoreClaim = { ...restoreRequest, claimId: 'restore-abandon-claim', retentionSeconds: 0 };
const event = { context: {} } as H3Event;
let directory: string;
let filename: string;
let raw: Database.Database;
let coordinator: SqliteExternalStorageGenerationUploadCoordinator;
let adapter: SqliteSyncGatewayAdapter;
let now: number;

beforeEach(async () => {
    _resetForTest();
    directory = await mkdtemp(join(tmpdir(), 'or3-generation-upload-'));
    filename = join(directory, 'database.sqlite');
    const db = await initializeSqliteDb({ path: filename, synchronous: 'FULL' });
    await runMigrations(db);
    raw = getRawDb() as Database.Database;
    now = 1000;
    raw.function('unixepoch', () => now);
    vi.spyOn(Date, 'now').mockImplementation(() => now * 1000);
    coordinator = new SqliteExternalStorageGenerationUploadCoordinator({ storageProviderId: 'filesystem' });
    adapter = new SqliteSyncGatewayAdapter();
});

afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (raw?.inTransaction) raw.exec('ROLLBACK');
    await destroySqliteDb();
    await rm(directory, { recursive: true, force: true });
});

function source(table = 's_messages', id = 'source', data: unknown = { file_hashes: [hash] }, workspace = key.workspaceId): void {
    raw.prepare(`INSERT INTO ${table} (workspace_id,id,data_json) VALUES (?,?,?)`)
        .run(workspace, id, typeof data === 'string' ? data : JSON.stringify(data));
}

function metadata(data: unknown = { hash, storage_id: request.storageId, size_bytes: request.sizeBytes }, id = hash,
    workspace = key.workspaceId, deleted = 0): void {
    raw.prepare('INSERT INTO s_file_meta (workspace_id,id,data_json,deleted) VALUES (?,?,?,?)')
        .run(workspace, id, typeof data === 'string' ? data : JSON.stringify(data), deleted);
}

function accounting(): { status: string; reserved_bytes: number; expires_at: number } | undefined {
    return raw.prepare('SELECT status,reserved_bytes,expires_at FROM upload_intents WHERE id = ?')
        .get(key.intentId) as { status: string; reserved_bytes: number; expires_at: number } | undefined;
}

function activeCharge(): number {
    return (raw.prepare(`SELECT coalesce(sum(reserved_bytes),0) AS charge FROM upload_intents
        WHERE workspace_id = ? AND status = 'active' AND expires_at > ?`)
        .get(key.workspaceId, now) as { charge: number }).charge;
}

async function publish(): Promise<void> {
    await coordinator.reserveGenerationUpload(request);
    await coordinator.markGenerationUploadReady(ready);
    await coordinator.publishGenerationUpload(publication);
}

async function tombstoneMaterializedGeneration(): Promise<void> {
    await publish();
    metadata();
    raw.exec('UPDATE s_file_meta SET deleted = 1');
}

function operations(): Array<() => Promise<unknown>> {
    return [
        () => coordinator.reserveGenerationUpload(request),
        () => coordinator.reserveGenerationRestore(restoreRequest),
        () => coordinator.getGenerationUpload(key),
        () => coordinator.markGenerationUploadReady(ready),
        () => coordinator.publishGenerationUpload(publication),
        () => coordinator.claimAbandonedGenerationUpload(claim),
        () => coordinator.getGenerationUploadClaim(claim),
        () => coordinator.completeGenerationUploadAbandonment(claim),
        () => coordinator.listGenerationUploadRecovery({ workspaceId: key.workspaceId }),
    ];
}

describe('dormant generation upload admission and permanent accounting', () => {
    it('reserves without fabricating a verified generation or advertising a runtime capability', async () => {
        expect(coordinator.uploadVersion).toBe(1);
        expect(adapter.capabilities).not.toHaveProperty('externalStorageGenerationUploads');
        expect(adapter.capabilities).not.toHaveProperty('externalStorageGenerations');
        expect(adapter).not.toHaveProperty('storageGenerationUploadCoordinator');
        expect(await coordinator.reserveGenerationUpload(request)).toMatchObject({
            status: 'reserved', intent: {
                ...key, namespaceId: request.namespaceId, storageProviderId: 'filesystem',
                storageId: request.storageId, state: 'reserved', sizeBytes: 10, reservedBytes: 10,
                createdAt: 1000, expiresAt: 1060,
            },
        });
        expect(await coordinator.getGeneration(key)).toBeNull();
        expect(raw.prepare('SELECT count(*) AS count FROM storage_object_heads').get()).toEqual({ count: 0 });
        expect(accounting()).toEqual({ status: 'active', reserved_bytes: 10, expires_at: Number.MAX_SAFE_INTEGER });
        now = 1061;
        expect(activeCharge()).toBe(10);
        expect(await adapter.queryCanonicalStorage(event, {
            scope: { workspaceId: key.workspaceId }, kind: 'active_reservations', now,
        })).toMatchObject({ items: [{ reservationId: key.intentId, sizeBytes: 10, expiresAt: Number.MAX_SAFE_INTEGER }] });
    });

    it('replays exact admission without extending credentials or charging twice', async () => {
        const first = await coordinator.reserveGenerationUpload(request);
        now = 1010;
        expect(await coordinator.reserveGenerationUpload(request)).toEqual({ status: 'replayed', intent: first.intent });
        expect(await coordinator.reserveGenerationUpload({ ...request, hash: `SHA256:${hash.toUpperCase()}` }))
            .toEqual({ status: 'replayed', intent: first.intent });
        expect(activeCharge()).toBe(10);
        expect(raw.prepare('SELECT count(*) AS count FROM storage_generation_uploads').get()).toEqual({ count: 1 });
        expect(raw.prepare('SELECT count(*) AS count FROM upload_intents').get()).toEqual({ count: 1 });
    });

    it('rejects owner, namespace, provider and immutable tuple replay mismatches', async () => {
        await coordinator.reserveGenerationUpload(request);
        for (const change of [
            { userId: 'different-owner' }, { namespaceId: 'different-namespace' }, { workspaceId: 'foreign' },
            { hash: otherHash }, { generationId: 'different-generation' }, { storageId: 'different-target' },
            { mimeType: 'image/png' }, { sizeBytes: 11 }, { intentId: 'different-intent' },
            { expiresInSeconds: 61 }, { workspaceQuotaBytes: 101 },
        ]) await expect(coordinator.reserveGenerationUpload({ ...request, ...change })).rejects.toThrow();
        const foreignProvider = new SqliteExternalStorageGenerationUploadCoordinator({ storageProviderId: 'foreign-provider' });
        await expect(foreignProvider.reserveGenerationUpload(request)).rejects.toThrow();
        await expect(coordinator.markGenerationUploadReady({ ...ready, userId: 'different-owner' })).rejects.toThrow();
        await expect(coordinator.publishGenerationUpload({ ...publication, userId: 'different-owner' })).rejects.toThrow();
        expect(await coordinator.getGenerationUpload({ ...key, userId: 'different-owner' })).toBeNull();
        expect(await foreignProvider.getGenerationUpload(key)).toBeNull();
        expect(activeCharge()).toBe(10);
    });

    it('admits exactly one pending binding for a hash, including competing quota requests', async () => {
        const results = await Promise.allSettled([
            coordinator.reserveGenerationUpload(request),
            coordinator.reserveGenerationUpload({ ...request, intentId: 'duplicate', generationId: 'g2', storageId: 'target-2' }),
        ]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
        expect(activeCharge()).toBe(10);
        await expect(coordinator.reserveGenerationUpload({
            ...request, hash: otherHash, intentId: 'over-quota', generationId: 'g3', storageId: 'target-3', workspaceQuotaBytes: 19,
        })).rejects.toThrow(/quota/i);
        expect(raw.prepare('SELECT count(*) AS count FROM storage_generation_uploads').get()).toEqual({ count: 1 });
    });

    it('keeps expired credential charges visible to legacy admission and leaves failed admission atomic', async () => {
        await coordinator.reserveGenerationUpload(request);
        now = 1100;
        await expect(adapter.reserveUploadIntent(event, {
            intentId: 'legacy-too-large', workspaceId: key.workspaceId, hash: otherHash, mimeType: 'text/plain',
            sizeBytes: 91, expiresAt: now + 60, workspaceQuotaBytes: 100,
        })).rejects.toMatchObject({ statusCode: 413 });
        expect(accounting()).toEqual({ status: 'active', reserved_bytes: 10, expires_at: Number.MAX_SAFE_INTEGER });
        expect(raw.prepare("SELECT * FROM upload_intents WHERE id = 'legacy-too-large'").get()).toBeUndefined();
        await adapter.reserveUploadIntent(event, {
            intentId: 'legacy-fits', workspaceId: key.workspaceId, hash: otherHash, mimeType: 'text/plain',
            sizeBytes: 90, expiresAt: now + 60, workspaceQuotaBytes: 100,
        });
        expect(activeCharge()).toBe(100);
    });

    it('counts ordinary active legacy reservations when admitting a managed upload', async () => {
        await adapter.reserveUploadIntent(event, {
            intentId: 'older-reservation', workspaceId: key.workspaceId, hash: otherHash, mimeType: 'text/plain',
            sizeBytes: 91, expiresAt: now + 60, workspaceQuotaBytes: 100,
        });
        await expect(coordinator.reserveGenerationUpload(request)).rejects.toThrow(/quota/i);
        expect(accounting()).toBeUndefined();
        expect(raw.prepare('SELECT count(*) AS count FROM storage_generation_uploads').get()).toEqual({ count: 0 });
        expect(activeCharge()).toBe(91);
    });

    it('bounds credential lifetime and rejects unsafe byte/quota values before changing either ledger', async () => {
        for (const expiresInSeconds of [0, -1, 0.5, NaN, Infinity, GENERATION_UPLOAD_MAX_TTL_SECONDS + 1]) {
            await expect(coordinator.reserveGenerationUpload({ ...request, expiresInSeconds })).rejects.toThrow();
        }
        for (const sizeBytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            await expect(coordinator.reserveGenerationUpload({ ...request, sizeBytes })).rejects.toThrow();
        }
        for (const workspaceQuotaBytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            await expect(coordinator.reserveGenerationUpload({ ...request, workspaceQuotaBytes })).rejects.toThrow();
        }
        expect(accounting()).toBeUndefined();
        expect(await coordinator.reserveGenerationUpload({ ...request, expiresInSeconds: GENERATION_UPLOAD_MAX_TTL_SECONDS }))
            .toMatchObject({ intent: { expiresAt: now + GENERATION_UPLOAD_MAX_TTL_SECONDS } });
    });

    it('bounds incomplete pending allocations even when their logical byte charge is zero and credentials expired', async () => {
        for (let i = 0; i < GENERATION_UPLOAD_MAX_PENDING; i++) {
            await coordinator.reserveGenerationUpload({
                ...request, intentId: `pending-${i}`, generationId: `pending-${i}`, storageId: `pending-target-${i}`,
                hash: i.toString(16).padStart(64, '0'), sizeBytes: 0,
            });
        }
        now = 1100;
        await expect(coordinator.reserveGenerationUpload(request)).rejects.toThrow(/pending|limit|many/i);
        expect(raw.prepare('SELECT count(*) AS count FROM storage_generation_uploads').get()).toEqual({ count: GENERATION_UPLOAD_MAX_PENDING });
        expect(accounting()).toBeUndefined();
        expect(activeCharge()).toBe(0);
    });

    it.each(['s_messages', 's_posts', 's_file_meta'])('refuses live and tombstoned legacy %s adoption', async table => {
        source(table, table === 's_file_meta' ? hash : 'legacy', table === 's_file_meta'
            ? { hash, storage_id: request.storageId, size_bytes: 10 } : { file_hashes: [hash] });
        await expect(coordinator.reserveGenerationUpload(request)).rejects.toThrow();
        raw.exec(`UPDATE ${table} SET deleted = 1`);
        await expect(coordinator.reserveGenerationUpload(request)).rejects.toThrow();
        expect(accounting()).toBeUndefined();
        expect(await coordinator.getGeneration(key)).toBeNull();
    });

    it('refuses verified-head replacement and unbound registration over a pending allocation', async () => {
        const legacy = new SqliteExternalStorageGenerationCoordinator({ storageProviderId: 'filesystem' });
        await coordinator.reserveGenerationUpload(request);
        await expect(legacy.registerVerifiedGeneration({ ...key, storageId: request.storageId, sizeBytes: 10 })).rejects.toThrow();
        await expect(legacy.registerVerifiedGeneration({ ...key, generationId: 'bypass', storageId: 'bypass-target', sizeBytes: 10 })).rejects.toThrow();
        await coordinator.markGenerationUploadReady(ready);
        await coordinator.publishGenerationUpload(publication);
        await expect(coordinator.reserveGenerationUpload({ ...request, intentId: 'replace', generationId: 'replace', storageId: 'replace-target' })).rejects.toThrow();
        expect(await coordinator.getGeneration(key)).toMatchObject({ state: 'verified', storageId: request.storageId });
    });

    it('fences pending source references, metadata and cross-workspace target adoption for raw old writers', async () => {
        await coordinator.reserveGenerationUpload(request);
        for (const table of ['s_messages', 's_posts']) {
            expect(() => source(table)).toThrow();
            expect(() => source(table, 'alias', { file_hashes: [`SHA256:${hash.toUpperCase()}`] })).toThrow();
            expect(() => source(table, 'unrelated', { file_hashes: null })).not.toThrow();
            expect(() => raw.prepare(`UPDATE ${table} SET data_json = ? WHERE id = 'unrelated'`)
                .run(JSON.stringify({ file_hashes: [hash] }))).toThrow();
        }
        expect(() => metadata()).toThrow();
        expect(() => metadata({ hash: otherHash, storage_id: request.storageId, size_bytes: 10 }, otherHash, 'foreign')).toThrow();
        await expect(adapter.reserveUploadIntent(event, {
            intentId: 'legacy-same-hash', workspaceId: key.workspaceId, hash, mimeType: 'text/plain', sizeBytes: 10, expiresAt: now + 60,
        })).rejects.toThrow();
        expect(await coordinator.getGeneration(key)).toBeNull();
        expect(activeCharge()).toBe(10);
    });

    it.each(['reserved', 'published'])('blocks old consume, cancel, expiry, delete and REPLACE from releasing a %s charge', async state => {
        raw.pragma('recursive_triggers = OFF');
        if (state === 'published') await publish();
        else await coordinator.reserveGenerationUpload(request);
        await expect(adapter.consumeUploadIntent(event, { ...request })).rejects.toThrow();
        await expect(adapter.cancelUploadIntent(event, key)).rejects.toThrow();
        const attacks = [
            "UPDATE upload_intents SET status = 'expired'",
            "UPDATE upload_intents SET status = 'consumed', consumed_at = 1000",
            "UPDATE upload_intents SET status = 'cancelled', cancelled_at = 1000",
            'UPDATE upload_intents SET reserved_bytes = 0',
            'UPDATE upload_intents SET expires_at = 999',
            'UPDATE upload_intents SET size_bytes = 0',
            "UPDATE upload_intents SET workspace_id = 'foreign'",
            'DELETE FROM upload_intents',
            'INSERT OR REPLACE INTO upload_intents SELECT * FROM upload_intents',
            'DELETE FROM storage_generation_uploads',
            'INSERT OR REPLACE INTO storage_generation_uploads SELECT * FROM storage_generation_uploads',
        ];
        for (const sql of attacks) {
            expect(() => raw.exec(sql), sql).toThrow();
            expect(activeCharge(), sql).toBe(10);
        }
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: state === 'published' ? 'published_pending_metadata' : 'reserved' });
    });

    it('makes every allocation identity permanent for raw updates, including the owner and namespace', async () => {
        await coordinator.reserveGenerationUpload(request);
        for (const [column, value] of [
            ['intent_id', 'replacement'], ['workspace_id', 'foreign'], ['hash', otherHash], ['generation_id', 'g2'],
            ['storage_id', 'other-target'], ['storage_provider_id', 'other-provider'], ['namespace_id', 'other-namespace'],
            ['user_id', 'other-owner'], ['mime_type', 'image/png'], ['size_bytes', 11], ['expires_at', 1200],
        ] as const) {
            expect(() => raw.prepare(`UPDATE storage_generation_uploads SET ${column} = ?`).run(value), column).toThrow();
        }
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'reserved', storageId: request.storageId, userId: key.userId });
        expect(activeCharge()).toBe(10);
    });
});

describe('verified publication and exact canonical charge handoff', () => {
    it('cannot commit a raw published binding without the corresponding real generation', async () => {
        await coordinator.reserveGenerationUpload(request);
        await coordinator.markGenerationUploadReady(ready);
        raw.exec('BEGIN IMMEDIATE');
        raw.prepare(`UPDATE storage_generation_uploads SET state = 'published_pending_metadata',
            published_generation_id = ?, published_at = ? WHERE intent_id = ?`).run(key.generationId, now, key.intentId);
        expect(raw.prepare('SELECT state FROM storage_generation_uploads').get()).toEqual({ state: 'published_pending_metadata' });
        expect(raw.prepare('SELECT count(*) AS count FROM storage_object_generations').get()).toEqual({ count: 0 });
        expect(() => raw.exec('COMMIT')).toThrow(/FOREIGN KEY/i);
        expect(raw.inTransaction).toBe(true);
        raw.exec('ROLLBACK');
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'ready', reservedBytes: 10 });
        expect(await coordinator.getGeneration(key)).toBeNull();
        expect(activeCharge()).toBe(10);
    });

    it('requires an exact readiness identity and leaves the charge live through publication', async () => {
        await coordinator.reserveGenerationUpload(request);
        await expect(coordinator.publishGenerationUpload(publication)).rejects.toThrow();
        expect(await coordinator.markGenerationUploadReady(ready)).toMatchObject({ status: 'ready', intent: { state: 'ready', readyAt: 1000 } });
        expect(await coordinator.markGenerationUploadReady(ready)).toMatchObject({ status: 'replayed' });
        await expect(coordinator.markGenerationUploadReady({ ...ready, readyReceiptId: 'wrong' })).rejects.toThrow();
        for (const change of [{ readyReceiptId: 'wrong' }, { storageId: 'wrong-target' }, { sizeBytes: 11 }]) {
            await expect(coordinator.publishGenerationUpload({ ...publication, ...change })).rejects.toThrow();
        }
        const first = await coordinator.publishGenerationUpload(publication);
        expect(first).toMatchObject({ status: 'published', intent: { state: 'published_pending_metadata', publishedAt: 1000 }, generation: { state: 'verified' } });
        expect(await coordinator.publishGenerationUpload(publication)).toEqual({ ...first, status: 'replayed' });
        expect(accounting()).toEqual({ status: 'active', reserved_bytes: 10, expires_at: Number.MAX_SAFE_INTEGER });
    });

    it.each([0, 10])('transfers an exact %i-byte charge atomically only to live canonical metadata', async sizeBytes => {
        await coordinator.reserveGenerationUpload({ ...request, sizeBytes });
        await coordinator.markGenerationUploadReady(ready);
        await coordinator.publishGenerationUpload({ ...publication, sizeBytes });
        metadata({ hash, storage_id: request.storageId, size_bytes: sizeBytes }, hash, key.workspaceId, 1);
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'published_pending_metadata' });
        expect(accounting()?.status).toBe('active');
        raw.exec('BEGIN IMMEDIATE');
        raw.exec('UPDATE s_file_meta SET deleted = 0');
        expect(accounting()?.status).toBe('consumed');
        raw.exec('ROLLBACK');
        expect(accounting()?.status).toBe('active');
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'published_pending_metadata' });
        raw.exec('UPDATE s_file_meta SET deleted = 0');
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'materialized', sizeBytes, materializedAt: 1000 });
        expect(accounting()?.status).toBe('consumed');
        expect(activeCharge()).toBe(0);
        expect(await coordinator.claimAbandonedGenerationUpload(claim)).toEqual({ status: 'blocked', reason: 'materialized' });
    });

    it('accepts one exact size alias, rejects conflicting aliases, and cannot be materialized with the wrong target or size', async () => {
        await publish();
        for (const data of [
            { hash, storage_id: request.storageId, size_bytes: 0 },
            { hash, storage_id: request.storageId, size_bytes: '10' },
            { hash, storage_id: request.storageId, size_bytes: null },
            { hash, storage_id: request.storageId, size_bytes: 10, sizeBytes: 10 },
            { hash, storage_id: 'wrong-target', size_bytes: 10 },
            { hash: otherHash, storage_id: request.storageId, size_bytes: 10 },
            `{"hash":"${hash}","storage_id":"${request.storageId}","size_bytes":10,"size_bytes":0}`,
        ]) {
            expect(() => metadata(data)).toThrow();
            expect(activeCharge()).toBe(10);
            expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'published_pending_metadata' });
        }
        metadata({ hash, storage_id: request.storageId, sizeBytes: 10 });
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'materialized' });
        expect(activeCharge()).toBe(0);
        expect(raw.prepare('SELECT count(*) AS count FROM s_file_meta WHERE deleted = 0').get()).toEqual({ count: 1 });
    });

    it('refuses raw accounting handoff without live exact metadata', async () => {
        await publish();
        expect(() => raw.exec("UPDATE storage_generation_uploads SET state = 'materialized', reserved_bytes = 0, materialized_at = 1000")).toThrow();
        expect(() => raw.exec("UPDATE upload_intents SET status = 'consumed', consumed_at = 1000")).toThrow();
        expect(activeCharge()).toBe(10);
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'published_pending_metadata' });
    });

    it('retains source-first published bytes and their charge after credentials expire', async () => {
        await publish();
        source('s_messages', 'first', { file_hashes: [`SHA256:${hash.toUpperCase()}`] });
        now = 1100;
        expect(await coordinator.claimAbandonedGenerationUpload(claim)).toEqual({ status: 'blocked', reason: 'in_use' });
        expect(await coordinator.getGenerationUploadClaim(claim)).toBeNull();
        expect(await coordinator.getGeneration(key)).toMatchObject({ state: 'verified' });
        expect(activeCharge()).toBe(10);
        now = 1200;
        raw.exec('DELETE FROM s_messages');
        expect(await coordinator.claimAbandonedGenerationUpload({ ...claim, retentionSeconds: 10 }))
            .toEqual({ status: 'blocked', reason: 'retention' });
        now = 1210;
        expect(await coordinator.claimAbandonedGenerationUpload({ ...claim, retentionSeconds: 10 }))
            .toMatchObject({ status: 'claimed', intent: { state: 'abandon_claimed', claimId: claim.claimId } });
        expect(await coordinator.getGeneration(key)).toMatchObject({ state: 'claimed', claimId: claim.claimId });
        expect(activeCharge()).toBe(0);
        expect(() => source()).toThrow();
        expect(() => metadata()).toThrow();
    });
});

describe('separate abandonment authority and conservative recovery', () => {
    it('never authorizes incomplete reservations for reclamation, even long after expiry', async () => {
        await coordinator.reserveGenerationUpload(request);
        now = 100000;
        expect(await coordinator.claimAbandonedGenerationUpload(claim)).toEqual({ status: 'blocked', reason: 'not_ready' });
        expect(await coordinator.getGenerationUploadClaim(claim)).toBeNull();
        await expect(coordinator.completeGenerationUploadAbandonment(claim)).rejects.toThrow();
        expect(await coordinator.getGeneration(key)).toBeNull();
        expect(activeCharge()).toBe(10);
        expect(await coordinator.listGenerationUploadRecovery({ workspaceId: key.workspaceId }))
            .toMatchObject({ items: [{ intentId: key.intentId, state: 'reserved' }] });
    });

    it('keeps a ready allocation charged when canonical proof exceeds its bounded row budget', async () => {
        await coordinator.reserveGenerationUpload(request);
        await coordinator.markGenerationUploadReady(ready);
        raw.transaction(() => {
            for (let i = 0; i <= GENERATION_PROOF_ROWS; i++) source('s_messages', `empty-${i}`, { file_hashes: null });
        })();
        now = 1100;
        expect(await coordinator.claimAbandonedGenerationUpload(claim)).toEqual({ status: 'blocked', reason: 'proof_incomplete' });
        expect(await coordinator.getGenerationUploadClaim(claim)).toBeNull();
        expect(await coordinator.getGeneration(key)).toBeNull();
        expect(activeCharge()).toBe(10);
    });

    it('records late readiness for recovery without permitting expired publication or fabricating a generation', async () => {
        await coordinator.reserveGenerationUpload(request);
        now = 1061;
        expect(await coordinator.markGenerationUploadReady(ready)).toMatchObject({ status: 'ready', intent: { expiresAt: 1060, readyAt: 1061 } });
        await expect(coordinator.publishGenerationUpload(publication)).rejects.toThrow(/expir/i);
        expect(await coordinator.getGeneration(key)).toBeNull();
        expect(await coordinator.claimAbandonedGenerationUpload({ ...claim, retentionSeconds: 10 }))
            .toEqual({ status: 'blocked', reason: 'retention' });
        now = 1071;
        expect(await coordinator.claimAbandonedGenerationUpload({ ...claim, retentionSeconds: 10 }))
            .toMatchObject({ status: 'claimed', intent: { state: 'abandon_claimed', readyReceiptId: ready.readyReceiptId } });
        expect(await coordinator.getGeneration(key)).toBeNull();
        expect(await coordinator.getGenerationUploadClaim(claim)).toMatchObject({ state: 'abandon_claimed', claimId: claim.claimId });
        expect(activeCharge()).toBe(0);
        expect(await coordinator.completeGenerationUploadAbandonment(claim)).toMatchObject({ status: 'abandoned', intent: { state: 'abandoned' } });
        expect(await coordinator.completeGenerationUploadAbandonment(claim)).toMatchObject({ status: 'replayed' });
        expect(await coordinator.getGeneration(key)).toBeNull();
    });

    it('requires expiry, exact claims and durable published-generation fencing', async () => {
        await publish();
        expect(await coordinator.claimAbandonedGenerationUpload(claim)).toEqual({ status: 'blocked', reason: 'not_expired' });
        now = 1060;
        expect(await coordinator.claimAbandonedGenerationUpload(claim)).toMatchObject({ status: 'claimed' });
        expect(await coordinator.claimAbandonedGenerationUpload(claim)).toMatchObject({ status: 'replayed' });
        expect(await coordinator.claimAbandonedGenerationUpload({ ...claim, claimId: 'other-claim' }))
            .toEqual({ status: 'blocked', reason: 'claim_conflict' });
        for (const change of [{ claimId: 'other-claim' }, { intentId: 'other-intent' }, { workspaceId: 'foreign' }, { generationId: 'other-generation' }]) {
            expect(await coordinator.getGenerationUploadClaim({ ...claim, ...change })).toBeNull();
            await expect(coordinator.completeGenerationUploadAbandonment({ ...claim, ...change })).rejects.toThrow();
        }
        expect(await coordinator.getGeneration(key)).toMatchObject({ state: 'claimed', claimId: claim.claimId });
        expect(await coordinator.completeGenerationUploadAbandonment(claim)).toMatchObject({ status: 'abandoned' });
        expect(await coordinator.getGeneration(key)).toMatchObject({ state: 'deleted', claimId: claim.claimId });
        expect(await coordinator.getGenerationUploadClaim(claim)).toMatchObject({ state: 'abandoned' });
    });

    it('rolls back the real generation claim and allocation together when accounting release fails', async () => {
        await publish();
        now = 1100;
        raw.exec(`CREATE TRIGGER reject_test_accounting_release BEFORE UPDATE ON upload_intents
            WHEN NEW.status = 'cancelled' BEGIN SELECT RAISE(ABORT, 'injected accounting failure'); END`);
        await expect(coordinator.claimAbandonedGenerationUpload(claim)).rejects.toThrow(/injected accounting failure/);
        expect(await coordinator.getGeneration(key)).toMatchObject({ state: 'verified' });
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'published_pending_metadata' });
        expect(await coordinator.getGenerationUploadClaim(claim)).toBeNull();
        expect(activeCharge()).toBe(10);
        raw.exec('DROP TRIGGER reject_test_accounting_release');
        expect(await coordinator.claimAbandonedGenerationUpload(claim)).toMatchObject({ status: 'claimed' });
        expect(await coordinator.getGeneration(key)).toMatchObject({ state: 'claimed', claimId: claim.claimId });
        expect(activeCharge()).toBe(0);
    });

    it('keeps permanent abandoned bindings and replay authority across a real database reopen', async () => {
        await coordinator.reserveGenerationUpload(request);
        await coordinator.markGenerationUploadReady(ready);
        now = 1100;
        await coordinator.claimAbandonedGenerationUpload(claim);
        await destroySqliteDb();
        await initializeSqliteDb({ path: filename, synchronous: 'FULL' });
        raw = getRawDb() as Database.Database;
        raw.function('unixepoch', () => now);
        coordinator = new SqliteExternalStorageGenerationUploadCoordinator({ storageProviderId: 'filesystem' });
        expect(await coordinator.getGenerationUploadClaim(claim)).toMatchObject({ state: 'abandon_claimed', readyReceiptId: ready.readyReceiptId });
        expect(await coordinator.claimAbandonedGenerationUpload(claim)).toMatchObject({ status: 'replayed' });
        expect(await coordinator.completeGenerationUploadAbandonment(claim)).toMatchObject({ status: 'abandoned' });
        expect(await coordinator.reserveGenerationUpload(request)).toMatchObject({ status: 'replayed', intent: { state: 'abandoned' } });
        await expect(coordinator.reserveGenerationUpload({ ...request, intentId: 'reused-target', generationId: 'g2' })).rejects.toThrow();
        expect(() => raw.exec('DELETE FROM storage_generation_uploads')).toThrow();
        expect(() => raw.exec("UPDATE storage_generation_uploads SET state = 'reserved'")).toThrow();
        expect(await coordinator.getGeneration(key)).toBeNull();
    });

    it('pages bounded recovery observations with a workspace-scoped cursor and no authorization side effects', async () => {
        await coordinator.reserveGenerationUpload(request);
        await coordinator.reserveGenerationUpload({ ...request, hash: otherHash, intentId: 'intent-2', generationId: 'g2', storageId: 'target-2' });
        await coordinator.reserveGenerationUpload({ ...request, workspaceId: 'foreign', hash: 'c'.repeat(64), intentId: 'foreign', generationId: 'g3', storageId: 'target-3' });
        now = 1100;
        const before = raw.prepare('SELECT total_changes() AS count').get();
        const page = await coordinator.listGenerationUploadRecovery({ workspaceId: key.workspaceId, limit: 1 });
        expect(page.items).toHaveLength(1);
        expect(page.hasMore).toBe(true);
        expect(page.nextCursor).toBeTypeOf('string');
        const next = await coordinator.listGenerationUploadRecovery({ workspaceId: key.workspaceId, limit: 1, cursor: page.nextCursor });
        expect(next.items).toHaveLength(1);
        expect(next.hasMore).toBe(false);
        expect(new Set([...page.items, ...next.items].map(item => item.intentId))).toEqual(new Set([key.intentId, 'intent-2']));
        await expect(coordinator.listGenerationUploadRecovery({ workspaceId: 'foreign', cursor: page.nextCursor })).rejects.toThrow();
        await expect(coordinator.listGenerationUploadRecovery({ workspaceId: key.workspaceId, cursor: 'malformed' })).rejects.toThrow();
        expect(raw.prepare('SELECT total_changes() AS count').get()).toEqual(before);
        expect(await coordinator.getGenerationUploadClaim(claim)).toBeNull();
    });
});

describe('upload operations require exact durable guard authority', () => {
    it('refuses every upload operation inside an outer transaction without changing its state', async () => {
        await coordinator.reserveGenerationUpload(request);
        raw.exec('BEGIN IMMEDIATE');
        for (const operation of operations()) await expect(operation()).rejects.toThrow(/outer transaction/i);
        expect(raw.inTransaction).toBe(true);
        raw.exec('ROLLBACK');
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'reserved' });
    });

    it.each(['NORMAL', 'foreign_keys', 'DELETE'])('checks %s durability on all upload reads and writes without repairing operator settings', async setting => {
        await coordinator.reserveGenerationUpload(request);
        if (setting === 'NORMAL') raw.pragma('synchronous = NORMAL');
        if (setting === 'foreign_keys') raw.pragma('foreign_keys = OFF');
        if (setting === 'DELETE') raw.pragma('journal_mode = DELETE');
        for (const operation of operations()) await expect(operation()).rejects.toThrow(/FULL|foreign_keys|WAL/i);
        if (setting === 'NORMAL') expect(raw.pragma('synchronous', { simple: true })).toBe(1);
        if (setting === 'foreign_keys') expect(raw.pragma('foreign_keys', { simple: true })).toBe(0);
        if (setting === 'DELETE') expect(raw.pragma('journal_mode', { simple: true })).toBe('delete');
    });

    it('refuses missing and same-name modified guards even with a current migration ledger', async () => {
        await coordinator.reserveGenerationUpload(request);
        const name = 'storage_upload_ledger_update';
        raw.exec(`DROP TRIGGER ${name}`);
        for (const operation of operations()) await expect(operation()).rejects.toThrow(/integrity/i);
        raw.exec(`CREATE TRIGGER ${name} BEFORE UPDATE ON upload_intents BEGIN SELECT 1; END`);
        for (const operation of operations()) await expect(operation()).rejects.toThrow(/integrity/i);
        raw.exec(`DROP TRIGGER ${name}`);
        raw.exec(generationUploadGuardTriggers()[name]!);
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'reserved' });
    });

    it('requires inherited reference barriers on every upload operation too', async () => {
        await coordinator.reserveGenerationUpload(request);
        raw.exec('DROP TRIGGER s_messages_generation_guard_insert');
        for (const operation of operations()) await expect(operation()).rejects.toThrow(/integrity/i);
    });

    it('replaces historical migration-024 upload guards and fails closed under either mixed-version fingerprint', async () => {
        await coordinator.reserveGenerationUpload(request);
        const actual = new Map((raw.prepare("SELECT name,sql FROM sqlite_master WHERE type = 'trigger'").all() as
            { name: string; sql: string }[]).map(row => [row.name, canonicalGuardSql(row.sql)]));
        for (const name of ['upload_intents_generation_guard_insert', 'upload_intents_generation_guard_update']) {
            expect(actual.get(name)).toBe(canonicalGuardSql(generationUploadGuardTriggers()[name]!));
            expect(actual.get(name)).not.toBe(canonicalGuardSql(generationGuardTriggers()[name]!));
        }
        // This is the historical exact-fingerprint algorithm, using unchanged
        // production migration-024 definitions rather than a vendored old class.
        expect(() => {
            for (const [name, sql] of Object.entries(generationGuardTriggers())) {
                if (actual.get(name) !== canonicalGuardSql(sql)) throw new Error(`Historical guard integrity failure: ${name}`);
            }
        }).toThrow(/integrity/);
        const name = 'upload_intents_generation_guard_update';
        raw.exec(`DROP TRIGGER ${name}`);
        raw.exec(generationGuardTriggers()[name]!);
        try {
            await expect(coordinator.getGeneration(key)).rejects.toThrow(/integrity/i);
            for (const operation of operations()) await expect(operation()).rejects.toThrow(/integrity/i);
        } finally {
            raw.exec(`DROP TRIGGER ${name}`);
            raw.exec(generationUploadGuardTriggers()[name]!);
        }
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'reserved' });
    });

    it('refuses in-memory SQLite for every upload operation', async () => {
        const memory = new Database(':memory:');
        coordinator = new SqliteExternalStorageGenerationUploadCoordinator({ storageProviderId: 'filesystem', database: memory });
        try {
            for (const operation of operations()) await expect(operation()).rejects.toThrow(/file-backed/i);
        } finally { memory.close(); }
    });

    it.each(['d1', 'turso'])('explicitly refuses the unsupported %s driver', async driver => {
        await destroySqliteDb();
        vi.stubEnv('OR3_SQLITE_DRIVER', driver);
        expect(() => new SqliteExternalStorageGenerationUploadCoordinator({ storageProviderId: 'filesystem' })).toThrow(/unsupported/i);
    });
});

describe('retained generation restore tickets', () => {
    it('reserves an exact retained target without allocating bytes or replacing its generation', async () => {
        await tombstoneMaterializedGeneration();
        expect(await coordinator.reserveGenerationRestore(restoreRequest)).toMatchObject({
            status: 'reserved', intent: {
                intentId: restoreRequest.intentId, generationId: key.generationId, purpose: 'restore',
                storageId: request.storageId, namespaceId: request.namespaceId, mimeType: request.mimeType,
                sizeBytes: 10, reservedBytes: 10, state: 'published_pending_metadata', expiresAt: 1060,
            },
        });
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'materialized', purpose: 'upload', reservedBytes: 0 });
        expect(await coordinator.getGeneration(key)).toMatchObject({ state: 'verified', storageId: request.storageId });
        expect(raw.prepare('SELECT count(*) AS count FROM storage_object_generations').get()).toEqual({ count: 1 });
        expect(raw.prepare('SELECT count(*) AS count FROM storage_object_heads').get()).toEqual({ count: 1 });
        expect(activeCharge()).toBe(10);
        expect(raw.prepare('SELECT status,reserved_bytes,expires_at FROM upload_intents WHERE id = ?').get(restoreRequest.intentId))
            .toEqual({ status: 'active', reserved_bytes: 10, expires_at: Number.MAX_SAFE_INTEGER });
        await expect(coordinator.markGenerationUploadReady({ ...ready, intentId: restoreRequest.intentId })).rejects.toThrow(/restore/i);
        await expect(coordinator.publishGenerationUpload({ ...publication, intentId: restoreRequest.intentId })).rejects.toThrow(/restore/i);
    });

    it('keeps restore admission atomic and rejects quota overspend and duplicate live or pending tickets', async () => {
        await publish();
        metadata();
        await expect(coordinator.reserveGenerationRestore(restoreRequest)).rejects.toThrow();
        raw.exec('UPDATE s_file_meta SET deleted = 1');
        await expect(coordinator.reserveGenerationRestore({ ...restoreRequest, workspaceQuotaBytes: 9 })).rejects.toThrow(/quota/i);
        expect(await coordinator.getGenerationUpload(restoreRequest)).toBeNull();
        expect(activeCharge()).toBe(0);
        await coordinator.reserveGenerationRestore(restoreRequest);
        await expect(coordinator.reserveGenerationRestore({ ...restoreRequest, intentId: 'duplicate-restore' })).rejects.toThrow();
        expect(activeCharge()).toBe(10);
        expect(raw.prepare('SELECT count(*) AS count FROM storage_generation_uploads').get()).toEqual({ count: 2 });
    });

    it('replays one owner-bound restore tuple without renewing credentials or accepting cross-purpose replay', async () => {
        await tombstoneMaterializedGeneration();
        const first = await coordinator.reserveGenerationRestore(restoreRequest);
        now = 1010;
        expect(await coordinator.reserveGenerationRestore(restoreRequest)).toEqual({ status: 'replayed', intent: first.intent });
        for (const change of [
            { userId: 'different-owner' }, { workspaceId: 'foreign' }, { hash: otherHash },
            { generationId: 'wrong-generation' }, { expiresInSeconds: 61 }, { workspaceQuotaBytes: 101 },
        ]) await expect(coordinator.reserveGenerationRestore({ ...restoreRequest, ...change })).rejects.toThrow();
        const foreignProvider = new SqliteExternalStorageGenerationUploadCoordinator({ storageProviderId: 'other-provider' });
        await expect(foreignProvider.reserveGenerationRestore(restoreRequest)).rejects.toThrow();
        await expect(coordinator.reserveGenerationUpload({ ...request, intentId: restoreRequest.intentId })).rejects.toThrow();
        await expect(coordinator.reserveGenerationRestore({ ...restoreRequest, intentId: key.intentId })).rejects.toThrow();
        expect(await coordinator.getGenerationUpload({ ...restoreRequest, userId: 'different-owner' })).toBeNull();
        expect(activeCharge()).toBe(10);
    });

    it('requires an original materialized upload and a current verified generation', async () => {
        await coordinator.reserveGenerationUpload(request);
        await expect(coordinator.reserveGenerationRestore(restoreRequest)).rejects.toThrow();
        await coordinator.markGenerationUploadReady(ready);
        await coordinator.publishGenerationUpload(publication);
        await expect(coordinator.reserveGenerationRestore(restoreRequest)).rejects.toThrow();
        metadata();
        raw.exec('UPDATE s_file_meta SET deleted = 1');
        expect(await coordinator.claimGeneration(claim)).toMatchObject({ status: 'claimed' });
        await expect(coordinator.reserveGenerationRestore(restoreRequest)).rejects.toThrow();
        await coordinator.completeDeletion(claim);
        await expect(coordinator.reserveGenerationRestore(restoreRequest)).rejects.toThrow();
        expect(await coordinator.getGenerationUpload(restoreRequest)).toBeNull();
        expect(activeCharge()).toBe(0);
    });

    it('requires a restore hold for raw metadata resurrection and new source-first references after tombstoning', async () => {
        await tombstoneMaterializedGeneration();
        expect(() => raw.exec('UPDATE s_file_meta SET deleted = 0')).toThrow();
        expect(() => source('s_messages', 'without-hold')).toThrow();
        expect(() => source('s_posts', 'without-hold')).toThrow();
        await coordinator.reserveGenerationRestore(restoreRequest);
        source('s_messages', 'with-hold');
        source('s_posts', 'with-hold');
        expect(activeCharge()).toBe(10);
        raw.exec('UPDATE s_file_meta SET deleted = 0');
        expect(await coordinator.getGenerationUpload(restoreRequest)).toMatchObject({ state: 'materialized', reservedBytes: 0 });
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'materialized', reservedBytes: 0 });
        expect(activeCharge()).toBe(0);
        source('s_messages', 'with-live-metadata');
        expect(await coordinator.claimGeneration(claim)).toEqual({ status: 'blocked', reason: 'in_use' });
    });

    it('pins an expired restore hold while source-first references remain and claims its actual generation after removal', async () => {
        await tombstoneMaterializedGeneration();
        await coordinator.reserveGenerationRestore(restoreRequest);
        source('s_messages', 'restore-source');
        now = 1100;
        expect(await coordinator.claimAbandonedGenerationUpload(restoreClaim)).toEqual({ status: 'blocked', reason: 'in_use' });
        expect(activeCharge()).toBe(10);
        expect(await coordinator.getGenerationUploadClaim(restoreClaim)).toBeNull();
        source('s_posts', 'later-source');
        await expect(adapter.cancelUploadIntent(event, restoreRequest)).rejects.toThrow();
        raw.exec('DELETE FROM s_messages; DELETE FROM s_posts;');
        expect(await coordinator.claimAbandonedGenerationUpload(restoreClaim)).toMatchObject({ status: 'claimed', intent: { purpose: 'restore', state: 'abandon_claimed' } });
        expect(await coordinator.getGeneration(key)).toMatchObject({ state: 'claimed', claimId: restoreClaim.claimId });
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'materialized', purpose: 'upload' });
        expect(activeCharge()).toBe(0);
        expect(() => raw.exec('UPDATE s_file_meta SET deleted = 0')).toThrow();
        expect(await coordinator.completeGenerationUploadAbandonment(restoreClaim)).toMatchObject({ status: 'abandoned' });
        expect(await coordinator.getGeneration(key)).toMatchObject({ state: 'deleted', claimId: restoreClaim.claimId });
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'materialized', purpose: 'upload' });
    });

    it('rolls back exact metadata resurrection and restore charge consumption together', async () => {
        await tombstoneMaterializedGeneration();
        await coordinator.reserveGenerationRestore(restoreRequest);
        raw.exec('BEGIN IMMEDIATE');
        raw.exec('UPDATE s_file_meta SET deleted = 0');
        expect(activeCharge()).toBe(0);
        raw.exec('ROLLBACK');
        expect(await coordinator.getGenerationUpload(restoreRequest)).toMatchObject({ state: 'published_pending_metadata', reservedBytes: 10 });
        expect(activeCharge()).toBe(10);
        expect(raw.prepare('SELECT deleted FROM s_file_meta').get()).toEqual({ deleted: 1 });
        raw.exec('UPDATE s_file_meta SET deleted = 0');
        expect(await coordinator.getGenerationUpload(restoreRequest)).toMatchObject({ state: 'materialized', reservedBytes: 0 });
        expect(activeCharge()).toBe(0);
    });

    it('retains separate materialized tickets through repeated restores of the same immutable generation', async () => {
        await tombstoneMaterializedGeneration();
        await coordinator.reserveGenerationRestore(restoreRequest);
        raw.exec('UPDATE s_file_meta SET deleted = 0');
        expect(await coordinator.reserveGenerationRestore(restoreRequest)).toMatchObject({ status: 'replayed', intent: { state: 'materialized' } });
        expect(await coordinator.reserveGenerationUpload(request)).toMatchObject({
            status: 'replayed', intent: { ...key, state: 'materialized', purpose: 'upload', reservedBytes: 0 },
        });
        now = 1100;
        raw.exec('UPDATE s_file_meta SET deleted = 1');
        const next = { ...restoreRequest, intentId: 'restore-2', userId: 'another-authorized-user' };
        await coordinator.reserveGenerationRestore(next);
        expect(activeCharge()).toBe(10);
        expect(await coordinator.getGenerationUpload(restoreRequest)).toMatchObject({ state: 'materialized', reservedBytes: 0 });
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'materialized', reservedBytes: 0 });
        raw.exec('UPDATE s_file_meta SET deleted = 0');
        expect(await coordinator.getGenerationUpload(next)).toMatchObject({ state: 'materialized', reservedBytes: 0 });
        expect(await coordinator.reserveGenerationUpload(request)).toMatchObject({
            status: 'replayed', intent: { ...key, state: 'materialized', purpose: 'upload', reservedBytes: 0 },
        });
        expect(activeCharge()).toBe(0);
        expect(raw.prepare('SELECT count(*) AS count FROM storage_generation_uploads').get()).toEqual({ count: 3 });
        expect(raw.prepare('SELECT count(*) AS count FROM storage_object_generations').get()).toEqual({ count: 1 });
        expect(await coordinator.claimAbandonedGenerationUpload(restoreClaim)).toEqual({ status: 'blocked', reason: 'materialized' });
    });

    it('serializes shared quota admission against the existing legacy adapter', async () => {
        await tombstoneMaterializedGeneration();
        const results = await Promise.allSettled([
            adapter.reserveUploadIntent(event, {
                workspaceId: key.workspaceId, intentId: 'legacy-racer', hash: otherHash, mimeType: 'text/plain',
                sizeBytes: 95, expiresAt: now + 60, workspaceQuotaBytes: 100,
            }),
            coordinator.reserveGenerationRestore(restoreRequest),
        ]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
        expect(activeCharge()).toBeLessThanOrEqual(100);
        expect(activeCharge()).toBeGreaterThan(0);
    });
});

const nativeModule = createRequire(import.meta.url).resolve('better-sqlite3');
function rawWorker(script: string, shared?: SharedArrayBuffer): Worker {
    return new Worker(`const {parentPort, workerData} = require('node:worker_threads');
        const Database = require(workerData.nativeModule);
        const db = new Database(workerData.filename);
        db.pragma('busy_timeout = 5000'); db.pragma('synchronous = FULL'); db.pragma('foreign_keys = ON');
        db.function('unixepoch', () => workerData.now);
        const hash = workerData.hash; const workspace = workerData.workspace;
        const flags = workerData.shared && new Int32Array(workerData.shared);
        ${script}`, { eval: true, workerData: { nativeModule, filename, hash, workspace: key.workspaceId, now, shared } });
}

function message(worker: Worker): Promise<unknown> {
    return new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
}

describe('native independent connection atomicity', () => {
    it('lets an earlier metadata transaction materialize the charge before a waiting abandonment claim', async () => {
        await publish();
        now = 1100;
        const worker = rawWorker(`db.exec('BEGIN IMMEDIATE');
            db.prepare('INSERT INTO s_file_meta(workspace_id,id,data_json) VALUES (?,?,?)')
                .run(workspace,hash,JSON.stringify({hash,storage_id:'${request.storageId}',size_bytes:10}));
            parentPort.postMessage('locked'); setTimeout(() => { db.exec('COMMIT'); db.close(); }, 150);`);
        try {
            expect(await message(worker)).toBe('locked');
            expect(await coordinator.claimAbandonedGenerationUpload(claim)).toEqual({ status: 'blocked', reason: 'materialized' });
            expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'materialized' });
            expect(accounting()?.status).toBe('consumed');
            expect(await coordinator.getGeneration(key)).toMatchObject({ state: 'verified' });
        } finally { await worker.terminate(); }
    });

    it('rolls back an interrupted metadata handoff with the canonical row and recovers the charge', async () => {
        await publish();
        const worker = rawWorker(`db.exec('BEGIN IMMEDIATE');
            db.prepare('INSERT INTO s_file_meta(workspace_id,id,data_json) VALUES (?,?,?)')
                .run(workspace,hash,JSON.stringify({hash,storage_id:'${request.storageId}',size_bytes:10}));
            parentPort.postMessage(db.prepare('SELECT status FROM upload_intents').get().status);
            setInterval(() => {}, 1000);`);
        try { expect(await message(worker)).toBe('consumed'); }
        finally { await worker.terminate(); }
        expect(raw.prepare('SELECT count(*) AS count FROM s_file_meta').get()).toEqual({ count: 0 });
        expect(await coordinator.getGenerationUpload(key)).toMatchObject({ state: 'published_pending_metadata' });
        expect(activeCharge()).toBe(10);
        now = 1100;
        expect(await coordinator.claimAbandonedGenerationUpload(claim)).toMatchObject({ status: 'claimed' });
        expect(activeCharge()).toBe(0);
    });

    it('lets a real metadata restore holding the writer lock win before a waiting restore-ticket abandonment', async () => {
        await tombstoneMaterializedGeneration();
        await coordinator.reserveGenerationRestore(restoreRequest);
        now = 1100;
        const worker = rawWorker(`db.exec('BEGIN IMMEDIATE');
            db.prepare('UPDATE s_file_meta SET deleted=0 WHERE workspace_id=? AND id=?').run(workspace,hash);
            parentPort.postMessage('locked'); setTimeout(() => { db.exec('COMMIT'); db.close(); }, 150);`);
        try {
            expect(await message(worker)).toBe('locked');
            expect(await coordinator.claimAbandonedGenerationUpload(restoreClaim)).toEqual({ status: 'blocked', reason: 'materialized' });
            expect(await coordinator.getGenerationUpload(restoreRequest)).toMatchObject({ state: 'materialized' });
            expect(await coordinator.getGeneration(key)).toMatchObject({ state: 'verified' });
            expect(activeCharge()).toBe(0);
        } finally { await worker.terminate(); }
    });

    it('rejects a simultaneous raw metadata resurrection after the real restore-ticket claim commits first', async () => {
        await tombstoneMaterializedGeneration();
        await coordinator.reserveGenerationRestore(restoreRequest);
        now = 1100;
        const shared = new SharedArrayBuffer(8);
        const flags = new Int32Array(shared);
        const worker = rawWorker(`parentPort.postMessage('ready'); Atomics.wait(flags,0,0);
            Atomics.store(flags,1,1); Atomics.notify(flags,1);
            try { db.prepare('UPDATE s_file_meta SET deleted=0 WHERE workspace_id=? AND id=?').run(workspace,hash); parentPort.postMessage('unsafe-success'); }
            catch (error) { parentPort.postMessage(error.message); } finally { db.close(); }`, shared);
        try {
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
            try { expect(await coordinator.claimAbandonedGenerationUpload(restoreClaim)).toMatchObject({ status: 'claimed' }); }
            finally { spy.mockRestore(); }
            expect(await result).toMatch(/CLAIMED|MISMATCH|PENDING/);
            expect(await coordinator.getGeneration(key)).toMatchObject({ state: 'claimed', claimId: restoreClaim.claimId });
            expect(raw.prepare('SELECT deleted FROM s_file_meta').get()).toEqual({ deleted: 1 });
            expect(activeCharge()).toBe(0);
        } finally { await worker.terminate(); }
    });

    it('sees an independent legacy quota reservation committed before a waiting restore admission', async () => {
        await tombstoneMaterializedGeneration();
        const worker = rawWorker(`db.exec('BEGIN IMMEDIATE');
            db.prepare("INSERT INTO upload_intents(id,workspace_id,hash,mime_type,size_bytes,reserved_bytes,expires_at,status,created_at) VALUES ('legacy-writer',?,?,'text/plain',95,95,1060,'active',1000)")
                .run(workspace,'${otherHash}');
            parentPort.postMessage('locked'); setTimeout(() => { db.exec('COMMIT'); db.close(); }, 150);`);
        try {
            expect(await message(worker)).toBe('locked');
            await expect(coordinator.reserveGenerationRestore(restoreRequest)).rejects.toThrow(/quota/i);
            expect(await coordinator.getGenerationUpload(restoreRequest)).toBeNull();
            expect(activeCharge()).toBe(95);
        } finally { await worker.terminate(); }
    });
});
