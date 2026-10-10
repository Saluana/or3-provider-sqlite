import type {
    ExternalStorageGenerationClaimResult,
    ExternalStorageGenerationCoordinatorV1,
    ExternalStorageGenerationKey,
    ExternalStorageGenerationRecord,
} from '~~/server/storage/gateway/generation-lifecycle';
import { getRawDb, getSqliteDriver, type SqliteRawDatabase } from '../db/kysely';
import {
    GENERATION_TABLE, HEAD_TABLE, GENERATION_PROOF_ROWS, GENERATION_PROOF_EDGES,
    generationGuardTriggers, canonicalGuardSql, generationHashSql, validGenerationHashSql,
    validGenerationObjectSql, generationReferencesSql, validGenerationReferencesSql,
} from '../db/storage-generation-guards';

type GenerationRow = {
    generation_id: string; workspace_id: string; hash: string; storage_provider_id: string;
    storage_id: string; size_bytes: number; state: 'verified' | 'claimed' | 'deleted';
    created_at: number; last_activity_at: number; claim_id: string | null;
    claimed_at: number | null; deleted_at: number | null;
};
type Proof = 'in_use' | 'unknown_references' | 'proof_incomplete' | null;

function identifier(value: string, name: string, max = 256): void {
    if (typeof value !== 'string' || !value || value.length > max || value !== value.trim()
        || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
        throw new Error(`Invalid storage generation ${name}`);
    }
}

function record(row: GenerationRow): ExternalStorageGenerationRecord {
    return {
        workspaceId: row.workspace_id, hash: row.hash, generationId: row.generation_id,
        storageId: row.storage_id, sizeBytes: row.size_bytes, state: row.state,
        createdAt: row.created_at, lastActivityAt: row.last_activity_at,
        ...(row.claim_id === null ? {} : { claimId: row.claim_id }),
        ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
        ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
    };
}

/**
 * Trusted-server foundation only. Deliberately not registered on the adapter.
 * A future authenticated dispatcher and verified, namespace-bound filesystem
 * receipts are required before activation. This class never selects or unlinks bytes.
 */
export class SqliteExternalStorageGenerationCoordinator implements ExternalStorageGenerationCoordinatorV1 {
    readonly version = 1 as const;
    readonly storageProviderId: string;
    private readonly raw: SqliteRawDatabase;

    constructor(options: { storageProviderId: string; database?: SqliteRawDatabase }) {
        this.assertSupportedDriver();
        identifier(options.storageProviderId, 'storage provider');
        this.storageProviderId = options.storageProviderId;
        this.raw = options.database ?? getRawDb();
    }

    private assertSupportedDriver(): void {
        if (!['better-sqlite3', 'bun'].includes(getSqliteDriver())) {
            throw new Error('Storage generation coordination requires a qualified local SQLite driver; D1 and Turso are unsupported.');
        }
    }

    private key(input: ExternalStorageGenerationKey): ExternalStorageGenerationKey {
        this.assertSupportedDriver();
        identifier(input.workspaceId, 'workspace');
        identifier(input.generationId, 'generation');
        if (typeof input.hash !== 'string' || input.hash.length > 71) throw new Error('Invalid storage generation hash');
        const value = this.raw.prepare(`SELECT ${validGenerationHashSql('hash')} AS valid,
            ${generationHashSql('hash')} AS hash FROM (SELECT ? AS hash)`).get(input.hash) as { valid: number; hash: string };
        if (value.valid !== 1 || value.hash.length !== 64) throw new Error('Managed storage generations require a strict SHA-256 hash');
        return { workspaceId: input.workspaceId, generationId: input.generationId, hash: value.hash };
    }

    private assertIntegrity(): void {
        const actual = new Map((this.raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as
            { name: string; sql: string }[]).map(row => [row.name, canonicalGuardSql(row.sql)]));
        for (const [name, sql] of Object.entries(generationGuardTriggers())) {
            if (actual.get(name) !== canonicalGuardSql(sql)) throw new Error(`Storage generation guard integrity failure: ${name}`);
        }
    }

