import type { H3Event } from 'h3';
import { createError } from 'h3';
import type {
    ProviderAdminAdapter,
    ProviderActionContext,
    ProviderAdminStatusResult,
    ProviderStatusContext,
} from '~~/server/admin/providers/types';
import { SYNC_HISTORY_GC_POLICY } from '../../sync/history-gc-policy';

const SQLITE_PROVIDER_ID = 'sqlite';

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
        warnings.push({
            level: 'warning',
            message: SYNC_HISTORY_GC_POLICY.reason,
        });

        return {
            details: {
                dbPath: dbPath ?? ':memory:',
                journalMode: process.env.OR3_SQLITE_PRAGMA_JOURNAL_MODE ?? 'WAL',
                synchronous: process.env.OR3_SQLITE_PRAGMA_SYNCHRONOUS ?? 'NORMAL',
            },
            warnings,
            actions: [],
        };
    },

    async runAction(
        _event: H3Event,
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
            throw createError({
                statusCode: 503,
                statusMessage: SYNC_HISTORY_GC_POLICY.reason,
            });
        }

        throw createError({ statusCode: 400, statusMessage: 'Unknown action' });
    },
};
