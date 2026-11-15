import { randomUUID } from 'node:crypto';
import type { H3Event } from 'h3';
import type { PendingOp, PushResult } from '~~/shared/sync/types';
import { incomingRevisionWins } from '~~/shared/sync/revision';
import { SyncChangeSchema, SnapshotItemSchema, SyncRecordIdentifierSchema } from '~~/shared/sync/schemas';
import { nextSyncClock } from '~~/shared/sync/prepare-sync-write';
import { SYNCED_TABLE_MAP } from '../db/schema';
import { boundedSyncPayload, syncRows, syncBatch } from './unavailable-records';
import type { D1SqlStatement } from '../db/d1';

export type RepairGuard = { id: string; workspaceId: string; table: string; pk: string; clock: number; hlc: string; opId: string; deleted: number; materialized: boolean; tombstone: string | null };
export function repairAssertion(guard: RepairGuard): D1SqlStatement {
    const current = guard.materialized
        ? `EXISTS (SELECT 1 FROM ${guard.table} WHERE workspace_id = ? AND id = ?
            AND clock IS ? AND hlc IS ? AND op_id IS ? AND deleted IS ?)`
        : `NOT EXISTS (SELECT 1 FROM ${guard.table} WHERE workspace_id = ? AND id = ?)`;
    return { sql: `SELECT json_extract('{}', CASE WHEN EXISTS (
        SELECT 1 FROM sync_unavailable_records WHERE workspace_id = ? AND id = ? AND status = 'unresolved'
    ) AND ${current}
        AND (SELECT json_array(clock,hlc,op_id) FROM tombstones WHERE workspace_id = ? AND table_name = ? AND pk = ?) IS ?
        THEN '$' ELSE 'OR3_SYNC_REPAIR_CHANGED' END)`,
    parameters: [guard.workspaceId,guard.id,guard.workspaceId,guard.pk,
        ...(guard.materialized ? [guard.clock,guard.hlc,guard.opId,guard.deleted] : []),guard.workspaceId,guard.table.slice(2),guard.pk,guard.tombstone] };
}
export function repairResolution(guard: RepairGuard, opId: string): D1SqlStatement {
    return { sql: `UPDATE sync_unavailable_records SET status = 'repaired', resolved_op_id = ?
        WHERE workspace_id = ? AND id = ?`, parameters: [opId,guard.workspaceId,guard.id] };
}
type Evidence = { id: string; source: string; metadata_json: string | null; payload_json: string | null; payload_bytes: number; status: string };

