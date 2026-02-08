/**
 * SQLite implementation of SyncGatewayAdapter.
 *
 * Handles push/pull/updateCursor/gc using Kysely + better-sqlite3.
 * Uses raw DB transactions via better-sqlite3 for push atomicity
 * (BEGIN IMMEDIATE prevents concurrent server_version races).
 */
import type { H3Event } from 'h3';
import type { SyncGatewayAdapter } from '~~/server/sync/gateway/types';
import type {
    PullRequest,
    PullResponse,
    PushBatch,
    PushResult,
    SyncChange,
} from '~~/shared/sync/types';
import { randomUUID } from 'node:crypto';
import { getSqliteDb, getRawDb } from '../db/kysely';
import { SYNCED_TABLE_MAP, ALLOWED_SYNC_TABLES } from '../db/schema';

function uid(): string {
    return randomUUID();
}

function nowEpoch(): number {
    return Math.floor(Date.now() / 1000);
}

/**
 * LWW comparison: incoming wins if clock is higher,
 * or clock is equal and hlc is lexicographically greater.
 */
function incomingWinsLww(
    inClock: number,
    inHlc: string,
    existingClock: number,
    existingHlc: string
): boolean {
    if (inClock > existingClock) return true;
    if (inClock === existingClock && inHlc > existingHlc) return true;
    return false;
}

export class SqliteSyncGatewayAdapter implements SyncGatewayAdapter {
    id = 'sqlite';

    private get db() {
        return getSqliteDb();
    }

