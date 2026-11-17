import { EXPLORER_CAPABILITY, explorerMutationIdentity, explorerIdentityMatches, hasExplorerSemantics } from './explorer-contract';
import { readHistoryIncarnation, validateExpectedHistory, validHistoryIncarnation, historyChanged, historyAssertion, historyBatch } from './history-incarnation';
import { maintainEvidence, repairAssertion, repairResolution, type RepairGuard } from './evidence-maintenance';
import { SqliteExternalStorageGenerationUploadCoordinator } from '../storage/sqlite-generation-upload-coordinator';
import { backgroundFinalizationFingerprint, stableJson } from './background-history-fingerprint';
import { hasWorkspaceItemSemantics, WORKSPACE_ITEM_CAPABILITY } from './workspace-item-capability';
/**
 * SQLite implementation of SyncGatewayAdapter.
 *
 * Handles push/pull/updateCursor/gc using the selected native SQLite runtime.
 * Local runtimes use raw BEGIN IMMEDIATE transactions; Cloudflare D1 uses
 * native atomic batches for its asynchronous binding.
 */
import type { H3Event } from 'h3';
import { createHash } from 'node:crypto';
import { digestUuid } from '../utils/digest-uuid';
import { sql } from 'kysely';
import { canRunSyncHistoryGc } from './history-gc-policy';
import { createError } from 'h3';
import {
    beginSyncMaintenanceRun,
    completeSyncMaintenanceRun,
    computeSyncMaintenanceBacklog,
    failSyncMaintenanceRun,
    getSyncMaintenanceState,
    SYNC_MAINTENANCE_RETENTION_SECONDS,
} from './maintenance-state';
import type {
    CanonicalStorageQueryRequest,
    CanonicalStorageQueryResponse,
    SyncGatewayAdapter,
    SyncMaintenanceState,
    UploadIntentConsumptionRequest,
    UploadIntentReservationRequest,
} from '~~/server/sync/gateway/types';
import type {
    AdmitChatGenerationResult,
    CanonicalGenerationSnapshot,
    CanonicalHistoryActor,
    ChatGenerationAdmissionEnvelope,
    FinalizeChatGenerationResult,
} from '~~/shared/chat/background-history';
import {
    backgroundHistoryDeviceId,
    parseChatGenerationAdmissionEnvelope,
} from '~~/shared/chat/background-history';
import type {
    PendingOp,
    PullUnavailableRecord,
    SnapshotUnavailableRecord,
    PullRequest,
    PullResponse,
    PushBatch,
    PushResult,
    PushWinner,
    SnapshotItem,
    SnapshotRequest,
    SnapshotResponse,
    SyncChange,
} from '~~/shared/sync/types';
import { getSqliteDb, getRawDb, isD1Driver } from '../db/kysely';
import { d1All, d1Batch, d1Run, type D1SqlStatement } from '../db/d1';
import { SYNCED_TABLE_MAP, ALLOWED_SYNC_TABLES } from '../db/schema';
import { emitWebhookSystemHook } from '~~/server/utils/webhooks/runtime';
import { incomingRevisionWins } from '~~/shared/sync/revision';
import { sanitizePayloadForSync } from '~~/shared/sync/sanitize';
import { boundedSyncPayload, boundedSyncMetadata, syncMetadataBytes, SYNC_METADATA_BYTES, notificationOwnerSql, syncRows, retainSqlEvidence, unknownNotificationEvidence, type EvidenceSource, evidenceInsert, evidenceLookup } from './unavailable-records';
import { MAX_SYNC_SNAPSHOT_TOKEN_LENGTH, SyncChangeSchema, SnapshotItemSchema, TABLE_PAYLOAD_SCHEMAS, isLosslessSyncIdentifier, PullResponseSchema, SnapshotResponseSchema, compareSyncTuple, normalizeWirePayloadForTable } from '~~/shared/sync/schemas';
import { prepareSyncWrite, nextSyncClock } from '~~/shared/sync/prepare-sync-write';
import { readRequestUsage } from '~~/shared/chat/compaction';
import { matchesToolResultStorage, parseToolResultArtifact, prepareToolResultStorage, toolResultArtifactPrefix, type ToolResultArtifactRow } from '~~/shared/chat/tool-result-artifact';
import { validateCanonicalChatQuery, encodeCanonicalChatSeek, parseCanonicalChatSeek, type CanonicalChatQuery, type CanonicalChatReadResult } from '~~/shared/chat/history-reader';
import type { CanonicalHistoryRecord } from '~~/shared/chat/background-history';
import { computePullRetention } from './history-gc-policy';
import { resolveCanonicalProjectOwnership } from './canonical-project-ownership';

type ExplorerRequest<T> = T & { explorerCapability?: typeof EXPLORER_CAPABILITY };

const DEFAULT_PULL_LIMIT = 100;
const MAX_PULL_LIMIT = 1000;
const MAX_SNAPSHOT_PAGE_SIZE = 1000;
const DEFAULT_CANONICAL_STORAGE_PAGE_SIZE = 100;
const MAX_CANONICAL_STORAGE_PAGE_SIZE = 500;
const SNAPSHOT_TTL_SECONDS = 60 * 60;
const MAX_RETAINED_SNAPSHOTS_PER_USER = 4;
const PRUNE_USER_SNAPSHOTS_SQL = `DELETE FROM sync_snapshots WHERE id IN (
    SELECT id FROM sync_snapshots
    WHERE workspace_id = ? AND (id LIKE ? OR id LIKE ?)
    ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
)`;
const SESSION_CONTEXT_KEY_PREFIX = '__or3_session_context_';
const MIN_SYNC_RETENTION_SECONDS = 60 * 60;
const MAX_SYNC_RETENTION_SECONDS = 365 * 24 * 60 * 60;
const MAX_SYNC_PAYLOAD_BYTES = 256 * 1024;
const MAX_SYNC_PAGE_BYTES = 1024 * 1024;
const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

// Consumed uploads occupy quota until canonical metadata arrives or their
// authorization expires. Exact receipt retries share that original lifetime.
// Grouping content hashes preserves duplicate intents'
// charge when another intent is cancelled, without charging the bytes twice.
const PENDING_UPLOAD_RESERVATIONS_SQL = `
    SELECT MIN(intent.id) AS id, intent.hash,
           MAX(intent.size_bytes) AS reserved_bytes, MAX(intent.expires_at) AS expires_at
    FROM upload_intents AS intent
    WHERE intent.workspace_id = ? AND intent.status IN ('active', 'consumed')
      AND intent.expires_at > ? AND intent.size_bytes > 0
      AND NOT EXISTS (
          SELECT 1 FROM s_file_meta AS metadata
          WHERE metadata.workspace_id = intent.workspace_id AND metadata.deleted = 0
            AND lower(CASE WHEN instr(trim(metadata.id), ':') > 0
                THEN substr(trim(metadata.id), instr(trim(metadata.id), ':') + 1)
                ELSE trim(metadata.id) END) = intent.hash
      )
    GROUP BY intent.hash
`;

// Active holds are grouped by digest; retained bytes are already in the ledger.
const QUOTA_RESERVATIONS_SQL = `SELECT intent.hash, MAX(intent.size_bytes) AS reserved_bytes,
        MAX(0, MAX(intent.size_bytes) - COALESCE(retained.size_bytes, 0)) AS held_bytes
    FROM upload_intents AS intent LEFT JOIN retained_storage AS retained
        ON retained.workspace_id = intent.workspace_id AND retained.hash = intent.hash
    WHERE intent.workspace_id = ? AND intent.status = 'active' AND intent.expires_at > ?
    GROUP BY intent.hash`;

type SnapshotKind = 'row' | 'tombstone';

type SnapshotPageToken = {
    version: 1;
    snapshotId: string;
    historyIncarnation: string;
    after: {
        tableName: string;
        pk: string;
        kind: SnapshotKind;
    };
};

type SnapshotHeaderRow = {
    id: string;
    workspace_id: string;
    high_watermark: number;
    tables_json: string;
    expires_at: number;
};

type PayloadSizeRow = { payload_bytes: number; metadata_bytes: number };
const PULL_METADATA_BYTES = syncMetadataBytes('table_name','pk','id','op','clock','hlc','device_id','op_id');
const SNAPSHOT_METADATA_BYTES = syncMetadataBytes('table_name','pk','kind','clock','hlc','op_id','server_deleted_at');

// Read only a bounded amount of payload data across the database boundary.
// Size metadata can cover the full row limit without transferring the payloads.
// Oversized rows consume a marker allowance; their payload never crosses into JS.
function boundedPayloadRowCount(sizes: PayloadSizeRow[], limit: number): number {
    let count = 0;
    let bytes = 0;
    for (const row of sizes.slice(0, limit)) {
        const size = (row.payload_bytes > MAX_SYNC_PAYLOAD_BYTES ? 1024 : Math.max(0, Number(row.payload_bytes) || 0))
            + Math.min(row.metadata_bytes, SYNC_METADATA_BYTES);
        if (count && bytes + size > MAX_SYNC_PAGE_BYTES) break;
        count++;
        bytes += size;
    }
    return count;
}

function snapshotPageSelection(headerId: string, after?: SnapshotPageToken['after']): { clause: string; parameters: string[] } {
    const clause = `FROM sync_snapshot_items WHERE snapshot_id = ?${after ? `
        AND (table_name COLLATE BINARY, pk COLLATE BINARY, kind COLLATE BINARY) > (?, ?, ?)` : ''}
        ORDER BY table_name COLLATE BINARY ASC, pk COLLATE BINARY ASC, kind COLLATE BINARY ASC LIMIT ?`;
    const parameters = after
        ? [headerId, after.tableName, after.pk, after.kind]
        : [headerId];
    return { clause, parameters };
}

type SnapshotItemRow = {
    table_name: string;
    pk: string;
    kind: SnapshotKind;
    payload_json: string | null;
    clock: number;
    hlc: string;
    op_id: string;
    server_deleted_at: number | null;
    payload_bytes?: number;
    metadata_bytes?: number;
    pk_hex?: string;
    table_hex?: string;
    notification_owner?: string | null;
};

function assertCoverageKey(table: string, pk: string, pkHex?: string, tableHex?: string): void {
    if (typeof table !== 'string' || !table || typeof pk !== 'string' || !pk ||
        !isLosslessSyncIdentifier(table) || !isLosslessSyncIdentifier(pk) ||
        (pkHex !== undefined && Buffer.from(pk).toString('hex').toUpperCase() !== pkHex) ||
        (tableHex !== undefined && Buffer.from(table).toString('hex').toUpperCase() !== tableHex)) {
        throw new Error('Untrustworthy sync coverage identity');
    }
}
function validReadPayload(table: string, pk: string, payload: unknown, _clock: number, hlc?: string): boolean {
    if (!Object.hasOwn(TABLE_PAYLOAD_SCHEMAS, table)) return false;
    const normalized = normalizeWirePayloadForTable(table, payload);
    // Old messages derive ordering from the revision HLC. Validate that view
    // without changing original wire bytes or persisted receipt content.
    const validationPayload = table === 'messages' && normalized && typeof normalized === 'object' && !Array.isArray(normalized)
        ? { ...normalized, order_key: (normalized as Record<string, unknown>).order_key || hlc }
        : normalized;
    if (!TABLE_PAYLOAD_SCHEMAS[table]!.safeParse(validationPayload).success) return false;
    const row = normalized as Record<string, unknown>;
    for (const key of ['id','hash','thread_id','project_id','user_id','document_id','root_thread_id','summary_message_id']) {
        if (typeof row[key] === 'string' && !isLosslessSyncIdentifier(row[key])) return false;
    }
    // Historical payloads may retain older redundant revision fields. Readers
    // install the authoritative envelope revision; only new writes bind both.
    return row[table === 'file_meta' ? 'hash' : 'id'] === pk;
}
function snapshotEvidence(header: SnapshotHeaderRow, row: SnapshotItemRow, historyIncarnation: string): EvidenceSource {
    return { historyIncarnation, workspaceId: header.workspace_id, source: 'snapshot', locator: JSON.stringify([row.table_name, row.pk]),
        revisionSql: "json_array(kind,clock,hlc,op_id)", table: 'sync_snapshot_items',
        where: 'snapshot_id = ? AND table_name = ? AND pk = ? AND kind = ?',
        parameters: [header.id, row.table_name, row.pk, row.kind], payload: 'coalesce(source_payload_json,payload_json)',
        metadata: "json_object('snapshot_id',snapshot_id,'table_name',table_name,'pk',pk,'kind',kind,'clock',clock,'hlc',hlc,'op_id',op_id,'server_deleted_at',server_deleted_at)" };
}
async function buildSnapshotPage(header: SnapshotHeaderRow, rows: SnapshotItemRow[], pageSize: number,
    availableRows: number, historyIncarnation: string, after?: SnapshotPageToken['after'], userId?: string): Promise<SnapshotResponse> {
    if (!Number.isSafeInteger(header.high_watermark) || header.high_watermark < 0) throw new Error('Untrustworthy snapshot watermark');
    const items: SnapshotItem[] = [];
    const unavailable: NonNullable<SnapshotResponse['unavailable']> = [];
    let scanned = 0;
    let itemBytes = 0;
    let token: string | null = null;
    let previous = after ? [after.tableName, after.pk, after.kind] : undefined;
    for (const row of rows.slice(0, pageSize)) {
        assertCoverageKey(row.table_name, row.pk, row.pk_hex, row.table_hex);
        const key = [row.table_name, row.pk, row.kind];
        if (!['row', 'tombstone'].includes(row.kind) || previous &&
            (compareSyncTuple(previous, key) >= 0 || compareSyncTuple(previous.slice(0,2),key.slice(0,2)) === 0)) {
            throw new Error('Untrustworthy snapshot ordering');
        }
        let item: SnapshotItem | undefined;
        let reason = row.metadata_bytes! > SYNC_METADATA_BYTES ? 'metadata_oversized' : row.payload_bytes! > MAX_SYNC_PAYLOAD_BYTES ? 'payload_oversized' : 'invalid_record';
        if (reason === 'invalid_record') {
            try {
                const revision = { clock: row.clock, hlc: row.hlc, opId: row.op_id };
                const candidate = row.kind === 'row'
                    ? { kind: 'row' as const, tableName: row.table_name, pk: row.pk, payload: JSON.parse(row.payload_json ?? 'null'), revision }
                    : { kind: 'tombstone' as const, tableName: row.table_name, pk: row.pk, revision, serverDeletedAt: row.server_deleted_at };
                if (SnapshotItemSchema.safeParse(candidate).success && Number.isSafeInteger(row.clock) &&
                    (row.kind === 'row' ? validReadPayload(row.table_name,row.pk,candidate.payload,row.clock,row.hlc) : ALLOWED_SYNC_TABLES.includes(row.table_name))) item = candidate as SnapshotItem;
            } catch { reason = 'invalid_json'; }
        }
        const marker = { tableName: row.table_name, pk: row.pk, originalKind: row.kind,
            snapshotId: header.id, highWatermark: header.high_watermark, evidenceRef: '', reason };
        const next = encodeSnapshotPageToken({ version: 1, snapshotId: header.id, historyIncarnation,
            after: { tableName: row.table_name, pk: row.pk, kind: row.kind } });
        const visible = row.table_name !== 'notifications' || row.kind === 'tombstone' || !!row.notification_owner && row.notification_owner === userId;
        let bytes = visible ? jsonBytes(item ?? {...marker,evidenceRef:'x'.repeat(36)}) + ((item ? items.length : unavailable.length) ? 1 : 0) : 0;
        const envelopeBytes = jsonBytes({historyIncarnation,workspaceId:header.workspace_id,snapshotId:header.id,highWatermark:header.high_watermark,
            items:[],unavailable:[],nextPageToken:next});
        if (item && envelopeBytes + bytes > MAX_SYNC_PAGE_BYTES) {
            item = undefined; reason = marker.reason = 'record_oversized';
            bytes = visible ? jsonBytes({...marker,evidenceRef:'x'.repeat(36)}) + (unavailable.length ? 1 : 0) : 0;
        }
        if (envelopeBytes + itemBytes + bytes > MAX_SYNC_PAGE_BYTES) {
            if (!scanned) throw new Error('Sync identity exceeds page byte budget');
            break;
        }
        if (item && visible) items.push(item);
        else if (!item) {
            marker.evidenceRef = await retainSqlEvidence(snapshotEvidence(header,row,historyIncarnation), reason);
            if (visible) unavailable.push(marker);
        }
        itemBytes += bytes;
        scanned++; token = next; previous = key;
    }
    const [retained] = await syncRows<{expires_at:number}>('SELECT expires_at FROM sync_snapshots WHERE id = ?',header.id);
    if (!retained || retained.expires_at <= nowEpoch()) throw createError({statusCode:410,statusMessage:'Snapshot expired or unavailable'});
    return SnapshotResponseSchema.parse({ historyIncarnation, workspaceId: header.workspace_id, snapshotId: header.id,
        highWatermark: header.high_watermark, items, ...(unavailable.length ? { unavailable } : {}),
        nextPageToken: availableRows > scanned ? token : null });
}

type HookEmission = {
    hookName: string;
    payload: Record<string, unknown>;
};

type CanonicalStorageCursor = {
    version: 1;
    kind: CanonicalStorageQueryRequest['kind'];
    hash?: string;
    key: string[];
};

function uid(): string {
    return globalThis.crypto.randomUUID();
}

function parseRequiredHistoryAdmission(input: unknown): ChatGenerationAdmissionEnvelope {
    try { return parseChatGenerationAdmissionEnvelope(input); }
    catch (cause) { throw Object.assign(new Error('Invalid background history admission', { cause }), { code: 'VALIDATION_ERROR' }); }
}

function nowEpoch(): number {
    return Math.floor(Date.now() / 1000);
}

function snapshotOwnerPrefix(userId: string | undefined): string {
    // Persist ownership in the server-generated ID, never in caller token claims.
    return `user:${createHash('sha256').update(userId ?? '').digest('hex')}:`;
}

function assertSnapshotOwner(id: string, userId: string | undefined): void {
    const scopedId = id.replace(/^backup:/, '');
    // Pre-upgrade copies have no authenticated owner. Restart those chains.
    if (!scopedId.startsWith('user:')) {
        throw createError({ statusCode: 410, statusMessage: 'Snapshot expired or unavailable' });
    }
    if (!scopedId.startsWith(snapshotOwnerPrefix(userId))) {
        throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
    }
}

export async function pruneExpiredSyncSnapshots(): Promise<void> {
    if (isD1Driver()) {
        await d1Run('DELETE FROM sync_snapshots WHERE expires_at <= ?', nowEpoch());
    } else {
        getRawDb().prepare('DELETE FROM sync_snapshots WHERE expires_at <= ?').run(nowEpoch());
    }
}


// Keep head + 1 representable for the empty-log retention boundary.
function safeVersionEnd(base: number, count: number): number {
    const end = base + count;
    if (!Number.isSafeInteger(base) || base < 0 || !Number.isSafeInteger(end) || end < 0
        || (count > 0 && end >= Number.MAX_SAFE_INTEGER)) {
        throw Object.assign(new Error('Sync server version exhausted or invalid'), { code: 'VALIDATION_ERROR' });
    }
    return end;
}

function backgroundHistoryOpId(
    admission: Pick<ChatGenerationAdmissionEnvelope, 'workspaceId' | 'generationId'>,
    stage: 'thread' | 'user' | 'assistant' | 'finalize'
): string {
    return digestUuid(createHash('sha256')
        .update(`${admission.workspaceId}\0${admission.generationId}\0${stage}`)
        .digest('hex'));
}

function fingerprintPayload(tableName: string, operation: string, payload: unknown): unknown {
    if (tableName !== 'notifications' || operation !== 'delete') return payload;
    if (payload == null) return undefined;
    if (typeof payload !== 'object' || Array.isArray(payload)) return payload;
    // The authenticated owner is server metadata, not delete intent. Older
    // receipts omitted it; lost-ACK retries must remain idempotent on upgrade.
    const intent = { ...(payload as Record<string, unknown>) };
    delete intent.user_id;
    return Object.keys(intent).length > 0 ? intent : undefined;
}

function operationFingerprint(op: PendingOp): string {
    return stableJson({
        tableName: op.tableName,
        operation: op.operation,
        pk: op.pk,
        payload: fingerprintPayload(op.tableName, op.operation, op.payload),
        clock: op.stamp.clock,
        hlc: op.stamp.hlc,
        deviceId: op.stamp.deviceId,
    });
}

function prepareFinalOperation(op: PendingOp): PendingOp {
    const payload = op.operation === 'put' && op.payload && typeof op.payload === 'object'
        ? { ...(op.payload as Record<string, unknown>), clock: op.stamp.clock, hlc: op.stamp.hlc, op_id: op.stamp.opId }
        : op.payload;
    return { ...op, ...prepareSyncWrite({ ...op, payload }) };
}


function notificationPayloadUserId(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return undefined;
    }
    const userId = (payload as Record<string, unknown>).user_id;
    return typeof userId === 'string' && userId.trim().length > 0 ? userId : undefined;
}

function scopeNotificationWrite(
    op: PendingOp,
    userId: string | undefined
): PendingOp | string {
    if (op.tableName !== 'notifications') return op;
    if (!userId) {
        return 'Unauthorized: notification writes require a session user';
    }
    const payload =
        op.payload && typeof op.payload === 'object' && !Array.isArray(op.payload)
            ? { ...(op.payload as Record<string, unknown>) }
            : {};
    if (payload.user_id !== undefined && payload.user_id !== userId) {
        return 'Forbidden: notification owner mismatch';
    }
    return { ...op, payload: { ...payload, user_id: userId } };
}

const WORKSPACE_ITEM_UPDATE_REQUIRED = 'OR3_WORKSPACE_ITEM_UPDATE_REQUIRED';

function assertExplorerPage(capability: unknown, ...pages: ReadonlyArray<
    readonly { tableName: string; pk: string; payload?: unknown }[]
>) {
    if (capability !== EXPLORER_CAPABILITY && pages.some(page => page.some(row =>
        hasExplorerSemantics(row.tableName, row.pk, row.payload)))) {
        throw createError({ statusCode: 426, statusMessage: 'Update OR3 Chat to sync workspace folders',
            data: { code: 'OR3_EXPLORER_UPDATE_REQUIRED', requiredCapability: EXPLORER_CAPABILITY } });
    }
}

function workspaceItemUpdateRequired() {
    return createError({
        statusCode: 426,
        statusMessage: 'Update OR3 Chat to use workspace Files and Trash',
        data: { code: WORKSPACE_ITEM_UPDATE_REQUIRED, requiredCapability: WORKSPACE_ITEM_CAPABILITY },
    });
}

/**
 * D1 has no interactive write transaction. Assert canonical capability inside
 * its atomic batch, so a concurrent Files/Trash write cannot be overwritten by
 * an older client after a preflight read. An invalid JSON path aborts the whole
 * batch, including sibling operations and version allocation.
 */
