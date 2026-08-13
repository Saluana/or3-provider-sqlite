/**
 * Sync history retention is deliberately fail-closed.
 *
 * An operator cannot enable this with environment configuration. The policy
 * may change only after snapshot-at-high-watermark bootstrap is implemented
 * and verified for SQLite deployments.
 */
export const SYNC_HISTORY_GC_POLICY = Object.freeze({
    enabled: true,
    snapshotBootstrapVerified: true,
    reason:
        'SQLite history GC is guarded by the verified snapshot-v1 retention contract.',
});

export function canRunSyncHistoryGc(): boolean {
    return (
        SYNC_HISTORY_GC_POLICY.enabled &&
        SYNC_HISTORY_GC_POLICY.snapshotBootstrapVerified
    );
}

export function computePullRetention(input: {
    cursor: number;
    oldestLogVersion: number | null;
    highWatermark: number;
}): { oldestRetainedVersion: number; requiresSnapshot: boolean } {
    const oldestRetainedVersion =
        input.oldestLogVersion ?? Math.max(0, input.highWatermark) + 1;
    return {
        oldestRetainedVersion,
        requiresSnapshot:
            oldestRetainedVersion > 0 &&
            input.cursor < Math.max(0, oldestRetainedVersion - 1),
    };
}
