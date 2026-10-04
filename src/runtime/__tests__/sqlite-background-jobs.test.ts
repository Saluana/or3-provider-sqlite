import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { destroySqliteDb, getRawDb, initializeSqliteDb } from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { SqliteBackgroundJobProvider } from '../server/background-jobs/sqlite-provider';
import { createD1TestDatabase } from '../../../test/support/d1-test-database';
import type { RequestUsage } from '~~/shared/chat/compaction';
import type { BackgroundJobExecution, JobUpdate, TerminalGenerationSnapshot } from '~~/server/utils/background-jobs/types';

function measuredUsage(promptTokens = 150, iteration = 0): RequestUsage {
    return {
        prompt_tokens: promptTokens, completion_tokens: 25, model: 'test-model',
        request_id: `request-${iteration}`, iteration, measured_at: 1_800_000_000_000,
        prefix_message_count: iteration + 1, prefix_hash: `prefix-${iteration}`,
        configuration_hash: 'configuration-1', input_estimate_tokens: promptTokens - 10,
    };
}

// Failure inventory: dropped progress/terminal usage; summed snapshots; malformed
// telemetry breaking text; usage lost at reopen; uncheckpointed retry leakage;
// expired, superseded or absent lease owners overwriting a durable measurement.
describe('SQLite durable request usage', () => {
    let directory: string;
    let databasePath: string;
    let provider: SqliteBackgroundJobProvider;
    const params = {
        userId: 'user-usage', threadId: 'thread-usage', messageId: 'message-usage',
        model: 'test-model', generationId: 'generation-usage', kind: 'chat' as const,
    };
    const execution: BackgroundJobExecution = {
        version: 1, body: { model: 'test-model', messages: [] },
        workspaceId: 'workspace-usage', referer: 'https://example.test',
        apiKeyCiphertext: 'test-only-not-a-credential', contentBase: 'checkpoint',
    };

    async function reopen() {
        await destroySqliteDb();
        await runMigrations(await initializeSqliteDb({ path: databasePath }));
        provider = new SqliteBackgroundJobProvider();
    }

    beforeEach(async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        directory = await mkdtemp(join(tmpdir(), 'or3-sqlite-usage-'));
        databasePath = join(directory, 'history.sqlite');
        await runMigrations(await initializeSqliteDb({ path: databasePath }));
        provider = new SqliteBackgroundJobProvider();
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await destroySqliteDb();
        await rm(directory, { recursive: true, force: true });
    });

    it.each(['complete', 'error', 'aborted'] as const)(
        'reopens the last measured request after %s without summing snapshots', async (status) => {
            const id = await provider.createJob(params);
            await provider.updateJob(id, { contentChunk: 'answer', usage: measuredUsage() });
            const latest = measuredUsage(400, 1);
            await provider.updateJob(id, { usage: latest });
            await provider.updateJob(id, { usage: latest });
            await provider.updateJob(id, { reasoningChunk: 'reason', usage: undefined });
            await provider.updateJob(id, { usage: { ...latest, prompt_tokens: -1 } } as JobUpdate);
            expect(await provider.saveTerminalSnapshot(id, {
                status, content: 'answer', reasoning: 'reason', completedAt: Date.now(),
                ...(status === 'error' ? { error: 'provider interrupted' } : {}),
            })).toBe(true);
            await reopen();
            expect(await provider.getJob(id, params.userId)).toMatchObject({
                content: 'answer', reasoning: 'reason', status, usage: latest,
                generationId: params.generationId, historyPhase: 'finalization_pending',
            });
            expect((await provider.getPendingHistoryJobs(10))[0]?.usage).toEqual(latest);
            expect(await provider.getJob(id, 'different-user')).toBeNull();
        }
    );

    it('persists usage supplied only by the terminal snapshot and refuses late writes', async () => {
        const id = await provider.createJob(params);
        const usage = measuredUsage(400, 1);
        const terminal: TerminalGenerationSnapshot = {
            status: 'complete', content: 'terminal answer', reasoning: '',
            usage, completedAt: Date.now(),
        };
        expect(await provider.saveTerminalSnapshot(id, terminal)).toBe(true);
        await provider.updateJob(id, { contentChunk: 'late', usage: measuredUsage(900, 2) });
        expect(await provider.saveTerminalSnapshot(id, { ...terminal, usage: measuredUsage(900, 2) })).toBe(false);
        await reopen();
        expect(await provider.getJob(id, params.userId)).toMatchObject({ usage, content: 'terminal answer' });
    });

    it('preserves valid zero counters without manufacturing a measurement for old jobs', async () => {
        const id = await provider.createJob(params);
        expect((await provider.getJob(id, params.userId))?.usage).toBeUndefined();
        const zero = { ...measuredUsage(), prompt_tokens: 0, completion_tokens: 0 };
        await provider.updateJob(id, { usage: zero });
        await reopen();
        expect((await provider.getJob(id, params.userId))?.usage).toEqual(zero);
    });

    it.each(['abort', 'fail'] as const)('keeps the completed measurement on direct %s', async (method) => {
        const id = await provider.createJob(params);
        await provider.updateJob(id, { contentChunk: 'partial', usage: measuredUsage() });
        if (method === 'abort') await provider.abortJob(id, params.userId);
        else await provider.failJob(id, 'interrupted');
        await reopen();
        expect(await provider.getJob(id, params.userId)).toMatchObject({ content: 'partial', usage: measuredUsage() });
    });

    it('keeps missing and malformed usage absent while valid text persists', async () => {
        const id = await provider.createJob(params);
        for (const usage of [undefined, null, {}, { ...measuredUsage(), prompt_tokens: NaN },
            { ...measuredUsage(), prefix_hash: '' }, { ...measuredUsage(), completion_tokens: 1.5 }]) {
            await provider.updateJob(id, { contentChunk: 'text', usage } as JobUpdate);
        }
        await provider.saveTerminalSnapshot(id, {
            status: 'error', content: 'valid text', reasoning: '', completedAt: Date.now(),
            usage: { prompt_tokens: 1 },
        } as TerminalGenerationSnapshot);
        await reopen();
        expect(await provider.getJob(id, params.userId)).toMatchObject({ content: 'valid text', status: 'error' });
        expect((await provider.getJob(id, params.userId))?.usage).toBeUndefined();
    });

    it.each(['claimJob', 'claimNextJob'] as const)('%s restores only checkpointed measurement on a new attempt', async (method) => {
        const checkpoint = measuredUsage();
        const id = await provider.createJob({ ...params, execution: {
            ...execution, normalizedToolState: { requestUsage: checkpoint },
        } as BackgroundJobExecution });
        const now = Date.now();
        await provider.claimJob(id, 'worker-a', now, now + 1_000);
        await provider.updateJob(id, { leaseOwner: 'worker-a', contentChunk: 'discarded', usage: measuredUsage(400, 1) });
        await reopen();
        vi.mocked(Date.now).mockReturnValue(now + 2_000);
        const recovered = method === 'claimJob'
            ? await provider.claimJob(id, 'worker-b', Date.now(), now + 5_000)
            : await provider.claimNextJob('worker-b', Date.now(), now + 5_000);
        expect(recovered).toMatchObject({ content: 'checkpoint', usage: checkpoint, attempts: 2, generationId: params.generationId });
        await expect(provider.updateJob(id, { leaseOwner: 'worker-a', usage: measuredUsage(900, 2) }))
            .rejects.toMatchObject({ name: 'BackgroundJobLeaseLostError' });
        expect(await provider.saveTerminalSnapshot(id, {
            status: 'complete', content: 'stale', reasoning: '', usage: measuredUsage(900, 2), completedAt: Date.now(),
        }, 'worker-a')).toBe(false);
        expect((await provider.getJob(id, params.userId))?.usage).toEqual(checkpoint);
    });

    it.each([undefined, { prompt_tokens: 150 }])('clears discarded-attempt usage when the checkpoint is absent or malformed (%j)', async (requestUsage) => {
        const id = await provider.createJob({ ...params, execution: {
            ...execution, normalizedToolState: { requestUsage },
        } as BackgroundJobExecution });
        const now = Date.now();
        await provider.claimJob(id, 'worker-a', now, now + 1_000);
        await provider.updateJob(id, { leaseOwner: 'worker-a', usage: measuredUsage(400, 1) });
        vi.mocked(Date.now).mockReturnValue(now + 2_000);
        const recovered = await provider.claimJob(id, 'worker-b', Date.now(), now + 5_000);
        expect(recovered?.usage).toBeUndefined();
        await reopen();
        expect((await provider.getJob(id, params.userId))?.usage).toBeUndefined();
    });

    it.each(['claimJob', 'claimNextJob'] as const)('%s rejects a JSON-string checkpoint rather than parsing usage twice', async (method) => {
        const id = await provider.createJob({ ...params, execution: {
            ...execution, normalizedToolState: { requestUsage: JSON.stringify(measuredUsage()) },
        } as unknown as BackgroundJobExecution });
        const now = Date.now();
        await provider.claimJob(id, 'worker-a', now, now + 1_000);
        await provider.updateJob(id, { leaseOwner: 'worker-a', usage: measuredUsage(400, 1) });
        vi.mocked(Date.now).mockReturnValue(now + 2_000);
        const recovered = method === 'claimJob'
            ? await provider.claimJob(id, 'worker-b', Date.now(), now + 5_000)
            : await provider.claimNextJob('worker-b', Date.now(), now + 5_000);
        expect(recovered?.usage).toBeUndefined();
        await reopen();
        expect((await provider.getJob(id, params.userId))?.usage).toBeUndefined();
    });

    it('does not let missing or expired lease owners change measurements or checkpoints', async () => {
        const id = await provider.createJob({ ...params, execution });
        const now = Date.now();
        await provider.claimJob(id, 'worker-a', now, now + 1_000);
        await provider.updateJob(id, { leaseOwner: 'worker-a', usage: measuredUsage() });
        await provider.updateJob(id, { contentChunk: 'unowned', usage: measuredUsage(400, 1) });
        expect(await provider.saveTerminalSnapshot(id, {
            status: 'complete', content: 'unowned', reasoning: '', usage: measuredUsage(400, 1), completedAt: now,
        })).toBe(false);
        vi.mocked(Date.now).mockReturnValue(now + 2_000);
        expect(await provider.updateJobExecution(id, { ...execution, contentBase: 'stale checkpoint' }, 'worker-a')).toBe(false);
        await expect(provider.updateJob(id, { leaseOwner: 'worker-a', usage: measuredUsage(400, 1) }))
            .rejects.toMatchObject({ name: 'BackgroundJobLeaseLostError' });
        expect((await provider.getJob(id, params.userId))?.usage).toEqual(measuredUsage());
    });

    it.each(['complete', 'fail'] as const)('ignores unowned direct %s of a leased measured generation', async (method) => {
        const id = await provider.createJob({ ...params, execution });
        const now = Date.now();
        await provider.claimJob(id, 'worker-a', now, now + 1_000);
        await provider.updateJob(id, { leaseOwner: 'worker-a', contentChunk: 'owned answer', usage: measuredUsage() });
        if (method === 'complete') await provider.completeJob(id, 'unowned answer');
        else await provider.failJob(id, 'unowned error');
        expect(await provider.getJob(id, params.userId)).toMatchObject({ status: 'streaming', content: 'owned answer', usage: measuredUsage() });
    });

    it.each(['complete', 'fail'] as const)('rejects expired-owner direct %s of a measured generation', async (method) => {
        const id = await provider.createJob({ ...params, execution });
        const now = Date.now();
        await provider.claimJob(id, 'worker-a', now, now + 1_000);
        await provider.updateJob(id, { leaseOwner: 'worker-a', usage: measuredUsage() });
        vi.mocked(Date.now).mockReturnValue(now + 2_000);
        const finish = method === 'complete'
            ? provider.completeJob(id, 'expired answer', 'worker-a')
            : provider.failJob(id, 'expired error', 'worker-a');
        await expect(finish).rejects.toMatchObject({ name: 'BackgroundJobLeaseLostError' });
        expect(await provider.getJob(id, params.userId)).toMatchObject({ status: 'streaming', usage: measuredUsage() });
    });

    it('ignores malformed stored usage without breaking job text reads', async () => {
        const id = await provider.createJob({ ...params, initialContent: 'surviving text' });
        getRawDb().prepare('UPDATE background_jobs SET usage_json = ? WHERE id = ?').run('{broken', id);
        await reopen();
        expect(await provider.getJob(id, params.userId)).toMatchObject({ content: 'surviving text' });
        expect((await provider.getJob(id, params.userId))?.usage).toBeUndefined();
    });
});

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

    it('atomically parks, claims, and settles a browser tool call', async () => {
        const provider = new SqliteBackgroundJobProvider();
        const execution = {
            version: 1 as const,
            body: { model: 'test-model', messages: [] },
            workspaceId: 'workspace-1',
            referer: 'https://or3.chat',
            apiKeyCiphertext: 'ciphertext',
            pendingToolCalls: [
                {
                    id: 'call-1',
                    type: 'function' as const,
                    function: { name: 'client_tool', arguments: '{}' },
                },
            ],
            clientToolCall: {
                callId: 'call-1',
                name: 'client_tool',
                arguments: '{}',
                argumentFingerprint: 'fingerprint',
                definition: {
                    type: 'function' as const,
                    function: {
                        name: 'client_tool',
                        description: 'Client tool',
                        parameters: {
                            type: 'object' as const,
                            properties: {},
                        },
                    },
                    runtime: 'client' as const,
                },
            },
        };
        const jobId = await provider.createJob({
            userId: 'user-1',
            threadId: 'thread-1',
            messageId: 'message-1',
            model: 'test-model',
            execution,
            tool_calls: [
                { id: 'call-1', name: 'client_tool', status: 'pending' },
            ],
        });

        await expect(
            provider.claimJob(jobId, 'worker', Date.now(), Date.now() + 1_000)
        ).resolves.toBeNull();
        await expect(
            provider.claimClientToolCall(
                jobId,
                'user-1',
                'call-1',
                'token-1',
                Date.now() + 30_000
            )
        ).resolves.toMatchObject({
            execution: {
                clientToolCall: expect.objectContaining({ claimToken: 'token-1' }),
            },
        });
        await expect(
            provider.claimClientToolCall(
                jobId,
                'user-1',
                'call-1',
                'token-2',
                Date.now() + 30_000
            )
        ).resolves.toBeNull();

        const settled = {
            ...execution,
            pendingToolCalls: undefined,
            clientToolCall: undefined,
        };
        await expect(
            provider.settleClientToolCall(
                jobId,
                'user-1',
                'call-1',
                'token-1',
                settled,
                [{ id: 'call-1', name: 'client_tool', status: 'complete' }]
            )
        ).resolves.toBe(true);
        const resumed = await provider.claimJob(
            jobId,
            'worker',
            Date.now(),
            Date.now() + 1_000
        );
        expect(resumed?.execution).toMatchObject({
            body: settled.body,
            workspaceId: 'workspace-1',
        });
        expect(resumed?.execution?.clientToolCall).toBeUndefined();
        expect(resumed?.execution?.pendingToolCalls).toBeUndefined();
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
