/**
 * SQLite implementation of SyncGatewayAdapter.
 *
 * Handles push/pull/updateCursor/gc using the selected native SQLite runtime.
 * Local runtimes use raw BEGIN IMMEDIATE transactions; Cloudflare D1 uses
 * native atomic batches for its asynchronous binding.
 */
import type { H3Event } from 'h3';
import { createHash } from 'node:crypto';
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
import { computePullRetention } from './history-gc-policy';

const DEFAULT_PULL_LIMIT = 100;
const MAX_PULL_LIMIT = 1000;
const MAX_SNAPSHOT_PAGE_SIZE = 1000;
const DEFAULT_CANONICAL_STORAGE_PAGE_SIZE = 100;
const MAX_CANONICAL_STORAGE_PAGE_SIZE = 500;
const SNAPSHOT_TTL_SECONDS = 60 * 60;
const SESSION_CONTEXT_KEY_PREFIX = '__or3_session_context_';
const MIN_SYNC_RETENTION_SECONDS = 60 * 60;
const MAX_SYNC_RETENTION_SECONDS = 365 * 24 * 60 * 60;
const MAX_SYNC_PAYLOAD_BYTES = 256 * 1024;

type SnapshotKind = 'row' | 'tombstone';

type SnapshotPageToken = {
    version: 1;
    snapshotId: string;
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

type SnapshotItemRow = {
    table_name: string;
    pk: string;
    kind: SnapshotKind;
    payload_json: string | null;
    clock: number;
    hlc: string;
    op_id: string;
    server_deleted_at: number | null;
};

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

function nowEpoch(): number {
    return Math.floor(Date.now() / 1000);
}

function stableJson(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(',')}}`;
}

function backgroundHistoryOpId(
    admission: Pick<ChatGenerationAdmissionEnvelope, 'workspaceId' | 'generationId'>,
    stage: 'thread' | 'user' | 'assistant' | 'finalize'
): string {
    const hex = createHash('sha256')
        .update(`${admission.workspaceId}\0${admission.generationId}\0${stage}`)
        .digest('hex')
        .slice(0, 32)
        .split('');
    hex[12] = '4';
    hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
    const value = hex.join('');
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function operationFingerprint(op: PendingOp): string {
    return stableJson({
        tableName: op.tableName,
        operation: op.operation,
        pk: op.pk,
        payload: op.payload,
        clock: op.stamp.clock,
        hlc: op.stamp.hlc,
        deviceId: op.stamp.deviceId,
    });
}

function changeLogFingerprint(row: {
    table_name: string;
    op: string;
    pk: string;
    payload_json: string | null;
    clock: number;
    hlc: string;
    device_id: string;
}): string {
    return stableJson({
        tableName: row.table_name,
        operation: row.op,
        pk: row.pk,
        payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
        clock: row.clock,
        hlc: row.hlc,
        deviceId: row.device_id,
    });
}

function notificationPayloadUserId(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return undefined;
    }
    const userId = (payload as Record<string, unknown>).user_id;
    return typeof userId === 'string' && userId.trim().length > 0 ? userId : undefined;
}

function isNotificationVisibleToUser(
    change: { tableName: string; payload?: unknown },
    userId: string | undefined
): boolean {
    if (change.tableName !== 'notifications') return true;
    if (!userId) return false;
    return notificationPayloadUserId(change.payload) === userId;
}

function scopeNotificationWrite(
    op: PendingOp,
    userId: string | undefined
): PendingOp | string {
    if (op.tableName !== 'notifications') return op;
    if (!userId) {
        return 'Unauthorized: notification writes require a session user';
    }
    if (op.operation !== 'put') return op;
    const payload =
        op.payload && typeof op.payload === 'object' && !Array.isArray(op.payload)
            ? { ...(op.payload as Record<string, unknown>) }
            : {};
    if (payload.user_id !== undefined && payload.user_id !== userId) {
        return 'Forbidden: notification owner mismatch';
    }
    return { ...op, payload: { ...payload, user_id: userId } };
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
        sql: ` AND json_extract(${jsonExpr}, '$.user_id') = ?`,
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
};

type TombstoneWinnerRow = {
    clock: number;
    hlc: string;
    op_id: string;
    deleted_at: number;
};

function materializedWinner(
    row: MaterializedWinnerRow | undefined,
    tombstone: TombstoneWinnerRow | undefined
): PushWinner | undefined {
    if (
        tombstone &&
        (!row || incomingWinsRevision(
            { clock: tombstone.clock, hlc: tombstone.hlc, opId: tombstone.op_id },
            row
        ))
    ) {
        return {
            kind: 'delete',
            revision: { clock: tombstone.clock, hlc: tombstone.hlc, opId: tombstone.op_id },
            serverDeletedAt: tombstone.deleted_at,
        };
    }
    if (!row) return undefined;
    const revision = { clock: row.clock, hlc: row.hlc, opId: row.op_id };
    return row.deleted
        ? {
              kind: 'delete',
              revision,
              serverDeletedAt: tombstone?.op_id === row.op_id
                  ? tombstone.deleted_at
                  : row.updated_at,
          }
        : { kind: 'put', payload: JSON.parse(row.data_json), revision };
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
        `SELECT data_json, deleted, clock, hlc, op_id, updated_at
         FROM ${materializedTable} WHERE id = ? AND workspace_id = ?`
    ).get(pk, workspaceId) as MaterializedWinnerRow | undefined;
    const tombstone = raw.prepare(
        `SELECT clock, hlc, op_id, deleted_at FROM tombstones
         WHERE workspace_id = ? AND table_name = ? AND pk = ?`
    ).get(workspaceId, tableName, pk) as TombstoneWinnerRow | undefined;
    return materializedWinner(row, tombstone);
}

async function currentWinnerD1(
    workspaceId: string,
    tableName: string,
    pk: string
): Promise<PushWinner | undefined> {
    const materializedTable = SYNCED_TABLE_MAP[tableName];
    if (!materializedTable) return undefined;
    const [row] = await d1All<MaterializedWinnerRow>(
        `SELECT data_json, deleted, clock, hlc, op_id, updated_at
         FROM "${materializedTable}" WHERE id = ? AND workspace_id = ?`,
        pk,
        workspaceId
    );
    const [tombstone] = await d1All<TombstoneWinnerRow>(
        `SELECT clock, hlc, op_id, deleted_at FROM tombstones
         WHERE workspace_id = ? AND table_name = ? AND pk = ?`,
        workspaceId,
        tableName,
        pk
    );
    return materializedWinner(row, tombstone);
}

export class SqliteSyncGatewayAdapter implements SyncGatewayAdapter {
    id = 'sqlite';
    get capabilities() {
        return isD1Driver()
            ? ({
                  snapshotBootstrap: 'snapshot-v1',
                  historyRetention: 'snapshot-v1',
              } as const)
            : ({
                  snapshotBootstrap: 'snapshot-v1',
                  historyRetention: 'snapshot-v1',
                  backgroundGenerationHistory: 'v1',
              } as const);
    }

    private get db() {
        return getSqliteDb();
    }

    private assertCanonicalActor(actor: CanonicalHistoryActor): void {
        if (isD1Driver()) {
            throw new Error('SQLite D1 does not support background generation history v1');
        }
        const membership = getRawDb()
            .prepare(
                `SELECT role FROM workspace_members
                 WHERE workspace_id = ? AND user_id = ?`
            )
            .get(actor.workspaceId, actor.userId) as { role: string } | undefined;
        if (!membership || (membership.role !== 'owner' && membership.role !== 'editor')) {
            throw new Error('Forbidden background history actor');
        }
    }

    async admitChatGeneration(
        actor: CanonicalHistoryActor,
        input: ChatGenerationAdmissionEnvelope
    ): Promise<AdmitChatGenerationResult> {
        const admission = parseChatGenerationAdmissionEnvelope(input);
        if (actor.workspaceId !== admission.workspaceId) {
            throw new Error('Invalid background history workspace');
        }
        const raw = getRawDb();
        const fingerprint = createHash('sha256')
            .update(stableJson(admission))
            .digest('hex');
        return raw.transaction(() => {
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
                    throw new Error('Conflicting background admission replay');
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
                    throw new Error('Conflicting continuation admission');
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
            const counter = raw
                .prepare('SELECT value FROM server_version_counter WHERE workspace_id = ?')
                .get(admission.workspaceId) as { value: number } | undefined;
            const baseVersion = counter?.value ?? 0;
            const finalVersion = baseVersion + records.length;
            raw.prepare(
                `INSERT INTO server_version_counter (workspace_id, value) VALUES (?, ?)
                 ON CONFLICT(workspace_id) DO UPDATE SET value = excluded.value`
            ).run(admission.workspaceId, finalVersion);
            const now = nowEpoch();
            records.forEach((entry, index) => {
                const opId = backgroundHistoryOpId(
                    admission,
                    entry.table === 'threads'
                        ? 'thread'
                        : entry.record.id === admission.messageId
                          ? 'assistant'
                          : 'user'
                );
                const hlc = entry.record.hlc ?? `${Date.now().toString(36).padStart(9, '0')}:000:background`;
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
                    throw new Error('Background history record was superseded');
                }
                const sanitized = sanitizePayloadForSync(
                    entry.table,
                    entry.record,
                    'put'
                );
                if (!sanitized) {
                    throw new Error('Invalid background history payload');
                }
                const payload = { ...sanitized, hlc, op_id: opId };
                const payloadJson = JSON.stringify(payload);
                if (new TextEncoder().encode(payloadJson).byteLength > MAX_SYNC_PAYLOAD_BYTES) {
                    throw new Error('Invalid background history payload size');
                }
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
                raw.prepare(
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
                throw new Error('Background assistant admission was superseded');
            }
            raw.prepare(
                `INSERT INTO background_generation_receipts
                 (id, workspace_id, generation_id, stage, fingerprint, outcome,
                  server_version, created_at)
                 VALUES (?, ?, ?, 'admission', ?, 'admitted', ?, ?)`
            ).run(uid(), admission.workspaceId, admission.generationId, fingerprint, finalVersion, now);
            return { status: 'admitted' as const, replayed: false, serverVersion: finalVersion };
        }).immediate();
    }

    async finalizeChatGeneration(
        actor: CanonicalHistoryActor,
        input: {
            admission: ChatGenerationAdmissionEnvelope;
            snapshot: CanonicalGenerationSnapshot;
        }
    ): Promise<FinalizeChatGenerationResult> {
        const admission = parseChatGenerationAdmissionEnvelope(input.admission);
        if (actor.workspaceId !== admission.workspaceId) {
            throw new Error('Invalid background history workspace');
        }
        const raw = getRawDb();
        const fingerprint = createHash('sha256')
            .update(stableJson(input))
            .digest('hex');
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
                    throw new Error('Conflicting background finalization replay');
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
            if (!row || !current) superseded = 'missing';
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
            const nextClock = row!.clock + 1;
            const hlc = `${Date.now().toString(36).padStart(9, '0')}:000:background`;
            const opId = backgroundHistoryOpId(admission, 'finalize');
            const terminalState = input.snapshot.status === 'complete'
                ? 'complete'
                : input.snapshot.status === 'aborted'
                  ? 'aborted'
                  : 'failed';
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
                    content: input.snapshot.content,
                    reasoning_text: input.snapshot.reasoning || null,
                    tool_calls: input.snapshot.toolCalls ?? null,
                    generation_state: terminalState,
                    background_job_status: input.snapshot.status,
                    background_job_error: input.snapshot.error ?? null,
                    error: input.snapshot.error ?? null,
                },
            };
            const payloadJson = JSON.stringify(payload);
            if (new TextEncoder().encode(payloadJson).byteLength > MAX_SYNC_PAYLOAD_BYTES) {
                throw new Error('Invalid background history payload size');
            }
            const counter = raw
                .prepare('SELECT value FROM server_version_counter WHERE workspace_id = ?')
                .get(admission.workspaceId) as { value: number } | undefined;
            const serverVersion = (counter?.value ?? 0) + 1;
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
            const liveRows = raw.prepare(`SELECT id, data_json FROM s_file_meta
                WHERE workspace_id = ? AND deleted = 0`).all(input.workspaceId) as Array<{
                    id: string; data_json: string;
                }>;
            let usedBytes = 0;
            let alreadyStored = false;
            for (const row of liveRows) {
                const payload = JSON.parse(row.data_json) as Record<string, unknown>;
                const size = payload.size_bytes ?? payload.sizeBytes;
                if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
                    throw createError({ statusCode: 500, statusMessage: 'Invalid canonical file size' });
                }
                usedBytes += size;
                if (normalizeStorageHash(row.id) === hash) alreadyStored = true;
            }
            const totals = raw.prepare(`SELECT
                    COALESCE(SUM(reserved_bytes), 0) AS reserved_bytes,
                    MAX(CASE WHEN hash = ? AND reserved_bytes > 0 THEN 1 ELSE 0 END) AS same_hash
                FROM upload_intents WHERE workspace_id = ? AND status = 'active' AND expires_at > ?`)
                .get(hash, input.workspaceId, now) as { reserved_bytes: number; same_hash: number | null };
            const reservedBytes = alreadyStored || totals.same_hash === 1 ? 0 : input.sizeBytes;
            if (input.workspaceQuotaBytes !== undefined &&
                usedBytes + totals.reserved_bytes + reservedBytes > input.workspaceQuotaBytes) {
                throw createError({ statusCode: 413, statusMessage: 'Workspace storage quota exceeded' });
            }
            raw.prepare(`INSERT INTO upload_intents (
                    id, workspace_id, hash, mime_type, size_bytes, reserved_bytes,
                    expires_at, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
                .run(input.intentId, input.workspaceId, hash, input.mimeType, input.sizeBytes,
                    reservedBytes, input.expiresAt, now);
        })();
    }

    async consumeUploadIntent(event: H3Event, input: UploadIntentConsumptionRequest): Promise<void> {
        await assertWorkspaceScopeAuthorized(event, input.workspaceId);
        if (isD1Driver()) {
            const now = nowEpoch();
            const result = await d1Run(
                `UPDATE upload_intents
                 SET status = 'consumed', storage_id = ?, consumed_at = ?
                 WHERE id = ? AND workspace_id = ? AND status = 'active' AND expires_at > ?
                   AND hash = ? AND mime_type = ? AND size_bytes = ?`,
                input.storageId,
                now,
                input.intentId,
                input.workspaceId,
                now,
                normalizeStorageHash(input.hash),
                input.mimeType,
                input.sizeBytes
            );
            if ((result.meta?.changes ?? 0) !== 1) {
                throw createError({ statusCode: 409, statusMessage: 'Upload intent expired, mismatched, or already consumed' });
            }
            return;
        }
        const raw = getRawDb();
        const result = raw.prepare(`UPDATE upload_intents
            SET status = 'consumed', storage_id = ?, consumed_at = ?
            WHERE id = ? AND workspace_id = ? AND status = 'active' AND expires_at > ?
              AND hash = ? AND mime_type = ? AND size_bytes = ?`)
            .run(input.storageId, nowEpoch(), input.intentId, input.workspaceId, nowEpoch(),
                normalizeStorageHash(input.hash), input.mimeType, input.sizeBytes);
        if (result.changes !== 1) {
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
            }>(`SELECT id, hash, reserved_bytes, expires_at
                FROM upload_intents
                WHERE workspace_id = ? AND status = 'active' AND expires_at > ?
                  AND id > ? AND reserved_bytes > 0 AND (? IS NULL OR hash = ?)
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

        if (input.kind === 'live_metadata') {
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
                  AND deleted = 0
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
            `, workspaceId, after[0] ?? '', hash ?? null, hash ?? null, limit + 1);

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
                if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
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
                return {
                    kind: 'metadata' as const,
                    hash: normalizeStorageHash(row.id),
                    sizeBytes: size,
                    ...(typeof storageId === 'string' && storageId ? { storageId } : {}),
                    ...(typeof (payload.mime_type ?? payload.mimeType) === 'string'
                        ? { mimeType: String(payload.mime_type ?? payload.mimeType) }
                        : {}),
                    ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
                    ...(fileKind ? { fileKind } : {}),
                    updatedAt: row.updated_at,
                };
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

    async push(event: H3Event, input: PushBatch): Promise<PushResult> {
        const { scope, ops } = input;
        const workspaceId = scope.workspaceId;
        await assertWorkspaceScopeAuthorized(event, workspaceId);

        if (!ops.length) {
            return { results: [], serverVersion: 0 };
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
            uniqueOps.push(scoped as PendingOp);
            indicesByOpId.set(group.op.stamp.opId, group.indices);
        }

        if (isD1Driver()) {
            return this.pushInD1({
                event,
                workspaceId,
                uniqueOps,
                resultSlots,
                indicesByOpId,
                userId,
            });
        }

        // Use raw better-sqlite3 transaction for BEGIN IMMEDIATE semantics
        const raw = getRawDb();
        const now = nowEpoch();

        const uniqueResults: PushResult['results'] = [];
        let finalServerVersion = 0;
        const hookEmissions: HookEmission[] = [];

        const runTx = raw.transaction(() => {
            // Check for existing op_ids (idempotency)
            const opIds = uniqueOps.map((o) => o.stamp.opId);
            const existingOps = new Map<string, {
                server_version: number;
                workspace_id: string;
                fingerprint: string;
                op_id: string;
            }>();

            // Query in chunks to avoid SQLite variable limits
            const chunkSize = 500;
            for (let i = 0; i < opIds.length; i += chunkSize) {
                const chunk = opIds.slice(i, i + chunkSize);
                const placeholders = chunk.map(() => '?').join(',');
                const rows = raw
                    .prepare(
                        `SELECT op_id, server_version, workspace_id, table_name, pk, op,
                                payload_json, clock, hlc, device_id
                         FROM change_log WHERE op_id IN (${placeholders})`
                    )
                    .all(...chunk) as Array<{
                        op_id: string;
                        server_version: number;
                        workspace_id: string;
                        table_name: string;
                        pk: string;
                        op: string;
                        payload_json: string | null;
                        clock: number;
                        hlc: string;
                        device_id: string;
                    }>;

                for (const row of rows) {
                    existingOps.set(row.op_id, {
                        server_version: row.server_version,
                        workspace_id: row.workspace_id,
                        fingerprint: changeLogFingerprint(row),
                        op_id: row.op_id,
                    });
                }
            }

            const failedBeforeAlloc = new Set<string>();
            for (const op of uniqueOps) {
                if (op.tableName !== 'notifications' || op.operation !== 'delete') continue;
                const materializedTable = SYNCED_TABLE_MAP[op.tableName];
                if (!materializedTable) continue;
                const owned = raw
                    .prepare(
                        `SELECT data_json FROM ${materializedTable} WHERE id = ? AND workspace_id = ?`
                    )
                    .get(op.pk, workspaceId) as { data_json: string } | undefined;
                const owner = owned
                    ? notificationPayloadUserId(JSON.parse(owned.data_json))
                    : undefined;
                if (!owned || owner !== userId) {
                    failedBeforeAlloc.add(op.stamp.opId);
                    uniqueResults.push({
                        opId: op.stamp.opId,
                        success: false,
                        error: 'Forbidden: notification owner mismatch',
                        errorCode: 'UNAUTHORIZED',
                    });
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

            if (counterRow) {
                baseVersion = counterRow.value;
                raw.prepare(
                    'UPDATE server_version_counter SET value = ? WHERE workspace_id = ?'
                ).run(baseVersion + uniqueNewOpIds.size, workspaceId);
            } else {
                baseVersion = 0;
                raw.prepare(
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
                        existingLog.fingerprint !== operationFingerprint(op)
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

                if (op.tableName === 'notifications' && op.operation === 'delete') {
                    const owned = raw
                        .prepare(
                            `SELECT data_json FROM ${materializedTable} WHERE id = ? AND workspace_id = ?`
                        )
                        .get(pkValue, workspaceId) as { data_json: string } | undefined;
                    const owner = owned
                        ? notificationPayloadUserId(JSON.parse(owned.data_json))
                        : undefined;
                    if (!owned || owner !== userId) {
                        uniqueResults.push({
                            opId,
                            success: false,
                            error: 'Forbidden: notification owner mismatch',
                            errorCode: 'UNAUTHORIZED',
                        });
                        continue;
                    }
                }

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

                const incomingRev = {
                    clock: op.stamp.clock,
                    hlc: op.stamp.hlc,
                    opId,
                };

                // Apply to materialized table using LWW
                if (op.operation === 'put') {
                    const existing = raw
                        .prepare(
                            `SELECT clock, hlc, op_id, data_json FROM ${materializedTable} WHERE id = ? AND workspace_id = ?`
                        )
                        .get(pkValue, workspaceId) as
                        | { clock: number; hlc: string; op_id: string; data_json: string }
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
                        winnerPayload = JSON.parse(existing.data_json);
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
                            `SELECT clock, hlc, op_id, data_json FROM ${materializedTable} WHERE id = ? AND workspace_id = ?`
                        )
                        .get(pkValue, workspaceId) as
                        | { clock: number; hlc: string; op_id: string; data_json: string }
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
                            : { payload: JSON.parse(existing.data_json) }),
                        ...(applied ? {} : {
                            winner: currentWinnerNative(raw, workspaceId, op.tableName, pkValue),
                        }),
                    });
                }
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
        };
    }

    async pull(event: H3Event, input: PullRequest): Promise<PullResponse> {
        const db = this.db;
        const { scope, cursor, limit, tables } = input;
        await assertWorkspaceScopeAuthorized(event, scope.workspaceId);
        const fetchLimit = resolvePullLimit(limit);

        let query = db
            .selectFrom('change_log')
            .selectAll()
            .where('workspace_id', '=', scope.workspaceId)
            .where('server_version', '>', cursor)
            .orderBy('server_version', 'asc')
            .limit(fetchLimit + 1);

        if (tables?.length) {
            query = query.where('table_name', 'in', tables);
        }

        const rows = await query.execute();

        const hasMore = rows.length > fetchLimit;
        const resultRows = hasMore ? rows.slice(0, fetchLimit) : rows;

        const changes: SyncChange[] = resultRows.map((row) => ({
            serverVersion: row.server_version,
            tableName: row.table_name,
            pk: row.pk,
            op: row.op as 'put' | 'delete',
            payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
            stamp: {
                clock: row.clock,
                hlc: row.hlc,
                deviceId: row.device_id,
                opId: row.op_id,
            },
        })).filter((change) =>
            isNotificationVisibleToUser(change, resolveSessionUserId(event))
        );

        const lastRow = resultRows[resultRows.length - 1];
        const nextCursor = lastRow ? lastRow.server_version : cursor;

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
        const retention = computePullRetention({
            cursor,
            oldestLogVersion: minLog?.server_version ?? null,
            highWatermark: counter?.value ?? 0,
        });

        return {
            changes,
            nextCursor,
            hasMore,
            ...retention,
        };
    }

    async snapshot(
        event: H3Event,
        input: SnapshotRequest
    ): Promise<SnapshotResponse> {
        const workspaceId = input.scope.workspaceId;
        await assertWorkspaceScopeAuthorized(event, workspaceId);
        const pageSize = resolveSnapshotPageSize(input.pageSize);
        const snapshotUserId = resolveSessionUserId(event);
        if (isD1Driver()) {
            return this.snapshotInD1(workspaceId, input, pageSize, snapshotUserId);
        }
        const raw = getRawDb();
        const now = nowEpoch();

        let header: SnapshotHeaderRow;
        let after: SnapshotPageToken['after'] | undefined;

        if (input.pageToken) {
            if (input.pageToken.length > 4096) {
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
            if (
                input.tables &&
                existing.tables_json !== JSON.stringify(normalizeSnapshotTables(input.tables))
            ) {
                throw createError({
                    statusCode: 400,
                    statusMessage: 'Snapshot table filter cannot change between pages',
                });
            }

            header = existing;
            after = token.after;
        } else {
            const tables = normalizeSnapshotTables(input.tables);
            const snapshotId = uid();
            const expiresAt = now + SNAPSHOT_TTL_SECONDS;

            const capture = raw.transaction((): SnapshotHeaderRow => {
                // Opportunistic bounded-lifetime cleanup. Cascading deletion removes
                // immutable item rows for abandoned or completed snapshots.
                raw.prepare('DELETE FROM sync_snapshots WHERE expires_at <= ?').run(now);

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
                    raw.prepare(`
                        INSERT INTO sync_snapshot_items (
                            snapshot_id, table_name, pk, kind, payload_json,
                            clock, hlc, op_id, server_deleted_at
                        )
                        SELECT
                            ?, ?, materialized.id, 'tombstone', NULL,
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
                            ))
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

        const rows = after
            ? raw.prepare(`
                SELECT
                    table_name, pk, kind, payload_json, clock, hlc, op_id,
                    server_deleted_at
                FROM sync_snapshot_items
                WHERE snapshot_id = ?
                  AND (
                      table_name > ?
                      OR (table_name = ? AND pk > ?)
                      OR (table_name = ? AND pk = ? AND kind > ?)
                  )
                ORDER BY table_name ASC, pk ASC, kind ASC
                LIMIT ?
            `).all(
                header.id,
                after.tableName,
                after.tableName,
                after.pk,
                after.tableName,
                after.pk,
                after.kind,
                pageSize + 1
            ) as SnapshotItemRow[]
            : raw.prepare(`
                SELECT
                    table_name, pk, kind, payload_json, clock, hlc, op_id,
                    server_deleted_at
                FROM sync_snapshot_items
                WHERE snapshot_id = ?
                ORDER BY table_name ASC, pk ASC, kind ASC
                LIMIT ?
            `).all(header.id, pageSize + 1) as SnapshotItemRow[];

        const hasMore = rows.length > pageSize;
        const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
        const items: SnapshotItem[] = pageRows.map((row) => {
            const revision = {
                clock: row.clock,
                hlc: row.hlc,
                opId: row.op_id,
            };
            if (row.kind === 'row') {
                return {
                    kind: 'row',
                    tableName: row.table_name,
                    pk: row.pk,
                    payload: JSON.parse(row.payload_json ?? 'null') as unknown,
                    revision,
                };
            }
            return {
                kind: 'tombstone',
                tableName: row.table_name,
                pk: row.pk,
                revision,
                serverDeletedAt: row.server_deleted_at ?? 0,
            };
        });

        const lastRow = pageRows.at(-1);
        const nextPageToken = hasMore && lastRow
            ? encodeSnapshotPageToken({
                version: 1,
                snapshotId: header.id,
                after: {
                    tableName: lastRow.table_name,
                    pk: lastRow.pk,
                    kind: lastRow.kind,
                },
            })
            : null;

        return {
            workspaceId: header.workspace_id,
            snapshotId: header.id,
            highWatermark: header.high_watermark,
            items,
            nextPageToken,
        };
    }

    async updateCursor(
        event: H3Event,
        input: { scope: { workspaceId: string }; deviceId: string; version: number }
    ): Promise<void> {
        await assertWorkspaceScopeAuthorized(event, input.scope.workspaceId);
        const now = nowEpoch();
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
            return this.updateCursorInD1(input.scope.workspaceId, deviceId, input.version, ownerUserId, now);
        }
        const raw = getRawDb();
        const update = raw.transaction(() => {
            const counter = raw.prepare(
                'SELECT value FROM server_version_counter WHERE workspace_id = ?'
            ).get(input.scope.workspaceId) as { value: number } | undefined;
            const maximum = counter?.value ?? 0;
            if (input.version > maximum) {
                throw createError({ statusCode: 400, statusMessage: 'Cursor exceeds workspace version' });
            }

            const existing = raw.prepare(
                `SELECT owner_user_id, last_seen_version
                 FROM device_cursors WHERE workspace_id = ? AND device_id = ?`
            ).get(input.scope.workspaceId, deviceId) as {
                owner_user_id: string | null;
                last_seen_version: number;
            } | undefined;
            if (existing?.owner_user_id && existing.owner_user_id !== ownerUserId) {
                throw createError({ statusCode: 403, statusMessage: 'Device cursor belongs to another user' });
            }
            if (existing && input.version < existing.last_seen_version) {
                throw createError({ statusCode: 409, statusMessage: 'Device cursor cannot regress' });
            }

            raw.prepare(
                `INSERT INTO device_cursors (
                    id, workspace_id, device_id, owner_user_id, last_seen_version, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(workspace_id, device_id) DO UPDATE SET
                   owner_user_id = COALESCE(device_cursors.owner_user_id, excluded.owner_user_id),
                   last_seen_version = excluded.last_seen_version,
                   updated_at = excluded.updated_at`
            ).run(uid(), input.scope.workspaceId, deviceId, ownerUserId, input.version, now);
        });
        update();
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
        if (isD1Driver()) {
            await d1Batch([
                {
                    sql: `DELETE FROM device_cursors
                     WHERE workspace_id = ? AND updated_at < ?`,
                    parameters: [input.scope.workspaceId, cutoff],
                },
                {
                    sql: `DELETE FROM change_log
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
            // See gcTombstones: inactive devices are snapshot-bootstrapped, so
            // they must not pin historical rows forever.
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
                    `DELETE FROM change_log
                     WHERE workspace_id = ? AND created_at < ?`
                ).run(input.scope.workspaceId, cutoff);
            } else {
                raw.prepare(
                    `DELETE FROM change_log
                     WHERE workspace_id = ? AND created_at < ? AND server_version <= ?`
                ).run(input.scope.workspaceId, cutoff, cursor.min_version);
            }
        })();
    }

    private async reserveUploadIntentInD1(
        input: UploadIntentReservationRequest,
        hash: string
    ): Promise<void> {
        const now = nowEpoch();
        const liveRows = await d1All<{ id: string; data_json: string }>(
            `SELECT id, data_json FROM s_file_meta
             WHERE workspace_id = ? AND deleted = 0`,
            input.workspaceId
        );
        let usedBytes = 0;
        let alreadyStored = false;
        for (const row of liveRows) {
            const payload = JSON.parse(row.data_json) as Record<string, unknown>;
            const size = payload.size_bytes ?? payload.sizeBytes;
            if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
                throw createError({ statusCode: 500, statusMessage: 'Invalid canonical file size' });
            }
            usedBytes += size;
            if (normalizeStorageHash(row.id) === hash) alreadyStored = true;
        }
        const [totals] = await d1All<{
            reserved_bytes: number;
            same_hash: number | null;
        }>(
            `SELECT COALESCE(SUM(reserved_bytes), 0) AS reserved_bytes,
                    MAX(CASE WHEN hash = ? AND reserved_bytes > 0 THEN 1 ELSE 0 END) AS same_hash
             FROM upload_intents
             WHERE workspace_id = ? AND status = 'active' AND expires_at > ?`,
            hash,
            input.workspaceId,
            now
        );
        const reservedBytes = alreadyStored || totals?.same_hash === 1
            ? 0
            : input.sizeBytes;
        if (
            input.workspaceQuotaBytes !== undefined &&
            usedBytes + (totals?.reserved_bytes ?? 0) + reservedBytes > input.workspaceQuotaBytes
        ) {
            throw createError({ statusCode: 413, statusMessage: 'Workspace storage quota exceeded' });
        }
        await d1Batch([
            {
                sql: `UPDATE upload_intents SET status = 'expired'
                      WHERE workspace_id = ? AND status = 'active' AND expires_at <= ?`,
                parameters: [input.workspaceId, now],
            },
            {
                sql: `INSERT INTO upload_intents (
                    id, workspace_id, hash, mime_type, size_bytes, reserved_bytes,
                    expires_at, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
                parameters: [
                    input.intentId,
                    input.workspaceId,
                    hash,
                    input.mimeType,
                    input.sizeBytes,
                    reservedBytes,
                    input.expiresAt,
                    now,
                ],
            },
        ]);
    }

    private async snapshotInD1(
        workspaceId: string,
        input: SnapshotRequest,
        pageSize: number,
        snapshotUserId: string | undefined
    ): Promise<SnapshotResponse> {
        const now = nowEpoch();
        let header: SnapshotHeaderRow;
        let after: SnapshotPageToken['after'] | undefined;

        if (input.pageToken) {
            if (input.pageToken.length > 4096) {
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
            if (
                input.tables &&
                existing.tables_json !== JSON.stringify(normalizeSnapshotTables(input.tables))
            ) {
                throw createError({
                    statusCode: 400,
                    statusMessage: 'Snapshot table filter cannot change between pages',
                });
            }
            header = existing;
            after = token.after;
        } else {
            const tables = normalizeSnapshotTables(input.tables);
            const snapshotId = uid();
            const expiresAt = now + SNAPSHOT_TTL_SECONDS;
            const tablesJson = JSON.stringify(tables);
            const statements: D1SqlStatement[] = [
                {
                    sql: 'DELETE FROM sync_snapshots WHERE expires_at <= ?',
                    parameters: [now],
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
                            clock, hlc, op_id, server_deleted_at
                        )
                        SELECT
                            ?, ?, materialized.id, 'tombstone', NULL,
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
                            ))
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
            if (!created) throw new Error('D1 did not create a sync snapshot.');
            header = created;
        }

        const rows = after
            ? await d1All<SnapshotItemRow>(
                `SELECT table_name, pk, kind, payload_json, clock, hlc, op_id, server_deleted_at
                 FROM sync_snapshot_items
                 WHERE snapshot_id = ?
                   AND (
                       table_name > ?
                       OR (table_name = ? AND pk > ?)
                       OR (table_name = ? AND pk = ? AND kind > ?)
                   )
                 ORDER BY table_name ASC, pk ASC, kind ASC
                 LIMIT ?`,
                header.id,
                after.tableName,
                after.tableName,
                after.pk,
                after.tableName,
                after.pk,
                after.kind,
                pageSize + 1
            )
            : await d1All<SnapshotItemRow>(
                `SELECT table_name, pk, kind, payload_json, clock, hlc, op_id, server_deleted_at
                 FROM sync_snapshot_items
                 WHERE snapshot_id = ?
                 ORDER BY table_name ASC, pk ASC, kind ASC
                 LIMIT ?`,
                header.id,
                pageSize + 1
            );
        const hasMore = rows.length > pageSize;
        const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
        const items: SnapshotItem[] = pageRows.map((row) => {
            const revision = { clock: row.clock, hlc: row.hlc, opId: row.op_id };
            if (row.kind === 'row') {
                return {
                    kind: 'row',
                    tableName: row.table_name,
                    pk: row.pk,
                    payload: JSON.parse(row.payload_json ?? 'null') as unknown,
                    revision,
                };
            }
            return {
                kind: 'tombstone',
                tableName: row.table_name,
                pk: row.pk,
                revision,
                serverDeletedAt: row.server_deleted_at ?? 0,
            };
        });
        const lastRow = pageRows.at(-1);
        return {
            workspaceId: header.workspace_id,
            snapshotId: header.id,
            highWatermark: header.high_watermark,
            items,
            nextPageToken: hasMore && lastRow
                ? encodeSnapshotPageToken({
                    version: 1,
                    snapshotId: header.id,
                    after: {
                        tableName: lastRow.table_name,
                        pk: lastRow.pk,
                        kind: lastRow.kind,
                    },
                })
                : null,
        };
    }

    private async updateCursorInD1(
        workspaceId: string,
        deviceId: string,
        version: number,
        ownerUserId: string,
        now: number
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
             FROM device_cursors WHERE workspace_id = ? AND device_id = ?`,
            workspaceId,
            deviceId
        );
        if (existing?.owner_user_id && existing.owner_user_id !== ownerUserId) {
            throw createError({ statusCode: 403, statusMessage: 'Device cursor belongs to another user' });
        }
        if (existing && version < existing.last_seen_version) {
            throw createError({ statusCode: 409, statusMessage: 'Device cursor cannot regress' });
        }
        const result = await d1Run(
            `INSERT INTO device_cursors (
                id, workspace_id, device_id, owner_user_id, last_seen_version, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(workspace_id, device_id) DO UPDATE SET
                owner_user_id = COALESCE(device_cursors.owner_user_id, excluded.owner_user_id),
                last_seen_version = excluded.last_seen_version,
                updated_at = excluded.updated_at
             WHERE (device_cursors.owner_user_id IS NULL OR device_cursors.owner_user_id = ?)
               AND excluded.last_seen_version >= device_cursors.last_seen_version`,
            uid(),
            workspaceId,
            deviceId,
            ownerUserId,
            version,
            now,
            ownerUserId
        );
        if ((result.meta?.changes ?? 0) !== 1) {
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
    }): Promise<PushResult> {
        const { workspaceId, uniqueOps, resultSlots, indicesByOpId, userId } = input;
        const existingOps = new Map<string, {
            server_version: number;
            workspace_id: string;
            fingerprint: string;
        }>();
        const opIds = uniqueOps.map((op) => op.stamp.opId);
        for (let offset = 0; offset < opIds.length; offset += 500) {
            const chunk = opIds.slice(offset, offset + 500);
            if (chunk.length === 0) continue;
            const placeholders = chunk.map(() => '?').join(',');
            const rows = await d1All<{
                op_id: string;
                server_version: number;
                workspace_id: string;
                table_name: string;
                pk: string;
                op: string;
                payload_json: string | null;
                clock: number;
                hlc: string;
                device_id: string;
            }>(
                `SELECT op_id, server_version, workspace_id, table_name, pk, op,
                        payload_json, clock, hlc, device_id
                 FROM change_log WHERE op_id IN (${placeholders})`,
                ...chunk
            );
            for (const row of rows) {
                existingOps.set(row.op_id, {
                    server_version: row.server_version,
                    workspace_id: row.workspace_id,
                    fingerprint: changeLogFingerprint(row),
                });
            }
        }

        const rejected = new Set<string>();
        for (const op of uniqueOps) {
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
            if (op.tableName !== 'notifications' || op.operation !== 'delete') continue;
            if (existingOps.has(op.stamp.opId) || rejected.has(op.stamp.opId)) continue;
            const materializedTable = SYNCED_TABLE_MAP[op.tableName];
            if (!materializedTable) continue;
            const [owned] = await d1All<{ data_json: string }>(
                `SELECT data_json FROM "${materializedTable}" WHERE id = ? AND workspace_id = ?`,
                op.pk,
                workspaceId
            );
            const owner = owned
                ? notificationPayloadUserId(JSON.parse(owned.data_json))
                : undefined;
            if (!owned || owner !== userId) {
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

        const newOps = uniqueOps.filter(
            (op) => !existingOps.has(op.stamp.opId) && !rejected.has(op.stamp.opId)
        );
        const versionOffsets = new Map<string, number>();
        newOps.forEach((op, index) => {
            versionOffsets.set(op.stamp.opId, index + 1);
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
        const statements: D1SqlStatement[] = [];
        if (newOps.length > 0) {
            // Allocate the block inside the same D1 batch as the mutations so
            // a failed write rolls the counter back with the rest of the push.
            statements.push(
                {
                    sql: `INSERT OR IGNORE INTO server_version_counter (workspace_id, value)
                          VALUES (?, 0)`,
                    parameters: [workspaceId],
                },
                {
                    sql: 'UPDATE server_version_counter SET value = value + ? WHERE workspace_id = ?',
                    parameters: [newOps.length, workspaceId],
                }
            );
        }
        const materializedStatementIndex = new Map<string, number>();
        const materializedWasExisting = new Map<string, boolean>();
        const seenMaterializedKeys = new Set<string>();
        for (const op of newOps) {
            const materializedTable = SYNCED_TABLE_MAP[op.tableName];
            if (!materializedTable) continue;
            const versionOffset = versionOffsets.get(op.stamp.opId);
            if (versionOffset === undefined) continue;
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
                    payload_json, clock, hlc, device_id, op_id, created_at
                ) VALUES (
                    ?, ?,
                    (SELECT value - ? + ? FROM server_version_counter WHERE workspace_id = ?),
                    ?, ?, ?, ?, ?, ?, ?, ?, ?
                )`,
                parameters: [
                    uid(),
                    workspaceId,
                    newOps.length,
                    versionOffset,
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
                ],
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
                    WHERE ${lwwExcludedWins(`"${materializedTable}"`)}`,
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
                    WHERE ${lwwExcludedWins(`"${materializedTable}"`)}`,
                    parameters: [
                        op.pk,
                        workspaceId,
                        op.stamp.clock,
                        op.stamp.hlc,
                        op.stamp.deviceId,
                        op.stamp.opId,
                        now,
                        now,
                    ],
                });
                statements.push({
                    sql: `INSERT INTO tombstones (
                        id, workspace_id, table_name, pk, deleted_at, clock,
                        hlc, op_id, server_version, created_at
                    ) VALUES (
                        ?, ?, ?, ?, ?, ?, ?, ?,
                        (SELECT value - ? + ? FROM server_version_counter WHERE workspace_id = ?),
                        ?
                    )
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
                        newOps.length,
                        versionOffset,
                        workspaceId,
                        now,
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
        const batchResults = statements.length > 0 ? await d1Batch(statements) : [];
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
            const existing = existingOps.get(op.stamp.opId);
            if (existing) {
                const winner = await currentWinnerD1(workspaceId, op.tableName, op.pk);
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
            let winnerPayload: unknown;
            if (!applied && !skipApply) {
                const materializedTable = SYNCED_TABLE_MAP[op.tableName];
                if (materializedTable) {
                    const [winner] = await d1All<{ data_json: string }>(
                        `SELECT data_json FROM "${materializedTable}" WHERE id = ? AND workspace_id = ?`,
                        op.pk,
                        workspaceId
                    );
                    if (winner?.data_json) {
                        winnerPayload = JSON.parse(winner.data_json);
                    }
                }
            }
            const result: PushResult['results'][number] = {
                opId: op.stamp.opId,
                success: true,
                serverVersion,
                applied,
                ...(applied ? {} : { payload: winnerPayload }),
                ...(applied ? {} : {
                    winner: await currentWinnerD1(workspaceId, op.tableName, op.pk),
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
        }

        for (const emission of emissions) {
            await emitWebhookSystemHook(emission.hookName, emission.payload);
        }
        return {
            results: resultSlots.filter(
                (result): result is PushResult['results'][number] => Boolean(result)
            ),
            serverVersion: finalServerVersion,
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

export function createSqliteSyncGatewayAdapter(): SyncGatewayAdapter {
    return new SqliteSyncGatewayAdapter();
}
