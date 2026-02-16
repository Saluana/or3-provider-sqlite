import type { H3Event } from 'h3';
import { createError } from 'h3';
import type {
    ProviderAdminAdapter,
    ProviderActionContext,
    ProviderAdminStatusResult,
    ProviderStatusContext,
} from '~~/server/admin/providers/types';
import { createSqliteSyncGatewayAdapter } from '../../sync/sqlite-sync-gateway-adapter';

const SQLITE_PROVIDER_ID = 'sqlite';
const DEFAULT_RETENTION_SECONDS = 30 * 24 * 3600;

function resolveRetentionSeconds(payload?: Record<string, unknown>): number {
    const days = typeof payload?.retentionDays === 'number' ? payload.retentionDays : null;
    const seconds =
        typeof payload?.retentionSeconds === 'number' ? payload.retentionSeconds : null;
    if (seconds && Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds);
    if (days && Number.isFinite(days) && days > 0) return Math.floor(days * 24 * 3600);
    return DEFAULT_RETENTION_SECONDS;
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

        return {
            details: {
                dbPath: dbPath ?? ':memory:',
                journalMode: process.env.OR3_SQLITE_PRAGMA_JOURNAL_MODE ?? 'WAL',
                synchronous: process.env.OR3_SQLITE_PRAGMA_SYNCHRONOUS ?? 'NORMAL',
            },
            warnings,
            actions: [
                {
                    id: 'sync.gc-change-log',
                    label: 'Run Sync Change Log GC',
                    description: 'Purge old change_log entries after retention and device cursor checks.',
                    danger: true,
                },
                {
                    id: 'sync.gc-tombstones',
                    label: 'Run Sync Tombstone GC',
                    description: 'Purge old tombstones after retention and device cursor checks.',
                    danger: true,
                },
            ],
        };
    },

    async runAction(
        event: H3Event,
        actionId: string,
        payload: Record<string, unknown> | undefined,
        ctx: ProviderActionContext
    ): Promise<unknown> {
        if (!ctx.session.workspace?.id) {
            throw createError({
                statusCode: 400,
                statusMessage: 'Workspace not resolved',
            });
        }

        const adapter = createSqliteSyncGatewayAdapter();
        const retentionSeconds = resolveRetentionSeconds(payload);
        const scope = { workspaceId: ctx.session.workspace.id };

        if (actionId === 'sync.gc-change-log') {
            await adapter.gcChangeLog?.(event, { scope, retentionSeconds });
            return { ok: true, action: actionId, retentionSeconds };
        }

        if (actionId === 'sync.gc-tombstones') {
            await adapter.gcTombstones?.(event, { scope, retentionSeconds });
            return { ok: true, action: actionId, retentionSeconds };
        }

        throw createError({ statusCode: 400, statusMessage: 'Unknown action' });
    },
};