/** Admin route authorization is supplied by the existing provider-admin action path. */
export async function maintainEvidence(event: H3Event, workspaceId: string, action: string, input: Record<string, unknown>,
    write: (event: H3Event, op: PendingOp, guard: RepairGuard) => Promise<PushResult>,
    valid: (table: string, pk: string, payload: unknown, clock: number, hlc?: string, opId?: string) => boolean): Promise<Record<string, unknown>> {
    if (action === 'inspect') {
        const after = typeof input.after === 'string' ? input.after : '';
        const items = await syncRows(`SELECT id,source,
            CASE WHEN length(cast(locator AS blob)) <= 4096 THEN locator END AS locator,
            CASE WHEN length(cast(revision AS blob)) <= 4096 THEN revision END AS revision,
            reason,status,created_at,
            length(cast(payload_json AS blob)) AS payload_bytes FROM sync_unavailable_records
            WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT 50`,workspaceId,after);
        return { items, next: items.length === 50 ? (items[49] as {id:string}).id : null };
    }
    if (typeof input.id !== 'string' || !input.id || input.id.length > 512) throw new Error('Evidence id required');
    const [evidence] = await syncRows<Evidence>(`SELECT id,source,status,
        ${boundedSyncPayload('metadata_json')} AS metadata_json, ${boundedSyncPayload('payload_json')} AS payload_json,
        coalesce(length(cast(payload_json AS blob)),0) AS payload_bytes FROM sync_unavailable_records WHERE workspace_id = ? AND id = ?`,workspaceId,input.id);
    if (!evidence) throw new Error('Evidence unavailable');
    if (action === 'export') {
        const offset = input.offset ?? 0;
        if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error('Invalid evidence export offset');
        const [chunk] = await syncRows(`SELECT hex(substr(cast(payload_json AS blob),?,32768)) AS payloadHex,
            hex(substr(cast(metadata_json AS blob),?,32768)) AS metadataHex,
            max(coalesce(length(cast(payload_json AS blob)),0),length(cast(metadata_json AS blob))) AS totalBytes
            FROM sync_unavailable_records WHERE workspace_id = ? AND id = ?`,(offset as number)+1,(offset as number)+1,workspaceId,input.id);
        return { ...chunk as object, offset, chunkBytes:32768 };
    }
    if (!evidence.metadata_json) throw new Error('Evidence metadata requires explicit offline recovery');
    const metadata = JSON.parse(evidence.metadata_json) as { table_name: string; pk: string; clock: number; hlc: string; op_id: string; kind?: string; op?: string; device_id?: string; server_version?: number; server_deleted_at?: number };
    if (action === 'revalidate') {
        let healthy = false;
        try {
            const payload = evidence.payload_json ? JSON.parse(evidence.payload_json) : undefined;
            const revision = {clock:metadata.clock,hlc:metadata.hlc,opId:metadata.op_id};
            const envelopeValid = evidence.source === 'pull'
                ? SyncChangeSchema.safeParse({serverVersion:metadata.server_version,tableName:metadata.table_name,pk:metadata.pk,op:metadata.op,payload,
                    stamp:{...revision,deviceId:metadata.device_id}}).success
                : evidence.source === 'snapshot'
                    ? SnapshotItemSchema.safeParse({kind:metadata.kind,tableName:metadata.table_name,pk:metadata.pk,revision,payload,serverDeletedAt:metadata.server_deleted_at}).success
                    : Number.isSafeInteger(metadata.clock) && metadata.clock >= 0 && !!metadata.hlc && !!metadata.op_id;
            const deleted = metadata.op === 'delete' || metadata.kind === 'tombstone';
            healthy = envelopeValid && evidence.payload_bytes <= 262144 &&
                (deleted ? Object.hasOwn(SYNCED_TABLE_MAP,metadata.table_name) : valid(metadata.table_name,metadata.pk,payload,metadata.clock,metadata.hlc,metadata.op_id));
        } catch { /* retained corrupt JSON */ }
        return { id: evidence.id, valid: healthy, status: evidence.status };
    }
    if (action !== 'repair') throw new Error('Unknown evidence action');
    if (evidence.status !== 'unresolved') return {id:evidence.id,status:evidence.status};
    const table = Object.hasOwn(SYNCED_TABLE_MAP,metadata.table_name) ? SYNCED_TABLE_MAP[metadata.table_name] : undefined;
    if (!table || !SyncRecordIdentifierSchema.safeParse(metadata.pk).success || !Number.isSafeInteger(metadata.clock) || metadata.clock < 0 || !metadata.hlc || !metadata.op_id) {
        throw new Error('Unrepairable evidence revision or identity; no clock reset is permitted');
    }
    const [current] = await syncRows<{clock:number;hlc:string;op_id:string;deleted:number}>(
        `SELECT clock,hlc,op_id,deleted FROM ${table} WHERE workspace_id = ? AND id = ?`,workspaceId,metadata.pk);
    const [tombstone] = await syncRows<{revision:string}>(
        'SELECT json_array(clock,hlc,op_id) AS revision FROM tombstones WHERE workspace_id = ? AND table_name = ? AND pk = ?',workspaceId,metadata.table_name,metadata.pk);
    const deletedRevision = tombstone ? JSON.parse(tombstone.revision) as [number,string,string] : undefined;
    if (deletedRevision && (!Number.isSafeInteger(deletedRevision[0]) || deletedRevision[0] < 0 || !deletedRevision[1] || !deletedRevision[2])) throw new Error('Unrepairable deletion revision');
    const newerDelete = deletedRevision && current &&
        incomingRevisionWins({clock:deletedRevision[0],hlc:deletedRevision[1],opId:deletedRevision[2]},
            {clock:current.clock,hlc:current.hlc,opId:current.op_id});
    // Orphan tombstones remain canonical deletion winners. Missing live state
    // alone does not make their evidence obsolete.
    const winner = current ?? (deletedRevision ? {clock:deletedRevision[0],hlc:deletedRevision[1],op_id:deletedRevision[2],deleted:1} : undefined);
    const isDeletion = metadata.op === 'delete' || metadata.kind === 'tombstone';
    if (!winner || !current && !isDeletion || winner.clock !== metadata.clock || winner.hlc !== metadata.hlc || winner.op_id !== metadata.op_id || newerDelete) {
        await syncBatch([{sql:"UPDATE sync_unavailable_records SET status = 'superseded' WHERE workspace_id = ? AND id = ? AND status = 'unresolved'",parameters:[workspaceId,evidence.id]}]);
        return {id:evidence.id,status:'superseded'};
    }
    if (input.operation !== undefined && input.operation !== 'put' && input.operation !== 'delete') throw new Error('Invalid repair operation');
    // Explicit operator replacement, never implicit replay of the retained bytes.
    if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw new Error('Repair replacement payload required');
    const opId = randomUUID();
    const clock = nextSyncClock(winner.clock);
    const op: PendingOp = { id:opId,tableName:metadata.table_name,pk:metadata.pk,operation:input.operation === 'delete' ? 'delete' : 'put',
        payload:input.payload,stamp:{clock,hlc:`${Date.now().toString(36)}:000:repair`,opId,deviceId:'server:sync-repair'},createdAt:Date.now(),attempts:0,status:'pending' };
    const result = await write(event,op,{id:evidence.id,workspaceId,table,pk:metadata.pk,...winner,opId:winner.op_id,materialized:!!current,tombstone:tombstone?.revision ?? null});
    if (!result.results[0]?.success || result.results[0]?.applied === false) throw new Error(result.results[0]?.error ?? 'Repair did not win');
    return {id:evidence.id,status:'repaired',opId,serverVersion:result.results[0].serverVersion};
}