    private assertDurability(): void {
        const journal = this.raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
        const synchronous = this.raw.prepare('PRAGMA synchronous').get() as { synchronous: number };
        const foreignKeys = this.raw.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
        const databases = this.raw.prepare('PRAGMA database_list').all() as { name: string; file: string }[];
        if (journal.journal_mode?.toLowerCase() !== 'wal' || ![2, 3].includes(synchronous.synchronous)
            || foreignKeys.foreign_keys !== 1 || !databases.some(db => db.name === 'main' && Boolean(db.file))) {
            throw new Error('Storage generation coordination requires file-backed local WAL, synchronous FULL/EXTRA, and foreign_keys ON; defaults are not changed.');
        }
    }

    private mutate<T>(fn: () => T): T {
        this.assertSupportedDriver();
        if (this.raw.inTransaction !== false) {
            throw new Error('Storage generation coordination requires its own durable transaction, not an outer transaction or unqualified connection.');
        }
        return this.raw.transaction(() => {
            this.assertDurability();
            this.assertIntegrity();
            return fn();
        }).immediate();
    }

    private now(): number {
        return (this.raw.prepare('SELECT unixepoch() AS now').get() as { now: number }).now;
    }

    private find(key: ExternalStorageGenerationKey): GenerationRow | undefined {
        return this.raw.prepare(`SELECT * FROM ${GENERATION_TABLE}
            WHERE workspace_id = ? AND hash = ? AND generation_id = ? AND storage_provider_id = ?`)
            .get(key.workspaceId, key.hash, key.generationId, this.storageProviderId) as GenerationRow | undefined;
    }

    private head(key: ExternalStorageGenerationKey): GenerationRow | undefined {
        return this.raw.prepare(`SELECT generation.* FROM ${HEAD_TABLE} head
            JOIN ${GENERATION_TABLE} generation ON generation.generation_id = head.generation_id
            WHERE head.workspace_id = ? AND head.hash = ?`).get(key.workspaceId, key.hash) as GenerationRow | undefined;
    }

    private metadataProof(key: ExternalStorageGenerationKey, includeDeleted: boolean, storageId?: string): Proof {
        const rows = this.raw.prepare(`SELECT deleted, ${generationHashSql('id')} AS hash,
            ${validGenerationHashSql('id')} AS valid_hash,
            CASE WHEN ${validGenerationObjectSql('data_json')} = 0 THEN 0
                WHEN json_type(data_json, '$.hash') IS NOT NULL AND (${validGenerationHashSql("json_extract(data_json, '$.hash')")} IS NOT 1
                    OR ${generationHashSql("json_extract(data_json, '$.hash')")} <> ${generationHashSql('id')}) THEN 0
                WHEN json_type(data_json, '$.storage_id') IS NOT NULL AND json_type(data_json, '$.storageId') IS NOT NULL THEN 0
                WHEN json_type(data_json, '$.size_bytes') IS NOT NULL AND json_type(data_json, '$.sizeBytes') IS NOT NULL THEN 0
                WHEN coalesce(json_type(data_json, '$.storage_id'), json_type(data_json, '$.storageId'), 'text') <> 'text' THEN 0
                ELSE 1 END AS valid_metadata,
            CASE WHEN ${validGenerationObjectSql('data_json')} = 1 THEN coalesce(json_extract(data_json, '$.storage_id'), json_extract(data_json, '$.storageId')) ELSE NULL END AS storage_id
            FROM s_file_meta WHERE workspace_id = ? LIMIT ?`)
            .all(key.workspaceId, GENERATION_PROOF_ROWS + 1) as { deleted: number; hash: string; valid_hash: number; valid_metadata: number; storage_id: unknown }[];
        if (rows.length > GENERATION_PROOF_ROWS) return 'proof_incomplete';
        const relevant = includeDeleted ? rows : rows.filter(row => row.deleted === 0);
        if (relevant.some(row => row.valid_hash !== 1 || row.valid_metadata !== 1)) return 'unknown_references';
        return relevant.some(row => row.hash === key.hash || (storageId !== undefined && row.storage_id === storageId)) ? 'in_use' : null;
    }