function workspaceItemCapabilityAssertion(op: PendingOp, workspaceId: string): D1SqlStatement {
    const field = op.tableName === 'posts' ? 'meta' : 'data';
    const decoded = `CASE WHEN json_type(data_json, '$.${field}') = 'text'
        THEN CASE WHEN json_valid(json_extract(data_json, '$.${field}'))
            THEN json_extract(data_json, '$.${field}') ELSE 'null' END
        ELSE COALESCE(json_extract(data_json, '$.${field}'), 'null') END`;
    const semantics = op.tableName === 'posts'
        ? `COALESCE(json_extract(data_json, '$.post_type'), json_extract(data_json, '$.postType')) = 'or3:file'
            OR (json_type(metadata) = 'object' AND (
                json_type(metadata, '$."or3.workspace-item"') IS NOT NULL
                OR json_extract(metadata, '$.key') = 'or3.workspace-item'
            ))
            OR (json_type(metadata) = 'array' AND EXISTS (
                SELECT 1 FROM json_each(metadata) AS entry
                WHERE CASE WHEN entry.type = 'object'
                    THEN json_extract(entry.value, '$.key') = 'or3.workspace-item' ELSE 0 END
            ))`
        : `json_type(metadata) = 'array' AND EXISTS (
            SELECT 1 FROM json_each(metadata) AS entry
            WHERE CASE WHEN entry.type = 'object'
                THEN json_extract(entry.value, '$.kind') = 'file' ELSE 0 END
        )`;
    return {
        sql: `SELECT json_extract('{}', CASE WHEN EXISTS (
            SELECT 1 FROM (
                SELECT data_json, ${decoded} AS metadata FROM (
                    SELECT CASE WHEN json_valid(data_json) AND length(cast(data_json AS blob)) <= ${MAX_SYNC_PAYLOAD_BYTES} THEN data_json ELSE '{}' END AS data_json
                    FROM "${SYNCED_TABLE_MAP[op.tableName]}" WHERE workspace_id = ? AND id = ?
                )
            ) WHERE ${semantics}
        ) THEN '${WORKSPACE_ITEM_UPDATE_REQUIRED}' ELSE '$' END)`,
        parameters: [workspaceId, op.pk],
    };
}

const LWW_EXCLUDED_WINS = `(
    excluded.clock > TARGET.clock
    OR (excluded.clock = TARGET.clock AND excluded.hlc > TARGET.hlc)
    OR (
        excluded.clock = TARGET.clock
        AND excluded.hlc = TARGET.hlc
        AND excluded.op_id > TARGET.op_id
    )
)`;

function lwwExcludedWins(existingTable: string): string {
    return LWW_EXCLUDED_WINS.replaceAll('TARGET', existingTable);
}

function snapshotNotificationOwnerClause(
    tableName: string,
    jsonExpr: string,
    userId: string | undefined
): { sql: string; params: unknown[] } {
    if (tableName !== 'notifications') return { sql: '', params: [] };
    if (!userId) return { sql: ' AND 1 = 0', params: [] };
    return {
        sql: ` AND ${notificationOwnerSql(jsonExpr)} = ?`,
        params: [userId],
    };
}

function validatePushOperation(workspaceId: string, op: PendingOp): string | undefined {
    if (!ALLOWED_SYNC_TABLES.includes(op.tableName)) {
        return `Invalid table: ${op.tableName}`;
    }
    if (op.payload !== undefined &&
        (typeof op.payload !== 'object' || op.payload === null || Array.isArray(op.payload))) {
        return `Invalid payload for ${op.tableName}: payload must be an object`;
    }
    const payload = op.payload as Record<string, unknown> | undefined;
    if (!payload) return undefined;
    let serializedPayload: string;
    try {
        serializedPayload = JSON.stringify(payload);
    } catch {
        return `Invalid payload for ${op.tableName}: payload is not serializable`;
    }
    if (
        new TextEncoder().encode(serializedPayload).byteLength >
        MAX_SYNC_PAYLOAD_BYTES
    ) {
        return `Payload too large for ${op.tableName}: exceeds ${MAX_SYNC_PAYLOAD_BYTES} bytes`;
    }
    if ('_id' in payload) return `Invalid payload for ${op.tableName}: '_id' is immutable`;
    if ('workspace_id' in payload && payload.workspace_id !== workspaceId) {
        return `Invalid payload for ${op.tableName}: 'workspace_id' is immutable`;
    }
    const pkField = op.tableName === 'file_meta' ? 'hash' : 'id';
    if (pkField in payload && payload[pkField] !== op.pk) {
        return `Invalid payload for ${op.tableName}: '${pkField}' must match operation pk`;
    }
    return undefined;
}

function normalizeStorageHash(value: string): string {
    return value.replace(/^sha256:/i, '').replace(/^md5:/i, '').trim().toLowerCase();
}

function resolveCanonicalStorageLimit(limit: number | undefined): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
        return DEFAULT_CANONICAL_STORAGE_PAGE_SIZE;
    }
    return Math.max(1, Math.min(Math.floor(limit), MAX_CANONICAL_STORAGE_PAGE_SIZE));
}

function encodeCanonicalStorageCursor(cursor: CanonicalStorageCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCanonicalStorageCursor(
    input: string | undefined,
    kind: CanonicalStorageQueryRequest['kind'],
    hash: string | undefined
): string[] {
    if (!input) return [];
    try {
        if (input.length > 2048) throw new Error('oversized');
        const parsed = JSON.parse(Buffer.from(input, 'base64url').toString('utf8')) as CanonicalStorageCursor;
        if (
            parsed.version !== 1 ||
            parsed.kind !== kind ||
            parsed.hash !== hash ||
            !Array.isArray(parsed.key) ||
            !parsed.key.every((part) => typeof part === 'string')
        ) {
            throw new Error('mismatch');
        }
        return parsed.key;
    } catch {
        throw createError({ statusCode: 400, statusMessage: 'Invalid canonical storage cursor' });
    }
}

function resolvePullLimit(limit: number | undefined): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_PULL_LIMIT;
    return Math.max(1, Math.min(Math.floor(limit), MAX_PULL_LIMIT));
}

function resolveSnapshotPageSize(pageSize: number): number {
    if (
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > MAX_SNAPSHOT_PAGE_SIZE
    ) {
        throw createError({
            statusCode: 400,
            statusMessage: `pageSize must be an integer between 1 and ${MAX_SNAPSHOT_PAGE_SIZE}`,
        });
    }
    return pageSize;
}

function normalizeSnapshotTables(tables: string[] | undefined): string[] {
    const requested = tables?.length ? [...new Set(tables)] : [...ALLOWED_SYNC_TABLES];
    for (const tableName of requested) {
        if (!ALLOWED_SYNC_TABLES.includes(tableName)) {
            throw createError({
                statusCode: 400,
                statusMessage: `Invalid snapshot table: ${tableName}`,
            });
        }
    }
    return requested.sort();
}

function encodeSnapshotPageToken(token: SnapshotPageToken): string {
    return Buffer.from(JSON.stringify(token), 'utf8').toString('base64url');
}

function decodeSnapshotPageToken(value: string): SnapshotPageToken {
    try {
        if (value.length > MAX_SYNC_SNAPSHOT_TOKEN_LENGTH) throw new Error('Token exceeds ceiling');
        const parsed = JSON.parse(
            Buffer.from(value, 'base64url').toString('utf8')
        ) as Partial<SnapshotPageToken>;
        const after = parsed.after;
        if (
            parsed.version !== 1 ||
            typeof parsed.snapshotId !== 'string' ||
            !parsed.snapshotId ||
            !after ||
            typeof after.tableName !== 'string' ||
            typeof after.pk !== 'string' ||
            (after.kind !== 'row' && after.kind !== 'tombstone')
        ) {
            throw new Error('Invalid token payload');
        }
        assertCoverageKey(after.tableName,after.pk);
        return parsed as SnapshotPageToken;
    } catch {
        throw createError({
            statusCode: 400,
            statusMessage: 'Invalid snapshot page token',
        });
    }
}

async function assertWorkspaceScopeAuthorized(
    event: H3Event,
    workspaceId: string
): Promise<void> {
    if (!workspaceId.trim()) {
        throw createError({
            statusCode: 400,
            statusMessage: 'workspaceId is required',
        });
    }

    const context = (event as { context?: Record<string, unknown> }).context;
    let activeWorkspaceId: string | null = null;
    if (context && typeof context === 'object') {
        for (const [key, value] of Object.entries(context)) {
            if (!key.startsWith(SESSION_CONTEXT_KEY_PREFIX)) continue;
            const workspaceIdCandidate = (value as { workspace?: { id?: unknown } })
                .workspace?.id;
            if (
                typeof workspaceIdCandidate === 'string' &&
                workspaceIdCandidate.trim().length > 0
            ) {
                activeWorkspaceId = workspaceIdCandidate;
                break;
            }
        }
    }

    // Defense in depth: API routes already enforce auth/can(), but reject
    // mismatched workspace scopes if a resolved session is present.
    if (activeWorkspaceId && activeWorkspaceId !== workspaceId) {
        throw createError({
            statusCode: 403,
            statusMessage: 'Forbidden',
        });
    }
}

function resolveSessionUserId(event: H3Event): string | undefined {
    const context = (event as { context?: Record<string, unknown> }).context;
    if (!context || typeof context !== 'object') {
        return undefined;
    }

    for (const [key, value] of Object.entries(context)) {
        if (!key.startsWith(SESSION_CONTEXT_KEY_PREFIX)) continue;
        const userId = (value as { user?: { id?: unknown } }).user?.id;
        if (typeof userId === 'string' && userId.trim().length > 0) {
            return userId;
        }
    }

    return undefined;
}

function toWebhookEntityPayload(input: {
    op: PendingOp;
    workspaceId: string;
    now: number;
    userId?: string;
    deleted?: boolean;
}): Record<string, unknown> {
    const base =
        input.op.payload && typeof input.op.payload === 'object'
            ? { ...(input.op.payload as Record<string, unknown>) }
            : {};

    if (typeof base.id !== 'string' || base.id.length === 0) {
        base.id = input.op.pk;
    }
    if (
        typeof base.workspace_id !== 'string' ||
        base.workspace_id.length === 0
    ) {
        base.workspace_id = input.workspaceId;
    }
    if (
        input.userId &&
        (typeof base.user_id !== 'string' || base.user_id.length === 0)
    ) {
        base.user_id = input.userId;
    }
    if (input.deleted) {
        base.deleted = true;
    }
    if (typeof base.updated_at !== 'number') {
        base.updated_at = input.now;
    }

    return base;
}

function resolveHookEmission(input: {
    op: PendingOp;
    workspaceId: string;
    now: number;
    userId?: string;
    wasExisting: boolean;
    applied: boolean;
}): HookEmission | null {
    if (!input.applied) {
        return null;
    }

    const { op } = input;
    if (op.tableName === 'threads') {
        if (op.operation === 'delete') {
            return {
                hookName: 'db.threads.delete:action:soft:after',
                payload: toWebhookEntityPayload({
                    op,
                    workspaceId: input.workspaceId,
                    now: input.now,
                    userId: input.userId,
                    deleted: true,
                }),
            };
        }

        return {
            hookName: input.wasExisting
                ? 'db.threads.update:action:after'
                : 'db.threads.create:action:after',
            payload: toWebhookEntityPayload({
                op,
                workspaceId: input.workspaceId,
                now: input.now,
                userId: input.userId,
            }),
        };
    }

    if (op.tableName === 'messages') {
        if (op.operation === 'delete') {
            return {
                hookName: 'db.messages.delete:action:soft:after',
                payload: toWebhookEntityPayload({
                    op,
                    workspaceId: input.workspaceId,
                    now: input.now,
                    userId: input.userId,
                    deleted: true,
                }),
            };
        }

        return {
            hookName: input.wasExisting
                ? 'db.messages.update:action:after'
                : 'db.messages.create:action:after',
            payload: toWebhookEntityPayload({
                op,
                workspaceId: input.workspaceId,
                now: input.now,
                userId: input.userId,
            }),
        };
    }

    if (op.tableName === 'documents' || op.tableName === 'posts') {
        if (op.operation === 'delete') {
            return {
                hookName: 'db.documents.delete:action:soft:after',
                payload: toWebhookEntityPayload({
                    op,
                    workspaceId: input.workspaceId,
                    now: input.now,
                    userId: input.userId,
                    deleted: true,
                }),
            };
        }

        return {
            hookName: input.wasExisting
                ? 'db.documents.update:action:after'
                : 'db.documents.create:action:after',
            payload: toWebhookEntityPayload({
                op,
                workspaceId: input.workspaceId,
                now: input.now,
                userId: input.userId,
            }),
        };
    }

    if (op.tableName === 'notifications' && op.operation === 'put') {
        return {
            hookName: 'notify:action:push',
            payload: toWebhookEntityPayload({
                op,
                workspaceId: input.workspaceId,
                now: input.now,
                userId: input.userId,
            }),
        };
    }

    return null;
}

function incomingWinsRevision(
    incoming: { clock: number; hlc: string; opId: string },
    existing: { clock: number; hlc: string; opId?: string | null; op_id?: string | null }
): boolean {
    return incomingRevisionWins(incoming, {
        clock: existing.clock,
        hlc: existing.hlc,
        opId: existing.opId || existing.op_id || '',
    });
}

type MaterializedWinnerRow = {
    clock: number;
    hlc: string;
    op_id: string;
    data_json: string;
    deleted: number;
    updated_at: number;
    payload_bytes?: number;
};

type TombstoneWinnerRow = {
    clock: number;
    hlc: string;
    op_id: string;
    deleted_at: number;
};

class StoredRecordUnavailable extends Error {
    constructor(readonly source: Omit<EvidenceSource, 'historyIncarnation'>, readonly reason: string, readonly revision?: {clock:number;hlc:string;opId:string}) {
        super(reason);
    }
}
function storedCanonicalSource(workspaceId: string, tableName: string, pk: string): Omit<EvidenceSource, 'historyIncarnation'> {
    // tableName comes from the fixed synced-table allowlist.
    return { workspaceId, source: 'canonical', locator: JSON.stringify([tableName, pk]),
        table: SYNCED_TABLE_MAP[tableName]!, where: 'workspace_id=? AND id=?', parameters: [workspaceId, pk],
        revisionSql: 'json_array(clock,hlc,op_id,deleted)', payload: 'data_json',
        metadata: `json_object('table_name','${tableName}','pk',id,'clock',clock,'hlc',hlc,'op_id',op_id,'deleted',deleted)` };
}
const WINNER_COLUMNS = `${boundedSyncPayload('data_json')} AS data_json,
    ${['clock','hlc','op_id','deleted','updated_at'].map(c => `${boundedSyncMetadata(c)} AS ${c}`).join(',')},
    length(cast(data_json AS blob)) AS payload_bytes`;
const TOMBSTONE_COLUMNS = ['clock','hlc','op_id','deleted_at'].map(c => `${boundedSyncMetadata(c)} AS ${c}`).join(',');
function materializedWinner(
    row: MaterializedWinnerRow | undefined,
    tombstone: TombstoneWinnerRow | undefined,
    workspaceId: string, tableName: string, pk: string
): PushWinner | undefined {
    const source = storedCanonicalSource(workspaceId, tableName, pk);
    const revisionValid = (value: MaterializedWinnerRow | TombstoneWinnerRow) =>
        SnapshotItemSchema.safeParse({kind:'tombstone',tableName,pk,
            revision:{clock:value.clock,hlc:value.hlc,opId:value.op_id},serverDeletedAt:0}).success && Number.isSafeInteger(value.clock);
    if (row && (!revisionValid(row) || ![0,1].includes(row.deleted))) throw new StoredRecordUnavailable(source, 'invalid_stored_revision');
    if (tombstone && (!revisionValid(tombstone) || !Number.isSafeInteger(tombstone.deleted_at) || tombstone.deleted_at < 0)) {
        throw new StoredRecordUnavailable({workspaceId,source:'canonical',locator:JSON.stringify([tableName,pk,'tombstone']),
            table:'tombstones',where:'workspace_id=? AND table_name=? AND pk=?',parameters:[workspaceId,tableName,pk],
            revisionSql:'json_array(clock,hlc,op_id)',payload:'NULL',
            metadata:"json_object('table_name',table_name,'pk',pk,'clock',clock,'hlc',hlc,'op_id',op_id,'deleted_at',deleted_at)"}, 'invalid_stored_revision');
    }
    if (tombstone && (!row || incomingWinsRevision({clock:tombstone.clock,hlc:tombstone.hlc,opId:tombstone.op_id},row))) {
        return {kind:'delete',revision:{clock:tombstone.clock,hlc:tombstone.hlc,opId:tombstone.op_id},serverDeletedAt:tombstone.deleted_at};
    }
    if (!row) return undefined;
    const revision = {clock:row.clock,hlc:row.hlc,opId:row.op_id};
    if (row.deleted) {
        if (!Number.isSafeInteger(row.updated_at) || row.updated_at < 0) throw new StoredRecordUnavailable(source,'invalid_stored_revision');
        return {kind:'delete',revision,serverDeletedAt:tombstone?.op_id===row.op_id?tombstone.deleted_at:row.updated_at};
    }
    if (row.payload_bytes! > MAX_SYNC_PAYLOAD_BYTES) throw new StoredRecordUnavailable(source, 'payload_oversized', revision);
    let payload: unknown;
    try { payload = JSON.parse(row.data_json); }
    catch { throw new StoredRecordUnavailable(source, 'invalid_json', revision); }
    if (!validReadPayload(tableName,pk,payload,row.clock,row.hlc)) throw new StoredRecordUnavailable(source,'invalid_stored_payload',revision);
    return {kind:'put',payload:payload as Record<string,unknown>,revision};
}

const RECEIPT_COLUMNS = `${boundedSyncMetadata('id')} AS id,op_id,server_version,workspace_id,
    ${['table_name','pk','op','clock','hlc','device_id'].map(c => `${boundedSyncMetadata(c)} AS ${c}`).join(',')},
    ${boundedSyncPayload('payload_json')} AS payload_json,length(cast(payload_json AS blob)) AS payload_bytes,
    ${boundedSyncMetadata('intent_fingerprint')} AS intent_fingerprint,length(cast(intent_fingerprint AS blob)) AS fingerprint_bytes`;
type StoredReceipt = {id:string;op_id:string;workspace_id:string;server_version:number;payload_bytes:number;fingerprint_bytes:number;table_name:string;pk:string;op:string;payload_json:string|null;intent_fingerprint:string|null;clock:number;hlc:string;device_id:string};
function storedReceiptSource(row: StoredReceipt): Omit<EvidenceSource,'historyIncarnation'> {
    return {workspaceId:row.workspace_id,source:'pull',locator:row.id || row.op_id,
        table:'change_log',where:'op_id=?',parameters:[row.op_id],revisionSql:'cast(server_version AS text)',payload:'payload_json',
        metadata:"json_object('table_name',table_name,'pk',pk,'op',op,'clock',clock,'hlc',hlc,'device_id',device_id,'op_id',op_id,'server_version',server_version,'intent_fingerprint',intent_fingerprint)"};
}
function receiptFingerprint(row: StoredReceipt): string {
    const source = storedReceiptSource(row);
    if (row.fingerprint_bytes > SYNC_METADATA_BYTES || row.payload_bytes > MAX_SYNC_PAYLOAD_BYTES) throw new StoredRecordUnavailable(source,'stored_receipt_oversized');
    // Receipts with persisted fingerprints need no payload normalization, but
    // a corrupted stored payload still cannot be certified as a successful replay.
    let payload: unknown;
    try {
        payload = row.payload_json != null ? JSON.parse(row.payload_json) : undefined;
    } catch { throw new StoredRecordUnavailable(source,'invalid_json'); }
    if (!Number.isSafeInteger(row.server_version) || row.server_version < 1 ||
        !SyncChangeSchema.safeParse({tableName:row.table_name,pk:row.pk,op:row.op,
            payload,
            stamp:{clock:row.clock,hlc:row.hlc,opId:row.op_id,deviceId:row.device_id},serverVersion:row.server_version}).success) {
        throw new StoredRecordUnavailable(source,'invalid_stored_receipt');
    }
    if (row.op === 'put' && !validReadPayload(row.table_name,row.pk,payload,row.clock,row.hlc)) throw new StoredRecordUnavailable(source,'invalid_stored_receipt');
    return row.intent_fingerprint ?? stableJson({tableName:row.table_name,operation:row.op,pk:row.pk,
        payload:fingerprintPayload(row.table_name,row.op,payload),clock:row.clock,hlc:row.hlc,deviceId:row.device_id});
}
function storedRecordCapability(capability: PushBatch['storedRecordCapability']): void {
    if (capability !== 'stored-record-v1') throw createError({statusCode:426,statusMessage:'Update OR3 Chat to recover unavailable stored records',
        data:{code:'OR3_SYNC_UPDATE_REQUIRED',requiredCapability:'stored-record-v1'}});
}
function rejectedIntent(op: PendingOp, source: EvidenceSource): D1SqlStatement {
    const lookup = evidenceLookup(source);
    return {sql:`INSERT OR IGNORE INTO sync_unavailable_records
        (id,workspace_id,source,locator,revision,payload_json,metadata_json,reason,status,created_at)
        SELECT ?,?,'push',?,json_array(?,?),?,json_object('historyIncarnation',?,'evidenceRef',id), 'stored_record_unavailable','unresolved',unixepoch()
        FROM (${lookup.sql})`, parameters:[uid(),source.workspaceId,op.stamp.opId,source.historyIncarnation,operationFingerprint(op),JSON.stringify(op),source.historyIncarnation,...lookup.parameters!]};
}
function unavailableResult(op: PendingOp, error: StoredRecordUnavailable, evidenceRef: string): PushResult['results'][number] {
    return {opId:op.stamp.opId,success:false,errorCode:'STORED_RECORD_UNAVAILABLE',error:error.reason,evidenceRef};
}
function retainPushFailureNative(op: PendingOp, error: StoredRecordUnavailable, input: ExplorerRequest<PushBatch>): PushResult['results'][number] {
    storedRecordCapability(input.storedRecordCapability);
    const source = {...error.source,historyIncarnation:input.historyIncarnation as string};
    const raw = getRawDb();
    for (const statement of [evidenceInsert(source,error.reason),rejectedIntent(op,source)]) raw.prepare(statement.sql).run(...statement.parameters!);
    const lookup = evidenceLookup(source);
    const row = raw.prepare(lookup.sql).get(...lookup.parameters!) as {id:string}|undefined;
    if (!row) throw new Error('Push evidence source disappeared');
    return unavailableResult(op,error,row.id);
}
async function retainPushFailureD1(op: PendingOp, error: StoredRecordUnavailable, historyIncarnation: string, capability: PushBatch['storedRecordCapability']): Promise<PushResult['results'][number]> {
    storedRecordCapability(capability);
    const source = {...error.source,historyIncarnation};
    await historyBatch([historyAssertion(historyIncarnation),evidenceInsert(source,error.reason),rejectedIntent(op,source)],historyIncarnation);
    const lookup = evidenceLookup(source);
    const [row] = await d1All<{id:string}>(lookup.sql,...lookup.parameters!);
    if (!row) throw new Error('Push evidence source disappeared');
    return unavailableResult(op,error,row.id);
}

