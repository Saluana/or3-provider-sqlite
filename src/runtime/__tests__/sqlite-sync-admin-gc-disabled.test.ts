import { describe, expect, it } from 'vitest';
import type { H3Event } from 'h3';
import { sqliteSyncAdminAdapter } from '../server/admin/adapters/sync-sqlite';

const event = {} as H3Event;
const statusContext = {
    enabled: true,
    providerId: 'sqlite',
} as never;
const actionContext = {
    session: {
        workspace: { id: 'ws-1' },
    },
} as never;

describe('SQLite sync admin GC safety gate', () => {
    it('does not advertise destructive history actions', async () => {
        const status = await sqliteSyncAdminAdapter.getStatus(event, statusContext);

        expect(status.actions).toEqual([]);
        expect(status.warnings).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    message: expect.stringContaining('snapshot-v1 retention contract'),
                }),
            ])
        );
    });

    it.each(['sync.gc-change-log', 'sync.gc-tombstones'])(
        'rejects stale admin action %s',
        async (actionId) => {
            await expect(
                sqliteSyncAdminAdapter.runAction!(
                    event,
                    actionId,
                    { retentionSeconds: 1 },
                    actionContext
                )
            ).rejects.toMatchObject({
                statusCode: 503,
                message: expect.stringContaining('snapshot-v1 retention contract'),
            });
        }
    );
});