    async push(_event: H3Event, input: PushBatch): Promise<PushResult> {
        const { scope, ops } = input;
        const workspaceId = scope.workspaceId;

        if (!ops.length) {
            return { results: [], serverVersion: 0 };
        }

        // Validate all table names upfront
        for (const op of ops) {
            if (!ALLOWED_SYNC_TABLES.includes(op.tableName)) {
                return {
                    results: ops.map((o) => ({
                        opId: o.stamp.opId,
                        success: false,
                        error: `Invalid table: ${o.tableName}`,
                        errorCode: 'VALIDATION_ERROR' as const,
                    })),
                    serverVersion: 0,
                };
            }
        }

        // Use raw better-sqlite3 transaction for BEGIN IMMEDIATE semantics
        const raw = getRawDb();
        const now = nowEpoch();

        const results: PushResult['results'] = [];
        let finalServerVersion = 0;

        const runTx = raw.transaction(() => {
            // Check for existing op_ids (idempotency)
            const opIds = ops.map((o) => o.stamp.opId);
            const existingOps = new Map<string, number>();

            // Query in chunks to avoid SQLite variable limits
            const chunkSize = 500;
            for (let i = 0; i < opIds.length; i += chunkSize) {
                const chunk = opIds.slice(i, i + chunkSize);
                const placeholders = chunk.map(() => '?').join(',');
                const rows = raw
                    .prepare(
                        `SELECT op_id, server_version FROM change_log WHERE op_id IN (${placeholders})`
                    )
                    .all(...chunk) as Array<{ op_id: string; server_version: number }>;

                for (const row of rows) {
                    existingOps.set(row.op_id, row.server_version);
                }
            }

            // Deduplicate op_ids inside the same batch so repeats are idempotent.
            const uniqueNewOpIds = new Set<string>();
            for (const op of ops) {
                if (existingOps.has(op.stamp.opId)) continue;
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
            for (const op of ops) {
                if (existingOps.has(op.stamp.opId)) continue;
                if (assignedVersions.has(op.stamp.opId)) continue;
                versionOffset++;
                assignedVersions.set(op.stamp.opId, baseVersion + versionOffset);
            }

            const processedNew = new Set<string>();

            for (const op of ops) {
                const opId = op.stamp.opId;

                // Idempotent replay
                const existingSv = existingOps.get(opId);
                if (existingSv !== undefined) {
                    results.push({
                        opId,
                        success: true,
                        serverVersion: existingSv,
                    });
                    continue;
                }

                const serverVersion = assignedVersions.get(opId);
                if (serverVersion === undefined) {
                    throw new Error(`Missing server version allocation for op_id ${opId}`);
                }

                // Duplicate op_id in the same batch: mirror first occurrence.
                if (processedNew.has(opId)) {
                    results.push({
                        opId,
                        success: true,
                        serverVersion,
                    });
                    continue;
                }
                processedNew.add(opId);

                const materializedTable = SYNCED_TABLE_MAP[op.tableName];
                if (!materializedTable) {
                    results.push({
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

                // Apply to materialized table using LWW
                if (op.operation === 'put') {
                    // Check existing row
                    const existing = raw
                        .prepare(
                            `SELECT clock, hlc FROM ${materializedTable} WHERE id = ? AND workspace_id = ?`
                        )
                        .get(pkValue, workspaceId) as
                        | { clock: number; hlc: string }
                        | undefined;

                    if (!existing) {
                        // Insert new row
                        raw.prepare(
                            `INSERT INTO ${materializedTable} (id, workspace_id, data_json, clock, hlc, device_id, deleted, created_at, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
                        ).run(
                            pkValue,
                            workspaceId,
                            payloadJson ?? '{}',
                            op.stamp.clock,
                            op.stamp.hlc,
                            op.stamp.deviceId,
                            now,
                            now
                        );
                    } else if (
                        incomingWinsLww(
                            op.stamp.clock,
                            op.stamp.hlc,
                            existing.clock,
                            existing.hlc
                        )
                    ) {
                        raw.prepare(
                            `UPDATE ${materializedTable}
                             SET data_json = ?, clock = ?, hlc = ?, device_id = ?, deleted = 0, updated_at = ?
                             WHERE id = ? AND workspace_id = ?`
                        ).run(
                            payloadJson ?? '{}',
                            op.stamp.clock,
                            op.stamp.hlc,
                            op.stamp.deviceId,
                            now,
                            pkValue,
                            workspaceId
                        );
                    }
                    // else: existing wins, no update
                } else if (op.operation === 'delete') {
                    // Mark deleted in materialized table
                    const existing = raw
                        .prepare(
                            `SELECT clock, hlc FROM ${materializedTable} WHERE id = ? AND workspace_id = ?`
                        )
                        .get(pkValue, workspaceId) as
                        | { clock: number; hlc: string }
                        | undefined;

                    if (!existing) {
                        // Insert as deleted
                        raw.prepare(
                            `INSERT INTO ${materializedTable} (id, workspace_id, data_json, clock, hlc, device_id, deleted, created_at, updated_at)
                             VALUES (?, ?, '{}', ?, ?, ?, 1, ?, ?)`
                        ).run(
                            pkValue,
                            workspaceId,
                            op.stamp.clock,
                            op.stamp.hlc,
                            op.stamp.deviceId,
                            now,
                            now
                        );
                    } else if (
                        incomingWinsLww(
                            op.stamp.clock,
                            op.stamp.hlc,
                            existing.clock,
                            existing.hlc
                        )
                    ) {
                        raw.prepare(
                            `UPDATE ${materializedTable}
                             SET deleted = 1, clock = ?, hlc = ?, device_id = ?, updated_at = ?
                             WHERE id = ? AND workspace_id = ?`
                        ).run(
                            op.stamp.clock,
                            op.stamp.hlc,
                            op.stamp.deviceId,
                            now,
                            pkValue,
                            workspaceId
                        );
                    }

                    // Upsert tombstone
                    raw.prepare(
                        `INSERT INTO tombstones (id, workspace_id, table_name, pk, deleted_at, clock, server_version, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(workspace_id, table_name, pk) DO UPDATE SET
                           deleted_at = excluded.deleted_at,
                           clock = excluded.clock,
                           server_version = excluded.server_version
                         WHERE excluded.clock > tombstones.clock
                            OR (
                                excluded.clock = tombstones.clock
                                AND excluded.server_version > tombstones.server_version
                            )`
                    ).run(
                        uid(),
                        workspaceId,
                        op.tableName,
                        pkValue,
                        now,
                        op.stamp.clock,
                        serverVersion,
                        now
                    );
                }

                results.push({
                    opId,
                    success: true,
                    serverVersion,
                });
            }
        });

        // Run with IMMEDIATE to prevent concurrent version allocation races
        runTx.immediate();

        return { results, serverVersion: finalServerVersion };
    }

    async pull(_event: H3Event, input: PullRequest): Promise<PullResponse> {
        const db = this.db;
        const { scope, cursor, limit, tables } = input;
        const fetchLimit = Math.min(limit, 1000);

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
        }));

        const lastRow = resultRows[resultRows.length - 1];
        const nextCursor = lastRow ? lastRow.server_version : cursor;

        return { changes, nextCursor, hasMore };
    }

    async updateCursor(
        _event: H3Event,
        input: { scope: { workspaceId: string }; deviceId: string; version: number }
    ): Promise<void> {
        const raw = getRawDb();
        const now = nowEpoch();

        // Upsert with forward-only constraint
        raw.prepare(
            `INSERT INTO device_cursors (id, workspace_id, device_id, last_seen_version, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(workspace_id, device_id) DO UPDATE SET
               last_seen_version = MAX(device_cursors.last_seen_version, excluded.last_seen_version),
               updated_at = excluded.updated_at`
        ).run(uid(), input.scope.workspaceId, input.deviceId, input.version, now);
    }

    async gcTombstones(
        _event: H3Event,
        input: { scope: { workspaceId: string }; retentionSeconds: number }
    ): Promise<void> {
        const raw = getRawDb();
        const workspaceId = input.scope.workspaceId;

        // Find minimum device cursor for this workspace
        const minCursorRow = raw
            .prepare(
                'SELECT MIN(last_seen_version) as min_version FROM device_cursors WHERE workspace_id = ?'
            )
            .get(workspaceId) as { min_version: number | null } | undefined;

        const minCursor = minCursorRow?.min_version ?? 0;
        const cutoff = nowEpoch() - input.retentionSeconds;

        // Delete tombstones older than retention AND behind all device cursors
        raw.prepare(
            `DELETE FROM tombstones
             WHERE workspace_id = ?
               AND server_version < ?
               AND created_at < ?`
        ).run(workspaceId, minCursor, cutoff);
    }

    async gcChangeLog(
        _event: H3Event,
        input: { scope: { workspaceId: string }; retentionSeconds: number }
    ): Promise<void> {
        const raw = getRawDb();
        const workspaceId = input.scope.workspaceId;

        const minCursorRow = raw
            .prepare(
                'SELECT MIN(last_seen_version) as min_version FROM device_cursors WHERE workspace_id = ?'
            )
            .get(workspaceId) as { min_version: number | null } | undefined;

        const minCursor = minCursorRow?.min_version ?? 0;
        const cutoff = nowEpoch() - input.retentionSeconds;

        // Delete change_log entries older than retention AND behind all device cursors
        // Batch to avoid long locks
        const BATCH_SIZE = 1000;
        let deleted: number;
        do {
            const result = raw
                .prepare(
                    `DELETE FROM change_log
                     WHERE rowid IN (
                       SELECT rowid FROM change_log
                       WHERE workspace_id = ?
                         AND server_version < ?
                         AND created_at < ?
                       LIMIT ?
                     )`
                )
                .run(workspaceId, minCursor, cutoff, BATCH_SIZE);
            deleted = result.changes;
        } while (deleted >= BATCH_SIZE);
    }
}

export function createSqliteSyncGatewayAdapter(): SyncGatewayAdapter {
    return new SqliteSyncGatewayAdapter();
}