function currentWinnerNative(
    raw: ReturnType<typeof getRawDb>,
    workspaceId: string,
    tableName: string,
    pk: string
): PushWinner | undefined {
    const materializedTable = SYNCED_TABLE_MAP[tableName];
    if (!materializedTable) return undefined;
    const row = raw.prepare(
        `SELECT ${WINNER_COLUMNS}
         FROM ${materializedTable} WHERE id = ? AND workspace_id = ?`
    ).get(pk, workspaceId) as MaterializedWinnerRow | undefined;
    const tombstone = raw.prepare(
        `SELECT ${TOMBSTONE_COLUMNS} FROM tombstones
         WHERE workspace_id = ? AND table_name = ? AND pk = ?`
    ).get(workspaceId, tableName, pk) as TombstoneWinnerRow | undefined;
    return materializedWinner(row, tombstone, workspaceId, tableName, pk);
}

async function currentWinnerD1(
    workspaceId: string,
    tableName: string,
    pk: string,
    userId: string | undefined
): Promise<PushWinner | undefined> {
    const materializedTable = SYNCED_TABLE_MAP[tableName];
    if (!materializedTable) return undefined;
    const [row] = await d1All<MaterializedWinnerRow>(
        `SELECT ${WINNER_COLUMNS}
         FROM "${materializedTable}" WHERE id = ? AND workspace_id = ?`,
        pk,
        workspaceId
    );

    const [tombstone] = await d1All<TombstoneWinnerRow>(
        `SELECT ${TOMBSTONE_COLUMNS} FROM tombstones
         WHERE workspace_id = ? AND table_name = ? AND pk = ?`,
        workspaceId,
        tableName,
        pk
    );
    const winner = materializedWinner(row,tombstone,workspaceId,tableName,pk);
    if (tableName === 'notifications' && winner?.kind === 'put' && notificationPayloadUserId(winner.payload) !== userId) return undefined;
    return winner;
}

export class SqliteSyncGatewayAdapter implements SyncGatewayAdapter {
    id = 'sqlite';
    private versionWatchers = new Map<string, {
        listeners: Map<(position: {historyIncarnation:string;version:number}) => void, (error: unknown) => void>;
        position?: {historyIncarnation:string;version:number}; timer?: ReturnType<typeof setTimeout>; running: boolean;
    }>();

    async watchVersion(event: H3Event, scope: { workspaceId: string }, onVersion: (position: {historyIncarnation:string;version:number}) => void,
        onError: (error: unknown) => void): Promise<() => void> {
        await assertWorkspaceScopeAuthorized(event, scope.workspaceId);
        let watcher = this.versionWatchers.get(scope.workspaceId);
        if (!watcher) {
            watcher = { listeners: new Map(), running: false };
            this.versionWatchers.set(scope.workspaceId, watcher);
        }
        const current = watcher;
        current.listeners.set(onVersion, onError);
        if (current.position) onVersion(current.position);
        const poll = async () => {
            if (current.running || this.versionWatchers.get(scope.workspaceId) !== current) return;
            current.running = true;
            try {
                const [row] = await syncRows<{historyIncarnation:string;version:number}>(`SELECT incarnation AS historyIncarnation,
                    coalesce((SELECT value FROM server_version_counter WHERE workspace_id=?),0) AS version FROM sync_history WHERE id=1`,scope.workspaceId);
                if (!row || !validHistoryIncarnation(row.historyIncarnation)) throw new Error('Invalid sync history singleton');
                if (current.position && current.position.historyIncarnation !== row.historyIncarnation) {
                    // Never keep a stream from the replaced database alive.
                    for (const fail of [...current.listeners.values()]) fail(createError({statusCode:409,
                        data:{code:'OR3_SYNC_HISTORY_CHANGED',historyIncarnation:row.historyIncarnation,requiresSnapshot:true}}));
                    current.listeners.clear();
                    this.versionWatchers.delete(scope.workspaceId);
                    return;
                }
                if (current.position?.version !== row.version) {
                    current.position = row;
                    for (const notify of [...current.listeners.keys()]) notify(row);
                }
            } catch (error) {
                for (const fail of [...current.listeners.values()]) fail(error);
            } finally { current.running = false; }
            if (this.versionWatchers.get(scope.workspaceId) === current && current.listeners.size) {
                current.timer = setTimeout(() => { void poll(); }, 2000);
                current.timer.unref?.();
            }
        };
        if (!current.running && !current.timer) void poll();
        return () => {
            current.listeners.delete(onVersion);
            if (current.listeners.size) return;
            if (current.timer) clearTimeout(current.timer);
            if (this.versionWatchers.get(scope.workspaceId) === current) this.versionWatchers.delete(scope.workspaceId);
        };
    }

