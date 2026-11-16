import { historyAssertion, historyBatch } from './history-incarnation';
import { randomUUID } from 'node:crypto';
import { getRawDb, isD1Driver } from '../db/kysely';
import { d1All, type D1SqlStatement } from '../db/d1';

export const SYNC_ROW_BYTES = 256 * 1024;
export const SYNC_METADATA_BYTES = 1024 * 1024;

export function syncMetadataBytes(...columns: string[]): string {
    return columns.map(column => `coalesce(length(cast(${column} AS blob)),0)`).join(' + ');
}
/** Legacy snapshot revisions have no stamp-length limit. Bound their transfer
 * at the page ceiling, preserving originals SQL-to-SQL for larger records. */
export function boundedSyncMetadata(column: string, bytes = syncMetadataBytes(column)): string {
    return `CASE WHEN (${bytes}) <= ${SYNC_METADATA_BYTES} THEN ${column} ELSE NULL END`;
}

/** SQL CASE, rather than WHERE order, guards both payload transfer and JSON evaluation. */
export function boundedSyncPayload(column: string): string {
    return `CASE WHEN coalesce(length(cast(${column} AS blob)),0) <= ${SYNC_ROW_BYTES} THEN ${column} ELSE NULL END`;
}
export function notificationOwnerSql(column: string): string {
    return `CASE WHEN json_valid(${column}) THEN CASE WHEN json_type(${column}, '$.user_id') = 'text'
        THEN CASE WHEN length(cast(json_extract(${column}, '$.user_id') AS blob)) BETWEEN 1 AND 1024 THEN json_extract(${column}, '$.user_id') END END END`;
}
export async function syncRows<T>(query: string, ...parameters: unknown[]): Promise<T[]> {
    return isD1Driver() ? d1All<T>(query, ...parameters) : getRawDb().prepare(query).all(...parameters) as T[];
}

export type EvidenceSource = {
    historyIncarnation: string; workspaceId: string; source: 'pull' | 'snapshot' | 'canonical'; locator: string; revisionSql: string;
    table: string; where: string; parameters: unknown[]; payload: string; metadata: string;
};
/** Original bytes travel only database-to-database, including oversized records. */
export async function retainSqlEvidence(source: EvidenceSource, reason: string): Promise<string> {
    await historyBatch([historyAssertion(source.historyIncarnation), evidenceInsert(source, reason)], source.historyIncarnation);
    const lookup = evidenceLookup(source);
    const [retained] = await syncRows<{ id: string }>(lookup.sql, ...lookup.parameters!);
    if (!retained) throw new Error('Sync evidence source disappeared; coverage was not acknowledged');
    return retained.id;
}

/** Shared SQL retention for synchronous native push transactions and D1 batches. */
export function evidenceInsert(source: EvidenceSource, reason: string): D1SqlStatement {
    return {
        sql: `INSERT OR IGNORE INTO sync_unavailable_records
            (id, workspace_id, source, locator, revision, payload_json, metadata_json, reason, status, created_at)
            SELECT ?, ?, ?, ?, json_array(?, ${source.revisionSql}), ${source.payload}, json_set(${source.metadata}, '$.historyIncarnation', ?), ?, 'unresolved', unixepoch()
            FROM ${source.table} WHERE ${source.where}`,
        parameters: [randomUUID(), source.workspaceId, source.source, source.locator, source.historyIncarnation, source.historyIncarnation, reason, ...source.parameters],
    };
}
export function evidenceLookup(source: EvidenceSource): D1SqlStatement {
    return { sql: `SELECT id FROM sync_unavailable_records
        WHERE workspace_id = ? AND source = ? AND locator = ? AND revision = (SELECT json_array(?, ${source.revisionSql}) FROM ${source.table} WHERE ${source.where})`,
    parameters: [source.workspaceId, source.source, source.locator, source.historyIncarnation, ...source.parameters] };
}

/** Capture unknown notification owners only into privileged evidence, never a workspace marker. */
export function unknownNotificationEvidence(workspaceId: string): D1SqlStatement {
    return { sql: `INSERT OR IGNORE INTO sync_unavailable_records
        (id, workspace_id, source, locator, revision, payload_json, metadata_json, reason, status, created_at)
        SELECT lower(hex(randomblob(16))), workspace_id, 'canonical', json_array('notifications', id),
            json_array((SELECT incarnation FROM sync_history WHERE id=1), json_array(clock, hlc, op_id, deleted)), data_json,
            json_object('historyIncarnation',(SELECT incarnation FROM sync_history WHERE id=1),'table_name','notifications','pk',id,'clock',clock,'hlc',hlc,'op_id',op_id,'deleted',deleted),
            'notification_owner_unavailable', 'unresolved', unixepoch()
        FROM s_notifications WHERE workspace_id = ? AND
            coalesce(length(cast(${notificationOwnerSql('data_json')} AS blob)),0) = 0`, parameters: [workspaceId] };
}
