import type {
    ExternalStorageGenerationUploadCoordinatorV1,
    ExternalStorageGenerationUploadIntent,
    ExternalStorageGenerationUploadKey,
    ExternalStorageGenerationUploadClaimKey,
    ExternalStorageGenerationUploadClaimResult,
} from '~~/server/storage/gateway/generation-upload';
import {
    SqliteExternalStorageGenerationCoordinator, assertGenerationIdentifier, generationRecord,
} from './sqlite-generation-coordinator';
import { GENERATION_TABLE, HEAD_TABLE, GENERATION_PROOF_ROWS, generationHashSql, validGenerationHashSql, validGenerationObjectSql } from '../db/storage-generation-guards';
import {
    GENERATION_UPLOAD_TABLE as UPLOADS, GENERATION_UPLOAD_HOLD_EXPIRY,
    GENERATION_UPLOAD_MAX_TTL_SECONDS, GENERATION_UPLOAD_MAX_PENDING,
} from '../db/storage-generation-upload-guards';

type ReserveInput = ExternalStorageGenerationUploadKey & {
    namespaceId: string; storageId: string; mimeType: string; sizeBytes: number;
    expiresInSeconds: number; workspaceQuotaBytes?: number;
};
type ReadyInput = ExternalStorageGenerationUploadKey & { storageId: string; readyReceiptId: string };
type PublishInput = ReadyInput & { sizeBytes: number };
type ClaimInput = ExternalStorageGenerationUploadClaimKey & { retentionSeconds: number };
type RestoreInput = ExternalStorageGenerationUploadKey & { expiresInSeconds: number; workspaceQuotaBytes?: number };
type UploadRow = {
    intent_id: string; workspace_id: string; hash: string; generation_id: string; user_id: string;
    storage_provider_id: string; namespace_id: string; storage_id: string; mime_type: string;
    size_bytes: number; reserved_bytes: number; created_at: number; expires_at: number;
    request_ttl: number; quota_bytes: number | null; state: ExternalStorageGenerationUploadIntent['state'];
    purpose: 'upload' | 'restore';
    ready_receipt_id: string | null; ready_at: number | null; published_generation_id: string | null;
    published_at: number | null; materialized_at: number | null; claim_id: string | null;
    claimed_at: number | null; deleted_at: number | null;
};

function intent(row: UploadRow): ExternalStorageGenerationUploadIntent {
    return {
        intentId: row.intent_id, workspaceId: row.workspace_id, hash: row.hash, purpose: row.purpose,
        generationId: row.generation_id, userId: row.user_id, storageProviderId: row.storage_provider_id,
        namespaceId: row.namespace_id, storageId: row.storage_id, mimeType: row.mime_type,
        sizeBytes: row.size_bytes, reservedBytes: row.reserved_bytes, createdAt: row.created_at,
        expiresAt: row.expires_at, state: row.state,
        ...(row.ready_receipt_id === null ? {} : { readyReceiptId: row.ready_receipt_id }),
        ...(row.ready_at === null ? {} : { readyAt: row.ready_at }),
        ...(row.published_at === null ? {} : { publishedAt: row.published_at }),
        ...(row.materialized_at === null ? {} : { materializedAt: row.materialized_at }),
        ...(row.claim_id === null ? {} : { claimId: row.claim_id }),
        ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
        ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
    };
}

