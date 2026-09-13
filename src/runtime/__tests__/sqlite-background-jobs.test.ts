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

    it('finds a job by admission idempotency key for owner only', async () => {
        const provider = new SqliteBackgroundJobProvider();
        const jobId = await provider.createJob({
            userId: 'user-1',
            threadId: 'thread-1',
            messageId: 'message-1',
            model: 'openai/gpt-5.6-luna',
            kind: 'chat',
            idempotencyKey: 'admission-1'
        });

        await expect(
            provider.findJobByIdempotencyKey('admission-1', 'user-1')
        ).resolves.toMatchObject({ id: jobId });
        await expect(
            provider.findJobByIdempotencyKey('admission-1', 'user-2')
        ).resolves.toBeNull();
    });

    it('cancels an admission before creation and after commitment', async () => {
        const provider = new SqliteBackgroundJobProvider();

        await expect(
            provider.cancelAdmission('user-1', 'admission-before')
        ).resolves.toMatchObject({ aborted: false, pending: true });
        await expect(
            provider.createJob({
                userId: 'user-1',
                threadId: 'thread-1',
                messageId: 'message-1',
                model: 'openai/gpt-5.6-luna',
                kind: 'chat',
                idempotencyKey: 'admission-before',
            })
        ).rejects.toMatchObject({ name: 'AdmissionCancelledError' });

        const jobId = await provider.createJob({
            userId: 'user-1',
            threadId: 'thread-1',
            messageId: 'message-2',
            model: 'openai/gpt-5.6-luna',
            kind: 'chat',
            idempotencyKey: 'admission-after',
        });
        await expect(
            provider.cancelAdmission('user-1', 'admission-after')
        ).resolves.toMatchObject({ aborted: true, jobId, pending: false });
        await expect(
            provider.getJob(jobId, 'user-1')
        ).resolves.toMatchObject({ status: 'aborted' });
    });

    it('resets partial output to the checkpoint when reclaiming an expired job', async () => {
        const provider = new SqliteBackgroundJobProvider();
        const jobId = await provider.createJob({
            userId: 'user-1',
            threadId: 'thread-1',
            messageId: 'message-1',
            model: 'openai/gpt-5.6-luna',
            kind: 'chat',
            execution: {
                version: 1,
                body: { model: 'openai/gpt-5.6-luna' },
                workspaceId: 'workspace-1',
                referer: 'https://or3.chat',
                apiKeyCiphertext: 'ciphertext',
                contentBase: 'checkpoint',
                checkpointedToolCallIds: [],
            },
        });

        await provider.updateJob(jobId, {
            contentChunk: 'partial',
            chunksReceived: 3,
        });

        const now = Date.now();
        await expect(
            provider.claimJob(jobId, 'worker-a', now, now + 1_000)
        ).resolves.toMatchObject({ content: 'partial', chunksReceived: 3 });

        // The first lease expires; the recovery claim must reset the partial
        // response back to the durable checkpoint before new deltas append.
        const recovered = await provider.claimJob(
            jobId,
            'worker-b',
            now + 2_000,
            now + 5_000
        );
        expect(recovered).toMatchObject({
            content: 'checkpoint',
            chunksReceived: 0,
            attempts: 2,
        });
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
