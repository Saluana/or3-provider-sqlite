import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { destroySqliteDb, initializeSqliteDb } from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { SqliteBackgroundJobProvider } from '../server/background-jobs/sqlite-provider';
import { createD1TestDatabase } from '../../../test/support/d1-test-database';

describe('SQLite background jobs', () => {
    beforeEach(async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        await runMigrations(await initializeSqliteDb({ path: ':memory:' }));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await destroySqliteDb();
    });

    it('keeps a live job visible across provider instances', async () => {
        const first = new SqliteBackgroundJobProvider();
        const second = new SqliteBackgroundJobProvider();
        const jobId = await first.createJob({
            userId: 'user-1',
            threadId: 'thread-1',
            messageId: 'message-1',
            model: 'openai/gpt-5.6-luna',
            kind: 'workflow'
        });

        await first.updateJob(jobId, {
            contentChunk: 'hello',
            chunksReceived: 1
        });

        await expect(second.getJob(jobId, 'user-1')).resolves.toMatchObject({
            id: jobId,
            status: 'streaming',
            content: 'hello',
            chunksReceived: 1
        });
    });

    it('persists cancellation for external polling and rejects duplicate aborts', async () => {
        const provider = new SqliteBackgroundJobProvider();
        const jobId = await provider.createJob({
            userId: 'user-1',
            threadId: 'thread-1',
            messageId: 'message-1',
            model: 'openai/gpt-5.6-luna',
            kind: 'workflow'
        });

        await expect(provider.abortJob(jobId, 'user-1')).resolves.toBe(true);
        await expect(provider.checkJobAborted(jobId)).resolves.toBe(true);
        await expect(provider.abortJob(jobId, 'user-1')).resolves.toBe(false);
        await expect(provider.getJob(jobId, 'user-1')).resolves.toMatchObject({
            status: 'aborted',
            completedAt: 1_800_000_000_000
        });
    });

    it('deduplicates admission with an idempotency key', async () => {
        const provider = new SqliteBackgroundJobProvider();
        const params = {
            userId: 'user-1',
            threadId: 'thread-1',
            messageId: 'message-1',
            model: 'openai/gpt-5.6-luna',
            kind: 'workflow' as const,
            idempotencyKey: 'workflow:message-1'
        };

        const first = await provider.createJob(params);
        const second = await provider.createJob(params);
        expect(second).toBe(first);
        await expect(provider.getActiveJobCount()).resolves.toBe(1);
    });
});

describe('SQLite background jobs with D1', () => {
    let d1: ReturnType<typeof createD1TestDatabase>;

    beforeEach(async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        d1 = createD1TestDatabase();
        await runMigrations(
            await initializeSqliteDb({
                driver: 'd1',
                d1Database: d1.database
            })
        );
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await destroySqliteDb();
        d1.close();
    });

    it('persists and aborts a workflow job', async () => {
        const provider = new SqliteBackgroundJobProvider();
        const jobId = await provider.createJob({
            userId: 'user-1',
            threadId: 'thread-1',
            messageId: 'message-1',
            model: 'openai/gpt-5.6-luna',
            kind: 'workflow'
        });

        await provider.updateJob(jobId, {
            workflow_state: { executionState: 'running' } as never
        });
        await expect(provider.abortJob(jobId, 'user-1')).resolves.toBe(true);
        await expect(provider.getJob(jobId, 'user-1')).resolves.toMatchObject({
            status: 'aborted',
            workflow_state: { executionState: 'running' }
        });
    });
});
