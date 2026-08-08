/**
 * Provider-side sync-history maintenance state.
 *
 * Storage decision: module-scoped in-memory state. Managed deployments run a
 * single process, so in-memory state is observable by both the admin adapter
 * (getStatus/runAction) and the in-process scheduler. A JSON file under the
 * SQLite DB directory was considered but rejected: the DB path is not always a
 * directory (e.g. `:memory:`), and cross-process visibility is not required by
 * the single-process deployment contract. State resets on restart, which is
 * acceptable for diagnostics (lastRun/backlog are advisory, not authoritative).
 */
import { canRunSyncHistoryGc } from './history-gc-policy';
import { getRawDb } from '../db/kysely';
import type { SyncMaintenanceState } from '~~/server/sync/gateway/types';

/**
 * Retention window used by maintenance GC. No OR3_SYNC_* retention knob exists
 * today, so we deliberately do NOT invent a new env var; we use the maximum
 * bounded window allowed by the gateway (365 days) and document it here.
 */
export const SYNC_MAINTENANCE_RETENTION_SECONDS = 365 * 24 * 60 * 60;

/** Backlog is a COUNT over the change log; cache it briefly to keep getStatus cheap. */
const BACKLOG_TTL_MS = 60_000;

let state: SyncMaintenanceState = { enabled: true, state: 'idle' };
let backlogCache: { value: number; at: number } | undefined;

export function getSyncMaintenanceState(): SyncMaintenanceState {
    return { ...state, enabled: canRunSyncHistoryGc() };
}

export function beginSyncMaintenanceRun(): void {
    state = { ...state, state: 'running' };
}

export function completeSyncMaintenanceRun(input: {
    lastRun: string;
    backlog: number;
}): void {
    state = {
        ...state,
        state: 'idle',
        lastRun: input.lastRun,
        backlog: input.backlog,
        lastError: undefined,
    };
}

export function failSyncMaintenanceRun(error: string): void {
    state = { ...state, state: 'failed', lastError: error };
}

export function getCachedSyncMaintenanceBacklog(): number | undefined {
    if (backlogCache && Date.now() - backlogCache.at < BACKLOG_TTL_MS) {
        return backlogCache.value;
    }
    return undefined;
}

/**
 * Count change-log entries eligible for GC across all workspaces: older than
 * the retention window AND behind every active device cursor for their
 * workspace. Cursors idle for a whole retention window intentionally do not
 * block collection because those clients snapshot-bootstrap on return.
 * Cached with a short TTL. Pass `force` after a GC pass so the recorded
 * backlog reflects the post-GC state.
 */
export function computeSyncMaintenanceBacklog(
    retentionSeconds: number,
    force = false
): number {
    if (!force) {
        const cached = getCachedSyncMaintenanceBacklog();
        if (cached !== undefined) return cached;
    }

    const backlog = countEligibleChangeLog(retentionSeconds);
    backlogCache = { value: backlog, at: Date.now() };
    state = { ...state, backlog };
    return backlog;
}

function countEligibleChangeLog(retentionSeconds: number): number {
    try {
        const raw = getRawDb();
        const cutoff = Math.floor(Date.now() / 1000) - retentionSeconds;
        const row = raw
            .prepare(
                `WITH active_cursors AS (
                    SELECT workspace_id, MIN(last_seen_version) AS min_version
                    FROM device_cursors
                    WHERE updated_at >= ?
                    GROUP BY workspace_id
                 )
                 SELECT COUNT(*) AS cnt
                 FROM change_log cl
                 LEFT JOIN active_cursors ac ON ac.workspace_id = cl.workspace_id
                 WHERE cl.created_at < ?
                   AND (ac.min_version IS NULL OR cl.server_version <= ac.min_version)`
            )
            .get(cutoff, cutoff) as { cnt: number };
        return row.cnt;
    } catch {
        return 0;
    }
}

/** Test-only reset. */
export function _resetSyncMaintenanceStateForTest(): void {
    state = { enabled: true, state: 'idle' };
    backlogCache = undefined;
}