    private referenceProof(key: ExternalStorageGenerationKey, includeDeleted: boolean): Proof {
        let totalRows = 0;
        let totalEdges = 0;
        let inUse = false;
        for (const table of ['s_messages', 's_posts']) {
            const valid = validGenerationReferencesSql('data_json');
            const rows = this.raw.prepare(`SELECT deleted, ${valid} AS valid,
                CASE WHEN ${valid} = 1 THEN ${generationReferencesSql('data_json')} ELSE '[]' END AS refs
                FROM ${table} WHERE workspace_id = ?
                LIMIT ?`).all(key.workspaceId, GENERATION_PROOF_ROWS + 1 - totalRows) as { deleted: number; valid: number; refs: string }[];
            totalRows += rows.length;
            if (totalRows > GENERATION_PROOF_ROWS) return 'proof_incomplete';
            for (const row of rows) {
                if (!includeDeleted && row.deleted !== 0) continue;
                if (row.valid !== 1) return 'unknown_references';
                const edges = this.raw.prepare(`SELECT ${generationHashSql('value')} AS hash FROM json_each(?)`)
                    .all(row.refs) as { hash: string }[];
                totalEdges += edges.length;
                if (totalEdges > GENERATION_PROOF_EDGES) return 'proof_incomplete';
                if (edges.some(edge => edge.hash === key.hash)) inUse = true;
            }
        }
        return inUse ? 'in_use' : null;
    }

    async registerVerifiedGeneration(input: ExternalStorageGenerationKey & { storageId: string; sizeBytes: number }): Promise<{
        status: 'registered' | 'replayed'; generation: ExternalStorageGenerationRecord;
    }> {
        const key = this.key(input);
        identifier(input.storageId, 'storage target', 2048);
        if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new Error('Invalid storage generation size');
        return this.mutate(() => {
            const existing = this.raw.prepare(`SELECT * FROM ${GENERATION_TABLE} WHERE generation_id = ? OR storage_id = ?`)
                .all(key.generationId, input.storageId) as GenerationRow[];
            if (existing.length) {
                const row = existing[0]!;
                if (existing.length !== 1 || row.generation_id !== key.generationId || row.workspace_id !== key.workspaceId
                    || row.hash !== key.hash || row.storage_provider_id !== this.storageProviderId
                    || row.storage_id !== input.storageId || row.size_bytes !== input.sizeBytes) {
                    throw new Error('Storage generation identity or target cannot be reused');
                }
                return { status: 'replayed', generation: record(row) };
            }
            const head = this.head(key);
            if (head && (head.storage_provider_id !== this.storageProviderId || head.state === 'verified')) {
                throw new Error('Current storage generation must be irreversibly claimed before replacement');
            }
            if (!head) {
                const proof = this.metadataProof(key, true, input.storageId) ?? this.referenceProof(key, true);
                if (proof) throw new Error(`Legacy storage adoption is forbidden: ${proof}`);
            }
            const now = this.now();
            this.raw.prepare(`INSERT INTO ${GENERATION_TABLE}
                (generation_id, workspace_id, hash, storage_provider_id, storage_id, size_bytes, state, created_at, last_activity_at)
                VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, ?)`)
                .run(key.generationId, key.workspaceId, key.hash, this.storageProviderId, input.storageId, input.sizeBytes, now, now);
            if (head) this.raw.prepare(`UPDATE ${HEAD_TABLE} SET generation_id = ? WHERE workspace_id = ? AND hash = ?`)
                .run(key.generationId, key.workspaceId, key.hash);
            else this.raw.prepare(`INSERT INTO ${HEAD_TABLE} (workspace_id, hash, generation_id) VALUES (?, ?, ?)`)
                .run(key.workspaceId, key.hash, key.generationId);
            return { status: 'registered', generation: record(this.find(key)!) };
        });
    }