/** Optional trusted-server factory input only. No adapter or route registers it. */
export class SqliteExternalStorageGenerationUploadCoordinator extends SqliteExternalStorageGenerationCoordinator
    implements ExternalStorageGenerationUploadCoordinatorV1 {
    readonly uploadVersion = 1 as const;

    private uploadKey(input: ExternalStorageGenerationUploadKey): ExternalStorageGenerationUploadKey {
        assertGenerationIdentifier(input.intentId, 'upload intent');
        assertGenerationIdentifier(input.userId, 'upload owner');
        return { ...this.key(input), intentId: input.intentId, userId: input.userId };
    }

    private claimKey(input: ExternalStorageGenerationUploadClaimKey): ExternalStorageGenerationUploadClaimKey {
        assertGenerationIdentifier(input.intentId, 'upload intent');
        assertGenerationIdentifier(input.claimId, 'upload claim');
        return { ...this.key(input), intentId: input.intentId, claimId: input.claimId };
    }

    private upload(input: { intentId: string; workspaceId: string; hash: string; generationId: string; userId?: string }): UploadRow | undefined {
        const row = this.raw.prepare(`SELECT * FROM ${UPLOADS} WHERE intent_id = ? AND workspace_id = ? AND hash = ?
            AND generation_id = ? AND storage_provider_id = ? ${input.userId === undefined ? '' : 'AND user_id = ?'}`)
            .get(input.intentId, input.workspaceId, input.hash, input.generationId, this.storageProviderId,
                ...(input.userId === undefined ? [] : [input.userId])) as UploadRow | undefined;
        if (row) this.assertProjection(row);
        return row;
    }

    private assertProjection(row: UploadRow): void {
        const ledger = this.raw.prepare('SELECT * FROM upload_intents WHERE id = ?').get(row.intent_id) as Record<string, unknown> | undefined;
        const holding = ['reserved', 'ready', 'published_pending_metadata'].includes(row.state);
        const materialized = row.state === 'materialized';
        const expected: Record<string, unknown> = {
            workspace_id: row.workspace_id, hash: row.hash, mime_type: row.mime_type, size_bytes: row.size_bytes,
            storage_id: row.storage_id, created_at: row.created_at, expires_at: GENERATION_UPLOAD_HOLD_EXPIRY,
            status: holding ? 'active' : materialized ? 'consumed' : 'cancelled',
            reserved_bytes: holding ? row.size_bytes : 0,
            consumed_at: materialized ? row.materialized_at : null,
            cancelled_at: holding || materialized ? null : row.claimed_at,
        };
        if (!ledger || Object.entries(expected).some(([key, value]) => ledger[key] !== value)) {
            throw new Error('Storage upload ledger projection integrity failure');
        }
    }

    private mustUpload(key: ExternalStorageGenerationUploadKey): UploadRow {
        const row = this.upload(key);
        if (!row) throw new Error('Storage generation upload is missing or owner/binding mismatched');
        return row;
    }

    private activeIntents(workspaceId: string): { id: string; hash: string; valid_hash: number; reserved_bytes: number; expires_at: number }[] {
        const rows = this.raw.prepare(`SELECT id, ${generationHashSql('hash')} AS hash,
            ${validGenerationHashSql('hash')} AS valid_hash, reserved_bytes, expires_at
            FROM upload_intents WHERE workspace_id = ? AND status = 'active' LIMIT ?`)
            .all(workspaceId, GENERATION_PROOF_ROWS + 1) as ReturnType<SqliteExternalStorageGenerationUploadCoordinator['activeIntents']>;
        if (rows.length > GENERATION_PROOF_ROWS) throw new Error('Storage upload proof_incomplete: intent budget');
        for (const row of rows) {
            if (row.valid_hash !== 1 || !Number.isSafeInteger(row.reserved_bytes) || row.reserved_bytes < 0
                || !Number.isSafeInteger(row.expires_at) || row.expires_at < 0) throw new Error('Storage upload unknown_references: invalid reservation');
        }
        return rows;
    }

    private quotaUsed(workspaceId: string): number {
        const rows = this.raw.prepare(`SELECT deleted, data_json, ${validGenerationObjectSql('data_json')} AS valid
            FROM s_file_meta WHERE workspace_id = ? LIMIT ?`).all(workspaceId, GENERATION_PROOF_ROWS + 1) as {
                deleted: number; data_json: string; valid: number;
            }[];
        if (rows.length > GENERATION_PROOF_ROWS) throw new Error('Storage upload proof_incomplete: metadata budget');
        let used = 0;
        for (const row of rows) {
            if (row.deleted !== 0) continue;
            if (row.valid !== 1) throw new Error('Storage upload invalid canonical metadata');
            const data = JSON.parse(row.data_json) as Record<string, unknown>;
            const size = data.size_bytes ?? data.sizeBytes;
            if (('size_bytes' in data && 'sizeBytes' in data) || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
                throw new Error('Storage upload invalid canonical file size');
            }
            used = this.sum(used, size);
        }
        return used;
    }

    private sum(left: number, right: number): number {
        const value = left + right;
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Storage upload quota accounting overflow');
        return value;
    }

    async reserveGenerationUpload(input: ReserveInput): Promise<{ status: 'reserved' | 'replayed'; intent: ExternalStorageGenerationUploadIntent }> {
        const key = this.uploadKey(input);
        for (const [name, value] of Object.entries({ namespace: input.namespaceId, target: input.storageId, mime: input.mimeType })) {
            assertGenerationIdentifier(value, name, name === 'target' ? 2048 : 256);
        }
        if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new Error('Invalid storage generation size');
        if (!Number.isSafeInteger(input.expiresInSeconds) || input.expiresInSeconds < 1 || input.expiresInSeconds > GENERATION_UPLOAD_MAX_TTL_SECONDS) {
            throw new Error('Invalid storage generation upload lifetime');
        }
        if (input.workspaceQuotaBytes !== undefined && (!Number.isSafeInteger(input.workspaceQuotaBytes) || input.workspaceQuotaBytes < 1)) {
            throw new Error('Invalid workspace storage quota');
        }
        return this.mutate(() => {
            const existing = this.raw.prepare(`SELECT * FROM ${UPLOADS} WHERE intent_id = ?`).all(key.intentId) as UploadRow[];
            if (existing.length) {
                const row = existing[0]!;
                if (existing.length !== 1 || row.purpose !== 'upload' || row.intent_id !== key.intentId || row.generation_id !== key.generationId
                    || row.workspace_id !== key.workspaceId || row.hash !== key.hash || row.user_id !== key.userId
                    || row.storage_provider_id !== this.storageProviderId || row.namespace_id !== input.namespaceId
                    || row.storage_id !== input.storageId || row.mime_type !== input.mimeType || row.size_bytes !== input.sizeBytes
                    || row.request_ttl !== input.expiresInSeconds || row.quota_bytes !== (input.workspaceQuotaBytes ?? null)) {
                    throw new Error('Storage upload replay identity or immutable target mismatch');
                }
                this.assertProjection(row);
                return { status: 'replayed', intent: intent(row) };
            }
            if (this.raw.prepare(`SELECT 1 FROM ${UPLOADS} WHERE generation_id = ? OR storage_id = ?`).get(key.generationId, input.storageId)) {
                throw new Error('Storage generation identity or target cannot be reused');
            }
            if (this.raw.prepare(`SELECT 1 FROM ${GENERATION_TABLE} WHERE generation_id = ? OR storage_id = ?`).get(key.generationId, input.storageId)) {
                throw new Error('Storage generation identity or target cannot be reused');
            }
            const head = this.head(key);
            if (head && (head.storage_provider_id !== this.storageProviderId || head.state === 'verified')) {
                throw new Error('Current storage generation must be irreversibly claimed before replacement');
            }
            const enrolled = Boolean(this.raw.prepare(`SELECT 1 FROM ${UPLOADS} WHERE workspace_id = ? AND hash = ? LIMIT 1`).get(key.workspaceId, key.hash));
            const proof = this.metadataProof(key, !head && !enrolled, input.storageId) ?? this.referenceProof(key, !head && !enrolled);
            if (proof) throw new Error(`Legacy storage adoption or upload proof failed: ${proof}`);
            const pending = this.raw.prepare(`SELECT count(*) AS count FROM ${UPLOADS} WHERE workspace_id = ?
                AND state IN ('reserved','ready','published_pending_metadata')`).get(key.workspaceId) as { count: number };
            if (pending.count >= GENERATION_UPLOAD_MAX_PENDING) throw new Error('Storage upload pending allocation limit');
            const now = this.now();
            const expires = this.sum(now, input.expiresInSeconds);
            let charged = this.quotaUsed(key.workspaceId);
            for (const row of this.activeIntents(key.workspaceId)) {
                if (row.expires_at <= now) continue;
                if (row.hash === key.hash) throw new Error('Storage upload already has an active reservation');
                charged = this.sum(charged, row.reserved_bytes);
            }
            const projectedBytes = this.sum(charged, input.sizeBytes);
            if (input.workspaceQuotaBytes !== undefined && projectedBytes > input.workspaceQuotaBytes) {
                throw new Error('Workspace storage quota exceeded');
            }
            this.raw.prepare(`INSERT INTO ${UPLOADS}
                (intent_id,workspace_id,hash,generation_id,user_id,storage_provider_id,namespace_id,storage_id,mime_type,
                 size_bytes,reserved_bytes,created_at,expires_at,request_ttl,quota_bytes,state)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved')`)
                .run(key.intentId, key.workspaceId, key.hash, key.generationId, key.userId, this.storageProviderId,
                    input.namespaceId, input.storageId, input.mimeType, input.sizeBytes, input.sizeBytes, now, expires,
                    input.expiresInSeconds, input.workspaceQuotaBytes ?? null);
            this.raw.prepare(`INSERT INTO upload_intents
                (id,workspace_id,hash,mime_type,size_bytes,reserved_bytes,expires_at,status,storage_id,created_at)
                VALUES (?,?,?,?,?,?,?,'active',?,?)`).run(key.intentId, key.workspaceId, key.hash, input.mimeType,
                    input.sizeBytes, input.sizeBytes, GENERATION_UPLOAD_HOLD_EXPIRY, input.storageId, now);
            return { status: 'reserved', intent: intent(this.mustUpload(key)) };
        });
    }

    async getGenerationUpload(input: ExternalStorageGenerationUploadKey): Promise<ExternalStorageGenerationUploadIntent | null> {
        const key = this.uploadKey(input);
        return this.mutate(() => { const row = this.upload(key); return row ? intent(row) : null; });
    }

    async reserveGenerationRestore(input: RestoreInput): Promise<{ status: 'reserved' | 'replayed'; intent: ExternalStorageGenerationUploadIntent }> {
        const key = this.uploadKey(input);
        if (!Number.isSafeInteger(input.expiresInSeconds) || input.expiresInSeconds < 1 || input.expiresInSeconds > GENERATION_UPLOAD_MAX_TTL_SECONDS) {
            throw new Error('Invalid storage generation restore lifetime');
        }
        if (input.workspaceQuotaBytes !== undefined && (!Number.isSafeInteger(input.workspaceQuotaBytes) || input.workspaceQuotaBytes < 1)) {
            throw new Error('Invalid workspace storage quota');
        }
        return this.mutate(() => {
            const previous = this.raw.prepare(`SELECT * FROM ${UPLOADS} WHERE intent_id = ?`).get(key.intentId) as UploadRow | undefined;
            if (previous) {
                if (previous.purpose !== 'restore' || previous.workspace_id !== key.workspaceId || previous.hash !== key.hash
                    || previous.generation_id !== key.generationId || previous.user_id !== key.userId || previous.storage_provider_id !== this.storageProviderId
                    || previous.request_ttl !== input.expiresInSeconds || previous.quota_bytes !== (input.workspaceQuotaBytes ?? null)) {
                    throw new Error('Storage restore replay identity mismatch');
                }
                this.assertProjection(previous);
                return { status: 'replayed', intent: intent(previous) };
            }
            const generation = this.find(key);
            const origin = this.raw.prepare(`SELECT * FROM ${UPLOADS} WHERE generation_id = ? AND purpose = 'upload'`).get(key.generationId) as UploadRow | undefined;
            if (!generation || generation.state !== 'verified' || this.head(key)?.generation_id !== key.generationId
                || !origin || origin.state !== 'materialized' || origin.storage_id !== generation.storage_id
                || origin.workspace_id !== key.workspaceId || origin.hash !== key.hash || origin.storage_provider_id !== this.storageProviderId) {
                throw new Error('Storage restore requires an exact verified materialized origin');
            }
            this.assertProjection(origin);
            if (this.raw.prepare(`SELECT 1 FROM s_file_meta WHERE workspace_id = ? AND deleted = 0 AND ${generationHashSql('id')} = ? LIMIT 1`)
                .get(key.workspaceId, key.hash)) throw new Error('Storage restore metadata is already live');
            const pending = this.raw.prepare(`SELECT count(*) AS count FROM ${UPLOADS} WHERE workspace_id = ?
                AND state IN ('reserved','ready','published_pending_metadata')`).get(key.workspaceId) as { count: number };
            if (pending.count >= GENERATION_UPLOAD_MAX_PENDING) throw new Error('Storage restore pending allocation limit');
            const now = this.now();
            if (now < generation.last_activity_at) throw new Error('Storage restore server clock regressed');
            let charged = this.quotaUsed(key.workspaceId);
            for (const row of this.activeIntents(key.workspaceId)) {
                if (row.expires_at <= now) continue;
                if (row.hash === key.hash) throw new Error('Storage restore already has an active reservation');
                charged = this.sum(charged, row.reserved_bytes);
            }
            const projected = this.sum(charged, origin.size_bytes);
            if (input.workspaceQuotaBytes !== undefined && projected > input.workspaceQuotaBytes) throw new Error('Workspace storage quota exceeded');
            this.raw.prepare(`INSERT INTO ${UPLOADS}
                (intent_id,workspace_id,hash,generation_id,user_id,storage_provider_id,namespace_id,storage_id,mime_type,
                 size_bytes,reserved_bytes,created_at,expires_at,request_ttl,quota_bytes,state,purpose,
                 ready_receipt_id,ready_at,published_generation_id,published_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'published_pending_metadata','restore',?,?,?,?)`)
                .run(key.intentId, key.workspaceId, key.hash, key.generationId, key.userId, this.storageProviderId,
                    origin.namespace_id, origin.storage_id, origin.mime_type, origin.size_bytes, origin.size_bytes,
                    now, this.sum(now, input.expiresInSeconds), input.expiresInSeconds, input.workspaceQuotaBytes ?? null,
                    origin.ready_receipt_id, now, key.generationId, now);
            this.raw.prepare(`INSERT INTO upload_intents
                (id,workspace_id,hash,mime_type,size_bytes,reserved_bytes,expires_at,status,storage_id,created_at)
                VALUES (?,?,?,?,?,?,?,'active',?,?)`).run(key.intentId, key.workspaceId, key.hash, origin.mime_type,
                    origin.size_bytes, origin.size_bytes, GENERATION_UPLOAD_HOLD_EXPIRY, origin.storage_id, now);
            return { status: 'reserved', intent: intent(this.mustUpload(key)) };
        });
    }

    async markGenerationUploadReady(input: ReadyInput): Promise<{ status: 'ready' | 'replayed'; intent: ExternalStorageGenerationUploadIntent }> {
        const key = this.uploadKey(input);
        assertGenerationIdentifier(input.readyReceiptId, 'ready receipt', 2048);
        return this.mutate(() => {
            const row = this.mustUpload(key);
            if (row.purpose !== 'upload') throw new Error('Restore intents do not authorize upload readiness');
            if (row.storage_id !== input.storageId || (row.ready_receipt_id !== null && row.ready_receipt_id !== input.readyReceiptId)) {
                throw new Error('Storage upload readiness receipt mismatch');
            }
            if (row.ready_receipt_id !== null) return { status: 'replayed', intent: intent(row) };
            const now = this.now();
            if (row.state !== 'reserved' || now < row.created_at) throw new Error('Storage upload readiness state or clock mismatch');
            this.raw.prepare(`UPDATE ${UPLOADS} SET state = 'ready', ready_receipt_id = ?, ready_at = ? WHERE intent_id = ?`)
                .run(input.readyReceiptId, now, key.intentId);
            return { status: 'ready', intent: intent(this.mustUpload(key)) };
        });
    }

    async publishGenerationUpload(input: PublishInput): Promise<Awaited<ReturnType<ExternalStorageGenerationUploadCoordinatorV1['publishGenerationUpload']>>> {
        const key = this.uploadKey(input);
        return this.mutate(() => {
            const row = this.mustUpload(key);
            if (row.purpose !== 'upload') throw new Error('Restore intents do not authorize byte publication');
            if (row.storage_id !== input.storageId || row.size_bytes !== input.sizeBytes || row.ready_receipt_id !== input.readyReceiptId) {
                throw new Error('Storage upload publication receipt mismatch');
            }
            if (row.state === 'published_pending_metadata' || row.state === 'materialized') {
                const generation = this.find(key);
                if (!generation || generation.state !== 'verified') throw new Error('Storage upload publication is no longer live');
                return { status: 'replayed', intent: intent(row), generation: generationRecord(generation) };
            }
            const now = this.now();
            if (row.state !== 'ready' || row.expires_at <= now || row.ready_at === null || now < row.ready_at) {
                throw new Error('Storage upload expired, not ready, or terminal');
            }
            const proof = this.metadataProof(key, false, row.storage_id) ?? this.referenceProof(key, false);
            if (proof) throw new Error(`Storage upload publication proof failed: ${proof}`);
            const head = this.head(key);
            if (head && (head.state === 'verified' || head.storage_provider_id !== this.storageProviderId)) throw new Error('Storage upload head conflict');
            this.raw.prepare(`UPDATE ${UPLOADS} SET state = 'published_pending_metadata', published_generation_id = ?, published_at = ? WHERE intent_id = ?`)
                .run(key.generationId, now, key.intentId);
            this.raw.prepare(`INSERT INTO ${GENERATION_TABLE}
                (generation_id,workspace_id,hash,storage_provider_id,storage_id,size_bytes,state,created_at,last_activity_at)
                VALUES (?,?,?,?,?,?,'verified',?,?)`).run(key.generationId, key.workspaceId, key.hash, this.storageProviderId, row.storage_id, row.size_bytes, now, now);
            if (head) this.raw.prepare(`UPDATE ${HEAD_TABLE} SET generation_id = ? WHERE workspace_id = ? AND hash = ?`).run(key.generationId, key.workspaceId, key.hash);
            else this.raw.prepare(`INSERT INTO ${HEAD_TABLE}(workspace_id,hash,generation_id) VALUES (?,?,?)`).run(key.workspaceId, key.hash, key.generationId);
            return { status: 'published', intent: intent(this.mustUpload(key)), generation: generationRecord(this.find(key)!) };
        });
    }

    async claimAbandonedGenerationUpload(input: ClaimInput): Promise<ExternalStorageGenerationUploadClaimResult> {
        const key = this.claimKey(input);
        if (!Number.isSafeInteger(input.retentionSeconds) || input.retentionSeconds < 0) throw new Error('Invalid storage retention interval');
        return this.mutate(() => {
            const row = this.upload(key);
            if (!row) return { status: 'blocked', reason: 'missing' };
            if (row.state === 'abandon_claimed' || row.state === 'abandoned') return row.claim_id === key.claimId
                ? { status: 'replayed', intent: intent(row) } : { status: 'blocked', reason: 'claim_conflict' };
            if (row.state === 'materialized') return { status: 'blocked', reason: 'materialized' };
            if (row.state === 'reserved' || row.ready_at === null) return { status: 'blocked', reason: 'not_ready' };
            const now = this.now();
            if (now < row.expires_at) return { status: 'blocked', reason: 'not_expired' };
            const proof = this.metadataProof(key, false, row.storage_id) ?? this.referenceProof(key, false);
            if (proof) return { status: 'blocked', reason: proof };
            const generation = row.published_generation_id === null ? undefined : this.find(key);
            if (row.published_generation_id !== null && (!generation || generation.state !== 'verified'
                || this.head(key)?.generation_id !== key.generationId)) return { status: 'blocked', reason: 'not_current' };
            let activity = Math.max(row.expires_at, row.ready_at, row.published_at ?? 0, generation?.last_activity_at ?? 0);
            let reservations: ReturnType<SqliteExternalStorageGenerationUploadCoordinator['activeIntents']>;
            try { reservations = this.activeIntents(key.workspaceId); }
            catch (error) { return { status: 'blocked', reason: String(error).includes('proof_incomplete') ? 'proof_incomplete' : 'unknown_references' }; }
            for (const reservation of reservations) {
                if (reservation.id === key.intentId || reservation.hash !== key.hash) continue;
                if (reservation.expires_at > now) return { status: 'blocked', reason: 'active_upload' };
                activity = Math.max(activity, reservation.expires_at);
            }
            if (now < activity || now - activity < input.retentionSeconds) return { status: 'blocked', reason: 'retention' };
            if (this.raw.prepare(`SELECT 1 FROM ${UPLOADS} WHERE claim_id = ? UNION ALL SELECT 1 FROM ${GENERATION_TABLE} WHERE claim_id = ?`).get(key.claimId, key.claimId)) {
                return { status: 'blocked', reason: 'claim_conflict' };
            }
            if (generation) this.raw.prepare(`UPDATE ${GENERATION_TABLE} SET state = 'claimed', claim_id = ?, claimed_at = ?, last_activity_at = ? WHERE generation_id = ?`)
                .run(key.claimId, now, activity, key.generationId);
            this.raw.prepare(`UPDATE ${UPLOADS} SET state = 'abandon_claimed', reserved_bytes = 0, claim_id = ?, claimed_at = ? WHERE intent_id = ?`)
                .run(key.claimId, now, key.intentId);
            this.raw.prepare(`UPDATE upload_intents SET status = 'cancelled', reserved_bytes = 0, cancelled_at = ? WHERE id = ?`).run(now, key.intentId);
            return { status: 'claimed', intent: intent(this.upload(key)!) };
        });
    }

    private claimedUpload(key: ExternalStorageGenerationUploadClaimKey): UploadRow | undefined {
        const row = this.upload(key);
        if (!row || row.claim_id !== key.claimId || !['abandon_claimed', 'abandoned'].includes(row.state)) return undefined;
        if (row.published_generation_id !== null) {
            const generation = this.find(key);
            if (!generation || generation.claim_id !== key.claimId || !['claimed', 'deleted'].includes(generation.state)) {
                throw new Error('Storage upload durable generation claim mismatch');
            }
        }
        return row;
    }

    async getGenerationUploadClaim(input: ExternalStorageGenerationUploadClaimKey): Promise<ExternalStorageGenerationUploadIntent | null> {
        const key = this.claimKey(input);
        return this.mutate(() => { const row = this.claimedUpload(key); return row ? intent(row) : null; });
    }

    async completeGenerationUploadAbandonment(input: ExternalStorageGenerationUploadClaimKey): Promise<Awaited<ReturnType<ExternalStorageGenerationUploadCoordinatorV1['completeGenerationUploadAbandonment']>>> {
        const key = this.claimKey(input);
        return this.mutate(() => {
            const row = this.claimedUpload(key);
            if (!row) throw new Error('Storage upload abandonment claim mismatch');
            if (row.state === 'abandoned') return { status: 'replayed', intent: intent(row) };
            const now = this.now();
            if (row.claimed_at === null || now < row.claimed_at) throw new Error('Storage upload server clock regressed');
            if (row.published_generation_id !== null) this.raw.prepare(`UPDATE ${GENERATION_TABLE} SET state = 'deleted', deleted_at = ? WHERE generation_id = ? AND state = 'claimed'`)
                .run(now, key.generationId);
            this.raw.prepare(`UPDATE ${UPLOADS} SET state = 'abandoned', deleted_at = ? WHERE intent_id = ?`).run(now, key.intentId);
            return { status: 'abandoned', intent: intent(this.upload(key)!) };
        });
    }

    async listGenerationUploadRecovery(input: { workspaceId: string; cursor?: string; limit?: number }): Promise<Awaited<ReturnType<ExternalStorageGenerationUploadCoordinatorV1['listGenerationUploadRecovery']>>> {
        assertGenerationIdentifier(input.workspaceId, 'workspace');
        const limit = input.limit ?? 100;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid upload recovery page limit');
        let after = '';
        if (input.cursor !== undefined) {
            try {
                if (input.cursor.length > 4096) throw new Error('size');
                const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as { version: number; workspaceId: string; providerId: string; after: string };
                if (cursor.version !== 1 || cursor.workspaceId !== input.workspaceId || cursor.providerId !== this.storageProviderId) throw new Error('scope');
                assertGenerationIdentifier(cursor.after, 'cursor'); after = cursor.after;
            } catch { throw new Error('Invalid upload recovery cursor'); }
        }
        return this.mutate(() => {
            const rows = this.raw.prepare(`SELECT * FROM ${UPLOADS} WHERE workspace_id = ? AND intent_id > ? AND storage_provider_id = ? ORDER BY intent_id LIMIT ?`)
                .all(input.workspaceId, after, this.storageProviderId, limit + 1) as UploadRow[];
            const hasMore = rows.length > limit;
            const page = rows.slice(0, limit);
            const now = this.now();
            return { items: page.filter(row => row.state === 'abandon_claimed'
                || (['reserved','ready','published_pending_metadata'].includes(row.state) && row.expires_at <= now)).map(intent), hasMore,
                ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ version: 1, workspaceId: input.workspaceId, providerId: this.storageProviderId, after: page.at(-1)!.intent_id })).toString('base64url') } : {}) };
        });
    }
}