    /** Construct only on use, after the provider initializes its database. */
    get storageGenerationCoordinator() {
        const namespace = process.env.OR3_STORAGE_FS_CLEANUP_NAMESPACE_ID;
        if (process.platform !== 'linux' || !namespace || isD1Driver()) return undefined;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(namespace)) throw new Error('Invalid filesystem cleanup namespace');
        const raw = getRawDb();
        const durability = raw.prepare('PRAGMA synchronous').get() as { synchronous?: number };
        if (durability.synchronous !== 2 && durability.synchronous !== 3) return undefined;
        return new SqliteExternalStorageGenerationUploadCoordinator({ storageProviderId: 'fs', database: raw });
    }

    get capabilities() {
        return isD1Driver()
            ? ({
                  snapshotBootstrap: 'snapshot-v1',
                  unavailableRecords: 'v1',
                  historyRetention: 'snapshot-v1',
                  retainedStorageMetadata: 'v1',
                  atomicUploadQuota: 'retained-v1',
              } as const)
            : ({
                  historyIncarnation: 'v1',
                  snapshotBootstrap: 'snapshot-v1',
                  unavailableRecords: 'v1',
                  historyRetention: 'snapshot-v1',
                  ...(this.storageGenerationCoordinator ? { externalStorageGenerations: 'v1' as const } : {}),
                  backgroundGenerationHistory: 'v1',
                  delegationTerminalHistory: 'v1',
                  canonicalChatHistory: 'v1',
                  projectOwnership: 'v1',
                  workspaceItems: 'v1',
                  explorer: EXPLORER_CAPABILITY,
                  retainedStorageMetadata: 'v1',
                  atomicUploadQuota: 'retained-v1',
              } as const);
    }

    async getHistoryIncarnation(event: H3Event, scope: {workspaceId:string}): Promise<string> {
        await assertWorkspaceScopeAuthorized(event, scope.workspaceId);
        return readHistoryIncarnation();
    }

    private async checkHistory(event: H3Event, input: {scope:{workspaceId:string};historyIncarnation?:unknown;historyIncarnationCapability?:unknown}, discovery = false): Promise<string> {
        await assertWorkspaceScopeAuthorized(event,input.scope.workspaceId);
        const expected = input.historyIncarnation;
        // An old host strips the new fields before reaching the provider.
        // Keep the existing update boundary instead of an opaque 400.
        if (expected === undefined && input.historyIncarnationCapability !== 'incarnation-v1') {
            throw createError({ statusCode: 426, statusMessage: 'Update OR3 Chat for history recovery',
                data: { code: 'OR3_SYNC_UPDATE_REQUIRED', requiredCapability: 'incarnation-v1' } });
        }
        validateExpectedHistory(expected);
        const current = await readHistoryIncarnation();
        if (!discovery && expected !== current) historyChanged(current);
        return current;
    }

    private get db() {
        return getSqliteDb();
    }

    async readChatHistory(actor: CanonicalHistoryActor, query: CanonicalChatQuery, signal?: AbortSignal): Promise<CanonicalChatReadResult> {
        validateCanonicalChatQuery(query);
        signal?.throwIfAborted();
        if (isD1Driver()) return { status: 'scope_incomplete' };
        const raw = getRawDb();
        const result = raw.transaction(() => {
            const membership = raw.prepare(`SELECT m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
                WHERE m.workspace_id = ? AND m.user_id = ? AND COALESCE(w.deleted, 0) = 0`).get(actor.workspaceId, actor.userId) as { role: string } | undefined;
            if (!membership || !['owner', 'editor', 'viewer'].includes(membership.role)) throw new Error('Forbidden canonical history actor');
            const counter = raw.prepare('SELECT value FROM server_version_counter WHERE workspace_id = ?').get(actor.workspaceId) as { value: number } | undefined;
            const revision = String(counter?.value ?? 0);
            type StoredRow = { id: string; data_json: string; clock: number; deleted: number };
            const parse = (row: StoredRow): CanonicalHistoryRecord => {
                const payload = JSON.parse(row.data_json) as CanonicalHistoryRecord;
                if (row.deleted !== 1 && payload.id !== row.id) throw new Error('Canonical history identity mismatch');
                return { ...payload, id: row.id, clock: row.clock, deleted: row.deleted === 1 };
            };
            if (query.kind === 'thread') {
                const threadRevision = raw.prepare('SELECT value FROM chat_history_revisions WHERE workspace_id = ? AND thread_id = ?')
                    .get(actor.workspaceId, query.thread_id) as { value: number } | undefined;
                const row = raw.prepare('SELECT id, data_json, clock, deleted FROM s_threads WHERE workspace_id = ? AND id = ?')
                    .get(actor.workspaceId, query.thread_id) as StoredRow | undefined;
                const thread = row ? parse(row) : undefined;
                if (!thread) return { status: 'ok' as const, project_ownership: 'resolved' as const,
                    revision: String(threadRevision?.value ?? 0), thread };
                const ownership = resolveCanonicalProjectOwnership(raw, actor.workspaceId, query.thread_id, thread.project_id);
                if (ownership.status === 'unresolved') return { status: 'scope_incomplete' as const, revision: String(threadRevision?.value ?? 0) };
                return { status: 'ok' as const, project_ownership: ownership.status,
                    revision: String(threadRevision?.value ?? 0), thread: { ...thread, project_id: ownership.projectId } };
            }
            if (query.kind === 'messages') {
                if (!query.message_ids.length) return { status: 'ok' as const, revision, messages: [] };
                const rows = raw.prepare(`SELECT id, data_json, clock, deleted FROM s_messages WHERE workspace_id = ? AND id IN (${query.message_ids.map(() => '?').join(',')})`)
                    .all(actor.workspaceId, ...query.message_ids) as StoredRow[];
                return { status: 'ok' as const, revision, messages: rows.map(parse) };
            }
            let after: [number, string, string] | undefined;
            const seek = parseCanonicalChatSeek(query.cursor, query.thread_id);
            if (seek) after = seek.key;
            else if (query.cursor) {
                const value: unknown = JSON.parse(query.cursor);
                if (!Array.isArray(value) || value.length !== 4 || value[0] !== query.thread_id
                    || !Number.isSafeInteger(value[1]) || typeof value[2] !== 'string' || typeof value[3] !== 'string') throw new Error('Invalid canonical history cursor');
                after = [value[1] as number, value[2], value[3]];
            }
            const rows = raw.prepare(`SELECT id, data_json, clock, deleted FROM s_messages
                WHERE workspace_id = ? AND json_extract(data_json, '$.thread_id') = ?
                ${after ? `AND (json_extract(data_json, '$.index'), COALESCE(json_extract(data_json, '$.order_key'), ''), id) ${seek?.backward ? '<' : '>'} (?, ?, ?)` : ''}
                ORDER BY json_extract(data_json, '$.index') ${seek?.backward ? 'DESC' : 'ASC'}, COALESCE(json_extract(data_json, '$.order_key'), '') ${seek?.backward ? 'DESC' : 'ASC'}, id ${seek?.backward ? 'DESC' : 'ASC'} LIMIT ?`)
                .all(actor.workspaceId, query.thread_id, ...(after ?? []), query.limit) as StoredRow[];
            const messages = rows.map(parse); const last = messages.at(-1);
            return { status: 'ok' as const, revision, messages, next_cursor: messages.length === query.limit && last
                ? seek ? encodeCanonicalChatSeek({ ...seek, key: [Number(last.index), String(last.order_key ?? ''), last.id] })
                    : JSON.stringify([query.thread_id, last.index, last.order_key ?? '', last.id]) : undefined };
        })();
        signal?.throwIfAborted(); return result;
    }

    private assertCanonicalActor(actor: CanonicalHistoryActor): void {
        if (isD1Driver()) {
            throw Object.assign(new Error('SQLite D1 does not support background generation history v1'), { code: 'UNSUPPORTED' });
        }
        const membership = getRawDb()
            .prepare(
                `SELECT role FROM workspace_members
                 WHERE workspace_id = ? AND user_id = ?`
            )
            .get(actor.workspaceId, actor.userId) as { role: string } | undefined;
        if (!membership || (membership.role !== 'owner' && membership.role !== 'editor')) {
            throw Object.assign(new Error('Forbidden background history actor'), { code: 'FORBIDDEN' });
        }
    }

    async admitChatGeneration(
        actor: CanonicalHistoryActor,
        input: ChatGenerationAdmissionEnvelope
    ): Promise<AdmitChatGenerationResult> {
        const admission = parseRequiredHistoryAdmission(input);
        if (actor.workspaceId !== admission.workspaceId) {
            throw Object.assign(new Error('Invalid background history workspace'), { code: 'VALIDATION_ERROR' });
        }
        const raw = getRawDb();
        const fingerprint = createHash('sha256')
            .update(stableJson(admission))
            .digest('hex');
        const hookEmissions: HookEmission[] = [];
        const result = raw.transaction(() => {
            this.assertCanonicalActor(actor);
            const receipt = raw
                .prepare(
                    `SELECT fingerprint, outcome, server_version
                     FROM background_generation_receipts
                     WHERE workspace_id = ? AND generation_id = ? AND stage = 'admission'`
                )
                .get(admission.workspaceId, admission.generationId) as
                | { fingerprint: string; outcome: string; server_version: number | null }
                | undefined;
            if (receipt) {
                if (receipt.fingerprint !== fingerprint) {
                    throw Object.assign(new Error('Conflicting background admission replay'), { code: 'CONFLICT' });
                }
                return {
                    status: 'admitted' as const,
                    replayed: true,
                    serverVersion: receipt.server_version ?? 0,
                };
            }

            if (admission.kind === 'continuation') {
                const row = raw
                    .prepare(
                        `SELECT data_json, clock, deleted FROM s_messages
                         WHERE workspace_id = ? AND id = ?`
                    )
                    .get(admission.workspaceId, admission.messageId) as
                    | { data_json: string; clock: number; deleted: number }
                    | undefined;
                const generationId = row
                    ? (JSON.parse(row.data_json) as { data?: { generation_id?: unknown } })
                          .data?.generation_id
                    : undefined;
                const expectedClock = admission.expectedAssistant?.clock ?? -1;
                const admissionClock = admission.assistantMessage.clock;
                if (
                    (row && row.deleted === 1) ||
                    (row && row.clock > admissionClock) ||
                    (row && row.clock === admissionClock &&
                        generationId !== admission.generationId) ||
                    (row && row.clock > expectedClock && row.clock < admissionClock) ||
                    (row &&
                        row.clock === expectedClock &&
                        admission.expectedAssistant?.generationId !== undefined &&
                        generationId !== admission.expectedAssistant.generationId)
                ) {
                    throw Object.assign(new Error('Conflicting continuation admission'), { code: 'CONFLICT' });
                }
            }

            const records = [
                admission.thread
                    ? { table: 'threads', materialized: 's_threads', record: admission.thread }
                    : null,
                admission.userMessage
                    ? { table: 'messages', materialized: 's_messages', record: admission.userMessage }
                    : null,
                { table: 'messages', materialized: 's_messages', record: admission.assistantMessage },
            ].filter(Boolean) as Array<{
                table: 'threads' | 'messages';
                materialized: 's_threads' | 's_messages';
                record: Record<string, unknown> & { id: string; clock: number; hlc?: string };
            }>;
            const prepared = records.map(entry => {
                const opId = backgroundHistoryOpId(admission, entry.table === 'threads' ? 'thread' : entry.record.id === admission.messageId ? 'assistant' : 'user');
                const hlc = entry.record.hlc ?? `${Date.now().toString(36).padStart(9, '0')}:000:background`;
                const normalized = normalizeWirePayloadForTable(entry.table, entry.record) as Record<string, unknown>;
                const payload: Record<string, unknown> = { ...sanitizePayloadForSync(entry.table, normalized, 'put'), hlc, op_id: opId };
                if (entry.table === 'messages' && !payload.order_key) payload.order_key = hlc;
                return prepareSyncWrite({ tableName: entry.table, pk: entry.record.id, operation: 'put', payload,
                    stamp: { clock: entry.record.clock, hlc, opId, deviceId: backgroundHistoryDeviceId(admission.generationId) } });
            });
            const counter = raw
                .prepare('SELECT value FROM server_version_counter WHERE workspace_id = ?')
                .get(admission.workspaceId) as { value: number } | undefined;
            const baseVersion = counter?.value ?? 0;
            const finalVersion = safeVersionEnd(baseVersion, records.length);
            raw.prepare(
                `INSERT INTO server_version_counter (workspace_id, value) VALUES (?, ?)
                 ON CONFLICT(workspace_id) DO UPDATE SET value = excluded.value`
            ).run(admission.workspaceId, finalVersion);
            const now = nowEpoch();
            records.forEach((entry, index) => {
                const { stamp: { opId, hlc }, payload } = prepared[index]!;
                const tombstone = raw.prepare(
                    `SELECT clock, hlc, op_id FROM tombstones
                     WHERE workspace_id = ? AND table_name = ? AND pk = ?`
                ).get(
                    admission.workspaceId,
                    entry.table,
                    entry.record.id
                ) as { clock: number; hlc: string; op_id: string } | undefined;
                if (tombstone && !incomingWinsRevision(
                    { clock: entry.record.clock, hlc, opId },
                    tombstone
                )) {
                    throw Object.assign(new Error('Background history record was superseded'), { code: 'SUPERSEDED' });
                }
                const payloadJson = JSON.stringify(payload);
                const version = baseVersion + index + 1;
                raw.prepare(
                    `INSERT INTO change_log
                     (id, workspace_id, server_version, table_name, pk, op, payload_json,
                      clock, hlc, device_id, op_id, created_at)
                     VALUES (?, ?, ?, ?, ?, 'put', ?, ?, ?, ?, ?, ?)`
                ).run(
                    uid(), admission.workspaceId, version, entry.table, entry.record.id,
                    payloadJson, entry.record.clock, hlc,
                    backgroundHistoryDeviceId(admission.generationId), opId, now
                );
                const existing = raw.prepare(`SELECT 1 FROM ${entry.materialized} WHERE workspace_id = ? AND id = ?`)
                    .get(admission.workspaceId, entry.record.id);
                const materialized = raw.prepare(
                    `INSERT INTO ${entry.materialized}
                     (id, workspace_id, data_json, clock, hlc, device_id, op_id,
                      deleted, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                     ON CONFLICT(workspace_id, id) DO UPDATE SET
                       data_json = excluded.data_json, clock = excluded.clock,
                       hlc = excluded.hlc, device_id = excluded.device_id,
                       op_id = excluded.op_id, deleted = 0, updated_at = excluded.updated_at
                     WHERE ${lwwExcludedWins(entry.materialized)}`
                ).run(
                    entry.record.id, admission.workspaceId, payloadJson,
                    entry.record.clock, hlc,
                    backgroundHistoryDeviceId(admission.generationId), opId, now, now
                );
                if ((entry.table === 'threads' || entry.record.id !== admission.messageId) && !existing && materialized.changes > 0) {
                    const op = { tableName: entry.table, operation: 'put', pk: entry.record.id, payload } as PendingOp;
                    const emission = resolveHookEmission({ op, workspaceId: admission.workspaceId, now, userId: actor.userId, wasExisting: false, applied: true });
                    if (emission) hookEmissions.push(emission);
                }
            });
            const admittedAssistant = raw
                .prepare(
                    `SELECT data_json, clock, deleted FROM s_messages
                     WHERE workspace_id = ? AND id = ?`
                )
                .get(admission.workspaceId, admission.messageId) as
                | { data_json: string; clock: number; deleted: number }
                | undefined;
            const admittedPayload = admittedAssistant
                ? (JSON.parse(admittedAssistant.data_json) as Record<string, unknown>)
                : null;
            const admittedData = admittedPayload?.data &&
                typeof admittedPayload.data === 'object'
                ? admittedPayload.data as Record<string, unknown>
                : {};
            if (
                !admittedAssistant ||
                admittedAssistant.deleted === 1 ||
                admittedAssistant.clock !== admission.assistantMessage.clock ||
                admittedData.generation_id !== admission.generationId
            ) {
                throw Object.assign(new Error('Background assistant admission was superseded'), { code: 'SUPERSEDED' });
            }
            raw.prepare(
                `INSERT INTO background_generation_receipts
                 (id, workspace_id, generation_id, stage, fingerprint, outcome,
                  server_version, created_at)
                 VALUES (?, ?, ?, 'admission', ?, 'admitted', ?, ?)`
            ).run(uid(), admission.workspaceId, admission.generationId, fingerprint, finalVersion, now);
            return { status: 'admitted' as const, replayed: false, serverVersion: finalVersion };
        }).immediate();
        for (const emission of hookEmissions) {
            try {
                await emitWebhookSystemHook(emission.hookName, emission.payload);
            } catch (error) {
                console.error('[or3-sqlite] Background admission hook failed', error);
            }
        }
        return result;
    }

    async finalizeChatGeneration(
        actor: CanonicalHistoryActor,
        input: {
            admission: ChatGenerationAdmissionEnvelope;
            snapshot: CanonicalGenerationSnapshot;
        }
    ): Promise<FinalizeChatGenerationResult> {
        const admission = parseRequiredHistoryAdmission(input.admission);
        if (actor.workspaceId !== admission.workspaceId) {
            throw Object.assign(new Error('Invalid background history workspace'), { code: 'VALIDATION_ERROR' });
        }
        const raw = getRawDb();
        // Preconditions may change on replay; the admission and result may not.
        const fingerprint = backgroundFinalizationFingerprint(input);
        return raw.transaction(() => {
            this.assertCanonicalActor(actor);
            const receipt = raw
                .prepare(
                    `SELECT fingerprint, outcome, server_version
                     FROM background_generation_receipts
                     WHERE workspace_id = ? AND generation_id = ? AND stage = 'finalization'`
                )
                .get(admission.workspaceId, admission.generationId) as
                | { fingerprint: string; outcome: string; server_version: number | null }
                | undefined;
            if (receipt) {
                if (receipt.fingerprint !== fingerprint) {
                    throw Object.assign(new Error('Conflicting background finalization replay'), { code: 'CONFLICT' });
                }
                return receipt.outcome === 'committed'
                    ? {
                          status: 'committed' as const,
                          replayed: true,
                          serverVersion: receipt.server_version ?? 0,
                      }
                    : {
                          status: 'superseded' as const,
                          reason: receipt.outcome as 'deleted' | 'newer_generation' | 'edited' | 'missing',
                      };
            }
            if (input.snapshot.expectedWorkspaceRevision !== undefined) {
                const expected = input.snapshot.expectedWorkspaceRevision;
                if (typeof expected !== 'string' || !/^(0|[1-9][0-9]*)$/.test(expected) || expected.length > 16)
                    throw Object.assign(new Error('Invalid terminal delegation revision'), { code: 'VALIDATION_ERROR' });
                const current = raw.prepare('SELECT value FROM server_version_counter WHERE workspace_id = ?')
                    .get(admission.workspaceId) as { value: number } | undefined;
                if (String(current?.value ?? 0) !== expected)
                    throw Object.assign(new Error('Canonical history changed during delegation finalization'), { code: 'ERR_DELEGATION_HISTORY_REVISION', retryable: true });
            }
            const thread = raw.prepare('SELECT deleted FROM s_threads WHERE workspace_id = ? AND id = ?')
                .get(admission.workspaceId, admission.threadId) as { deleted: number } | undefined;
            const threadUnavailable = !thread || !!thread.deleted;
            if (input.snapshot.onlyIfThreadUnavailable !== undefined && input.snapshot.onlyIfThreadUnavailable !== true)
                throw Object.assign(new Error('Invalid thread precondition'), { code: 'VALIDATION_ERROR' });
            if (input.snapshot.onlyIfThreadUnavailable && !threadUnavailable)
                throw Object.assign(new Error('Canonical thread is available again'), { code: 'ERR_DELEGATION_HISTORY_REVISION', retryable: true });
            const row = raw
                .prepare(
                    `SELECT data_json, clock, deleted FROM s_messages
                     WHERE workspace_id = ? AND id = ?`
                )
                .get(admission.workspaceId, admission.messageId) as
                | { data_json: string; clock: number; deleted: number }
                | undefined;
            const current = row ? (JSON.parse(row.data_json) as Record<string, unknown>) : null;
            const data = current?.data && typeof current.data === 'object'
                ? (current.data as Record<string, unknown>)
                : {};
            let superseded: 'deleted' | 'newer_generation' | 'edited' | 'missing' | null = null;
            if (threadUnavailable) superseded = 'deleted';
            else if (!row || !current) superseded = 'missing';
            else if (row.deleted === 1 || current.deleted === true) superseded = 'deleted';
            else if (data.generation_id !== admission.generationId) superseded = 'newer_generation';
            else if (row.clock !== admission.assistantMessage.clock) superseded = 'edited';
            const now = nowEpoch();
            if (superseded) {
                raw.prepare(
                    `INSERT INTO background_generation_receipts
                     (id, workspace_id, generation_id, stage, fingerprint, outcome,
                      server_version, created_at)
                     VALUES (?, ?, ?, 'finalization', ?, ?, NULL, ?)`
                ).run(uid(), admission.workspaceId, admission.generationId, fingerprint, superseded, now);
                return { status: 'superseded' as const, reason: superseded };
            }
            const nextClock = nextSyncClock(row!.clock);
            const hlc = `${Date.now().toString(36).padStart(9, '0')}:000:background`;
            const opId = backgroundHistoryOpId(admission, 'finalize');
            const terminalState = input.snapshot.status === 'complete'
                ? 'complete'
                : input.snapshot.status === 'aborted'
                  ? 'aborted'
                  : 'failed';
            const usage = readRequestUsage(input.snapshot.usage);
            const payload = {
                ...current!,
                pending: false,
                error: input.snapshot.error ?? null,
                updated_at: Math.floor(input.snapshot.completedAt / 1000),
                clock: nextClock,
                hlc,
                op_id: opId,
                data: {
                    ...data,
                    ...(usage ? { usage } : {}),
                    content: input.snapshot.content,
                    reasoning_text: input.snapshot.reasoning || null,
                    tool_calls: input.snapshot.toolCalls ?? null,
                    generation_state: terminalState,
                    background_job_status: input.snapshot.status,
                    background_job_error: input.snapshot.error ?? null,
                    error: input.snapshot.error ?? null,
                },
            };
            const finalPayload = normalizeWirePayloadForTable('messages', payload) as Record<string, unknown>;
            if (!finalPayload.order_key) finalPayload.order_key = hlc;
            const prepared = prepareSyncWrite({ tableName: 'messages', pk: admission.messageId, operation: 'put', payload: finalPayload,
                stamp: { clock: nextClock, hlc, opId, deviceId: backgroundHistoryDeviceId(admission.generationId) } });
            const payloadJson = JSON.stringify(prepared.payload);
            const counter = raw
                .prepare('SELECT value FROM server_version_counter WHERE workspace_id = ?')
                .get(admission.workspaceId) as { value: number } | undefined;
            const serverVersion = safeVersionEnd(counter?.value ?? 0, 1);
            raw.prepare(
                `INSERT INTO server_version_counter (workspace_id, value) VALUES (?, ?)
                 ON CONFLICT(workspace_id) DO UPDATE SET value = excluded.value`
            ).run(admission.workspaceId, serverVersion);
            raw.prepare(
                `UPDATE s_messages SET data_json = ?, clock = ?, hlc = ?, device_id = ?,
                    op_id = ?, deleted = 0, updated_at = ?
                 WHERE workspace_id = ? AND id = ?`
            ).run(
                payloadJson, nextClock, hlc,
                backgroundHistoryDeviceId(admission.generationId), opId, now,
                admission.workspaceId, admission.messageId
            );
            raw.prepare(
                `INSERT INTO change_log
                 (id, workspace_id, server_version, table_name, pk, op, payload_json,
                  clock, hlc, device_id, op_id, created_at)
                 VALUES (?, ?, ?, 'messages', ?, 'put', ?, ?, ?, ?, ?, ?)`
            ).run(
                uid(), admission.workspaceId, serverVersion, admission.messageId,
                payloadJson, nextClock, hlc,
                backgroundHistoryDeviceId(admission.generationId), opId, now
            );
            raw.prepare(
                `INSERT INTO background_generation_receipts
                 (id, workspace_id, generation_id, stage, fingerprint, outcome,
                  server_version, created_at)
                 VALUES (?, ?, ?, 'finalization', ?, 'committed', ?, ?)`
            ).run(uid(), admission.workspaceId, admission.generationId, fingerprint, serverVersion, now);
            return { status: 'committed' as const, replayed: false, serverVersion };
        }).immediate();
    }

    private assertRetainedToolParent(actor: CanonicalHistoryActor, admission: ChatGenerationAdmissionEnvelope): void {
        if (actor.workspaceId !== admission.workspaceId) throw Object.assign(new Error('Invalid tool result workspace'), { code: 'VALIDATION_ERROR' });
        this.assertCanonicalActor(actor);
        const raw = getRawDb();
        const receipt = raw.prepare(`SELECT fingerprint, outcome FROM background_generation_receipts
            WHERE workspace_id = ? AND generation_id = ? AND stage = 'admission'`)
            .get(admission.workspaceId, admission.generationId) as { fingerprint: string; outcome: string } | undefined;
        const fingerprint = createHash('sha256').update(stableJson(admission)).digest('hex');
        const thread = raw.prepare('SELECT deleted FROM s_threads WHERE workspace_id = ? AND id = ?')
            .get(admission.workspaceId, admission.threadId) as { deleted: number } | undefined;
        const assistant = raw.prepare('SELECT data_json, clock, deleted FROM s_messages WHERE workspace_id = ? AND id = ?')
            .get(admission.workspaceId, admission.messageId) as { data_json: string; clock: number; deleted: number } | undefined;
        const message = assistant ? JSON.parse(assistant.data_json) as { thread_id?: unknown; pending?: unknown; deleted?: unknown; data?: { generation_id?: unknown } } : undefined;
        if (!receipt || receipt.outcome !== 'admitted' || receipt.fingerprint !== fingerprint || !thread || thread.deleted ||
            !assistant || assistant.deleted || assistant.clock !== admission.assistantMessage.clock ||
            !message || message.thread_id !== admission.threadId || message.deleted === true || message.pending !== true || message.data?.generation_id !== admission.generationId)
            throw Object.assign(new Error('Tool result parent history is unavailable'), { code: 'SUPERSEDED' });
    }

    /** Persist immutable tool-result chunks and their sync changes in one workspace transaction. */
    async retainChatToolResult(
        actor: CanonicalHistoryActor,
        input: { admission: ChatGenerationAdmissionEnvelope; callId: string; reference: string; rows: ToolResultArtifactRow[] },
    ): Promise<void> {
        const admission = parseRequiredHistoryAdmission(input.admission);
        if (isD1Driver()) throw Object.assign(new Error('SQLite D1 does not support tool result retention'), { code: 'UNSUPPORTED' });
        if (actor.workspaceId !== admission.workspaceId || typeof input.callId !== 'string' || !input.callId ||
            new TextEncoder().encode(input.callId).length > 512 || !Array.isArray(input.rows) ||
            !input.rows.length || input.rows.length > 32 || typeof input.reference !== 'string' || input.reference.length > 2048 ||
            input.rows.some(row => !row || typeof row.value !== 'string' || new TextEncoder().encode(row.value).length > 64 * 1024 ||
                row.clock !== 1 || row.deleted !== false || !Number.isSafeInteger(row.created_at) || row.created_at < 0 ||
                !Number.isSafeInteger(row.updated_at) || row.updated_at < 0))
            throw Object.assign(new Error('Invalid tool result retention'), { code: 'VALIDATION_ERROR' });
        const content = input.rows.map(row => row.value).join('');
        if (new TextEncoder().encode(content).length > 256 * 1024)
            throw Object.assign(new Error('Invalid tool result size'), { code: 'VALIDATION_ERROR' });
        const expected = await prepareToolResultStorage(content, { threadId: admission.threadId,
            parentAssistantId: admission.messageId, callId: input.callId });
        if (expected.result !== input.reference || expected.rows.length !== input.rows.length || expected.rows.some((row, index) =>
            row.id !== input.rows[index]?.id || row.name !== input.rows[index]?.name || row.value !== input.rows[index]?.value))
            throw Object.assign(new Error('Invalid tool result identity'), { code: 'VALIDATION_ERROR' });
        const raw = getRawDb();
        raw.transaction(() => {
            this.assertRetainedToolParent(actor, admission);
            const newRows: ToolResultArtifactRow[] = [];
            for (const row of input.rows) {
                const tombstone = raw.prepare("SELECT 1 FROM tombstones WHERE workspace_id = ? AND table_name = 'kv' AND pk = ?")
                    .get(admission.workspaceId, row.id);
                const existing = raw.prepare('SELECT data_json, deleted, clock FROM s_kv WHERE workspace_id = ? AND id = ?')
                    .get(admission.workspaceId, row.id) as { data_json: string; deleted: number; clock: number } | undefined;
                if (tombstone || existing?.deleted) throw Object.assign(new Error('Tool result was deleted'), { code: 'SUPERSEDED' });
                if (existing) {
                    const stored = JSON.parse(existing.data_json) as { id?: unknown; name?: unknown; value?: unknown; deleted?: unknown };
                    if (existing.clock !== row.clock || stored.deleted === true || stored.id !== row.id || stored.name !== row.name || stored.value !== row.value)
                        throw Object.assign(new Error('Conflicting tool result retention'), { code: 'CONFLICT' });
                } else newRows.push(row);
            }
            if (!newRows.length) return;
            const prepared = newRows.map(row => {
                const opId = digestUuid(createHash('sha256').update(JSON.stringify([admission.workspaceId, admission.generationId, row.id])).digest('hex'));
                const hlc = `${Date.now().toString(36).padStart(9, '0')}:000:background`;
                return prepareSyncWrite({ tableName: 'kv', pk: row.id, operation: 'put',
                    payload: { ...sanitizePayloadForSync('kv', row, 'put'), hlc, op_id: opId },
                    stamp: { clock: row.clock, hlc, opId, deviceId: backgroundHistoryDeviceId(admission.generationId) } });
            });
            const counter = raw.prepare('SELECT value FROM server_version_counter WHERE workspace_id = ?')
                .get(admission.workspaceId) as { value: number } | undefined;
            const baseVersion = counter?.value ?? 0;
            raw.prepare(`INSERT INTO server_version_counter (workspace_id, value) VALUES (?, ?)
                ON CONFLICT(workspace_id) DO UPDATE SET value = excluded.value`).run(admission.workspaceId, safeVersionEnd(baseVersion, newRows.length));
            const now = nowEpoch();
            newRows.forEach((row, index) => {
                const { stamp: { opId, hlc }, payload } = prepared[index]!;
                const payloadJson = JSON.stringify(payload);
                raw.prepare(`INSERT INTO s_kv (id, workspace_id, data_json, clock, hlc, device_id, op_id, deleted, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(row.id, admission.workspaceId, payloadJson, row.clock, hlc,
                        backgroundHistoryDeviceId(admission.generationId), opId, now, now);
                raw.prepare(`INSERT INTO change_log (id, workspace_id, server_version, table_name, pk, op, payload_json,
                    clock, hlc, device_id, op_id, created_at) VALUES (?, ?, ?, 'kv', ?, 'put', ?, ?, ?, ?, ?, ?)`)
                    .run(uid(), admission.workspaceId, baseVersion + index + 1, row.id, payloadJson, row.clock, hlc,
                        backgroundHistoryDeviceId(admission.generationId), opId, now);
            });
        }).immediate();
    }

    /** Resolve one bounded artifact in a single authorized canonical snapshot. */
    async readChatToolResult(
        actor: CanonicalHistoryActor,
        input: { admission: ChatGenerationAdmissionEnvelope; callId: string; reference: string },
    ): Promise<string> {
        const admission = parseRequiredHistoryAdmission(input.admission);
        if (isD1Driver()) throw Object.assign(new Error('SQLite D1 does not support tool result retention'), { code: 'UNSUPPORTED' });
        if (typeof input.callId !== 'string' || !input.callId || new TextEncoder().encode(input.callId).length > 512 ||
            typeof input.reference !== 'string' || input.reference.length > 2048)
            throw Object.assign(new Error('Invalid tool result reference'), { code: 'VALIDATION_ERROR' });
        const manifest = parseToolResultArtifact(input.reference);
        if (!manifest || manifest.threadId !== admission.threadId)
            throw Object.assign(new Error('Invalid tool result reference'), { code: 'VALIDATION_ERROR' });
        const raw = getRawDb();
        return raw.transaction(() => {
            this.assertRetainedToolParent(actor, admission);
            const parts: string[] = [];
            for (let index = 0; index < manifest.parts; index++) {
                const id = `tool-result:${manifest.id}:${index}`;
                const row = raw.prepare('SELECT data_json, deleted, clock FROM s_kv WHERE workspace_id = ? AND id = ?')
                    .get(admission.workspaceId, id) as { data_json: string; deleted: number; clock: number } | undefined;
                let value: { id?: unknown; name?: unknown; value?: unknown; deleted?: unknown } | undefined;
                try { value = row && JSON.parse(row.data_json); }
                catch { throw Object.assign(new Error('Tool result is unavailable or corrupt'), { code: 'TOOL_RESULT_UNAVAILABLE' }); }
                if (!row || row.deleted || row.clock !== 1 || !value || value.deleted === true || value.id !== id ||
                    value.name !== `${toolResultArtifactPrefix(admission.threadId)}${manifest.id}:${index}` ||
                    typeof value.value !== 'string' || new TextEncoder().encode(value.value).length > 64 * 1024)
                    throw Object.assign(new Error('Tool result is unavailable or corrupt'), { code: 'TOOL_RESULT_UNAVAILABLE' });
                parts.push(value.value);
            }
            const result = parts.join('');
            if (!matchesToolResultStorage(input.reference, result, { threadId: admission.threadId,
                parentAssistantId: admission.messageId, callId: input.callId }))
                throw Object.assign(new Error('Tool result is unavailable or corrupt'), { code: 'TOOL_RESULT_UNAVAILABLE' });
            return result;
        }).immediate();
    }

    async reserveUploadIntent(
        event: H3Event,
        input: UploadIntentReservationRequest
    ): Promise<void> {
        await assertWorkspaceScopeAuthorized(event, input.workspaceId);
        if (!input.intentId || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 ||
            !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= nowEpoch()) {
            throw createError({ statusCode: 400, statusMessage: 'Invalid upload intent' });
        }
        if (input.workspaceQuotaBytes !== undefined &&
            (!Number.isSafeInteger(input.workspaceQuotaBytes) || input.workspaceQuotaBytes < 1)) {
            throw createError({ statusCode: 400, statusMessage: 'Invalid workspace quota' });
        }
        const hash = normalizeStorageHash(input.hash);
        if (isD1Driver()) {
            return this.reserveUploadIntentInD1(input, hash);
        }
        const raw = getRawDb();
        raw.transaction(() => {
            const now = nowEpoch();
            raw.prepare(`UPDATE upload_intents SET status = 'expired'
                WHERE workspace_id = ? AND status = 'active' AND expires_at <= ?`)
                .run(input.workspaceId, now);
            const usedBytes = (raw.prepare('SELECT used_bytes FROM storage_usage WHERE workspace_id = ?')
                .get(input.workspaceId) as { used_bytes: number } | undefined)?.used_bytes ?? 0;
            const retainedBytes = (raw.prepare('SELECT size_bytes FROM retained_storage WHERE workspace_id = ? AND hash = ?')
                .get(input.workspaceId, hash) as { size_bytes: number } | undefined)?.size_bytes ?? 0;
            const totals = raw.prepare(`WITH pending AS (${QUOTA_RESERVATIONS_SQL}) SELECT
                    COALESCE(SUM(held_bytes), 0) AS reserved_bytes,
                    COALESCE(MAX(CASE WHEN hash = ? THEN reserved_bytes END), 0) AS same_hash
                FROM pending`)
                .get(input.workspaceId, now, hash) as { reserved_bytes: number; same_hash: number };
            const addedBytes = Math.max(0, input.sizeBytes - Math.max(retainedBytes, totals.same_hash));
            if (input.workspaceQuotaBytes !== undefined &&
                usedBytes + totals.reserved_bytes + addedBytes > input.workspaceQuotaBytes) {
                throw createError({ statusCode: 413, statusMessage: 'Workspace storage quota exceeded' });
            }
            raw.prepare(`INSERT INTO upload_intents (
                    id, workspace_id, hash, mime_type, size_bytes, reserved_bytes,
                    expires_at, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
                .run(input.intentId, input.workspaceId, hash, input.mimeType, input.sizeBytes,
                    input.sizeBytes, input.expiresAt, now);
        })();
    }

    async consumeUploadIntent(event: H3Event, input: UploadIntentConsumptionRequest): Promise<void> {
        await assertWorkspaceScopeAuthorized(event, input.workspaceId);
        const now = nowEpoch();
        const hash = normalizeStorageHash(input.hash);
        const raw = isD1Driver() ? null : getRawDb();
        const sql = `UPDATE upload_intents
            SET status = 'consumed', storage_id = ?, consumed_at = ?
            WHERE id = ? AND workspace_id = ? AND status = 'active' AND expires_at > ?
              AND hash = ? AND mime_type = ? AND size_bytes = ?`;
        const parameters = [input.storageId, now, input.intentId, input.workspaceId, now,
            hash, input.mimeType, input.sizeBytes];
        const changes = raw
            ? raw.prepare(sql).run(...parameters).changes
            : (await d1Run(sql, ...parameters)).meta?.changes;
        if (changes === 1) return;

        // The durable consumed tuple is the receipt for interrupted storage
        // commits. Replays never rewrite its timestamp or grant another object.
        const receiptSql = `SELECT 1 FROM upload_intents
            WHERE id = ? AND workspace_id = ? AND status = 'consumed' AND expires_at > ?
              AND hash = ? AND mime_type = ? AND size_bytes = ? AND storage_id = ?`;
        const receiptParameters = [input.intentId, input.workspaceId, now, hash,
            input.mimeType, input.sizeBytes, input.storageId];
        const receipt = raw
            ? raw.prepare(receiptSql).get(...receiptParameters)
            : (await d1All(receiptSql, ...receiptParameters))[0];
        if (!receipt) {
            throw createError({ statusCode: 409, statusMessage: 'Upload intent expired, mismatched, or already consumed' });
        }
    }

    async cancelUploadIntent(
        event: H3Event,
        input: { workspaceId: string; intentId: string }
    ): Promise<void> {
        await assertWorkspaceScopeAuthorized(event, input.workspaceId);
        if (isD1Driver()) {
            const result = await d1Run(
                `UPDATE upload_intents SET status = 'cancelled', cancelled_at = ?
                 WHERE id = ? AND workspace_id = ? AND status = 'active'`,
                nowEpoch(),
                input.intentId,
                input.workspaceId
            );
            if ((result.meta?.changes ?? 0) !== 1) {
                throw createError({ statusCode: 409, statusMessage: 'Upload intent is not active' });
            }
            return;
        }
        const result = getRawDb().prepare(`UPDATE upload_intents
            SET status = 'cancelled', cancelled_at = ?
            WHERE id = ? AND workspace_id = ? AND status = 'active'`)
            .run(nowEpoch(), input.intentId, input.workspaceId);
        if (result.changes !== 1) {
            throw createError({ statusCode: 409, statusMessage: 'Upload intent is not active' });
        }
    }

    async queryCanonicalStorage(
        event: H3Event,
        input: CanonicalStorageQueryRequest
    ): Promise<CanonicalStorageQueryResponse> {
        const workspaceId = input.scope.workspaceId;
        await assertWorkspaceScopeAuthorized(event, workspaceId);

        const limit = resolveCanonicalStorageLimit(input.limit);
        const hash = input.hash === undefined ? undefined : normalizeStorageHash(input.hash);
        if (input.hash !== undefined && !hash) {
            throw createError({ statusCode: 400, statusMessage: 'Invalid storage hash' });
        }
        const after = decodeCanonicalStorageCursor(input.cursor, input.kind, hash);
        const raw = isD1Driver() ? null : getRawDb();
        const all = async <T>(sql: string, ...parameters: unknown[]): Promise<T[]> =>
            raw
                ? raw.prepare(sql).all(...parameters) as T[]
                : d1All<T>(sql, ...parameters);

        if (input.kind === 'active_reservations') {
            if (after.length > 1) {
                throw createError({ statusCode: 400, statusMessage: 'Invalid canonical storage cursor' });
            }
            const now = input.now ?? nowEpoch();
            const rows = await all<{
                id: string; hash: string; reserved_bytes: number; expires_at: number;
            }>(`WITH pending AS (${PENDING_UPLOAD_RESERVATIONS_SQL})
                SELECT id, hash, reserved_bytes, expires_at FROM pending
                WHERE id > ? AND (? IS NULL OR hash = ?)
                ORDER BY id ASC LIMIT ?`, workspaceId, now, after[0] ?? '', hash ?? null, hash ?? null, limit + 1);
            const hasMore = rows.length > limit;
            const page = hasMore ? rows.slice(0, limit) : rows;
            const last = page[page.length - 1];
            return {
                items: page.map((row) => ({
                    kind: 'reservation' as const,
                    reservationId: row.id,
                    hash: row.hash,
                    sizeBytes: row.reserved_bytes,
                    expiresAt: row.expires_at,
                })),
                hasMore,
                ...(hasMore && last ? { nextCursor: encodeCanonicalStorageCursor({
                    version: 1, kind: input.kind, hash, key: [last.id],
                }) } : {}),
            };
        }

        if (input.kind === 'live_metadata' || input.kind === 'retained_metadata') {
            const retained = input.kind === 'retained_metadata';
            if (after.length > 1) {
                throw createError({ statusCode: 400, statusMessage: 'Invalid canonical storage cursor' });
            }
            const rows = await all<{
                id: string;
                data_json: string;
                updated_at: number;
            }>(`
                SELECT id, data_json, updated_at
                FROM s_file_meta
                WHERE workspace_id = ?
                  AND deleted = ?
                  AND id > ?
                  AND (? IS NULL OR lower(
                    CASE
                      WHEN instr(trim(id), ':') > 0
                      THEN substr(trim(id), instr(trim(id), ':') + 1)
                      ELSE trim(id)
                    END
                  ) = ?)
                ORDER BY id ASC
                LIMIT ?
            `, workspaceId, retained ? 1 : 0, after[0] ?? '', hash ?? null, hash ?? null, limit + 1);

            const hasMore = rows.length > limit;
            const page = hasMore ? rows.slice(0, limit) : rows;
            const items = page.map((row) => {
                let payload: Record<string, unknown>;
                try {
                    payload = JSON.parse(row.data_json) as Record<string, unknown>;
                } catch {
                    throw createError({ statusCode: 500, statusMessage: 'Invalid canonical file metadata' });
                }
                const size = payload.size_bytes ?? payload.sizeBytes;
                const missingSize = !('size_bytes' in payload) && !('sizeBytes' in payload);
                if (!(retained && missingSize) &&
                    (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)) {
                    throw createError({ statusCode: 500, statusMessage: 'Invalid canonical file size' });
                }
                const storageId = payload.storage_id ?? payload.storageId;
                const fileKind =
                    payload.kind === 'image'
                        ? ('image' as const)
                        : payload.kind === 'pdf'
                          ? ('pdf' as const)
                          : payload.kind === 'file'
                            ? ('file' as const)
                            : undefined;
                const metadata = {
                    hash: normalizeStorageHash(row.id),
                    ...(typeof storageId === 'string' && storageId ? { storageId } : {}),
                    ...(typeof (payload.mime_type ?? payload.mimeType) === 'string'
                        ? { mimeType: String(payload.mime_type ?? payload.mimeType) }
                        : {}),
                    ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
                    ...(fileKind ? { fileKind } : {}),
                    updatedAt: row.updated_at,
                };
                return retained
                    ? { ...metadata, kind: 'retained_metadata' as const,
                        ...(typeof size === 'number' ? { sizeBytes: size } : {}) }
                    : { ...metadata, kind: 'metadata' as const, sizeBytes: size as number };
            });
            const last = page[page.length - 1];
            return {
                items,
                hasMore,
                ...(hasMore && last
                    ? {
                          nextCursor: encodeCanonicalStorageCursor({
                              version: 1,
                              kind: input.kind,
                              hash,
                              key: [last.id],
                          }),
                      }
                    : {}),
            };
        }

        if (after.length !== 0 && after.length !== 3) {
            throw createError({ statusCode: 400, statusMessage: 'Invalid canonical storage cursor' });
        }
        const [afterTable = '', afterId = '', afterHash = ''] = after;
        const rows = await all<{
            source_table: 'messages' | 'posts';
            source_id: string;
            raw_hash: string;
            normalized_hash: string;
        }>(`
            WITH reference_edges(source_table, source_id, raw_hash) AS (
                SELECT 'messages', row.id, CAST(edge.value AS TEXT)
                FROM s_messages AS row
                JOIN json_each(
                    CASE
                      WHEN json_valid(json_extract(row.data_json, '$.file_hashes'))
                      THEN json_extract(row.data_json, '$.file_hashes')
                      ELSE '[]'
                    END
                ) AS edge
                WHERE row.workspace_id = ? AND row.deleted = 0 AND edge.type = 'text'
                UNION ALL
                SELECT 'posts', row.id, CAST(edge.value AS TEXT)
                FROM s_posts AS row
                JOIN json_each(
                    CASE
                      WHEN json_valid(json_extract(row.data_json, '$.file_hashes'))
                      THEN json_extract(row.data_json, '$.file_hashes')
                      ELSE '[]'
                    END
                ) AS edge
                WHERE row.workspace_id = ? AND row.deleted = 0 AND edge.type = 'text'
            ), normalized_edges AS (
                SELECT source_table, source_id, raw_hash, lower(
                    CASE
                      WHEN instr(trim(raw_hash), ':') > 0
                      THEN substr(trim(raw_hash), instr(trim(raw_hash), ':') + 1)
                      ELSE trim(raw_hash)
                    END
                ) AS normalized_hash
                FROM reference_edges
            )
            SELECT source_table, source_id, raw_hash, normalized_hash
            FROM normalized_edges
            WHERE normalized_hash <> ''
              AND (? IS NULL OR normalized_hash = ?)
              AND (
                source_table > ? OR
                (source_table = ? AND source_id > ?) OR
                (source_table = ? AND source_id = ? AND raw_hash > ?)
              )
            ORDER BY source_table ASC, source_id ASC, raw_hash ASC
            LIMIT ?
        `,
            workspaceId,
            workspaceId,
            hash ?? null,
            hash ?? null,
            afterTable,
            afterTable,
            afterId,
            afterTable,
            afterId,
            afterHash,
            limit + 1
        );

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];
        return {
            items: page.map((row) => ({
                kind: 'reference' as const,
                hash: row.normalized_hash,
                sourceTable: row.source_table,
                sourceId: row.source_id,
            })),
            hasMore,
            ...(hasMore && last
                ? {
                      nextCursor: encodeCanonicalStorageCursor({
                          version: 1,
                          kind: input.kind,
                          hash,
                          key: [last.source_table, last.source_id, last.raw_hash],
                      }),
                  }
                : {}),
        };
    }

    async push(event: H3Event, input: ExplorerRequest<PushBatch>, repair?: RepairGuard): Promise<PushResult> {
        const { scope, ops } = input;
        const workspaceId = scope.workspaceId;
        await assertWorkspaceScopeAuthorized(event, workspaceId);

        const historyIncarnation = await this.checkHistory(event, input);
        if (!ops.length) {
            return { results: [], serverVersion: 0, historyIncarnation };
        }

        const userId = resolveSessionUserId(event);

        const resultSlots: Array<PushResult['results'][number] | undefined> =
            new Array(ops.length);
        const groups = new Map<string, {
            op: PendingOp;
            fingerprint: string;
            indices: number[];
            conflicting: boolean;
        }>();
        ops.forEach((op, index) => {
            const fingerprint = operationFingerprint(op);
            const group = groups.get(op.stamp.opId);
            if (!group) {
                groups.set(op.stamp.opId, {
                    op,
                    fingerprint,
                    indices: [index],
                    conflicting: false,
                });
                return;
            }
            group.indices.push(index);
            if (group.fingerprint !== fingerprint) group.conflicting = true;
        });

        const uniqueOps: PendingOp[] = [];
        const indicesByOpId = new Map<string, number[]>();
        for (const group of groups.values()) {
            const scoped = group.conflicting
                ? group.op
                : scopeNotificationWrite(group.op, userId);
            const error = group.conflicting
                ? `Conflicting operations reuse op_id ${group.op.stamp.opId}`
                : typeof scoped === 'string'
                    ? scoped
                    : validatePushOperation(workspaceId, scoped);
            if (error) {
                for (const index of group.indices) {
                    resultSlots[index] = {
                        opId: group.op.stamp.opId,
                        success: false,
                        error,
                        errorCode: group.conflicting
                            ? 'CONFLICT'
                            : error.startsWith('Unauthorized') ||
                                error.startsWith('Forbidden')
                                ? 'UNAUTHORIZED'
                                : 'VALIDATION_ERROR',
                    };
                }
                continue;
            }
            uniqueOps.push({ ...(scoped as PendingOp) });
            indicesByOpId.set(group.op.stamp.opId, group.indices);
        }

        if (isD1Driver()) {
            if (uniqueOps.some(op => hasExplorerSemantics(op.tableName, op.pk, op.payload))) {
                throw createError({ statusCode: 503, statusMessage: 'Workspace folders are unavailable on this provider' });
            }
            return this.pushInD1({
                event,
                workspaceId,
                uniqueOps,
                resultSlots,
                indicesByOpId,
                userId,
                workspaceItemCapability: input.workspaceItemCapability,
                storedRecordCapability: input.storedRecordCapability,
                historyIncarnation,
                repair,
            });
        }

        // Use raw better-sqlite3 transaction for BEGIN IMMEDIATE semantics
        const raw = getRawDb();
        const now = nowEpoch();

        const uniqueResults: PushResult['results'] = [];
        let finalServerVersion = 0;
        const hookEmissions: HookEmission[] = [];

        const runTx = raw.transaction(() => {
            const current = raw.prepare('SELECT incarnation FROM sync_history WHERE id=1').get() as {incarnation:string} | undefined;
            if (current?.incarnation !== historyIncarnation) {
                if (!validHistoryIncarnation(current?.incarnation)) throw new Error('Invalid sync history singleton');
                historyChanged(current.incarnation);
            }
            if (repair) {
                const assertion = repairAssertion(repair);
                raw.prepare(assertion.sql).get(...assertion.parameters ?? []);
            }
            for (const op of uniqueOps) {
                if (op.tableName !== 'posts') continue;
                const canonical = raw.prepare(`SELECT CASE WHEN json_valid(data_json) THEN ${boundedSyncPayload('data_json')} END AS data_json
                    FROM s_posts WHERE id = ? AND workspace_id = ?`).get(op.pk, workspaceId) as { data_json: string | null } | undefined;
                const stored: unknown = canonical?.data_json ? JSON.parse(canonical.data_json) : undefined;
                if (!hasExplorerSemantics(op.tableName, op.pk, op.payload) && !hasExplorerSemantics(op.tableName, op.pk, stored)) continue;
                assertExplorerPage(input.explorerCapability, [op], [{ tableName: op.tableName, pk: op.pk, payload: stored }]);
                const member = raw.prepare(`SELECT m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
                    WHERE m.workspace_id = ? AND m.user_id = ? AND COALESCE(w.deleted, 0) = 0`)
                    .get(workspaceId, userId ?? '') as { role: string } | undefined;
                if (member?.role !== 'owner' && member?.role !== 'editor') {
                    throw createError({ statusCode: 403, statusMessage: 'Workspace write permission required' });
                }
                const identity = explorerMutationIdentity(op.tableName, op.pk, op.operation, op.payload, stored);
                if ((canonical && stored === undefined) || !identity.valid || [identity.incoming, identity.existing].some(value =>
                    value && !explorerIdentityMatches(op.pk, value, value.hashInput && createHash('sha256').update(value.hashInput).digest('hex')))) {
                    throw createError({ statusCode: 400, statusMessage: 'Invalid workspace folder record' });
                }
            }
            const existingOps = new Map<string, StoredReceipt & {fingerprint:string}>();
            const failedBeforeAlloc = new Set<string>();
            for (const op of uniqueOps) {
                try {
                    const receipt = raw.prepare(`SELECT ${RECEIPT_COLUMNS} FROM change_log WHERE op_id=?`).get(op.stamp.opId) as StoredReceipt|undefined;
                    if (receipt) {
                        const fingerprint = receipt.workspace_id === workspaceId ? receiptFingerprint(receipt) : '';
                        existingOps.set(op.stamp.opId,{...receipt,fingerprint});
                        if (receipt.workspace_id !== workspaceId) continue;
                    }
                    if (receipt && existingOps.get(op.stamp.opId)!.fingerprint !== operationFingerprint(op)) continue;
                    if (!repair && !currentWinnerNative(raw,workspaceId,op.tableName,op.pk) && receipt) throw new StoredRecordUnavailable(storedReceiptSource(receipt),'stored_winner_missing');
                } catch (error) {
                    if (!(error instanceof StoredRecordUnavailable)) throw error;
                    if (error.revision && op.tableName !== 'notifications' && incomingWinsRevision(op.stamp,error.revision)) {
                        const statement = evidenceInsert({...error.source,historyIncarnation},error.reason);
                        raw.prepare(statement.sql).run(...statement.parameters!);
                        continue;
                    }
                    uniqueResults.push(retainPushFailureNative(op,error,input)); failedBeforeAlloc.add(op.stamp.opId);
                }
            }
            // Admission observes canonical state under the same write lock as LWW.
            if (input.workspaceItemCapability !== WORKSPACE_ITEM_CAPABILITY) {
                for (const op of uniqueOps) {
                    if (failedBeforeAlloc.has(op.stamp.opId)) continue;
                    const table = SYNCED_TABLE_MAP[op.tableName];
                    if (!table || !['posts', 'projects'].includes(op.tableName)) continue;
                    const canonical = raw.prepare(`SELECT CASE WHEN json_valid(data_json) THEN ${boundedSyncPayload('data_json')} END AS data_json FROM ${table} WHERE id = ? AND workspace_id = ?`)
                        .get(op.pk, workspaceId) as { data_json: string } | undefined;
                    if (hasWorkspaceItemSemantics(op.tableName, op.payload)
                        || hasWorkspaceItemSemantics(op.tableName, canonical?.data_json ? JSON.parse(canonical.data_json) : undefined)) {
                        throw workspaceItemUpdateRequired();
                    }
                }
            }
            for (const op of uniqueOps) {
                if (failedBeforeAlloc.has(op.stamp.opId)) continue;
                if (op.tableName !== 'notifications') continue;
                const materializedTable = SYNCED_TABLE_MAP[op.tableName];
                if (!materializedTable) continue;
                const owned = raw
                    .prepare(
                        `SELECT ${notificationOwnerSql('data_json')} AS owner FROM ${materializedTable} WHERE id = ? AND workspace_id = ?`
                    )
                    .get(op.pk, workspaceId) as { owner: string | null } | undefined;
                const owner = owned?.owner;
                if (owned && !owner) {
                    uniqueResults.push(retainPushFailureNative(op, new StoredRecordUnavailable(
                        storedCanonicalSource(workspaceId, op.tableName, op.pk), 'notification_owner_unavailable'
                    ), input));
                    failedBeforeAlloc.add(op.stamp.opId);
                    continue;
                }
                if ((owned && owner !== userId) || (!owned && op.operation === 'delete')) {
                    failedBeforeAlloc.add(op.stamp.opId);
                    uniqueResults.push({
                        opId: op.stamp.opId,
                        success: false,
                        error: 'Forbidden: notification owner mismatch',
                        errorCode: 'UNAUTHORIZED',
                    });
                }
            }

            const intentFingerprints = new Map(uniqueOps.map(op => [op.stamp.opId, operationFingerprint(op)]));
            for (const op of uniqueOps) {
                if (existingOps.has(op.stamp.opId) || failedBeforeAlloc.has(op.stamp.opId)) continue;
                try { Object.assign(op, prepareFinalOperation(op)); }
                catch (error) {
                    failedBeforeAlloc.add(op.stamp.opId);
                    uniqueResults.push({ opId: op.stamp.opId, success: false, error: (error as Error).message,
                        errorCode: 'VALIDATION_ERROR' });
                }
            }

            // Deduplicate op_ids inside the same batch so repeats are idempotent.
            const uniqueNewOpIds = new Set<string>();
            for (const op of uniqueOps) {
                if (existingOps.has(op.stamp.opId)) continue;
                if (failedBeforeAlloc.has(op.stamp.opId)) continue;
                uniqueNewOpIds.add(op.stamp.opId);
            }

            // Allocate contiguous server_version block
            let baseVersion: number;
            const counterRow = raw
                .prepare('SELECT value FROM server_version_counter WHERE workspace_id = ?')
                .get(workspaceId) as { value: number } | undefined;

            safeVersionEnd(counterRow?.value ?? 0, uniqueNewOpIds.size);
            if (counterRow) {
                baseVersion = counterRow.value;
                raw.prepare(
                    'UPDATE server_version_counter SET value = ? WHERE workspace_id = ?'
                ).run(baseVersion + uniqueNewOpIds.size, workspaceId);
            } else {
                baseVersion = 0;
                if (uniqueNewOpIds.size) raw.prepare(
                    'INSERT INTO server_version_counter (workspace_id, value) VALUES (?, ?)'
                ).run(workspaceId, uniqueNewOpIds.size);
            }

            finalServerVersion = baseVersion + uniqueNewOpIds.size;

            // Prepared statements for hot-path inserts/upserts
            const insertChangeLog = raw.prepare(`
                INSERT INTO change_log (id, workspace_id, server_version, table_name, pk, op, payload_json, clock, hlc, device_id, op_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const assignedVersions = new Map<string, number>();
            let versionOffset = 0;
            for (const op of uniqueOps) {
                if (existingOps.has(op.stamp.opId)) continue;
                if (failedBeforeAlloc.has(op.stamp.opId)) continue;
                if (assignedVersions.has(op.stamp.opId)) continue;
                versionOffset++;
                assignedVersions.set(op.stamp.opId, baseVersion + versionOffset);
            }

            const processedNew = new Set<string>();

            for (const op of uniqueOps) {
                const opId = op.stamp.opId;
                if (failedBeforeAlloc.has(opId)) continue;

                // Idempotent replay
                const existingLog = existingOps.get(opId);
                if (existingLog !== undefined) {
                    if (
                        existingLog.workspace_id !== workspaceId ||
                        existingLog.fingerprint !== intentFingerprints.get(opId)
                    ) {
                        uniqueResults.push({
                            opId,
                            success: false,
                            error: `Conflicting operation reuses processed op_id ${opId}`,
                            errorCode: 'CONFLICT',
                        });
                        continue;
                    }
                    const winner = currentWinnerNative(raw, workspaceId, op.tableName, op.pk);
                    uniqueResults.push({
                        opId,
                        success: true,
                        serverVersion: existingLog.server_version,
                        replayed: true,
                        applied: winner?.revision.opId === opId,
                        ...(winner?.revision.opId === opId ? {} : { winner }),
                    });
                    continue;
                }

                const serverVersion = assignedVersions.get(opId);
                if (serverVersion === undefined) {
                    throw new Error(`Missing server version allocation for op_id ${opId}`);
                }

                // Duplicate op_id in the same batch: mirror first occurrence.
                if (processedNew.has(opId)) {
                    uniqueResults.push({
                        opId,
                        success: true,
                        serverVersion,
                    });
                    continue;
                }
                processedNew.add(opId);

                const materializedTable = SYNCED_TABLE_MAP[op.tableName];
                if (!materializedTable) {
                    uniqueResults.push({
                        opId,
                        success: false,
                        error: `Unknown table: ${op.tableName}`,
                        errorCode: 'VALIDATION_ERROR',
                    });
                    continue;
                }

                const pkValue = op.pk;

                // Write change_log
                const payloadJson =
                    op.payload != null ? JSON.stringify(op.payload) : null;

                insertChangeLog.run(
                    uid(),
                    workspaceId,
                    serverVersion,
                    op.tableName,
                    pkValue,
                    op.operation,
                    payloadJson,
                    op.stamp.clock,
                    op.stamp.hlc,
                    op.stamp.deviceId,
                    opId,
                    now
                );

                raw.prepare('UPDATE change_log SET intent_fingerprint = ? WHERE op_id = ?')
                    .run(intentFingerprints.get(opId), opId);

                const incomingRev = {
                    clock: op.stamp.clock,
                    hlc: op.stamp.hlc,
                    opId,
                };

                // Apply to materialized table using LWW
                if (op.operation === 'put') {
                    const existing = raw
                        .prepare(
                            `SELECT clock, hlc, op_id, deleted, ${boundedSyncPayload('data_json')} AS data_json FROM ${materializedTable} WHERE id = ? AND workspace_id = ?`
                        )
                        .get(pkValue, workspaceId) as
                        | { clock: number; hlc: string; op_id: string; data_json: string; deleted: number }
                        | undefined;
                    const tombstone = !existing
                        ? raw.prepare(
                            `SELECT clock, hlc, op_id FROM tombstones
                             WHERE workspace_id = ? AND table_name = ? AND pk = ?`
                        ).get(workspaceId, op.tableName, pkValue) as
                            | { clock: number; hlc: string; op_id: string }
                            | undefined
                        : undefined;
                    let applied = false;
                    let winnerPayload: unknown = op.payload;

                    if (!existing) {
                        if (tombstone && !incomingWinsRevision(incomingRev, tombstone)) {
                            winnerPayload = undefined;
                        } else {
                            raw.prepare(
                                `INSERT INTO ${materializedTable} (id, workspace_id, data_json, clock, hlc, device_id, op_id, deleted, created_at, updated_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
                            ).run(
                                pkValue,
                                workspaceId,
                                payloadJson ?? '{}',
                                op.stamp.clock,
                                op.stamp.hlc,
                                op.stamp.deviceId,
                                opId,
                                now,
                                now
                            );
                            applied = true;
                        }
                    } else if (incomingWinsRevision(incomingRev, existing)) {
                        raw.prepare(
                            `UPDATE ${materializedTable}
                             SET data_json = ?, clock = ?, hlc = ?, device_id = ?, op_id = ?, deleted = 0, updated_at = ?
                             WHERE id = ? AND workspace_id = ?`
                        ).run(
                            payloadJson ?? '{}',
                            op.stamp.clock,
                            op.stamp.hlc,
                            op.stamp.deviceId,
                            opId,
                            now,
                            pkValue,
                            workspaceId
                        );
                        applied = true;
                    } else {
                        winnerPayload = existing.deleted ? undefined : JSON.parse(existing.data_json);
                    }

                    const emission = resolveHookEmission({
                        op,
                        workspaceId,
                        now,
                        userId,
                        wasExisting: Boolean(existing),
                        applied,
                    });
                    if (emission) {
                        hookEmissions.push(emission);
                    }
                    uniqueResults.push({
                        opId,
                        success: true,
                        serverVersion,
                        applied,
                        ...(applied ? {} : {
                            payload: winnerPayload,
                            winner: currentWinnerNative(raw, workspaceId, op.tableName, pkValue),
                        }),
                    });
                } else if (op.operation === 'delete') {
                    const existing = raw
                        .prepare(
                            `SELECT clock, hlc, op_id, deleted, ${boundedSyncPayload('data_json')} AS data_json FROM ${materializedTable} WHERE id = ? AND workspace_id = ?`
                        )
                        .get(pkValue, workspaceId) as
                        | { clock: number; hlc: string; op_id: string; data_json: string; deleted: number }
                        | undefined;
                    let applied = false;

                    if (!existing) {
                        raw.prepare(
                            `INSERT INTO ${materializedTable} (id, workspace_id, data_json, clock, hlc, device_id, op_id, deleted, created_at, updated_at)
                             VALUES (?, ?, '{}', ?, ?, ?, ?, 1, ?, ?)`
                        ).run(
                            pkValue,
                            workspaceId,
                            op.stamp.clock,
                            op.stamp.hlc,
                            op.stamp.deviceId,
                            opId,
                            now,
                            now
                        );
                        applied = true;
                    } else if (incomingWinsRevision(incomingRev, existing)) {
                        raw.prepare(
                            `UPDATE ${materializedTable}
                             SET deleted = 1, clock = ?, hlc = ?, device_id = ?, op_id = ?, updated_at = ?
                             WHERE id = ? AND workspace_id = ?`
                        ).run(
                            op.stamp.clock,
                            op.stamp.hlc,
                            op.stamp.deviceId,
                            opId,
                            now,
                            pkValue,
                            workspaceId
                        );
                        applied = true;
                    }

                    raw.prepare(
                        `INSERT INTO tombstones (id, workspace_id, table_name, pk, deleted_at, clock, hlc, op_id, server_version, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(workspace_id, table_name, pk) DO UPDATE SET
                           deleted_at = excluded.deleted_at,
                           clock = excluded.clock,
                           hlc = excluded.hlc,
                           op_id = excluded.op_id,
                           server_version = excluded.server_version
                         WHERE ${lwwExcludedWins('tombstones')}`
                    ).run(
                        uid(),
                        workspaceId,
                        op.tableName,
                        pkValue,
                        now,
                        op.stamp.clock,
                        op.stamp.hlc,
                        opId,
                        serverVersion,
                        now
                    );

                    const emission = resolveHookEmission({
                        op,
                        workspaceId,
                        now,
                        userId,
                        wasExisting: Boolean(existing),
                        applied,
                    });
                    if (emission) {
                        hookEmissions.push(emission);
                    }
                    uniqueResults.push({
                        opId,
                        success: true,
                        serverVersion,
                        applied,
                        ...(applied || !existing
                            ? {}
                            : { payload: existing.deleted ? undefined : JSON.parse(existing.data_json) }),
                        ...(applied ? {} : {
                            winner: currentWinnerNative(raw, workspaceId, op.tableName, pkValue),
                        }),
                    });
                }
            }
            if (repair) {
                if (!uniqueResults[0]?.success || uniqueResults[0]?.applied === false) throw new Error('Repair did not win');
                const resolution = repairResolution(repair,uniqueOps[0]!.stamp.opId);
                raw.prepare(resolution.sql).run(...resolution.parameters ?? []);
            }
        });

        // Run with IMMEDIATE to prevent concurrent version allocation races
        runTx.immediate();

        for (const result of uniqueResults) {
            for (const index of indicesByOpId.get(result.opId) ?? []) {
                resultSlots[index] = result;
            }
        }

        for (const emission of hookEmissions) {
            await emitWebhookSystemHook(emission.hookName, emission.payload);
        }

        return {
            results: resultSlots.filter(
                (result): result is PushResult['results'][number] => Boolean(result)
            ),
            serverVersion: finalServerVersion,
            historyIncarnation,
        };
    }

    async pull(event: H3Event, input: ExplorerRequest<PullRequest>): Promise<PullResponse> {
        const db = this.db;
        const { scope, cursor, limit, tables } = input;
        await assertWorkspaceScopeAuthorized(event, scope.workspaceId);
        const historyIncarnation = await this.checkHistory(event, input, true);
        const fetchLimit = resolvePullLimit(limit);

        const minLog = await db
            .selectFrom('change_log')
            .select('server_version')
            .where('workspace_id', '=', scope.workspaceId)
            .orderBy('server_version', 'asc')
            .limit(1)
            .executeTakeFirst();
        const counter = await db
            .selectFrom('server_version_counter')
            .select('value')
            .where('workspace_id', '=', scope.workspaceId)
            .executeTakeFirst();
        if (!Number.isSafeInteger(counter?.value ?? 0) || (counter?.value ?? 0) < 0 ||
            minLog && (!Number.isSafeInteger(minLog.server_version) || minLog.server_version <= 0)) throw new Error('Untrustworthy sync retention version');
        const retention = computePullRetention({
            cursor,
            oldestLogVersion: minLog?.server_version ?? null,
            highWatermark: counter?.value ?? 0,
        });
        if (input.historyIncarnation !== historyIncarnation || retention.requiresSnapshot || cursor > (counter?.value ?? 0)) {
            return { historyIncarnation, changes: [], unavailable: [], nextCursor: cursor, hasMore: false, ...retention, requiresSnapshot: true };
        }

        let query = db
            .selectFrom('change_log')
            .where('workspace_id', '=', scope.workspaceId)
            .where('server_version', '>', cursor)
            .orderBy('server_version', 'asc');

        if (tables?.length) {
            query = query.where('table_name', 'in', tables);
        }

        const sizes = await query.select(['server_version',sql<number>`coalesce(length(cast(payload_json as blob)), 0)`.as('payload_bytes'),sql<number>`${sql.raw(PULL_METADATA_BYTES)}`.as('metadata_bytes')])
            .limit(fetchLimit + 1).execute();
        // Validate the lookahead too: a duplicate at the boundary would otherwise
        // disappear behind nextCursor on the following request.
        let previousVersion = cursor;
        for (const row of sizes) {
            if (!Number.isSafeInteger(row.server_version) || row.server_version <= previousVersion || row.server_version > (counter?.value ?? 0)) {
                throw new Error('Untrustworthy sync server version');
            }
            previousVersion = row.server_version;
        }
        const selected = boundedPayloadRowCount(sizes, fetchLimit);
        const rows = selected ? await query.select(['server_version',sql<number>`${sql.raw(boundedSyncMetadata('clock',PULL_METADATA_BYTES))}`.as('clock'),
            ...['id','table_name','pk','op'].map(column => sql<string>`${sql.raw(boundedSyncMetadata(column))}`.as(column as 'id' | 'table_name' | 'pk' | 'op')),
            ...['hlc','device_id','op_id'].map(column => sql<string>`${sql.raw(boundedSyncMetadata(column,PULL_METADATA_BYTES))}`.as(column as 'hlc' | 'device_id' | 'op_id')),
            sql<number>`${sql.raw(PULL_METADATA_BYTES)}`.as('metadata_bytes'),
            sql<string | null>`${sql.raw(boundedSyncPayload('payload_json'))}`.as('payload_json'),
            sql<number>`coalesce(length(cast(payload_json AS blob)),0)`.as('payload_bytes'),
            sql<string>`${sql.raw(`hex(cast(${boundedSyncMetadata('pk')} AS blob))`)}`.as('pk_hex'), sql<string>`${sql.raw(`hex(cast(${boundedSyncMetadata('table_name')} AS blob))`)}`.as('table_hex'),
            sql<string | null>`${sql.raw(`CASE WHEN table_name = 'notifications' THEN ${notificationOwnerSql('payload_json')} END`)}`.as('notification_owner'),
        ]).limit(selected).execute() : [];

        const changes: SyncChange[] = [];
        const unavailable: NonNullable<PullResponse['unavailable']> = [];
        let scanned = 0;
        let itemBytes = 0;
        let nextCursor = cursor;
        for (const row of rows) {
            if (!Number.isSafeInteger(row.server_version) || row.server_version <= nextCursor || row.server_version > (counter?.value ?? 0)) {
                throw new Error('Untrustworthy sync server version');
            }
            assertCoverageKey(row.table_name, row.pk, row.pk_hex, row.table_hex);
            if (row.op !== 'put' && row.op !== 'delete') throw new Error('Untrustworthy sync operation kind');
            const visible = row.table_name !== 'notifications' || !!row.notification_owner && row.notification_owner === resolveSessionUserId(event);
            let change: SyncChange | undefined;
            let reason = row.metadata_bytes > SYNC_METADATA_BYTES ? 'metadata_oversized' : row.payload_bytes > MAX_SYNC_PAYLOAD_BYTES ? 'payload_oversized' : 'invalid_record';
            if (reason === 'invalid_record') {
                try {
                    const candidate = { serverVersion: row.server_version, tableName: row.table_name, pk: row.pk, op: row.op as 'put' | 'delete',
                        payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
                        stamp: { clock: row.clock, hlc: row.hlc, deviceId: row.device_id, opId: row.op_id } };
                    if (SyncChangeSchema.safeParse(candidate).success && Number.isSafeInteger(row.clock) &&
                        (row.op === 'put' ? validReadPayload(row.table_name,row.pk,candidate.payload,row.clock,row.hlc) : ALLOWED_SYNC_TABLES.includes(row.table_name))) change = candidate;
                } catch { reason = 'invalid_json'; }
            }
            const marker = { tableName: row.table_name, pk: row.pk, originalKind: row.op as 'put' | 'delete',
                serverVersion: row.server_version, evidenceRef: '', reason };
            const bytes = visible ? jsonBytes(change ?? {...marker,evidenceRef:'x'.repeat(36)}) + ((change ? changes.length : unavailable.length) ? 1 : 0) : 0;
            const envelopeBytes = jsonBytes({historyIncarnation,changes:[],unavailable:[],nextCursor:row.server_version,hasMore:false,...retention});
            if (envelopeBytes + itemBytes + bytes > MAX_SYNC_PAGE_BYTES) {
                if (!scanned) throw new Error('Sync identity exceeds page byte budget');
                break;
            }
            if (!change) {
                marker.evidenceRef = await retainSqlEvidence({ historyIncarnation, workspaceId: scope.workspaceId, source: 'pull',
                    locator: row.id, revisionSql: "cast(server_version AS text)", table: 'change_log', where: 'workspace_id = ? AND id = ? AND server_version = ?',
                    parameters: [scope.workspaceId, row.id, row.server_version], payload: 'payload_json',
                    metadata: "json_object('id',id,'table_name',table_name,'pk',pk,'op',op,'clock',clock,'hlc',hlc,'device_id',device_id,'op_id',op_id,'server_version',server_version,'created_at',created_at)" }, reason);
                if (visible) unavailable.push(marker);
            } else if (visible) changes.push(change);
            itemBytes += bytes;
            scanned++; nextCursor = row.server_version;
        }
        assertExplorerPage(input.explorerCapability, changes, unavailable);
        return PullResponseSchema.parse({ historyIncarnation, changes, ...(unavailable.length ? { unavailable } : {}),
            nextCursor, hasMore: sizes.length > scanned, ...retention });
    }

    async retainUnavailableRecord(event: H3Event, input: { scope: {workspaceId:string}; source:'pull'|'snapshot'; historyIncarnation?:string; record:unknown; marker:Omit<PullUnavailableRecord,'evidenceRef'> | Omit<SnapshotUnavailableRecord,'evidenceRef'> }): Promise<{ evidenceRef: string }> {
        await assertWorkspaceScopeAuthorized(event,input.scope.workspaceId);
        const historyIncarnation = await this.checkHistory(event,input);
        const marker = input.marker;
        assertCoverageKey(marker.tableName,marker.pk);
        let source: EvidenceSource;
        let record: unknown;
        if (input.source === 'pull' && 'serverVersion' in marker) {
            const [row] = await syncRows<{id:string;table_name:string;pk:string;op:string;clock:number;hlc:string;device_id:string;op_id:string;payload_json:string|null;owner:string|null}>(
                `SELECT id,table_name,pk,op,clock,hlc,device_id,op_id,${boundedSyncPayload('payload_json')} AS payload_json,
                ${notificationOwnerSql('payload_json')} AS owner FROM change_log WHERE workspace_id = ? AND server_version = ?`,input.scope.workspaceId,marker.serverVersion);
            if (!row || row.table_name !== marker.tableName || row.pk !== marker.pk || row.op !== marker.originalKind ||
                row.table_name === 'notifications' && (!row.owner || row.owner !== resolveSessionUserId(event))) throw new Error('Evidence source identity or visibility mismatch');
            record = {serverVersion:marker.serverVersion,tableName:row.table_name,pk:row.pk,op:row.op,
                payload:row.payload_json ? JSON.parse(row.payload_json) : undefined,stamp:{clock:row.clock,hlc:row.hlc,deviceId:row.device_id,opId:row.op_id}};
            source = {historyIncarnation,workspaceId:input.scope.workspaceId,source:'pull',locator:row.id,revisionSql:"cast(server_version AS text)",table:'change_log',
                where:'workspace_id = ? AND id = ? AND server_version = ?',parameters:[input.scope.workspaceId,row.id,marker.serverVersion],payload:'payload_json',
                metadata:"json_object('id',id,'table_name',table_name,'pk',pk,'op',op,'clock',clock,'hlc',hlc,'device_id',device_id,'op_id',op_id,'server_version',server_version)"};
        } else if (input.source === 'snapshot' && 'snapshotId' in marker) {
            const [header] = await syncRows<SnapshotHeaderRow>('SELECT * FROM sync_snapshots WHERE workspace_id = ? AND id = ?',input.scope.workspaceId,marker.snapshotId);
            if (!header || header.expires_at <= nowEpoch() || header.high_watermark !== marker.highWatermark) throw new Error('Evidence snapshot unavailable');
            assertSnapshotOwner(header.id,resolveSessionUserId(event));
            const [row] = await syncRows<SnapshotItemRow>(`SELECT table_name,pk,kind,${boundedSyncPayload('payload_json')} AS payload_json,clock,hlc,op_id,server_deleted_at
                FROM sync_snapshot_items WHERE snapshot_id = ? AND table_name = ? AND pk = ? AND kind = ?`,header.id,marker.tableName,marker.pk,marker.originalKind);
            if (!row) throw new Error('Evidence snapshot source unavailable');
            const payload = row.payload_json ? JSON.parse(row.payload_json) : undefined;
            if (row.table_name === 'notifications' && row.kind === 'row' && notificationPayloadUserId(payload) !== resolveSessionUserId(event)) throw new Error('Evidence notification visibility mismatch');
            record = {kind:row.kind,tableName:row.table_name,pk:row.pk,revision:{clock:row.clock,hlc:row.hlc,opId:row.op_id},
                ...(row.kind === 'row' ? {payload} : {serverDeletedAt:row.server_deleted_at})};
            source = snapshotEvidence(header,row,historyIncarnation);
        } else throw new Error('Evidence source mismatch');
        if (stableJson(record) !== stableJson(input.record)) throw new Error('Evidence source record mismatch');
        return { evidenceRef: await retainSqlEvidence(source,'reader_invalid') };
    }

    async maintainUnavailableRecords(event: H3Event, workspaceId: string, action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
        await assertWorkspaceScopeAuthorized(event,workspaceId);
        return maintainEvidence(event,workspaceId,action,input,(event,op,guard) => this.push(event,
            {scope:{workspaceId},ops:[op],historyIncarnation:guard.historyIncarnation,workspaceItemCapability:WORKSPACE_ITEM_CAPABILITY,explorerCapability:EXPLORER_CAPABILITY},guard),validReadPayload);
    }

    async snapshot(event: H3Event, input: ExplorerRequest<SnapshotRequest>): Promise<SnapshotResponse> {
        return this.captureSnapshot(event, input, false);
    }

    /** Archives retain full Trash metadata; normal sync still emits tombstones. */
    async backupSnapshot(event: H3Event, input: ExplorerRequest<SnapshotRequest>): Promise<SnapshotResponse> {
        // Server exports discover their first history; every later page stays
        // bound to that capture rather than adopting the current database.
        const historyIncarnation = input.historyIncarnation === undefined
            ? input.pageToken ? decodeSnapshotPageToken(input.pageToken).historyIncarnation ?? null : null
            : input.historyIncarnation;
        return this.captureSnapshot(event, { ...input, historyIncarnation }, true);
    }

    private async captureSnapshot(
        event: H3Event,
        input: ExplorerRequest<SnapshotRequest>,
        retainedFiles: boolean
    ): Promise<SnapshotResponse> {
        const workspaceId = input.scope.workspaceId;
        await assertWorkspaceScopeAuthorized(event, workspaceId);
        const historyIncarnation = await this.checkHistory(event,input,
            input.historyIncarnation === null && !input.pageToken);
        if (input.pageToken && decodeSnapshotPageToken(input.pageToken).historyIncarnation !== historyIncarnation) historyChanged(historyIncarnation);
        const pageSize = resolveSnapshotPageSize(input.pageSize);
        const snapshotUserId = resolveSessionUserId(event);
        if (isD1Driver()) {
            const page = await this.snapshotInD1(workspaceId, input, pageSize, snapshotUserId, retainedFiles, historyIncarnation);
            assertExplorerPage(input.explorerCapability, page.items, page.unavailable ?? []);
            return page;
        }
        const raw = getRawDb();
        const now = nowEpoch();

        let header: SnapshotHeaderRow;
        let after: SnapshotPageToken['after'] | undefined;

        if (input.pageToken) {
            if (input.pageToken.length > MAX_SYNC_SNAPSHOT_TOKEN_LENGTH) {
                throw createError({
                    statusCode: 400,
                    statusMessage: 'Invalid snapshot page token',
                });
            }
            const token = decodeSnapshotPageToken(input.pageToken);
            const existing = raw
                .prepare(`
                    SELECT id, workspace_id, high_watermark, tables_json, expires_at
                    FROM sync_snapshots
                    WHERE id = ?
                `)
                .get(token.snapshotId) as SnapshotHeaderRow | undefined;

            if (!existing || existing.expires_at <= now) {
                if (existing) {
                    raw.prepare('DELETE FROM sync_snapshots WHERE id = ?').run(existing.id);
                }
                throw createError({
                    statusCode: 410,
                    statusMessage: 'Snapshot expired or unavailable',
                });
            }
            if (existing.workspace_id !== workspaceId) {
                throw createError({
                    statusCode: 403,
                    statusMessage: 'Forbidden',
                });
            }
            assertSnapshotOwner(existing.id, snapshotUserId);
            if (
                input.tables &&
                existing.tables_json !== JSON.stringify(normalizeSnapshotTables(input.tables))
            ) {
                throw createError({
                    statusCode: 400,
                    statusMessage: 'Snapshot table filter cannot change between pages',
                });
            }

            if (existing.id.startsWith('backup:') !== retainedFiles) {
                throw createError({ statusCode: 400, statusMessage: 'Snapshot mode cannot change between pages' });
            }
            header = existing;
            after = token.after;
        } else {
            const tables = normalizeSnapshotTables(input.tables);
            const ownerPrefix = snapshotOwnerPrefix(snapshotUserId);
            const snapshotId = `${retainedFiles ? 'backup:' : ''}${ownerPrefix}${uid()}`;
            const expiresAt = now + SNAPSHOT_TTL_SECONDS;

            const capture = raw.transaction((): SnapshotHeaderRow => {
                // Opportunistic bounded-lifetime cleanup. Cascading deletion removes
                // immutable item rows for abandoned or completed snapshots.
                raw.prepare('DELETE FROM sync_snapshots WHERE expires_at <= ?').run(now);
                // Keep several simultaneous tab/backup chains; superseded chains
                // restart with 410 rather than retaining unlimited full copies.
                raw.prepare(PRUNE_USER_SNAPSHOTS_SQL).run(
                    workspaceId, `${ownerPrefix}%`, `backup:${ownerPrefix}%`, MAX_RETAINED_SNAPSHOTS_PER_USER - 1
                );

                const counter = raw
                    .prepare(
                        'SELECT value FROM server_version_counter WHERE workspace_id = ?'
                    )
                    .get(workspaceId) as { value: number } | undefined;
                const highWatermark = counter?.value ?? 0;
                const tablesJson = JSON.stringify(tables);

                raw.prepare(`
                    INSERT INTO sync_snapshots (
                        id, workspace_id, high_watermark, tables_json, created_at, expires_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                `).run(
                    snapshotId,
                    workspaceId,
                    highWatermark,
                    tablesJson,
                    now,
                    expiresAt
                );

                if (tables.includes('notifications')) {
                    const evidence = unknownNotificationEvidence(workspaceId);
                    raw.prepare(evidence.sql).run(...evidence.parameters ?? []);
                }
                for (const tableName of tables) {
                    const materializedTable = SYNCED_TABLE_MAP[tableName];
                    if (!materializedTable) {
                        throw new Error(`Missing materialized table for ${tableName}`);
                    }

                    const liveOwner = snapshotNotificationOwnerClause(
                        tableName,
                        'data_json',
                        snapshotUserId
                    );
                    raw.prepare(`
                        INSERT INTO sync_snapshot_items (
                            snapshot_id, table_name, pk, kind, payload_json,
                            clock, hlc, op_id, server_deleted_at
                        )
                        SELECT
                            ?, ?, id, 'row', data_json,
                            clock,
                            CASE WHEN hlc <> '' THEN hlc ELSE 'legacy:0' END,
                            CASE
                                WHEN op_id <> '' THEN op_id
                                ELSE 'legacy:${tableName}:' || id || ':' || clock || ':' || hlc
                            END,
                            NULL
                        FROM "${materializedTable}"
                        WHERE workspace_id = ? AND deleted = 0${liveOwner.sql}
                    `).run(snapshotId, tableName, workspaceId, ...liveOwner.params);

                    // A deleted materialized row is the canonical winner. Use its
                    // revision and the server-authored tombstone timestamp.
                    const deletedOwner = snapshotNotificationOwnerClause(
                        tableName,
                        'materialized.data_json',
                        snapshotUserId
                    );
                    const retainDeleted = retainedFiles && tableName === 'file_meta' ? '1'
                        : tableName === 'posts' ? `CASE WHEN json_valid(materialized.data_json) THEN
                            COALESCE(json_extract(materialized.data_json, '$.post_type'), json_extract(materialized.data_json, '$.postType'))
                                IN ('or3:explorer-folder', 'or3:explorer-placement') ELSE 0 END` : '0';
                    raw.prepare(`
                        INSERT INTO sync_snapshot_items (
                            snapshot_id, table_name, pk, kind, payload_json,
                            clock, hlc, op_id, server_deleted_at, source_payload_json
                        )
                        SELECT
                            ?, ?, materialized.id, CASE WHEN ${retainDeleted} THEN 'row' ELSE 'tombstone' END,
                            CASE WHEN ${retainDeleted} THEN
                                CASE WHEN length(cast(materialized.data_json AS blob)) <= 262144 AND json_valid(materialized.data_json)
                                    THEN json_set(materialized.data_json, '$.deleted', json('true'), '$.clock', materialized.clock,
                                        '$.hlc', materialized.hlc, '$.op_id', materialized.op_id, '$.updated_at', materialized.updated_at)
                                    ELSE materialized.data_json END
                                ELSE NULL END,
                            materialized.clock,
                            CASE
                                WHEN materialized.hlc <> '' THEN materialized.hlc
                                ELSE 'legacy:0'
                            END,
                            CASE
                                WHEN materialized.op_id <> '' THEN materialized.op_id
                                ELSE 'legacy:tombstone:${tableName}:' || materialized.id || ':' || materialized.clock
                            END,
                            MAX(0, COALESCE(
                                (
                                    SELECT tombstone.deleted_at
                                    FROM tombstones AS tombstone
                                    WHERE tombstone.workspace_id = materialized.workspace_id
                                      AND tombstone.table_name = ?
                                      AND tombstone.pk = materialized.id
                                    LIMIT 1
                                ),
                                materialized.updated_at,
                                materialized.created_at,
                                0
                            )),
                            CASE WHEN ${retainDeleted} THEN materialized.data_json ELSE NULL END
                        FROM "${materializedTable}" AS materialized
                        WHERE materialized.workspace_id = ? AND materialized.deleted <> 0${deletedOwner.sql}
                    `).run(snapshotId, tableName, tableName, workspaceId, ...deletedOwner.params);

                    const orphanFilter = tableName === 'notifications'
                        ? ' AND 1 = 0'
                        : '';
                    raw.prepare(`
                        INSERT INTO sync_snapshot_items (
                            snapshot_id, table_name, pk, kind, payload_json,
                            clock, hlc, op_id, server_deleted_at
                        )
                        SELECT
                            ?, ?, tombstone.pk, 'tombstone', NULL,
                            tombstone.clock,
                            CASE WHEN tombstone.hlc <> '' THEN tombstone.hlc ELSE 'legacy:0' END,
                            CASE
                                WHEN tombstone.op_id <> '' THEN tombstone.op_id
                                ELSE 'legacy:tombstone:${tableName}:' || tombstone.pk || ':' || tombstone.clock
                            END,
                            MAX(0, tombstone.deleted_at)
                        FROM tombstones AS tombstone
                        WHERE tombstone.workspace_id = ?
                          AND tombstone.table_name = ?
                          AND NOT EXISTS (
                              SELECT 1
                              FROM "${materializedTable}" AS materialized
                              WHERE materialized.workspace_id = tombstone.workspace_id
                                AND materialized.id = tombstone.pk
                          )${orphanFilter}
                    `).run(snapshotId, tableName, workspaceId, tableName);
                }

                return {
                    id: snapshotId,
                    workspace_id: workspaceId,
                    high_watermark: highWatermark,
                    tables_json: tablesJson,
                    expires_at: expiresAt,
                };
            });

            // BEGIN IMMEDIATE binds the materialized copy and counter read to one
            // consistency point while preventing a concurrent push from slipping in.
            header = capture.immediate();
        }

        const selection = snapshotPageSelection(header.id, after);
        const sizes = raw.prepare(`SELECT coalesce(length(cast(payload_json as blob)), 0) AS payload_bytes, ${SNAPSHOT_METADATA_BYTES} AS metadata_bytes ${selection.clause}`)
            .all(...selection.parameters, pageSize + 1) as PayloadSizeRow[];
        const selected = boundedPayloadRowCount(sizes, pageSize);
        const rows = selected ? raw.prepare(`SELECT ${boundedSyncMetadata('table_name')} AS table_name, ${boundedSyncMetadata('pk')} AS pk, ${boundedSyncMetadata('kind')} AS kind,
            ${boundedSyncPayload('payload_json')} AS payload_json, length(cast(payload_json AS blob)) AS payload_bytes,
            ${SNAPSHOT_METADATA_BYTES} AS metadata_bytes,
            hex(cast(${boundedSyncMetadata('pk')} AS blob)) AS pk_hex, hex(cast(${boundedSyncMetadata('table_name')} AS blob)) AS table_hex,
            CASE WHEN table_name = 'notifications' AND kind = 'row' THEN ${notificationOwnerSql('payload_json')} END AS notification_owner,
            ${boundedSyncMetadata('clock',SNAPSHOT_METADATA_BYTES)} AS clock, ${boundedSyncMetadata('hlc',SNAPSHOT_METADATA_BYTES)} AS hlc, ${boundedSyncMetadata('op_id',SNAPSHOT_METADATA_BYTES)} AS op_id, ${boundedSyncMetadata('server_deleted_at',SNAPSHOT_METADATA_BYTES)} AS server_deleted_at ${selection.clause}`)
            .all(...selection.parameters, selected) as SnapshotItemRow[] : [];
        const page = await buildSnapshotPage(header, rows, pageSize, sizes.length, historyIncarnation, after, snapshotUserId);
        assertExplorerPage(input.explorerCapability, page.items, page.unavailable ?? []);
        return page;
    }

    async updateCursor(
        event: H3Event,
        input: { scope: { workspaceId: string }; deviceId: string; version: number; historyIncarnation?: string | null }
    ): Promise<void> {
        await assertWorkspaceScopeAuthorized(event, input.scope.workspaceId);
        const now = nowEpoch();
        const historyIncarnation = await this.checkHistory(event,input);
        const deviceId = input.deviceId.trim();
        if (!deviceId || deviceId.length > 256) {
            throw createError({ statusCode: 400, statusMessage: 'Invalid device cursor' });
        }
        if (!Number.isSafeInteger(input.version) || input.version < 0) {
            throw createError({ statusCode: 400, statusMessage: 'Invalid device cursor' });
        }

        const ownerUserId = resolveSessionUserId(event);
        if (!ownerUserId) {
            throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
        }
        if (isD1Driver()) {
            return this.updateCursorInD1(input.scope.workspaceId, deviceId, input.version, ownerUserId, now, historyIncarnation);
        }
        const raw = getRawDb();
        const update = raw.transaction(() => {
            const current = raw.prepare('SELECT incarnation FROM sync_history WHERE id=1').get() as {incarnation:string}|undefined;
            if(current?.incarnation !== historyIncarnation) {
                if(!validHistoryIncarnation(current?.incarnation)) throw new Error('Invalid sync history singleton');
                historyChanged(current.incarnation);
            }
            const counter = raw.prepare(
                'SELECT value FROM server_version_counter WHERE workspace_id = ?'
            ).get(input.scope.workspaceId) as { value: number } | undefined;
            const maximum = counter?.value ?? 0;
            if (input.version > maximum) {
                throw createError({ statusCode: 400, statusMessage: 'Cursor exceeds workspace version' });
            }

            const existing = raw.prepare(
                `SELECT owner_user_id, last_seen_version
                 FROM device_cursors WHERE workspace_id = ? AND owner_user_id = ? AND device_id = ?`
            ).get(input.scope.workspaceId, ownerUserId, deviceId) as {
                owner_user_id: string | null;
                last_seen_version: number;
            } | undefined;
            if (existing && input.version < existing.last_seen_version) {
                throw createError({ statusCode: 409, statusMessage: 'Device cursor cannot regress' });
            }

            raw.prepare(
                `INSERT INTO device_cursors (
                    id, workspace_id, device_id, owner_user_id, last_seen_version, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(workspace_id, owner_user_id, device_id) DO UPDATE SET
                   last_seen_version = excluded.last_seen_version,
                   updated_at = excluded.updated_at`
            ).run(uid(), input.scope.workspaceId, deviceId, ownerUserId, input.version, now);
        });
        update.immediate();
    }

    async gcTombstones(
        event: H3Event,
        input: { scope: { workspaceId: string }; retentionSeconds: number }
    ): Promise<void> {
        await assertWorkspaceScopeAuthorized(event, input.scope.workspaceId);
        if (!Number.isSafeInteger(input.retentionSeconds) ||
            input.retentionSeconds < MIN_SYNC_RETENTION_SECONDS ||
            input.retentionSeconds > MAX_SYNC_RETENTION_SECONDS) {
            throw createError({ statusCode: 400, statusMessage: 'Invalid sync retention window' });
        }
        if (!canRunSyncHistoryGc()) return;
        const cutoff = nowEpoch() - input.retentionSeconds;
        if (isD1Driver()) {
            await d1Batch([
                {
                    sql: `DELETE FROM device_cursors
                     WHERE workspace_id = ? AND updated_at < ?`,
                    parameters: [input.scope.workspaceId, cutoff],
                },
                {
                    sql: `DELETE FROM tombstones
                     WHERE workspace_id = ?
                       AND created_at < ?
                       AND (
                           NOT EXISTS (
                               SELECT 1 FROM device_cursors
                               WHERE workspace_id = ?
                           )
                           OR server_version <= (
                               SELECT MIN(last_seen_version)
                               FROM device_cursors
                               WHERE workspace_id = ?
                           )
                       )`,
                    parameters: [
                        input.scope.workspaceId,
                        cutoff,
                        input.scope.workspaceId,
                        input.scope.workspaceId,
                    ],
                },
            ]);
            return;
        }
        const raw = getRawDb();
        raw.transaction(() => {
            // A cursor that has not checked in for the entire retention window
            // is no longer a retention blocker. Its client will take the
            // snapshot-v1 bootstrap path before applying new history.
            raw.prepare(
                `DELETE FROM device_cursors
                 WHERE workspace_id = ? AND updated_at < ?`
            ).run(input.scope.workspaceId, cutoff);
            const cursor = raw.prepare(
                `SELECT MIN(last_seen_version) AS min_version
                 FROM device_cursors WHERE workspace_id = ?`
            ).get(input.scope.workspaceId) as { min_version: number | null };
            if (cursor.min_version === null) {
                raw.prepare(
                    `DELETE FROM tombstones
                     WHERE workspace_id = ? AND created_at < ?`
                ).run(input.scope.workspaceId, cutoff);
            } else {
                raw.prepare(
                    `DELETE FROM tombstones
                     WHERE workspace_id = ? AND created_at < ? AND server_version <= ?`
                ).run(input.scope.workspaceId, cutoff, cursor.min_version);
            }
        })();
    }

    async gcChangeLog(
        event: H3Event,
        input: { scope: { workspaceId: string }; retentionSeconds: number }
    ): Promise<void> {
        await assertWorkspaceScopeAuthorized(event, input.scope.workspaceId);
        if (!Number.isSafeInteger(input.retentionSeconds) ||
            input.retentionSeconds < MIN_SYNC_RETENTION_SECONDS ||
            input.retentionSeconds > MAX_SYNC_RETENTION_SECONDS) {
            throw createError({ statusCode: 400, statusMessage: 'Invalid sync retention window' });
        }
        if (!canRunSyncHistoryGc()) return;
        const cutoff = nowEpoch() - input.retentionSeconds;
        // Age need not increase with server version (wall clocks can move).
        // The first recent row fences all later history, even if it is old.
        const deletePrefix = `DELETE FROM change_log
            WHERE workspace_id = ? AND server_version < COALESCE((
                SELECT MIN(server_version) FROM change_log
                WHERE workspace_id = ? AND created_at >= ?
            ), 9223372036854775807)
            AND server_version <= COALESCE((
                SELECT MIN(last_seen_version) FROM device_cursors WHERE workspace_id = ?
            ), 9223372036854775807)`;
        const workspaceId = input.scope.workspaceId;
        if (isD1Driver()) {
            await d1Batch([
                { sql: 'DELETE FROM device_cursors WHERE workspace_id = ? AND updated_at < ?', parameters: [workspaceId, cutoff] },
                { sql: deletePrefix, parameters: [workspaceId, workspaceId, cutoff, workspaceId] },
            ]);
            return;
        }
        const raw = getRawDb();
        raw.transaction(() => {
            raw.prepare('DELETE FROM device_cursors WHERE workspace_id = ? AND updated_at < ?').run(workspaceId, cutoff);
            raw.prepare(deletePrefix).run(workspaceId, workspaceId, cutoff, workspaceId);
        }).immediate();
    }

    private async reserveUploadIntentInD1(
        input: UploadIntentReservationRequest,
        hash: string
    ): Promise<void> {
        const now = nowEpoch();
        const results = await d1Batch([
            {
                sql: `UPDATE upload_intents SET status = 'expired'
                      WHERE workspace_id = ? AND status = 'active' AND expires_at <= ?`,
                parameters: [input.workspaceId, now],
            },
            {
                // Keep the quota decision in the write statement: D1's async
                // preflight reads cannot serialize concurrent reservations.
                sql: `WITH pending AS (${QUOTA_RESERVATIONS_SQL}), quota AS (
                    SELECT
                        COALESCE((SELECT used_bytes FROM storage_usage WHERE workspace_id = ?), 0) AS used_bytes,
                        (SELECT COALESCE(SUM(held_bytes), 0) FROM pending) AS pending_bytes,
                        MAX(0, ? - MAX(COALESCE((SELECT size_bytes FROM retained_storage WHERE workspace_id = ? AND hash = ?), 0),
                            (SELECT COALESCE(MAX(reserved_bytes), 0) FROM pending WHERE hash = ?))) AS added_bytes
                ) INSERT INTO upload_intents (
                    id, workspace_id, hash, mime_type, size_bytes, reserved_bytes,
                    expires_at, status, created_at
                ) SELECT ?, ?, ?, ?, ?, ?, ?, 'active', ? FROM quota
                  WHERE (? IS NULL OR used_bytes + pending_bytes + added_bytes <= ?)`,
                parameters: [
                    input.workspaceId,
                    now,
                    input.workspaceId,
                    input.sizeBytes,
                    input.workspaceId,
                    hash,
                    hash,
                    input.intentId,
                    input.workspaceId,
                    hash,
                    input.mimeType,
                    input.sizeBytes,
                    input.sizeBytes,
                    input.expiresAt,
                    now,
                    input.workspaceQuotaBytes ?? null,
                    input.workspaceQuotaBytes ?? null,
                ],
            },
        ]);
        if (results[1]?.meta?.changes !== 1) {
            throw createError({ statusCode: 413, statusMessage: 'Workspace storage quota exceeded' });
        }
    }

    private async snapshotInD1(
        workspaceId: string,
        input: ExplorerRequest<SnapshotRequest>,
        pageSize: number,
        snapshotUserId: string | undefined,
        retainedFiles: boolean,
        historyIncarnation: string
    ): Promise<SnapshotResponse> {
        const now = nowEpoch();
        let header: SnapshotHeaderRow;
        let after: SnapshotPageToken['after'] | undefined;

        if (input.pageToken) {
            if (input.pageToken.length > MAX_SYNC_SNAPSHOT_TOKEN_LENGTH) {
                throw createError({ statusCode: 400, statusMessage: 'Invalid snapshot page token' });
            }
            const token = decodeSnapshotPageToken(input.pageToken);
            const [existing] = await d1All<SnapshotHeaderRow>(
                `SELECT id, workspace_id, high_watermark, tables_json, expires_at
                 FROM sync_snapshots WHERE id = ?`,
                token.snapshotId
            );
            if (!existing || existing.expires_at <= now) {
                if (existing) {
                    await d1Run('DELETE FROM sync_snapshots WHERE id = ?', existing.id);
                }
                throw createError({ statusCode: 410, statusMessage: 'Snapshot expired or unavailable' });
            }
            if (existing.workspace_id !== workspaceId) {
                throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
            }
            assertSnapshotOwner(existing.id, snapshotUserId);
            if (
                input.tables &&
                existing.tables_json !== JSON.stringify(normalizeSnapshotTables(input.tables))
            ) {
                throw createError({
                    statusCode: 400,
                    statusMessage: 'Snapshot table filter cannot change between pages',
                });
            }
            if (existing.id.startsWith('backup:') !== retainedFiles) {
                throw createError({ statusCode: 400, statusMessage: 'Snapshot mode cannot change between pages' });
            }
            header = existing;
            after = token.after;
        } else {
            const tables = normalizeSnapshotTables(input.tables);
            const ownerPrefix = snapshotOwnerPrefix(snapshotUserId);
            const snapshotId = `${retainedFiles ? 'backup:' : ''}${ownerPrefix}${uid()}`;
            const expiresAt = now + SNAPSHOT_TTL_SECONDS;
            const tablesJson = JSON.stringify(tables);
            const statements: D1SqlStatement[] = [
                {
                    sql: 'DELETE FROM sync_snapshots WHERE expires_at <= ?',
                    parameters: [now],
                },
                {
                    sql: PRUNE_USER_SNAPSHOTS_SQL,
                    parameters: [workspaceId, `${ownerPrefix}%`, `backup:${ownerPrefix}%`, MAX_RETAINED_SNAPSHOTS_PER_USER - 1],
                },
                {
                    sql: `INSERT INTO sync_snapshots (
                        id, workspace_id, high_watermark, tables_json, created_at, expires_at
                    ) VALUES (
                        ?, ?,
                        COALESCE((
                            SELECT value FROM server_version_counter WHERE workspace_id = ?
                        ), 0),
                        ?, ?, ?
                    )`,
                    parameters: [
                        snapshotId,
                        workspaceId,
                        workspaceId,
                        tablesJson,
                        now,
                        expiresAt,
                    ],
                },
            ];
            if (tables.includes('notifications')) statements.push(unknownNotificationEvidence(workspaceId));
            for (const tableName of tables) {
                const materializedTable = SYNCED_TABLE_MAP[tableName];
                if (!materializedTable) {
                    throw new Error(`Missing materialized table for ${tableName}`);
                }
                const liveOwner = snapshotNotificationOwnerClause(
                    tableName,
                    'data_json',
                    snapshotUserId
                );
                const deletedOwner = snapshotNotificationOwnerClause(
                    tableName,
                    'materialized.data_json',
                    snapshotUserId
                );
                const orphanFilter = tableName === 'notifications' ? ' AND 1 = 0' : '';
                statements.push(
                    {
                        sql: `INSERT INTO sync_snapshot_items (
                            snapshot_id, table_name, pk, kind, payload_json,
                            clock, hlc, op_id, server_deleted_at
                        )
                        SELECT
                            ?, ?, id, 'row', data_json,
                            clock,
                            CASE WHEN hlc <> '' THEN hlc ELSE 'legacy:0' END,
                            CASE
                                WHEN op_id <> '' THEN op_id
                                ELSE 'legacy:${tableName}:' || id || ':' || clock || ':' || hlc
                            END,
                            NULL
                        FROM "${materializedTable}"
                        WHERE workspace_id = ? AND deleted = 0${liveOwner.sql}`,
                        parameters: [snapshotId, tableName, workspaceId, ...liveOwner.params],
                    },
                    {
                        sql: `INSERT INTO sync_snapshot_items (
                            snapshot_id, table_name, pk, kind, payload_json,
                            clock, hlc, op_id, server_deleted_at, source_payload_json
                        )
                        SELECT
                            ?, ?, materialized.id, '${retainedFiles && tableName === 'file_meta' ? 'row' : 'tombstone'}',
                            ${retainedFiles && tableName === 'file_meta' ? "CASE WHEN length(cast(materialized.data_json AS blob)) <= 262144 AND json_valid(materialized.data_json) THEN json_set(materialized.data_json, '$.deleted', json('true'), '$.clock', materialized.clock, '$.hlc', materialized.hlc, '$.op_id', materialized.op_id, '$.updated_at', materialized.updated_at) ELSE materialized.data_json END" : 'NULL'},
                            materialized.clock,
                            CASE
                                WHEN materialized.hlc <> '' THEN materialized.hlc
                                ELSE 'legacy:0'
                            END,
                            CASE
                                WHEN materialized.op_id <> '' THEN materialized.op_id
                                ELSE 'legacy:tombstone:${tableName}:' || materialized.id || ':' || materialized.clock
                            END,
                            MAX(0, COALESCE(
                                (
                                    SELECT tombstone.deleted_at
                                    FROM tombstones AS tombstone
                                    WHERE tombstone.workspace_id = materialized.workspace_id
                                      AND tombstone.table_name = ?
                                      AND tombstone.pk = materialized.id
                                    LIMIT 1
                                ),
                                materialized.updated_at,
                                materialized.created_at,
                                0
                            )),
                            ${retainedFiles && tableName === 'file_meta' ? 'materialized.data_json' : 'NULL'}
                        FROM "${materializedTable}" AS materialized
                        WHERE materialized.workspace_id = ? AND materialized.deleted <> 0${deletedOwner.sql}`,
                        parameters: [
                            snapshotId,
                            tableName,
                            tableName,
                            workspaceId,
                            ...deletedOwner.params,
                        ],
                    },
                    {
                        sql: `INSERT INTO sync_snapshot_items (
                            snapshot_id, table_name, pk, kind, payload_json,
                            clock, hlc, op_id, server_deleted_at
                        )
                        SELECT
                            ?, ?, tombstone.pk, 'tombstone', NULL,
                            tombstone.clock,
                            CASE WHEN tombstone.hlc <> '' THEN tombstone.hlc ELSE 'legacy:0' END,
                            CASE
                                WHEN tombstone.op_id <> '' THEN tombstone.op_id
                                ELSE 'legacy:tombstone:${tableName}:' || tombstone.pk || ':' || tombstone.clock
                            END,
                            MAX(0, tombstone.deleted_at)
                        FROM tombstones AS tombstone
                        WHERE tombstone.workspace_id = ?
                          AND tombstone.table_name = ?
                          AND NOT EXISTS (
                              SELECT 1
                              FROM "${materializedTable}" AS materialized
                              WHERE materialized.workspace_id = tombstone.workspace_id
                                AND materialized.id = tombstone.pk
                          )${orphanFilter}`,
                        parameters: [snapshotId, tableName, workspaceId, tableName],
                    }
                );
            }
            await d1Batch(statements);
            const [created] = await d1All<SnapshotHeaderRow>(
                `SELECT id, workspace_id, high_watermark, tables_json, expires_at
                 FROM sync_snapshots WHERE id = ?`,
                snapshotId
            );
            if (!created) throw createError({ statusCode: 410, statusMessage: 'Snapshot expired or unavailable' });
            header = created;
        }

        const selection = snapshotPageSelection(header.id, after);
        const sizes = await d1All<PayloadSizeRow>(
            `SELECT coalesce(length(cast(payload_json as blob)), 0) AS payload_bytes, ${SNAPSHOT_METADATA_BYTES} AS metadata_bytes ${selection.clause}`,
            ...selection.parameters, pageSize + 1
        );
        const selected = boundedPayloadRowCount(sizes, pageSize);
        const rows = selected ? await d1All<SnapshotItemRow>(
            `SELECT ${boundedSyncMetadata('table_name')} AS table_name, ${boundedSyncMetadata('pk')} AS pk, ${boundedSyncMetadata('kind')} AS kind,
            ${boundedSyncPayload('payload_json')} AS payload_json, length(cast(payload_json AS blob)) AS payload_bytes,
            ${SNAPSHOT_METADATA_BYTES} AS metadata_bytes,
            hex(cast(${boundedSyncMetadata('pk')} AS blob)) AS pk_hex, hex(cast(${boundedSyncMetadata('table_name')} AS blob)) AS table_hex,
            CASE WHEN table_name = 'notifications' AND kind = 'row' THEN ${notificationOwnerSql('payload_json')} END AS notification_owner,
            ${boundedSyncMetadata('clock',SNAPSHOT_METADATA_BYTES)} AS clock, ${boundedSyncMetadata('hlc',SNAPSHOT_METADATA_BYTES)} AS hlc, ${boundedSyncMetadata('op_id',SNAPSHOT_METADATA_BYTES)} AS op_id, ${boundedSyncMetadata('server_deleted_at',SNAPSHOT_METADATA_BYTES)} AS server_deleted_at ${selection.clause}`,
            ...selection.parameters, selected
        ) : [];
        // Captures and maintenance can evict a snapshot between these awaited
        // reads. Never acknowledge an incomplete copy as a final page.
        const [retained] = await d1All<{ expires_at: number }>(
            'SELECT expires_at FROM sync_snapshots WHERE id = ?', header.id
        );
        if (!retained || retained.expires_at <= nowEpoch()) {
            throw createError({ statusCode: 410, statusMessage: 'Snapshot expired or unavailable' });
        }
        return buildSnapshotPage(header, rows, pageSize, sizes.length, historyIncarnation, after, snapshotUserId);
    }

    private async updateCursorInD1(
        workspaceId: string,
        deviceId: string,
        version: number,
        ownerUserId: string,
        now: number,
        historyIncarnation: string
    ): Promise<void> {
        const [counter] = await d1All<{ value: number }>(
            'SELECT value FROM server_version_counter WHERE workspace_id = ?',
            workspaceId
        );
        if (version > (counter?.value ?? 0)) {
            throw createError({ statusCode: 400, statusMessage: 'Cursor exceeds workspace version' });
        }
        const [existing] = await d1All<{
            owner_user_id: string | null;
            last_seen_version: number;
        }>(
            `SELECT owner_user_id, last_seen_version
             FROM device_cursors WHERE workspace_id = ? AND owner_user_id = ? AND device_id = ?`,
            workspaceId,
            ownerUserId,
            deviceId
        );
        if (existing && version < existing.last_seen_version) {
            throw createError({ statusCode: 409, statusMessage: 'Device cursor cannot regress' });
        }
        const results = await d1Batch([
            historyAssertion(historyIncarnation),
            {sql:`SELECT json_extract('{}',CASE WHEN ? <= coalesce((SELECT value FROM server_version_counter WHERE workspace_id=?),0)
                AND ? >= coalesce((SELECT last_seen_version FROM device_cursors WHERE workspace_id=? AND owner_user_id=? AND device_id=?),0)
                THEN '$' ELSE 'OR3_SYNC_CURSOR_CHANGED' END)`,parameters:[version,workspaceId,version,workspaceId,ownerUserId,deviceId]},
            {sql:`INSERT INTO device_cursors (
                id, workspace_id, device_id, owner_user_id, last_seen_version, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(workspace_id, owner_user_id, device_id) DO UPDATE SET
                last_seen_version = excluded.last_seen_version,
                updated_at = excluded.updated_at
             WHERE excluded.last_seen_version >= device_cursors.last_seen_version`,
            parameters:[uid(),workspaceId,deviceId,ownerUserId,version,now]},
        ]).catch(async error=>{
            if(String(error).includes('OR3_SYNC_HISTORY_CHANGED')) historyChanged(await readHistoryIncarnation());
            if(String(error).includes('OR3_SYNC_CURSOR_CHANGED')) throw createError({statusCode:409,statusMessage:'Device cursor changed concurrently'});
            throw error;
        });
        if ((results[2]?.meta?.changes ?? 0) !== 1) {
            throw createError({ statusCode: 409, statusMessage: 'Device cursor changed concurrently' });
        }
    }

    private async pushInD1(input: {
        event: H3Event;
        workspaceId: string;
        uniqueOps: PendingOp[];
        resultSlots: Array<PushResult['results'][number] | undefined>;
        indicesByOpId: Map<string, number[]>;
        userId: string | undefined;
        workspaceItemCapability: PushBatch['workspaceItemCapability'];
        storedRecordCapability: PushBatch['storedRecordCapability'];
        historyIncarnation: string;
        repair?: RepairGuard;
    }): Promise<PushResult> {
        const { workspaceId, uniqueOps, resultSlots, indicesByOpId, userId, historyIncarnation } = input;
        const originalOps = new Map(uniqueOps.map(op => [op.stamp.opId,{...op}]));
        const existingOps = new Map<string, StoredReceipt & {fingerprint:string}>();
        const rejected = new Set<string>();
        for (const op of uniqueOps) {
            try {
                const [receipt] = await d1All<StoredReceipt>(`SELECT ${RECEIPT_COLUMNS} FROM change_log WHERE op_id=?`,op.stamp.opId);
                if (receipt) {
                    const fingerprint = receipt.workspace_id === workspaceId ? receiptFingerprint(receipt) : '';
                    existingOps.set(op.stamp.opId,{...receipt,fingerprint});
                    if (receipt.workspace_id !== workspaceId) continue;
                }
                if (receipt && existingOps.get(op.stamp.opId)!.fingerprint !== operationFingerprint(op)) continue;
                if (!input.repair && !await currentWinnerD1(workspaceId,op.tableName,op.pk,userId) && receipt && op.tableName !== 'notifications') throw new StoredRecordUnavailable(storedReceiptSource(receipt),'stored_winner_missing');
            } catch (error) {
                if (!(error instanceof StoredRecordUnavailable)) throw error;
                if (error.revision && op.tableName !== 'notifications' && incomingWinsRevision(op.stamp,error.revision)) {
                    await historyBatch([historyAssertion(historyIncarnation),evidenceInsert({...error.source,historyIncarnation},error.reason)],historyIncarnation);
                    continue;
                }
                const result = await retainPushFailureD1(originalOps.get(op.stamp.opId)!,error,historyIncarnation,input.storedRecordCapability);
                rejected.add(op.stamp.opId);
                for (const index of indicesByOpId.get(op.stamp.opId) ?? []) resultSlots[index] = result;
            }
        }
        for (const op of uniqueOps) {
            if (rejected.has(op.stamp.opId)) continue;
            const existing = existingOps.get(op.stamp.opId);
            if (!existing) continue;
            if (
                existing.workspace_id !== workspaceId ||
                existing.fingerprint !== operationFingerprint(op)
            ) {
                rejected.add(op.stamp.opId);
                for (const index of indicesByOpId.get(op.stamp.opId) ?? []) {
                    resultSlots[index] = {
                        opId: op.stamp.opId,
                        success: false,
                        error: `Conflicting operation reuses processed op_id ${op.stamp.opId}`,
                        errorCode: 'CONFLICT',
                    };
                }
            }
        }

        for (const op of uniqueOps) {
            if (op.tableName !== 'notifications') continue;
            if (rejected.has(op.stamp.opId)) continue;
            const materializedTable = SYNCED_TABLE_MAP[op.tableName];
            if (!materializedTable) continue;
            const [owned] = await d1All<{ owner: string | null }>(
                `SELECT ${notificationOwnerSql('data_json')} AS owner FROM "${materializedTable}" WHERE id = ? AND workspace_id = ?`,
                op.pk,
                workspaceId
            );
            const owner = owned?.owner;
            if (owned && !owner) {
                const result = await retainPushFailureD1(originalOps.get(op.stamp.opId)!,new StoredRecordUnavailable(storedCanonicalSource(workspaceId,op.tableName,op.pk),'notification_owner_unavailable'),historyIncarnation,input.storedRecordCapability);
                rejected.add(op.stamp.opId);
                for (const index of indicesByOpId.get(op.stamp.opId) ?? []) resultSlots[index] = result;
                continue;
            }
            if ((owned && owner !== userId) || (!owned && op.operation === 'delete')) {
                rejected.add(op.stamp.opId);
                for (const index of indicesByOpId.get(op.stamp.opId) ?? []) {
                    resultSlots[index] = {
                        opId: op.stamp.opId,
                        success: false,
                        error: 'Forbidden: notification owner mismatch',
                        errorCode: 'UNAUTHORIZED',
                    };
                }
            }
        }

        const intentFingerprints = new Map(uniqueOps.map(op => [op.stamp.opId, operationFingerprint(op)]));
        const newOps = uniqueOps.filter(op => {
            if (existingOps.has(op.stamp.opId) || rejected.has(op.stamp.opId)) return false;
            try { Object.assign(op, prepareFinalOperation(op)); return true; }
            catch (error) {
                rejected.add(op.stamp.opId);
                for (const index of indicesByOpId.get(op.stamp.opId) ?? []) resultSlots[index] = {
                    opId: op.stamp.opId, success: false, error: (error as Error).message, errorCode: 'VALIDATION_ERROR',
                };
                return false;
            }
        });

        const existingMaterializedKeys = new Set<string>();
        const opsByTable = new Map<string, PendingOp[]>();
        for (const op of newOps) {
            const materializedTable = SYNCED_TABLE_MAP[op.tableName];
            if (!materializedTable) continue;
            const tableOps = opsByTable.get(materializedTable) ?? [];
            tableOps.push(op);
            opsByTable.set(materializedTable, tableOps);
        }
        for (const [materializedTable, tableOps] of opsByTable) {
            const ids = [...new Set(tableOps.map((op) => op.pk))];
            for (let offset = 0; offset < ids.length; offset += 500) {
                const chunk = ids.slice(offset, offset + 500);
                if (chunk.length === 0) continue;
                const placeholders = chunk.map(() => '?').join(',');
                const rows = await d1All<{ id: string }>(
                    `SELECT id FROM "${materializedTable}"
                     WHERE workspace_id = ? AND id IN (${placeholders})`,
                    workspaceId,
                    ...chunk
                );
                for (const row of rows) {
                    existingMaterializedKeys.add(`${materializedTable}\u0000${row.id}`);
                }
            }
        }

        const skipMaterialize = new Set<string>();
        for (const op of newOps) {
            if (op.operation !== 'put') continue;
            const materializedTable = SYNCED_TABLE_MAP[op.tableName];
            if (!materializedTable) continue;
            const materializedKey = `${materializedTable}\u0000${op.pk}`;
            if (existingMaterializedKeys.has(materializedKey)) continue;
            const [tombstone] = await d1All<{ clock: number; hlc: string; op_id: string }>(
                `SELECT clock, hlc, op_id FROM tombstones
                 WHERE workspace_id = ? AND table_name = ? AND pk = ?`,
                workspaceId,
                op.tableName,
                op.pk
            );
            if (
                tombstone &&
                !incomingWinsRevision(
                    {
                        clock: op.stamp.clock,
                        hlc: op.stamp.hlc,
                        opId: op.stamp.opId,
                    },
                    tombstone
                )
            ) {
                skipMaterialize.add(op.stamp.opId);
            }
        }

        const now = nowEpoch();
        const statements: D1SqlStatement[] = [historyAssertion(historyIncarnation)];
        if (input.repair) statements.push(repairAssertion(input.repair));
        if (input.workspaceItemCapability !== WORKSPACE_ITEM_CAPABILITY) {
            for (const op of uniqueOps) {
                if (rejected.has(op.stamp.opId) || !['posts', 'projects'].includes(op.tableName)) continue;
                if (hasWorkspaceItemSemantics(op.tableName, op.payload)) {
                    throw workspaceItemUpdateRequired();
                }
                statements.push(workspaceItemCapabilityAssertion(op, workspaceId));
            }
        }
        if (newOps.length > 0) {
            statements.push({
                sql: `INSERT OR IGNORE INTO server_version_counter (workspace_id, value)
                          VALUES (?, 0)`,
                parameters: [workspaceId],
            });
        }
        // Assert inside the atomic batch, so concurrent writers cannot exhaust
        // the counter after a preflight check. Invalid JSON paths abort D1 batches.
        if (newOps.length > 0) statements.push({
            sql: `SELECT json_extract('{}', CASE WHEN typeof(value) = 'integer'
                AND value >= 0 AND value <= ? THEN '$' ELSE 'OR3_SYNC_VERSION_EXHAUSTED' END)
                FROM server_version_counter WHERE workspace_id = ?`,
            parameters: [Number.MAX_SAFE_INTEGER - 1 - newOps.length, workspaceId],
        });
        const materializedStatementIndex = new Map<string, number>();
        const materializedWasExisting = new Map<string, boolean>();
        const seenMaterializedKeys = new Set<string>();
        for (const op of newOps) {
            const materializedTable = SYNCED_TABLE_MAP[op.tableName];
            if (!materializedTable) continue;
            const payloadJson = op.payload == null ? null : JSON.stringify(op.payload);
            const materializedKey = `${materializedTable}\u0000${op.pk}`;
            materializedWasExisting.set(
                op.stamp.opId,
                existingMaterializedKeys.has(materializedKey) ||
                    seenMaterializedKeys.has(materializedKey)
            );
            seenMaterializedKeys.add(materializedKey);

            statements.push({
                sql: `INSERT INTO change_log (
                    id, workspace_id, server_version, table_name, pk, op,
                    payload_json, clock, hlc, device_id, op_id, created_at, intent_fingerprint
                ) SELECT
                    ?, ?,
                    (SELECT value + 1 FROM server_version_counter WHERE workspace_id = ?),
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                ${op.tableName === 'notifications' ? `WHERE NOT EXISTS (
                    SELECT 1 FROM s_notifications WHERE id = ? AND workspace_id = ?
                    AND ${notificationOwnerSql('data_json')} IS NOT ?
                )` : ''}`,
                parameters: [
                    uid(),
                    workspaceId,
                    workspaceId,
                    op.tableName,
                    op.pk,
                    op.operation,
                    payloadJson,
                    op.stamp.clock,
                    op.stamp.hlc,
                    op.stamp.deviceId,
                    op.stamp.opId,
                    now,
                    intentFingerprints.get(op.stamp.opId),
                    ...(op.tableName === 'notifications' ? [op.pk, workspaceId, userId] : []),
                ],
            });

            // Only an admitted log entry consumes a version. This statement
            // immediately follows its INSERT in the atomic D1 batch, so
            // changes() is 0 for a denied notification and 1 for an accepted op.
            statements.push({
                sql: 'UPDATE server_version_counter SET value = value + changes() WHERE workspace_id = ?',
                parameters: [workspaceId],
            });

            if (skipMaterialize.has(op.stamp.opId)) continue;

            materializedStatementIndex.set(op.stamp.opId, statements.length);
            if (op.operation === 'put') {
                statements.push({
                    sql: `INSERT INTO "${materializedTable}" (
                        id, workspace_id, data_json, clock, hlc, device_id,
                        op_id, deleted, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                    ON CONFLICT(workspace_id, id) DO UPDATE SET
                        data_json = excluded.data_json,
                        clock = excluded.clock,
                        hlc = excluded.hlc,
                        device_id = excluded.device_id,
                        op_id = excluded.op_id,
                        deleted = 0,
                        updated_at = excluded.updated_at
                    WHERE ${lwwExcludedWins(`"${materializedTable}"`)}
                    ${op.tableName === 'notifications' ? `AND ${notificationOwnerSql(`"${materializedTable}".data_json`)} = json_extract(excluded.data_json, '$.user_id')` : ''}`,
                    parameters: [
                        op.pk,
                        workspaceId,
                        payloadJson ?? '{}',
                        op.stamp.clock,
                        op.stamp.hlc,
                        op.stamp.deviceId,
                        op.stamp.opId,
                        now,
                        now,
                    ],
                });
            } else {
                statements.push({
                    sql: `INSERT INTO "${materializedTable}" (
                        id, workspace_id, data_json, clock, hlc, device_id,
                        op_id, deleted, created_at, updated_at
                    ) VALUES (?, ?, '{}', ?, ?, ?, ?, 1, ?, ?)
                    ON CONFLICT(workspace_id, id) DO UPDATE SET
                        clock = excluded.clock,
                        hlc = excluded.hlc,
                        device_id = excluded.device_id,
                        op_id = excluded.op_id,
                        deleted = 1,
                        updated_at = excluded.updated_at
                    WHERE ${lwwExcludedWins(`"${materializedTable}"`)}
                    ${op.tableName === 'notifications' ? 'AND EXISTS (SELECT 1 FROM change_log WHERE op_id=?)' : ''}`,
                    parameters: [
                        op.pk,
                        workspaceId,
                        op.stamp.clock,
                        op.stamp.hlc,
                        op.stamp.deviceId,
                        op.stamp.opId,
                        now,
                        now,
                        ...(op.tableName === 'notifications' ? [op.stamp.opId] : []),
                    ],
                });
                statements.push({
                    sql: `INSERT INTO tombstones (
                        id, workspace_id, table_name, pk, deleted_at, clock,
                        hlc, op_id, server_version, created_at
                    ) SELECT
                        ?, ?, ?, ?, ?, ?, ?, ?,
                        (SELECT value FROM server_version_counter WHERE workspace_id = ?),
                        ?
                    WHERE ${op.tableName === 'notifications' ? 'EXISTS (SELECT 1 FROM change_log WHERE op_id=?)' : '1'}
                    ON CONFLICT(workspace_id, table_name, pk) DO UPDATE SET
                        deleted_at = excluded.deleted_at,
                        clock = excluded.clock,
                        hlc = excluded.hlc,
                        op_id = excluded.op_id,
                        server_version = excluded.server_version
                    WHERE ${lwwExcludedWins('tombstones')}`,
                    parameters: [
                        uid(),
                        workspaceId,
                        op.tableName,
                        op.pk,
                        now,
                        op.stamp.clock,
                        op.stamp.hlc,
                        op.stamp.opId,
                        workspaceId,
                        now,
                        ...(op.tableName === 'notifications' ? [op.stamp.opId] : []),
                    ],
                });
            }
        }

        const finalVersionResultIndex = newOps.length > 0 ? statements.length : undefined;
        if (finalVersionResultIndex !== undefined) {
            statements.push({
                sql: 'SELECT value FROM server_version_counter WHERE workspace_id = ?',
                parameters: [workspaceId],
            });
        }
        let batchResults: Awaited<ReturnType<typeof d1Batch>>;
        try {
            batchResults = statements.length > 0 ? await d1Batch(input.repair && newOps.length ? [...statements,repairResolution(input.repair,newOps[0]!.stamp.opId)] : statements) : [];
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('OR3_SYNC_HISTORY_CHANGED')) historyChanged(await readHistoryIncarnation());
            if (/JSON path/i.test(message) && message.includes('OR3_SYNC_VERSION_EXHAUSTED')) {
                throw Object.assign(new Error('Sync server version exhausted or invalid'), { code: 'VALIDATION_ERROR' });
            }
            if (/JSON path/i.test(message) && message.includes(WORKSPACE_ITEM_UPDATE_REQUIRED)) {
                throw workspaceItemUpdateRequired();
            }
            throw error;
        }
        let finalServerVersion = 0;
        if (finalVersionResultIndex !== undefined) {
            const row = batchResults[finalVersionResultIndex]?.results?.[0] as
                | { value?: number }
                | undefined;
            if (typeof row?.value !== 'number') {
                throw new Error('D1 did not return a workspace version counter.');
            }
            finalServerVersion = row.value;
        } else if (uniqueOps.length > 0) {
            const [counter] = await d1All<{ value: number }>(
                'SELECT value FROM server_version_counter WHERE workspace_id = ?',
                workspaceId
            );
            finalServerVersion = counter?.value ?? 0;
        }
        const opIds = uniqueOps.filter(op => !rejected.has(op.stamp.opId)).map(op => op.stamp.opId);
        const resolvedOps = new Map<string, number>();
        for (let offset = 0; offset < opIds.length; offset += 500) {
            const chunk = opIds.slice(offset, offset + 500);
            if (chunk.length === 0) continue;
            const placeholders = chunk.map(() => '?').join(',');
            const rows = await d1All<{ op_id: string; server_version: number }>(
                `SELECT op_id, server_version FROM change_log WHERE op_id IN (${placeholders})`,
                ...chunk
            );
            for (const row of rows) resolvedOps.set(row.op_id, row.server_version);
        }

        const emissions: HookEmission[] = [];
        for (const op of uniqueOps) {
            if (rejected.has(op.stamp.opId)) continue;
            try {
                const winner = await currentWinnerD1(workspaceId,op.tableName,op.pk,userId);
                if (op.tableName === 'notifications') {
                    const [owned] = await d1All<{ owner: string | null }>(
                        `SELECT ${notificationOwnerSql('data_json')} AS owner FROM s_notifications WHERE id = ? AND workspace_id = ?`, op.pk, workspaceId
                    );
                    if (owned && !owned.owner) throw new StoredRecordUnavailable(storedCanonicalSource(workspaceId,op.tableName,op.pk),'notification_owner_unavailable');
                    if (owned && owned.owner !== userId) {
                        for (const index of indicesByOpId.get(op.stamp.opId) ?? []) {
                            resultSlots[index] = { opId: op.stamp.opId, success: false, error: 'Forbidden: notification owner mismatch', errorCode: 'UNAUTHORIZED' };
                        }
                        continue;
                    }
                }
                const existing = existingOps.get(op.stamp.opId);
                if (existing) {
                    if (!winner) throw new StoredRecordUnavailable(storedReceiptSource(existing),'stored_winner_missing');
                    const applied = winner?.revision.opId === op.stamp.opId;
                    const result: PushResult['results'][number] = {
                        opId: op.stamp.opId,
                        success: true,
                        serverVersion: existing.server_version,
                        replayed: true,
                        applied,
                        ...(applied ? {} : { winner }),
                    };
                    for (const index of indicesByOpId.get(op.stamp.opId) ?? []) {
                        resultSlots[index] = result;
                    }
                    continue;
                }
                const serverVersion = resolvedOps.get(op.stamp.opId);
                if (serverVersion === undefined) {
                    throw new Error(`D1 failed to resolve sync operation ${op.stamp.opId}.`);
                }
                const skipApply = skipMaterialize.has(op.stamp.opId);
                const materializedResult = batchResults[materializedStatementIndex.get(op.stamp.opId) ?? -1];
                const applied = !skipApply && (materializedResult?.meta?.changes ?? 0) > 0;
                const winnerPayload = winner?.kind === 'put' ? winner.payload : undefined;
                const result: PushResult['results'][number] = {
                    opId: op.stamp.opId,
                    success: true,
                    serverVersion,
                    applied,
                    ...(applied ? {} : { payload: winnerPayload }),
                    ...(applied ? {} : {
                        winner,
                    }),
                };
                for (const index of indicesByOpId.get(op.stamp.opId) ?? []) {
                    resultSlots[index] = result;
                }

                if (applied) {
                    const emission = resolveHookEmission({
                        op,
                        workspaceId,
                        now,
                        userId,
                        wasExisting:
                            materializedWasExisting.get(op.stamp.opId) ?? false,
                        applied: true,
                    });
                    if (emission) emissions.push(emission);
                }
            } catch (error) {
                if (!(error instanceof StoredRecordUnavailable)) throw error;
                const result = await retainPushFailureD1(originalOps.get(op.stamp.opId)!,error,historyIncarnation,input.storedRecordCapability);
                for (const index of indicesByOpId.get(op.stamp.opId) ?? []) resultSlots[index] = result;
            }
        }

        for (const emission of emissions) {
            await emitWebhookSystemHook(emission.hookName, emission.payload);
        }
        return {
            results: resultSlots.filter(
                (result): result is PushResult['results'][number] => Boolean(result)
            ),
            serverVersion: finalServerVersion,
            historyIncarnation,
        };
    }

    async listWorkspaceIds(): Promise<string[]> {
        if (isD1Driver()) {
            const rows = await d1All<{ id: string }>(
                'SELECT id FROM workspaces WHERE deleted = 0 ORDER BY id ASC'
            );
            return rows.map((row) => row.id);
        }
        const raw = getRawDb();
        const rows = raw.prepare(
            'SELECT id FROM workspaces WHERE deleted = 0 ORDER BY id ASC'
        ).all() as Array<{ id: string }>;
        return rows.map((row) => row.id);
    }

    getMaintenanceState(): SyncMaintenanceState {
        return getSyncMaintenanceState();
    }

    beginMaintenanceRun(): void {
        beginSyncMaintenanceRun();
    }

    completeMaintenanceRun(input: { lastRun: string }): void {
        const backlog = computeSyncMaintenanceBacklog(SYNC_MAINTENANCE_RETENTION_SECONDS, true);
        completeSyncMaintenanceRun({ lastRun: input.lastRun, backlog });
    }

    failMaintenanceRun(error: string): void {
        failSyncMaintenanceRun(error);
    }
}

export function createSqliteSyncGatewayAdapter(): SqliteSyncGatewayAdapter {
    return new SqliteSyncGatewayAdapter();
}
