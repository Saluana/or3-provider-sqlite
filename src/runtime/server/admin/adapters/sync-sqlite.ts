import type { H3Event } from 'h3';
import { createError } from 'h3';
import type {
    ProviderAdminAdapter,
    ProviderActionContext,
    ProviderAdminStatusResult,
    ProviderStatusContext,
} from '~~/server/admin/providers/types';
import { SYNC_HISTORY_GC_POLICY, canRunSyncHistoryGc } from '../../sync/history-gc-policy';
import {
    beginSyncMaintenanceRun,
    completeSyncMaintenanceRun,
    computeSyncMaintenanceBacklog,
    failSyncMaintenanceRun,
    getSyncMaintenanceState,
    SYNC_MAINTENANCE_RETENTION_SECONDS,
} from '../../sync/maintenance-state';
import { createSqliteSyncGatewayAdapter } from '../../sync/sqlite-sync-gateway-adapter';
import type { SyncGatewayAdapter } from '~~/server/sync/gateway/types';

const SQLITE_PROVIDER_ID = 'sqlite';

let gatewayInstance: SyncGatewayAdapter | undefined;

function getGateway(): SyncGatewayAdapter {
    gatewayInstance ??= createSqliteSyncGatewayAdapter();
    return gatewayInstance;
}

export const sqliteSyncAdminAdapter: ProviderAdminAdapter = {
    id: SQLITE_PROVIDER_ID,
    kind: 'sync',

    async getStatus(_event: H3Event, _ctx: ProviderStatusContext): Promise<ProviderAdminStatusResult> {
        const dbPath = process.env.OR3_SQLITE_DB_PATH;
        const warnings: ProviderAdminStatusResult['warnings'] = [];

        if (!dbPath) {
            warnings.push({
                level: 'warning',
                message: 'OR3_SQLITE_DB_PATH is not set. SQLite may run in ephemeral mode.',
            });
        } else if (dbPath === ':memory:') {
            warnings.push({
                level: 'warning',
                message: 'SQLite is configured with :memory:. Data will not persist across restarts.',
            });
        }

        const maintenance = getSyncMaintenanceState();
        if (maintenance.state === 'failed') {
            // Maintenance failure must never mark the provider unavailable: the
            // health endpoint only flips `available` on level==='error' warnings.
            warnings.push({
                level: 'warning',
                message: `Sync history maintenance failed: ${maintenance.lastError ?? 'unknown error'}`,
            });
        }

        const backlog = computeSyncMaintenanceBacklog(SYNC_MAINTENANCE_RETENTION_SECONDS);

        return {
            details: {
                dbPath: dbPath ?? ':memory:',
                journalMode: process.env.OR3_SQLITE_PRAGMA_JOURNAL_MODE ?? 'WAL',
                synchronous: process.env.OR3_SQLITE_PRAGMA_SYNCHRONOUS ?? 'NORMAL',
                maintenance: {
                    ...maintenance,
                    backlog,
                },
            },
            warnings,
            actions: [
                {
                    id: 'sync.gc-change-log',
                    label: 'GC change log',
                    description: `Prune change-log entries older than ${SYNC_MAINTENANCE_RETENTION_SECONDS / 86400} days and behind every device cursor.`,
                    danger: true,
                },
                {
                    id: 'sync.gc-tombstones',
                    label: 'GC tombstones',
                    description: `Prune tombstones older than ${SYNC_MAINTENANCE_RETENTION_SECONDS / 86400} days and behind every device cursor.`,
                    danger: true,
                },
            ],
        };
    },

    async runAction(
        event: H3Event,
        actionId: string,
        _payload: Record<string, unknown> | undefined,
        ctx: ProviderActionContext
    ): Promise<unknown> {
        if (!ctx.session.workspace?.id) {
            throw createError({
                statusCode: 400,
                statusMessage: 'Workspace not resolved',
            });
        }

        if (
            actionId === 'sync.gc-change-log' ||
            actionId === 'sync.gc-tombstones'
        ) {
            if (!canRunSyncHistoryGc()) {
                throw createError({
                    statusCode: 503,
                    statusMessage: SYNC_HISTORY_GC_POLICY.reason,
                });
            }

            const workspaceId = ctx.session.workspace.id;
            const retentionSeconds = SYNC_MAINTENANCE_RETENTION_SECONDS;
            const gateway = getGateway();

            beginSyncMaintenanceRun();
            try {
                if (actionId === 'sync.gc-change-log') {
                    await gateway.gcChangeLog!(event, { scope: { workspaceId }, retentionSeconds });
                } else {
                    await gateway.gcTombstones!(event, { scope: { workspaceId }, retentionSeconds });
                }
                const backlog = computeSyncMaintenanceBacklog(retentionSeconds, true);
                const lastRun = new Date().toISOString();
                completeSyncMaintenanceRun({ lastRun, backlog });
                return {
                    ok: true,
                    actionId,
                    workspaceId,
                    retentionSeconds,
                    lastRun,
                    backlog,
                };
            } catch (error) {
                failSyncMaintenanceRun(error instanceof Error ? error.message : String(error));
                throw error;
            }
        }

        throw createError({ statusCode: 400, statusMessage: 'Unknown action' });
    },
};