    async getGeneration(input: ExternalStorageGenerationKey): Promise<ExternalStorageGenerationRecord | null> {
        const key = this.key(input);
        return this.mutate(() => {
            const row = this.find(key);
            return row ? record(row) : null;
        });
    }

    async claimGeneration(input: ExternalStorageGenerationKey & { claimId: string; retentionSeconds: number }): Promise<ExternalStorageGenerationClaimResult> {
        const key = this.key(input);
        identifier(input.claimId, 'claim');
        if (!Number.isSafeInteger(input.retentionSeconds) || input.retentionSeconds < 0) throw new Error('Invalid storage retention interval');
        return this.mutate(() => {
            const row = this.find(key);
            if (!row) return { status: 'blocked', reason: 'missing' };
            if (row.state !== 'verified') return row.claim_id === input.claimId
                ? { status: 'replayed', generation: record(row) } : { status: 'blocked', reason: 'claim_conflict' };
            if (this.head(key)?.generation_id !== key.generationId) return { status: 'blocked', reason: 'not_current' };
            const proof = this.metadataProof(key, false, row.storage_id) ?? this.referenceProof(key, false);
            if (proof) return { status: 'blocked', reason: proof };
            const now = this.now();
            const intents = this.raw.prepare(`SELECT ${validGenerationHashSql('hash')} AS valid_hash,
                ${generationHashSql('hash')} AS hash, expires_at FROM upload_intents
                WHERE workspace_id = ? AND status = 'active' LIMIT ?`).all(key.workspaceId, GENERATION_PROOF_ROWS + 1) as {
                    valid_hash: number; hash: string; expires_at: number;
                }[];
            if (intents.length > GENERATION_PROOF_ROWS) return { status: 'blocked', reason: 'proof_incomplete' };
            let lastActivity = row.last_activity_at;
            for (const intent of intents) {
                if (intent.valid_hash !== 1 || !Number.isSafeInteger(intent.expires_at) || intent.expires_at < 0) {
                    return { status: 'blocked', reason: 'unknown_references' };
                }
                if (intent.hash !== key.hash) continue;
                if (intent.expires_at > now) return { status: 'blocked', reason: 'active_upload' };
                lastActivity = Math.max(lastActivity, intent.expires_at);
            }
            if (now < lastActivity || now - lastActivity < input.retentionSeconds) return { status: 'blocked', reason: 'retention' };
            if (this.raw.prepare(`SELECT 1 FROM ${GENERATION_TABLE} WHERE claim_id = ?`).get(input.claimId)) {
                return { status: 'blocked', reason: 'claim_conflict' };
            }
            this.raw.prepare(`UPDATE ${GENERATION_TABLE} SET state = 'claimed', claim_id = ?, claimed_at = ?, last_activity_at = ?
                WHERE generation_id = ? AND state = 'verified'`).run(input.claimId, now, lastActivity, key.generationId);
            return { status: 'claimed', generation: record(this.find(key)!) };
        });
    }

    async completeDeletion(input: ExternalStorageGenerationKey & { claimId: string }): Promise<{
        status: 'deleted' | 'replayed'; generation: ExternalStorageGenerationRecord;
    }> {
        const key = this.key(input);
        identifier(input.claimId, 'claim');
        return this.mutate(() => {
            const row = this.find(key);
            if (!row || row.claim_id !== input.claimId || row.state === 'verified') throw new Error('Storage generation claim mismatch');
            if (row.state === 'deleted') return { status: 'replayed', generation: record(row) };
            const now = this.now();
            if (row.claimed_at === null || now < row.claimed_at) throw new Error('Storage generation server clock regressed');
            this.raw.prepare(`UPDATE ${GENERATION_TABLE} SET state = 'deleted', deleted_at = ? WHERE generation_id = ?`)
                .run(now, key.generationId);
            return { status: 'deleted', generation: record(this.find(key)!) };
        });
    }
}
