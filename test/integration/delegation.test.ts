import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, toWebHandler } from 'h3';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSqliteDb, destroySqliteDb, getRawDb } from '#sqlite-runtime/server/db/kysely';
import { runMigrations } from '#sqlite-runtime/server/db/migrate';
import { SqliteBackgroundJobProvider } from '#sqlite-runtime/server/background-jobs/sqlite-provider';
import { SqliteSyncGatewayAdapter } from '#sqlite-runtime/server/sync/sqlite-sync-gateway-adapter';
import { SqliteAuthWorkspaceStore } from '#sqlite-runtime/server/auth/sqlite-auth-workspace-store';
import { registerAuthWorkspaceStore } from '~~/server/auth/store/registry';
import { registerSyncGatewayAdapter } from '~~/server/sync/gateway/registry';
import { registerServerTool } from '~~/server/utils/chat/tool-registry';
import { executeBackgroundJob, startBackgroundStream } from '~~/server/utils/background-jobs/stream-handler';
import { reconcileBackgroundJobHistory } from '~~/server/utils/background-jobs/history';
import { admitPreparedDelegationChildren, reconcileDelegationChild, reconcileDueDelegationWaits, resumeReconciledDelegation } from '~~/server/utils/background-jobs/delegation-coordinator';
import { reconstructDelegationChild } from '~~/server/utils/background-jobs/delegation-child';
import { getChatJobExecution } from '~~/server/utils/background-jobs/types';
import type { DelegationChildAdmission } from '~~/server/utils/background-jobs/types';
import { supportsDelegationCoordination, supportsDelegationHistory } from '~~/server/utils/background-jobs/capabilities';
import { runClaimedBackgroundJob } from '~~/server/utils/background-jobs/lifecycle';
import { getShutdownRuntime } from '~~/server/utils/shutdown/runtime';
import { encryptBackgroundCredential } from '~~/server/utils/background-jobs/crypto';
import { normalizeError } from '~~/shared/errors';
import { projectJobView, projectJobViewWithChildStatus } from '~~/server/utils/background-jobs/job-view';
import { getJobLiveState } from '~~/server/utils/background-jobs/viewers';
import { modelSearchDefinition } from '~~/shared/openrouter/delegation-model-catalog';
import type { ChatGenerationAdmissionEnvelope } from '~~/shared/chat/background-history';

const limits = vi.hoisted(() => ({ active: 10 }));
const draftStore = vi.hoisted(() => ({ provider: undefined as SqliteBackgroundJobProvider | undefined }));
vi.mock('~~/server/utils/background-jobs/store', () => ({ getJobConfig: () => ({
    maxConcurrentJobs: limits.active, maxConcurrentJobsPerUser: limits.active,
    jobTimeoutMs: 30 * 60 * 1000, completedJobRetentionMs: 60 * 60 * 1000,
}), getJobProvider: async () => draftStore.provider,
getBackgroundJobEncryptionKey: () => 'background-lifecycle-test-secret-that-is-long-enough',
isBackgroundStreamingEnabled: () => true }));
vi.mock('~~/shared/openrouter', async original => ({
    ...await original<typeof import('~~/shared/openrouter')>(),
    createOpenRouterClient: () => ({}),
    fetchOpenRouterCatalog: async () => [{ id: 'fixture/model', name: 'Fixture', context_length: 100_000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        top_provider: { context_length: 100_000, max_completion_tokens: 4096 }, supported_parameters: ['tools'] }],
}));
vi.mock('~~/server/auth/session', () => ({ resolveSessionContext: async () => ({ authenticated: true,
    user: { id: 'owner' }, workspace: { id: 'workspace' }, role: 'owner' }) }));

function sse(value: unknown): Response {
    return new Response(`data: ${JSON.stringify(value)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}

if (process.env.OR3_DELEGATION_RACE_WORKER) {
    it('runs a single process-contended delegation operation', async () => {
        const directory = process.env.OR3_DELEGATION_RACE_DIR!;
        const role = process.env.OR3_DELEGATION_RACE_WORKER!;
        const input = JSON.parse(await readFile(join(directory, 'input.json'), 'utf8')) as DelegationChildAdmission;
        await initializeSqliteDb({ path: join(directory, 'jobs.sqlite') });
        getRawDb().pragma?.('busy_timeout = 10000');
        const provider = new SqliteBackgroundJobProvider();
        try {
            await writeFile(join(directory, `${role}.ready`), 'ready');
            await vi.waitFor(() => access(join(directory, 'go')), { timeout: 15_000 });
            await writeFile(join(directory, `${role}.attempting`), 'attempting');
            const result = role === 'admit' ? await provider.admitDelegationChild(input)
                : await provider.abortJob(input.parentJobId, input.child.userId);
            await writeFile(join(directory, `${role}.result`), JSON.stringify(result));
        } finally { await destroySqliteDb(); }
    }, 25_000);
} else describe('SQLite delegation tool-loop integration', () => {
    let directory: string;
    let databasePath: string;
    let provider: SqliteBackgroundJobProvider;
    let sync: SqliteSyncGatewayAdapter;
    let unregister: (() => boolean) | undefined;
    const actor = { userId: 'owner', workspaceId: 'workspace' };
    const history: ChatGenerationAdmissionEnvelope = { version: 1, kind: 'new-turn', admissionId: 'parent-admission',
        generationId: 'parent-generation', workspaceId: actor.workspaceId, threadId: 'parent-thread', messageId: 'parent-assistant',
        thread: { id: 'parent-thread', clock: 1 },
        userMessage: { id: 'parent-user', thread_id: 'parent-thread', role: 'user', clock: 1 },
        assistantMessage: { id: 'parent-assistant', thread_id: 'parent-thread', role: 'assistant', clock: 1,
            pending: true, data: { generation_id: 'parent-generation' } } };

    function enableDraft() {
        provider = new SqliteBackgroundJobProvider();
        expect(supportsDelegationCoordination(provider)).toBe(true);
        draftStore.provider = provider;
    }
    async function reopen() {
        await destroySqliteDb();
        await runMigrations(await initializeSqliteDb({ path: databasePath }));
        enableDraft();
    }
    beforeEach(async () => {
        limits.active = 10;
        directory = await mkdtemp(join(tmpdir(), 'or3-delegation-loop-'));
        databasePath = join(directory, 'jobs.sqlite');
        await runMigrations(await initializeSqliteDb({ path: databasePath }));
        getRawDb().prepare('INSERT INTO workspaces (id, name, owner_user_id) VALUES (?, ?, ?)').run(actor.workspaceId, 'Fixture', actor.userId);
        getRawDb().prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)')
            .run('membership', actor.workspaceId, actor.userId, 'owner');
        enableDraft();
        sync = new SqliteSyncGatewayAdapter();
        registerSyncGatewayAdapter({ id: 'sqlite', create: () => sync });
        registerAuthWorkspaceStore({ id: 'sqlite', create: () => new SqliteAuthWorkspaceStore() });
        vi.stubGlobal('useRuntimeConfig', () => ({ public: { sync: { provider: 'sqlite' } }, backgroundJobs: {} }));
        await sync.admitChatGeneration(actor, history);
    });
    afterEach(async () => {
        unregister?.(); unregister = undefined;
        vi.unstubAllGlobals(); vi.restoreAllMocks();
        await destroySqliteDb();
        await rm(directory, { recursive: true, force: true });
    });

    it('does not advertise durable delegation until the native migration finishes', async () => {
        await destroySqliteDb();
        const uninitialized = new SqliteBackgroundJobProvider();
        expect(supportsDelegationCoordination(uninitialized)).toBe(false);
        const fresh = await initializeSqliteDb({ path: join(directory, 'fresh.sqlite') });
        expect(supportsDelegationCoordination(uninitialized)).toBe(false);
        await runMigrations(fresh);
        expect(supportsDelegationCoordination(uninitialized)).toBe(true);
    });

    it.each(['completes', 'loses its first worker'] as const)(
        'admits a durable parent with a guarded first dispatch and %s', async outcome => {
        const delegate = { type: 'function' as const, function: { name: 'delegate_chat', description: 'Delegate',
            parameters: { type: 'object' as const, properties: {} } } };
        const admission: ChatGenerationAdmissionEnvelope = { ...history, admissionId: 'new-admission', generationId: 'new-generation',
            threadId: 'new-thread', messageId: 'new-assistant', thread: { id: 'new-thread', clock: 1 },
            userMessage: { id: 'new-user', thread_id: 'new-thread', role: 'user', clock: 1 },
            assistantMessage: { id: 'new-assistant', thread_id: 'new-thread', role: 'assistant', clock: 1,
                pending: true, data: { generation_id: 'new-generation' } } };
        let release!: () => void;
        const barrier = new Promise<void>(resolve => { release = resolve; });
        let entered!: () => void;
        const dispatched = new Promise<void>(resolve => { entered = resolve; });
        let sent: Record<string, unknown> | undefined;
        const fetchModel = vi.fn(async (_url: string, init: RequestInit) => {
            sent = JSON.parse(String(init.body)) as Record<string, unknown>;
            entered();
            await barrier;
            return sse({ choices: [{ delta: { content: 'parent answer' }, finish_reason: 'stop' }] });
        });
        vi.stubGlobal('fetch', fetchModel);
        const params = { userId: actor.userId, workspaceId: actor.workspaceId, threadId: admission.threadId, messageId: admission.messageId,
            apiKey: 'fixture-key', referer: 'https://example.test', body: {
                model: 'fixture/model', messages: [{ role: 'user', content: 'Parent task' }], tools: [delegate],
                modalities: ['text'], _toolRuntime: { delegate_chat: 'client' }, _context: { version: 1,
                    user_max_context_tokens: null, requested_completion_tokens: null }, _durableDelegation: 1,
                _delegationDefaults: { version: 1, instructions: [] }, _history: admission,
                _backgroundAdmissionId: admission.admissionId,
            } };
        expect(supportsDelegationCoordination(provider)).toBe(true);
        expect(supportsDelegationHistory(sync)).toBe(true);
        const capabilityHandler = (await import('~~/server/api/jobs/client-tool/capability.get')).default;
        const capability = toWebHandler(createApp().use('/capability', capabilityHandler));
        const discover = async () => (await capability(new Request('http://localhost/capability'))).json() as Promise<Record<string, unknown>>;
        expect(await discover()).toMatchObject({ available: true, durableDelegationVersion: 1 });
        expect(await discover()).not.toHaveProperty('serverModelSearchVersion');
        const removeSearch = registerServerTool({ ...modelSearchDefinition, runtime: 'server' }, () => 'unused', { runtime: 'server' });
        try { expect(await discover()).toMatchObject({ serverModelSearchVersion: 1 }); }
        finally { removeSearch(); }
        expect(await discover()).not.toHaveProperty('serverModelSearchVersion');
        const legacyProvider = new SqliteBackgroundJobProvider();
        Object.defineProperty(legacyProvider, 'delegationCoordinatorVersion', { value: undefined });
        draftStore.provider = legacyProvider;
        expect(await discover()).not.toHaveProperty('durableDelegationVersion');
        draftStore.provider = provider;
        const browserTool = { type: 'function' as const, function: { name: 'browser_tool', description: 'Browser',
            parameters: { type: 'object' as const, properties: {} } } };
        for (const body of [
            { ...params.body, _durableDelegation: 2 },
            { ...params.body, _delegationDefaults: undefined },
            { ...params.body, tools: [delegate, browserTool], _toolRuntime: { delegate_chat: 'client', browser_tool: 'client' } },
            { ...params.body, _toolRuntime: { delegate_chat: 'client', unknown: 'server' } },
        ]) {
            await expect(startBackgroundStream({ ...params, body })).rejects.toMatchObject({ name: 'BackgroundDurableDelegationUnsupportedError' });
        }
        const { _context, ...withoutContext } = params.body;
        await expect(startBackgroundStream({ ...params, body: withoutContext }))
            .rejects.toMatchObject({ name: 'BackgroundDurableDelegationUnsupportedError' });
        Object.defineProperty(sync, 'capabilities', { configurable: true, value: { ...sync.capabilities, canonicalChatHistory: undefined } });
        expect(await discover()).not.toHaveProperty('durableDelegationVersion');
        await expect(startBackgroundStream(params)).rejects.toMatchObject({ name: 'BackgroundDurableDelegationUnsupportedError' });
        delete (sync as unknown as { capabilities?: unknown }).capabilities;
        expect(await provider.getActiveJobCount()).toBe(0);
        expect(sent).toBeUndefined();
        const result = await startBackgroundStream(params);
        try {
            await dispatched;
            const parent = (await provider.getJob(result.jobId, actor.userId))!;
            expect(getChatJobExecution(parent)).toMatchObject({ delegationRecoveryPolicy: 'v1', delegationDispatch: { state: 'started' } });
            expect(getChatJobExecution(parent)!.body).not.toHaveProperty('_durableDelegation');
            expect(sent).not.toHaveProperty('_durableDelegation');
            expect(sent).not.toHaveProperty('_delegationDefaults');
            if (outcome === 'loses its first worker') {
                let now = Date.now();
                vi.spyOn(Date, 'now').mockImplementation(() => now);
                await reopen();
                now = Math.max(now, parent.leaseExpiresAt ?? 0) + 1;
                const recovered = await provider.claimJob(parent.id, 'parent-recovery', now, now + 60_000);
                expect(recovered).toBeTruthy();
                await runClaimedBackgroundJob(recovered!, { provider,
                    encryptionKey: 'background-lifecycle-test-secret-that-is-long-enough', execute: executeBackgroundJob });
                const uncertain = (await provider.getJob(parent.id, actor.userId))!;
                expect(uncertain.status).toBe('error');
                expect(normalizeError(uncertain.error)).toMatchObject({ code: 'ERR_MODEL_OUTCOME_UNKNOWN' });
                expect(fetchModel).toHaveBeenCalledOnce();
            }
        } finally { release(); }
        await vi.waitFor(() => expect(getShutdownRuntime().controller.workload().work).toBe(0));
        await vi.waitFor(async () => expect((await provider.getJob(result.jobId, actor.userId))?.status)
            .toBe(outcome === 'completes' ? 'complete' : 'error'));
        expect(fetchModel).toHaveBeenCalledOnce();
        if (outcome === 'loses its first worker') {
            expect((await provider.getJob(result.jobId, actor.userId))?.content).not.toContain('parent answer');
            const saved = await sync.readChatHistory(actor, { kind: 'messages', message_ids: [admission.messageId] });
            expect(saved.messages?.[0]?.data).not.toMatchObject({ content: 'parent answer' });
        }
    });

    it.each([
        { withTools: false, interruption: 'stop' }, { withTools: true, interruption: 'stop' },
        { withTools: false, interruption: 'lease loss' }, { withTools: true, interruption: 'lease loss' },
        { withTools: false, interruption: 'unknown marker version' }, { withTools: true, interruption: 'unknown marker version' },
    ] as const)('does not dispatch after $interruption follows the marker (tools: $withTools)', async ({ withTools, interruption }) => {
        const delegate = { type: 'function' as const, function: { name: 'delegate_chat', description: 'Delegate',
            parameters: { type: 'object' as const, properties: {} } } };
        const body = { model: 'fixture/model', messages: [{ role: 'user', content: 'Parent task' }],
            _context: { version: 1, user_max_context_tokens: 50_000, requested_completion_tokens: null },
            ...(withTools ? { tools: [delegate], _toolRuntime: { delegate_chat: 'client' } } : {}) };
        const execution = { version: 1 as const, workspaceId: actor.workspaceId, referer: 'https://example.test',
            apiKeyCiphertext: 'fixture-ciphertext', body, history, delegationRecoveryPolicy: 'v1' as const,
            delegationDefaults: { version: 1 as const, instructions: [] } };
        const id = await provider.createJob({ userId: actor.userId, threadId: history.threadId, messageId: history.messageId,
            model: body.model, kind: 'chat', generationId: history.generationId, syncProviderId: 'sqlite', historyPhase: 'ready', execution });
        const now = Date.now();
        expect(await provider.claimJob(id, 'old-worker', now, now + 60_000)).toBeTruthy();
        const begin = provider.beginDelegationDispatch.bind(provider);
        vi.spyOn(provider, 'beginDelegationDispatch').mockImplementation(async (...args) => {
            const marker = await begin(...args);
            if (interruption === 'stop') await provider.abortJob(id, actor.userId);
            else if (interruption === 'lease loss') getRawDb().prepare('UPDATE background_jobs SET lease_owner = ? WHERE id = ?').run('new-worker', id);
            else getRawDb().prepare(`UPDATE background_jobs SET execution_json =
                json_set(execution_json, '$.delegationDispatch.version', 2) WHERE id = ?`).run(id);
            return marker;
        });
        const fetchModel = vi.fn(async () => sse({ choices: [{ delta: { content: 'unexpected' }, finish_reason: 'stop' }] }));
        vi.stubGlobal('fetch', fetchModel);
        await executeBackgroundJob(id, { body, apiKey: 'fixture-key', userId: actor.userId, workspaceId: actor.workspaceId,
            threadId: history.threadId, messageId: history.messageId, referer: execution.referer,
            execution, leaseOwner: 'old-worker' }, provider).catch(() => {});
        expect(fetchModel).not.toHaveBeenCalled();
        const stored = (await provider.getJob(id, actor.userId))!;
        expect(stored.content).not.toContain('unexpected');
        if (interruption === 'lease loss') expect(stored.leaseOwner).toBe('new-worker');
        else if (interruption === 'stop') expect(stored.status).toBe('aborted');
        else expect(getChatJobExecution(stored)?.delegationDispatch).toMatchObject({ version: 2 });
    });

    it('serializes child admission and parent Stop across independent SQLite processes', async () => {
        const delegate = { type: 'function' as const, function: { name: 'delegate_chat', description: 'Delegate',
            parameters: { type: 'object' as const, properties: {} } } };
        const body = { model: 'fixture/model', messages: [{ role: 'user', content: 'Parent task' }], tools: [delegate],
            _toolRuntime: { delegate_chat: 'client' },
            _context: { version: 1, user_max_context_tokens: 50_000, requested_completion_tokens: null } };
        const execution = { version: 1 as const, workspaceId: actor.workspaceId, referer: 'https://example.test',
            apiKeyCiphertext: 'fixture-ciphertext', body, history, delegationRecoveryPolicy: 'v1' as const,
            delegationDefaults: { version: 1 as const, instructions: [] } };
        const parentId = await provider.createJob({ userId: actor.userId, threadId: history.threadId, messageId: history.messageId,
            model: body.model, kind: 'chat', generationId: history.generationId, syncProviderId: 'sqlite', historyPhase: 'ready', execution });
        const now = Date.now();
        expect(await provider.claimJob(parentId, 'parent-worker', now, now + 60_000)).toBeTruthy();
        vi.stubGlobal('fetch', vi.fn(async () => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'race-call',
            function: { name: 'delegate_chat', arguments: JSON.stringify({ task: 'Research the topic' }) } }] }, finish_reason: 'tool_calls' }] })));
        await executeBackgroundJob(parentId, { body, apiKey: 'fixture-key', userId: actor.userId, workspaceId: actor.workspaceId,
            threadId: history.threadId, messageId: history.messageId, referer: execution.referer,
            execution, leaseOwner: 'parent-worker' }, provider);
        const claimed = await provider.claimNextDelegationWait('coordinator', Date.now(), Date.now() + 60_000);
        if (!claimed) throw new Error('Parent did not park for coordination');
        const wait = getChatJobExecution(claimed)!.delegationWait!;
        const input: DelegationChildAdmission = { parentJobId: parentId, leaseOwner: 'coordinator', revision: wait.revision,
            callId: wait.callId, argumentFingerprint: wait.argumentFingerprint, childIndex: 0,
            child: reconstructDelegationChild(claimed, 0) };
        await writeFile(join(directory, 'input.json'), JSON.stringify(input), { mode: 0o600 });

        const workers = ['admit', 'stop'].map(role => {
            const child = spawn(process.execPath, [join(process.cwd(), 'node_modules/vitest/vitest.mjs'), 'run',
                '--config', 'vitest.delegation-integration.config.ts', '--reporter=dot', '--silent'], {
                cwd: process.cwd(), env: { ...process.env, OR3_DELEGATION_RACE_WORKER: role, OR3_DELEGATION_RACE_DIR: directory },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let output = '';
            child.stdout.on('data', chunk => { output += String(chunk); });
            child.stderr.on('data', chunk => { output += String(chunk); });
            const finished = new Promise<void>((resolve, reject) => {
                child.once('error', reject);
                child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${role} worker exited ${code}: ${output}`)));
            });
            void finished.catch(() => {});
            return { child, finished };
        });
        try {
            await vi.waitFor(async () => { await access(join(directory, 'admit.ready')); await access(join(directory, 'stop.ready')); }, { timeout: 15_000 });
            getRawDb().exec('BEGIN IMMEDIATE');
            try {
                await writeFile(join(directory, 'go'), 'go');
                await vi.waitFor(async () => { await access(join(directory, 'admit.attempting')); await access(join(directory, 'stop.attempting')); }, { timeout: 15_000 });
                // Both independent connections must be waiting while the test
                // holds the writer lock, rather than completing sequentially.
                await new Promise(resolve => setTimeout(resolve, 150));
                for (const worker of workers) expect(worker.child.exitCode).toBeNull();
                await expect(access(join(directory, 'admit.result'))).rejects.toThrow();
                await expect(access(join(directory, 'stop.result'))).rejects.toThrow();
            } finally { getRawDb().exec('COMMIT'); }
            await Promise.all(workers.map(worker => worker.finished));
            const admission = JSON.parse(await readFile(join(directory, 'admit.result'), 'utf8')) as { status: string; jobId?: string };
            expect(JSON.parse(await readFile(join(directory, 'stop.result'), 'utf8'))).toBe(true);
            expect(['admitted', 'not-owned']).toContain(admission.status);
            const parent = (await provider.getJob(parentId, actor.userId))!;
            const stoppedWait = getChatJobExecution(parent)!.delegationWait!;
            expect(parent.status).toBe('aborted');
            const rows = getRawDb().prepare('SELECT id FROM background_jobs WHERE delegation_parent_id = ?').all(parentId) as { id: string }[];
            const saved = stoppedWait.children[0];
            if (admission.status === 'admitted') {
                expect(rows).toEqual([{ id: admission.jobId }]);
                expect(saved).toMatchObject({ jobId: admission.jobId });
                const cleanup = await provider.claimNextDelegationWait('cleanup', Date.now(), Date.now() + 60_000);
                expect(cleanup?.id).toBe(parentId);
                expect(await provider.cleanupDelegationWait({ parentJobId: parentId, leaseOwner: 'cleanup', expectedRevision: stoppedWait.revision })).toBe('pending');
                expect((await provider.getJob(admission.jobId!, actor.userId))?.status).toBe('aborted');
            } else {
                expect(rows).toEqual([]);
                expect(saved).not.toHaveProperty('jobId');
            }
        } finally {
            for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
            await Promise.allSettled(workers.map(worker => worker.finished));
        }
    }, 40_000);

    it.each(['defer', 'lease-expiry', 'near-deadline', 'stop-during-deferral'] as const)(
        'continues other parked parents when one coordination attempt fails (%s)', async recovery => {
        const delegate = { type: 'function' as const, function: { name: 'delegate_chat', description: 'Delegate',
            parameters: { type: 'object' as const, properties: {} } } };
        const body = { model: 'fixture/model', messages: [{ role: 'user', content: 'Parent task' }], tools: [delegate],
            _toolRuntime: { delegate_chat: 'client' },
            _context: { version: 1, user_max_context_tokens: 50_000, requested_completion_tokens: null } };
        const otherHistory: ChatGenerationAdmissionEnvelope = { ...history, admissionId: 'other-admission',
            generationId: 'other-generation', threadId: 'other-thread', messageId: 'other-assistant',
            thread: { id: 'other-thread', clock: 1 },
            userMessage: { id: 'other-user', thread_id: 'other-thread', role: 'user', clock: 1 },
            assistantMessage: { id: 'other-assistant', thread_id: 'other-thread', role: 'assistant', clock: 1,
                pending: true, data: { generation_id: 'other-generation' } } };
        await sync.admitChatGeneration(actor, otherHistory);
        vi.stubGlobal('fetch', vi.fn(async () => sse({ choices: [{ delta: { tool_calls: [
            { index: 0, id: 'delegate-call', function: { name: 'delegate_chat',
                arguments: JSON.stringify({ tasks: [{ task: 'Research topic', model: 'Fixture' }] }) } },
        ] }, finish_reason: 'tool_calls' }] })));
        const ids: string[] = [];
        const actualNow = Date.now();
        const nearDeadlineClock = recovery === 'near-deadline'
            ? vi.spyOn(Date, 'now').mockReturnValue(actualNow - 7_190_000) : undefined;
        for (const envelope of [history, otherHistory]) {
            const execution = { version: 1 as const, workspaceId: actor.workspaceId, referer: 'https://example.test',
                apiKeyCiphertext: 'fixture-ciphertext', body, history: envelope, delegationRecoveryPolicy: 'v1' as const,
                delegationDefaults: { version: 1 as const, instructions: [] } };
            const id = await provider.createJob({ ...actor, threadId: envelope.threadId, messageId: envelope.messageId,
                model: body.model, kind: 'chat', generationId: envelope.generationId, syncProviderId: 'sqlite',
                historyPhase: 'ready', execution });
            ids.push(id);
            const job = (await provider.claimJob(id, 'parent-worker', Date.now(), Date.now() + 60_000))!;
            await executeBackgroundJob(id, { body, apiKey: 'fixture-key', userId: job.userId, workspaceId: actor.workspaceId,
                threadId: job.threadId, messageId: job.messageId, referer: execution.referer, execution, leaseOwner: 'parent-worker' }, provider);
            expect(getChatJobExecution((await provider.getJob(id, actor.userId))!)?.delegationWait).toBeDefined();
        }
        nearDeadlineClock?.mockRestore();
        let failedId = '';
        const deadline = actualNow + 10_000;
        vi.spyOn(provider, 'stopInvalidDelegationWait').mockImplementationOnce(async input => {
            failedId = input.parentJobId;
            throw new Error('private-fixture-secret');
        });
        if (recovery === 'lease-expiry')
            vi.spyOn(provider, 'commitDelegationWait').mockRejectedValueOnce(new Error('private-deferral-error'));
        if (recovery === 'stop-during-deferral') {
            const commit = provider.commitDelegationWait.bind(provider);
            vi.spyOn(provider, 'commitDelegationWait').mockImplementationOnce(async input => {
                await provider.abortJob(input.parentJobId, actor.userId);
                return commit(input);
            });
        }
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await reconcileDueDelegationWaits(provider, 2)).toBe(2);
        const healthyId = ids.find(id => id !== failedId)!;
        const failed = (await provider.getJob(failedId, actor.userId))!;
        const healthy = (await provider.getJob(healthyId, actor.userId))!;
        expect(failed.status).toBe(recovery === 'stop-during-deferral' ? 'aborted' : 'streaming');
        if (recovery === 'defer' || recovery === 'near-deadline') {
            expect(failed.leaseOwner).toBeFalsy();
            expect(getChatJobExecution(failed)!.delegationWait!.nextCheckAt).toBeGreaterThan(Date.now());
            if (recovery === 'near-deadline')
                expect(getChatJobExecution(failed)!.delegationWait!.nextCheckAt).toBe(deadline);
        } else if (recovery === 'lease-expiry') expect(failed.leaseOwner).toBeTruthy();
        expect(getChatJobExecution(failed)!.delegationWait!.children[0]).not.toHaveProperty('jobId');
        expect(getChatJobExecution(healthy)!.delegationWait!.children[0]).toHaveProperty('jobId');
        expect(JSON.stringify(warning.mock.calls)).not.toContain('private-fixture-secret');
        expect(JSON.stringify(warning.mock.calls)).not.toContain('private-deferral-error');
        if (recovery === 'stop-during-deferral') return;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + (recovery === 'near-deadline' ? 11_000 : 31_000));
        try {
            expect(await reconcileDueDelegationWaits(provider, 2)).toBe(2);
            const retried = (await provider.getJob(failedId, actor.userId))!;
            if (recovery === 'near-deadline') expect(getChatJobExecution(retried)!.delegationWait!.expiredAt).toBeDefined();
            else expect(getChatJobExecution(retried)!.delegationWait!.children[0]).toHaveProperty('jobId');
        } finally { clock.mockRestore(); }
    });

    it.each(['authorization', 'expiry'] as const)(
        'does not starve a healthy parent behind repeatedly failing %s waits', async failure => {
        const start = Date.now();
        let now = start;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const delegate = { type: 'function' as const, function: { name: 'delegate_chat', description: 'Delegate',
            parameters: { type: 'object' as const, properties: {} } } };
        const body = { model: 'fixture/model', messages: [{ role: 'user', content: 'Parent task' }], tools: [delegate],
            _toolRuntime: { delegate_chat: 'client' },
            _context: { version: 1, user_max_context_tokens: 50_000, requested_completion_tokens: null } };
        vi.stubGlobal('fetch', vi.fn(async () => sse({ choices: [{ delta: { tool_calls: [
            { index: 0, id: 'delegate-call', function: { name: 'delegate_chat',
                arguments: JSON.stringify({ tasks: [{ task: 'Research topic', model: 'Fixture' }] }) } },
        ] }, finish_reason: 'tool_calls' }] })));
        const ids: string[] = [];
        for (let index = 0; index < 8; index++) {
            const suffix = String(index);
            const envelope: ChatGenerationAdmissionEnvelope = { ...history, admissionId: `admission-${suffix}`,
                generationId: `generation-${suffix}`, threadId: `thread-${suffix}`, messageId: `assistant-${suffix}`,
                thread: { id: `thread-${suffix}`, clock: 1 },
                userMessage: { id: `user-${suffix}`, thread_id: `thread-${suffix}`, role: 'user', clock: 1 },
                assistantMessage: { id: `assistant-${suffix}`, thread_id: `thread-${suffix}`, role: 'assistant', clock: 1,
                    pending: true, data: { generation_id: `generation-${suffix}` } } };
            await sync.admitChatGeneration(actor, envelope);
            const execution = { version: 1 as const, workspaceId: actor.workspaceId, referer: 'https://example.test',
                apiKeyCiphertext: 'fixture-ciphertext', body, history: envelope, delegationRecoveryPolicy: 'v1' as const,
                delegationDefaults: { version: 1 as const, instructions: [] } };
            const id = await provider.createJob({ ...actor, threadId: envelope.threadId, messageId: envelope.messageId,
                model: body.model, kind: 'chat', generationId: envelope.generationId, syncProviderId: 'sqlite',
                historyPhase: 'ready', execution });
            ids.push(id);
            const job = (await provider.claimJob(id, 'parent-worker', now, now + 60_000))!;
            await executeBackgroundJob(id, { body, apiKey: 'fixture-key', userId: job.userId, workspaceId: actor.workspaceId,
                threadId: job.threadId, messageId: job.messageId, referer: execution.referer, execution, leaseOwner: 'parent-worker' }, provider);
            getRawDb().prepare("UPDATE background_jobs SET execution_json = json_set(execution_json, '$.delegationWait.nextCheckAt', ?) WHERE id = ?")
                .run(start - 100 + index, id);
        }
        const healthyId = ids.at(-1)!;
        if (failure === 'authorization') {
            const stopInvalid = provider.stopInvalidDelegationWait.bind(provider);
            vi.spyOn(provider, 'stopInvalidDelegationWait').mockImplementation(async input => {
                if (input.parentJobId !== healthyId) throw new Error('transient fixture error');
                return stopInvalid(input);
            });
        } else {
            const deadline = getChatJobExecution((await provider.getJob(healthyId, actor.userId))!)!.delegationWait!.deadlineAt;
            for (const id of ids) getRawDb().prepare("UPDATE background_jobs SET execution_json = json_set(execution_json, '$.delegationWait.nextCheckAt', ?) WHERE id = ?")
                .run(deadline + (id === healthyId ? 1 : 0), id);
            now = deadline + 10;
            const expire = provider.expireDelegationWait.bind(provider);
            vi.spyOn(provider, 'expireDelegationWait').mockImplementation(async input => {
                if (input.parentJobId !== healthyId) throw new Error('transient fixture error');
                return expire(input);
            });
        }
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        if (failure === 'authorization') {
            for (let scan = 0; scan < 8; scan++) {
                now = start + scan * 5_000;
                expect(await reconcileDueDelegationWaits(provider, 1)).toBe(1);
            }
            expect(getChatJobExecution((await provider.getJob(healthyId, actor.userId))!)!.delegationWait!.children[0]).toHaveProperty('jobId');
        } else {
            expect(await reconcileDueDelegationWaits(provider, 8)).toBe(8);
            expect(getChatJobExecution((await provider.getJob(healthyId, actor.userId))!)!.delegationWait!.expiredAt).toBe(now);
        }
    });

    it('recovers stopped children when a parked parent has unreadable tool activity', async () => {
        const delegate = { type: 'function' as const, function: { name: 'delegate_chat', description: 'Delegate',
            parameters: { type: 'object' as const, properties: {} } } };
        const body = { model: 'fixture/model', messages: [{ role: 'user', content: 'Parent task' }], tools: [delegate],
            _toolRuntime: { delegate_chat: 'client' },
            _context: { version: 1, user_max_context_tokens: 50_000, requested_completion_tokens: null } };
        const execution = { version: 1 as const, workspaceId: actor.workspaceId, referer: 'https://example.test',
            apiKeyCiphertext: 'fixture-ciphertext', body, history, delegationRecoveryPolicy: 'v1' as const,
            delegationDefaults: { version: 1 as const, instructions: [] } };
        const id = await provider.createJob({ ...actor, threadId: history.threadId, messageId: history.messageId,
            model: body.model, kind: 'chat', generationId: history.generationId, syncProviderId: 'sqlite',
            historyPhase: 'ready', execution });
        const parent = (await provider.claimJob(id, 'parent-worker', Date.now(), Date.now() + 60_000))!;
        const fetchModel = vi.fn(async () => sse({ choices: [{ delta: { tool_calls: [
            { index: 0, id: 'delegate-call', function: { name: 'delegate_chat',
                arguments: JSON.stringify({ tasks: [{ task: 'Research topic', model: 'Fixture' }] }) } },
        ] }, finish_reason: 'tool_calls' }] }));
        vi.stubGlobal('fetch', fetchModel);
        await executeBackgroundJob(id, { body, apiKey: 'fixture-key', userId: parent.userId, workspaceId: actor.workspaceId,
            threadId: parent.threadId, messageId: parent.messageId, referer: execution.referer, execution, leaseOwner: 'parent-worker' }, provider);
        expect(await reconcileDueDelegationWaits(provider, 1)).toBe(1);
        const child = getChatJobExecution((await provider.getJob(id, actor.userId))!)!.delegationWait!.children[0];
        if (child?.kind !== 'prepared' || !child.jobId) throw new Error('Child was not admitted');
        expect(await provider.abortJob(id, actor.userId)).toBe(true);
        getRawDb().prepare('UPDATE background_jobs SET tool_calls_json = ? WHERE id = ?').run('{private broken data', id);
        await expect(reconcileDueDelegationWaits(provider, 1)).rejects.toThrow(`Invalid delegation job checkpoint (job ${id})`);
        getRawDb().prepare("UPDATE background_jobs SET history_phase = 'admission_pending' WHERE id = ?").run(id);
        expect((await provider.getPendingHistoryJobs(10)).map(job => job.id)).toContain(child.jobId);
        await reopen();
        expect(await reconcileDueDelegationWaits(provider, 1)).toBe(0);
        expect((await provider.getJob(child.jobId, actor.userId))?.status).toBe('aborted');
        expect(getRawDb().prepare('SELECT tool_calls_json FROM background_jobs WHERE id = ?').get(id))
            .toMatchObject({ tool_calls_json: '{private broken data' });
        expect(await provider.getShutdownBlockerCount()).toBeGreaterThan(0);
        expect(fetchModel).toHaveBeenCalledOnce();
    });

    it.each(['resume', 'stop'] as const)('keeps parked parents as shutdown blockers during preparation (%s)', async outcome => {
        const delegate = { type: 'function' as const, function: { name: 'delegate_chat', description: 'Delegate',
            parameters: { type: 'object' as const, properties: {} } } };
        const body = { model: 'fixture/model', messages: [{ role: 'user', content: 'Parent task' }], tools: [delegate],
            _toolRuntime: { delegate_chat: 'client' },
            _context: { version: 1, user_max_context_tokens: 50_000, requested_completion_tokens: null } };
        const execution = { version: 1 as const, workspaceId: actor.workspaceId, referer: 'https://example.test',
            apiKeyCiphertext: 'fixture-ciphertext', body, history, delegationRecoveryPolicy: 'v1' as const,
            delegationDefaults: { version: 1 as const, instructions: [] } };
        const id = await provider.createJob({ ...actor, threadId: history.threadId, messageId: history.messageId,
            model: body.model, kind: 'chat', generationId: history.generationId, syncProviderId: 'sqlite',
            historyPhase: 'ready', execution });
        const parent = (await provider.claimJob(id, 'parent-worker', Date.now(), Date.now() + 60_000))!;
        const fetchModel = vi.fn(async () => sse({ choices: [{ delta: { tool_calls: [
            { index: 0, id: 'delegate-call', function: { name: 'delegate_chat',
                arguments: JSON.stringify({ tasks: [{ task: 'Research topic', model: 'Fixture' }] }) } },
        ] }, finish_reason: 'tool_calls' }] }));
        vi.stubGlobal('fetch', fetchModel);
        await executeBackgroundJob(id, { body, apiKey: 'fixture-key', userId: parent.userId, workspaceId: actor.workspaceId,
            threadId: parent.threadId, messageId: parent.messageId, referer: execution.referer, execution, leaseOwner: 'parent-worker' }, provider);
        await reopen();
        expect(await provider.getShutdownBlockerCount()).toBeGreaterThan(0);
        const controller = getShutdownRuntime().controller;
        const preparation = controller.prepare('fixture-preparation', 5_000);
        try {
            expect(controller.phase()).toBe('preparing');
            expect(await reconcileDueDelegationWaits(provider, 1)).toBe(1);
            const parked = (await provider.getJob(id, actor.userId))!;
            expect(parked.status).toBe('streaming');
            expect(getChatJobExecution(parked)!.delegationWait!.children[0]).not.toHaveProperty('jobId');
            expect(await provider.getShutdownBlockerCount()).toBeGreaterThan(0);
            expect(fetchModel).toHaveBeenCalledOnce();
            if (outcome === 'stop') {
                expect(await provider.abortJob(id, actor.userId)).toBe(true);
                expect(await reconcileDueDelegationWaits(provider, 1)).toBe(1);
                expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(id, actor.userId))!)).toBe('committed');
                const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_001);
                try { expect(await reconcileDueDelegationWaits(provider, 1)).toBe(1); }
                finally { clock.mockRestore(); }
                expect(await provider.getShutdownBlockerCount()).toBe(0);
                expect(fetchModel).toHaveBeenCalledOnce();
                expect(await preparation).toEqual({ drained: true });
            }
        } finally {
            controller.cancel('fixture-preparation');
            await preparation;
        }
        expect(controller.phase()).toBe('running');
        if (outcome === 'stop') return;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_001);
        try {
            expect(await reconcileDueDelegationWaits(provider, 1)).toBe(1);
            expect(getChatJobExecution((await provider.getJob(id, actor.userId))!)!.delegationWait!.children[0]).toHaveProperty('jobId');
        } finally { clock.mockRestore(); }
    });

    it('parks, reopens, finishes the child, and resumes the ordered parent tool queue', async () => {
        const delegate = { type: 'function' as const, function: { name: 'delegate_chat', description: 'Delegate',
            parameters: { type: 'object' as const, properties: {} } } };
        const later = { type: 'function' as const, function: { name: 'later_tool', description: 'Later',
            parameters: { type: 'object' as const, properties: {} } } };
        const laterCalls = vi.fn(() => 'later result');
        unregister = registerServerTool(later, laterCalls, { runtime: 'server' });
        const instruction = { role: 'system', content: 'Selected instruction' };
        const body = { model: 'fixture/model', messages: [instruction, { role: 'user', content: 'Private parent history' }],
            tools: [delegate, later], _toolRuntime: { delegate_chat: 'client', later_tool: 'server' },
            _context: { version: 1, user_max_context_tokens: 50_000, requested_completion_tokens: null } };
        const execution = { version: 1 as const, workspaceId: actor.workspaceId, referer: 'https://example.test',
            apiKeyCiphertext: 'fixture-ciphertext', body, history, delegationRecoveryPolicy: 'v1' as const,
            delegationDefaults: { version: 1 as const, instructions: [instruction as { role: 'system'; content: string }] } };
        const parentId = await provider.createJob({ ...actor, userId: actor.userId, threadId: history.threadId, messageId: history.messageId,
            model: body.model, kind: 'chat', generationId: history.generationId, syncProviderId: 'sqlite', historyPhase: 'ready', execution });
        let job = await provider.claimJob(parentId, 'parent-worker', Date.now(), Date.now() + 60_000);
        expect(job).toBeTruthy();
        const calls: string[] = [];
        const delegateArgs = JSON.stringify({ tasks: [{ task: 'Research topic', model: 'Fixture' }] });
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            const request = JSON.parse(String(init.body));
            calls.push(request.model);
            if (calls.length === 1) return sse({ choices: [{ delta: { tool_calls: [
                { index: 0, id: 'delegate-call', function: { name: 'delegate_chat', arguments: delegateArgs } },
                { index: 1, id: 'later-call', function: { name: 'later_tool', arguments: '{}' } },
            ] }, finish_reason: 'tool_calls' }] });
            return sse({ choices: [{ delta: { content: calls.length === 2 ? 'child answer' : 'parent answer' }, finish_reason: 'stop' }] });
        }));
        const run = async (current: NonNullable<typeof job>, owner: string) => {
            const saved = getChatJobExecution(current)!;
            await executeBackgroundJob(current.id, { body: saved.body, apiKey: 'fixture-key', userId: current.userId,
                workspaceId: saved.workspaceId, threadId: current.threadId, messageId: current.messageId,
                referer: saved.referer, execution: saved, leaseOwner: owner }, provider);
        };
        await run(job!, 'parent-worker');
        let parent = (await provider.getJob(parentId, actor.userId))!;
        expect(parent.leaseOwner).toBeFalsy();
        expect(getJobLiveState(parentId)?.producing).toBe(false);
        expect(getChatJobExecution(parent)?.pendingToolCalls?.map(call => call.id)).toEqual(['delegate-call', 'later-call']);
        const initialView = projectJobView(parent);
        expect(initialView.tool_calls?.find(call => call.id === 'delegate-call')?.delegation).toEqual({ version: 2,
            callId: 'delegate-call', children: [{ index: 0, modelName: 'fixture/model', outcome: 'waiting' }] });
        expect(JSON.stringify(initialView)).not.toContain('fixture-ciphertext');
        expect(JSON.stringify(initialView)).not.toContain('Private parent history');
        const changedCall = { ...parent, tool_calls: parent.tool_calls?.map(call => call.id === 'delegate-call'
            ? { ...call, args: '{"task":"different"}' } : call) };
        expect(projectJobView(changedCall).tool_calls?.find(call => call.id === 'delegate-call')).not.toHaveProperty('delegation');
        expect(calls).toHaveLength(1); expect(laterCalls).not.toHaveBeenCalled();
        expect(await provider.claimJob(parentId, 'wrong-worker', Date.now(), Date.now() + 60_000)).toBeNull();

        await reopen();
        const originalCapabilities = sync.capabilities;
        Object.defineProperty(sync, 'capabilities', { configurable: true, value: { ...originalCapabilities, canonicalChatHistory: undefined } });
        expect(await reconcileDueDelegationWaits(provider, 1)).toBe(1);
        const deferred = getChatJobExecution((await provider.getJob(parentId, actor.userId))!)!.delegationWait!.children[0]!;
        expect(deferred.kind === 'prepared' && deferred.jobId).toBeUndefined();
        delete (sync as unknown as { capabilities?: unknown }).capabilities;
        const resumedAt = Date.now() + 5_001;
        parent = (await provider.claimNextDelegationWait('coordinator', resumedAt, resumedAt + 60_000))!;
        expect(parent.id).toBe(parentId);
        expect(await admitPreparedDelegationChildren(provider, parentId, actor.userId, 'coordinator')).toMatchObject({ admitted: 1 });
        parent = (await provider.getJob(parentId, actor.userId))!;
        const child = getChatJobExecution(parent)!.delegationWait!.children[0]!;
        if (child.kind !== 'prepared' || !child.jobId) throw new Error('Child was not admitted');
        expect(projectJobView(parent).tool_calls?.find(call => call.id === 'delegate-call')?.delegation).toEqual({ version: 2,
            callId: 'delegate-call', children: [{ index: 0, threadId: child.threadId, modelName: 'fixture/model', outcome: 'working' }] });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(child.jobId, actor.userId))!)).toBe('ready');
        job = await provider.claimJob(child.jobId, 'child-worker', Date.now(), Date.now() + 60_000);
        expect(job).toBeTruthy();
        await run(job!, 'child-worker');
        const saving = await projectJobViewWithChildStatus(provider, parent, actor.userId);
        expect(saving.tool_calls?.find(call => call.id === 'delegate-call')?.delegation).toEqual({ version: 3,
            callId: 'delegate-call', children: [{ index: 0, threadId: child.threadId, modelName: 'fixture/model', outcome: 'saving' }] });
        expect(JSON.stringify(saving)).not.toContain('child answer');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(child.jobId, actor.userId))!)).toBe('committed');
        const future = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 60 * 1000);
        try { await provider.cleanupExpired(); } finally { future.mockRestore(); }
        expect(await provider.getJob(parentId, actor.userId)).toBeTruthy();
        expect(await provider.getJob(child.jobId, actor.userId)).toMatchObject({ status: 'complete' });
        expect(await reconcileDelegationChild(provider, parentId, actor.userId, 'coordinator', 0)).toBe('committed');
        expect(projectJobView((await provider.getJob(parentId, actor.userId))!).tool_calls?.find(call => call.id === 'delegate-call')?.delegation)
            .toEqual({ version: 2, callId: 'delegate-call', children: [
                { index: 0, threadId: child.threadId, modelName: 'fixture/model', outcome: 'complete' },
            ] });
        const due = Date.now() + 5_001;
        expect(await provider.claimNextDelegationWait('resume-coordinator', due, due + 60_000)).toMatchObject({ id: parentId });
        expect(await resumeReconciledDelegation(provider, parentId, actor.userId, 'resume-coordinator')).toBe('resumed');
        expect(laterCalls).not.toHaveBeenCalled();
        job = await provider.claimJob(parentId, 'parent-resume', Date.now(), Date.now() + 60_000);
        expect(job).toBeTruthy();
        await run(job!, 'parent-resume');
        parent = (await provider.getJob(parentId, actor.userId))!;
        expect(parent.status).toBe('complete');
        expect(parent.content).toBe('parent answer');
        expect(laterCalls).toHaveBeenCalledOnce();
        expect(calls).toEqual(['fixture/model', 'fixture/model', 'fixture/model']);
        expect(await reconcileBackgroundJobHistory(provider, parent)).toBe('committed');
        const beforePrune = await sync.readChatHistory(actor, { kind: 'messages', message_ids: [history.messageId, child.assistantMessageId] });
        expect(beforePrune.status).toBe('ok');
        const parentRecord = beforePrune.messages?.find(message => message.id === history.messageId);
        expect(parentRecord?.data).toMatchObject({ content: 'parent answer', tool_calls: expect.arrayContaining([
            expect.objectContaining({ id: 'delegate-call', delegation: { version: 1, callId: 'delegate-call',
                children: [{ index: 0, threadId: child.threadId, modelName: 'fixture/model', outcome: 'complete' }] } }),
        ]) });
        expect(beforePrune.messages?.find(message => message.id === child.assistantMessageId)?.data)
            .toMatchObject({ content: 'child answer' });

        // The retained canonical records, not expired job rows, must supply the
        // child link and result when a different session returns later.
        const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 60 * 1000);
        try { await provider.cleanupExpired(); } finally { now.mockRestore(); }
        expect(await provider.getJob(parentId, actor.userId)).toBeNull();
        expect(await provider.getJob(child.jobId, actor.userId)).toBeNull();
        await reopen();
        const afterPrune = await sync.readChatHistory(actor, { kind: 'messages', message_ids: [history.messageId, child.assistantMessageId] });
        expect(afterPrune.messages).toEqual(beforePrune.messages);
    });

    it.each(['committed', 'not committed'] as const)(
        'recovers a lost parking acknowledgement when the wait was %s', async outcome => {
        const delegate = { type: 'function' as const, function: { name: 'delegate_chat', description: 'Delegate',
            parameters: { type: 'object' as const, properties: {} } } };
        const body = { model: 'fixture/model', messages: [{ role: 'user', content: 'Parent task' }], tools: [delegate],
            _toolRuntime: { delegate_chat: 'client' },
            _context: { version: 1, user_max_context_tokens: 50_000, requested_completion_tokens: null } };
        const secret = 'fixture-encryption-key-not-used-outside-this-test';
        const execution = { version: 1 as const, workspaceId: actor.workspaceId, referer: 'https://example.test',
            apiKeyCiphertext: encryptBackgroundCredential('fixture-key', secret), body, history,
            delegationRecoveryPolicy: 'v1' as const, delegationDefaults: { version: 1 as const, instructions: [] } };
        const parentId = await provider.createJob({ userId: actor.userId, threadId: history.threadId, messageId: history.messageId,
            model: body.model, kind: 'chat', generationId: history.generationId, syncProviderId: 'sqlite', historyPhase: 'ready', execution });
        const parent = await provider.claimJob(parentId, 'parent-worker', Date.now(), Date.now() + 60_000);
        if (!parent) throw new Error('Parent was not claimed');
        let requests = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            requests++;
            if (requests === 1) return sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'delegate-call',
                function: { name: 'delegate_chat', arguments: JSON.stringify({ task: 'Research' }) } }] }, finish_reason: 'tool_calls' }] });
            return sse({ choices: [{ delta: { content: requests === 2 ? 'Child answer' : 'Parent summary' }, finish_reason: 'stop' }] });
        }));
        const park = provider.parkDelegationWait.bind(provider);
        vi.spyOn(provider, 'parkDelegationWait').mockImplementationOnce(async (...args) => {
            if (outcome === 'committed') expect(await park(...args)).toBe(true);
            throw new Error('fixture lost acknowledgement');
        });
        await runClaimedBackgroundJob(parent, { provider, encryptionKey: secret, execute: executeBackgroundJob });
        let current = (await provider.getJob(parentId, actor.userId))!;
        expect(current.status).toBe('streaming');
        expect(current.error).toBeFalsy();
        expect(current.tool_calls?.find(call => call.id === 'delegate-call')?.status).toBe('pending');
        expect(getJobLiveState(parentId)?.tool_calls?.find(call => call.id === 'delegate-call')?.status).not.toBe('error');
        expect(requests).toBe(1);
        await reopen();
        if (outcome === 'not committed') {
            const later = Date.now() + 60_001;
            const recovered = await provider.claimJob(parentId, 'recovered-parent', later, later + 60_000);
            if (!recovered) throw new Error('Parent could not recover its pending tool queue');
            await runClaimedBackgroundJob(recovered, { provider, encryptionKey: secret, execute: executeBackgroundJob });
        }
        current = (await provider.getJob(parentId, actor.userId))!;
        expect(getChatJobExecution(current)?.delegationWait).toBeDefined();
        expect(requests).toBe(1);
        expect(await provider.claimNextDelegationWait('coordinator', Date.now(), Date.now() + 60_000)).toMatchObject({ id: parentId });
        expect(await admitPreparedDelegationChildren(provider, parentId, actor.userId, 'coordinator')).toMatchObject({ admitted: 1 });
        current = (await provider.getJob(parentId, actor.userId))!;
        const child = getChatJobExecution(current)!.delegationWait!.children[0]!;
        if (child.kind !== 'prepared' || !child.jobId) throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(child.jobId, actor.userId))!)).toBe('ready');
        const childJob = await provider.claimJob(child.jobId, 'child-worker', Date.now(), Date.now() + 60_000);
        if (!childJob) throw new Error('Child was not claimed');
        await runClaimedBackgroundJob(childJob, { provider, encryptionKey: secret, execute: executeBackgroundJob });
        const finishedChild = (await provider.getJob(child.jobId, actor.userId))!;
        if (finishedChild.historyPhase === 'finalization_pending') expect(await reconcileBackgroundJobHistory(provider, finishedChild)).toBe('committed');
        expect(await reconcileDelegationChild(provider, parentId, actor.userId, 'coordinator', 0)).toBe('committed');
        const due = Date.now() + 5_001;
        expect(await provider.claimNextDelegationWait('resume-coordinator', due, due + 60_000)).toMatchObject({ id: parentId });
        expect(await resumeReconciledDelegation(provider, parentId, actor.userId, 'resume-coordinator')).toBe('resumed');
        const resumed = await provider.claimJob(parentId, 'parent-resume', Date.now(), Date.now() + 60_000);
        if (!resumed) throw new Error('Parent was not claimed after child result');
        await runClaimedBackgroundJob(resumed, { provider, encryptionKey: secret, execute: executeBackgroundJob });
        expect(await provider.getJob(parentId, actor.userId)).toMatchObject({ status: 'complete', content: 'Parent summary' });
        expect(requests).toBe(3);
        expect(getRawDb().prepare('SELECT COUNT(*) AS total FROM background_jobs WHERE delegation_parent_id = ?').get(parentId))
            .toEqual({ total: 1 });
    });

    it.each(['admission', 'settlement', 'resume'] as const)(
        'recovers a lost %s acknowledgement without repeating work', async stage => {
        const delegate = { type: 'function' as const, function: { name: 'delegate_chat', description: 'Delegate',
            parameters: { type: 'object' as const, properties: {} } } };
        const body = { model: 'fixture/model', messages: [{ role: 'user', content: 'Parent task' }], tools: [delegate],
            _toolRuntime: { delegate_chat: 'client' },
            _context: { version: 1, user_max_context_tokens: 50_000, requested_completion_tokens: null } };
        const secret = 'fixture-encryption-key-not-used-outside-this-test';
        const execution = { version: 1 as const, workspaceId: actor.workspaceId, referer: 'https://example.test',
            apiKeyCiphertext: encryptBackgroundCredential('fixture-key', secret), body, history,
            delegationRecoveryPolicy: 'v1' as const, delegationDefaults: { version: 1 as const, instructions: [] } };
        let now = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const parentId = await provider.createJob({ userId: actor.userId, threadId: history.threadId, messageId: history.messageId,
            model: body.model, kind: 'chat', generationId: history.generationId, syncProviderId: 'sqlite', historyPhase: 'ready', execution });
        const parent = await provider.claimJob(parentId, 'parent-worker', now, now + 60_000);
        if (!parent) throw new Error('Parent was not claimed');
        let requests = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            requests++;
            if (requests === 1) return sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'delegate-call',
                function: { name: 'delegate_chat', arguments: JSON.stringify({ task: 'Research' }) } }] }, finish_reason: 'tool_calls' }] });
            return sse({ choices: [{ delta: { content: requests === 2 ? 'Child answer' : 'Parent summary' }, finish_reason: 'stop' }] });
        }));
        await runClaimedBackgroundJob(parent, { provider, encryptionKey: secret, execute: executeBackgroundJob });
        let injected = 0;
        if (stage === 'admission') {
            const admit = provider.admitDelegationChild.bind(provider);
            vi.spyOn(provider, 'admitDelegationChild').mockImplementationOnce(async input => {
                expect(await admit(input)).toMatchObject({ status: 'admitted' });
                injected++;
                throw new Error('fixture lost admission acknowledgement');
            });
        }
        expect(await reconcileDueDelegationWaits(provider, 1)).toBe(1);
        await reopen();
        let waiting = (await provider.getJob(parentId, actor.userId))!;
        const child = getChatJobExecution(waiting)!.delegationWait!.children[0]!;
        if (child.kind !== 'prepared' || !child.jobId) throw new Error('Child admission was lost');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(child.jobId, actor.userId))!)).toBe('ready');
        const childJob = await provider.claimJob(child.jobId, 'child-worker', now, now + 60_000);
        if (!childJob) throw new Error('Child was not claimed');
        await runClaimedBackgroundJob(childJob, { provider, encryptionKey: secret, execute: executeBackgroundJob });
        const completedChild = (await provider.getJob(child.jobId, actor.userId))!;
        if (completedChild.historyPhase === 'finalization_pending') expect(await reconcileBackgroundJobHistory(provider, completedChild)).toBe('committed');
        if (stage === 'settlement') {
            const commit = provider.commitDelegationWait.bind(provider);
            vi.spyOn(provider, 'commitDelegationWait').mockImplementationOnce(async input => {
                expect(input.wait.children[0]).toHaveProperty('settlement.kind', 'complete');
                expect(await commit(input)).toBe(true);
                injected++;
                throw new Error('fixture lost settlement acknowledgement');
            });
        }
        // The coordinator applies its bounded error backoff after a lost admission acknowledgement.
        now += 31_000;
        expect(await reconcileDueDelegationWaits(provider, 1)).toBe(1);
        await reopen();
        waiting = (await provider.getJob(parentId, actor.userId))!;
        expect(getChatJobExecution(waiting)?.delegationWait?.children[0]).toMatchObject({ settlement: { kind: 'complete' } });
        if (stage === 'resume') {
            const resume = provider.resumeDelegationWait.bind(provider);
            vi.spyOn(provider, 'resumeDelegationWait').mockImplementationOnce(async input => {
                expect(await resume(input)).toBe('resumed');
                injected++;
                throw new Error('fixture lost resume acknowledgement');
            });
        }
        now += 6_000;
        expect(await reconcileDueDelegationWaits(provider, 1)).toBe(1);
        await reopen();
        const resumed = (await provider.getJob(parentId, actor.userId))!;
        expect(getChatJobExecution(resumed)?.delegationWait).toBeUndefined();
        expect(resumed.tool_calls?.find(call => call.id === 'delegate-call')).toMatchObject({ status: 'complete' });
        const model = await provider.claimJob(parentId, 'parent-resume', now, now + 60_000);
        if (!model) throw new Error('Parent was not claimed after resumption');
        await runClaimedBackgroundJob(model, { provider, encryptionKey: secret, execute: executeBackgroundJob });
        expect(injected).toBe(1);
        expect(await provider.getJob(parentId, actor.userId)).toMatchObject({ status: 'complete', content: 'Parent summary' });
        expect(requests).toBe(3);
        expect(getRawDb().prepare('SELECT COUNT(*) AS total FROM background_jobs WHERE delegation_parent_id = ?').get(parentId))
            .toEqual({ total: 1 });
        const saved = await sync.readChatHistory(actor, { kind: 'messages', message_ids: [history.messageId] });
        expect(saved.messages?.[0]?.data).toMatchObject({ tool_calls: expect.arrayContaining([
            expect.objectContaining({ id: 'delegate-call', delegation: expect.objectContaining({ children: [
                expect.objectContaining({ threadId: child.threadId, outcome: 'complete' }),
            ] }) }),
        ]) });
        const calls = saved.messages?.[0]?.data?.tool_calls as Array<{ id?: string }>;
        expect(calls.filter(call => call.id === 'delegate-call')).toHaveLength(1);
    });

    it.each(['unchanged', 'edited', 'deleted', 'forged receipt'] as const)('releases stopped-parent evidence after canonical history is %s', async change => {
        const delegate = { type: 'function' as const, function: { name: 'delegate_chat', description: 'Delegate',
            parameters: { type: 'object' as const, properties: {} } } };
        const body = { model: 'fixture/model', messages: [{ role: 'user', content: 'Parent task' }], tools: [delegate],
            _toolRuntime: { delegate_chat: 'client' },
            _context: { version: 1, user_max_context_tokens: 50_000, requested_completion_tokens: null } };
        const secret = 'fixture-encryption-key-not-used-outside-this-test';
        const execution = { version: 1 as const, workspaceId: actor.workspaceId, referer: 'https://example.test',
            apiKeyCiphertext: encryptBackgroundCredential('fixture-key', secret), body, history,
            delegationRecoveryPolicy: 'v1' as const, delegationDefaults: { version: 1 as const, instructions: [] } };
        const parentId = await provider.createJob({ userId: actor.userId, threadId: history.threadId, messageId: history.messageId,
            model: body.model, kind: 'chat', generationId: history.generationId, syncProviderId: 'sqlite', historyPhase: 'ready', execution });
        const parent = await provider.claimJob(parentId, 'parent-worker', Date.now(), Date.now() + 60_000);
        if (!parent) throw new Error('Parent was not claimed');
        let entered!: () => void; let aborted!: () => void;
        let cancelFixture = () => {};
        const childStarted = new Promise<void>(resolve => { entered = resolve; });
        const childAborted = new Promise<void>(resolve => { aborted = resolve; });
        let requests = 0;
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            requests++;
            if (requests === 1) return sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'delegate-call',
                function: { name: 'delegate_chat', arguments: JSON.stringify({ task: 'Research' }) } }] }, finish_reason: 'tool_calls' }] });
            entered();
            return await new Promise<Response>((_resolve, reject) => {
                cancelFixture = () => reject(new DOMException('Fixture cleanup', 'AbortError'));
                const signal = init.signal!;
                const onAbort = () => { aborted(); reject(new DOMException('Stopped', 'AbortError')); };
                if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
            });
        }));
        await executeBackgroundJob(parentId, { body, apiKey: 'fixture-key', userId: actor.userId,
            workspaceId: actor.workspaceId, threadId: parent.threadId, messageId: parent.messageId,
            referer: execution.referer, execution, leaseOwner: 'parent-worker' }, provider);
        expect(await provider.claimNextDelegationWait('coordinator', Date.now(), Date.now() + 60_000)).toMatchObject({ id: parentId });
        expect(await admitPreparedDelegationChildren(provider, parentId, actor.userId, 'coordinator')).toMatchObject({ admitted: 1 });
        const waiting = (await provider.getJob(parentId, actor.userId))!;
        const child = getChatJobExecution(waiting)!.delegationWait!.children[0]!;
        if (child.kind !== 'prepared' || !child.jobId) throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(child.jobId, actor.userId))!)).toBe('ready');
        const claimed = await provider.claimJob(child.jobId, 'child-worker', Date.now(), Date.now() + 60_000);
        if (!claimed) throw new Error('Child was not claimed');
        const running = runClaimedBackgroundJob(claimed, { provider, encryptionKey: secret, execute: executeBackgroundJob, leaseMs: 300 });
        try {
            await Promise.race([childStarted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Child did not start')), 2_000))]);
            expect(getChatJobExecution((await provider.getJob(child.jobId, actor.userId))!)?.delegationDispatch)
                .toMatchObject({ state: 'started' });
            expect(await provider.abortJob(parentId, actor.userId)).toBe(true);
            expect(await provider.claimNextDelegationWait('cleanup', Date.now(), Date.now() + 60_000)).toMatchObject({ id: parentId });
            const stopped = (await provider.getJob(parentId, actor.userId))!;
            const wait = getChatJobExecution(stopped)!.delegationWait!;
            expect(await provider.cleanupDelegationWait({ parentJobId: parentId, leaseOwner: 'cleanup', expectedRevision: wait.revision })).toBe('pending');
            await Promise.race([childAborted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Child request was not aborted')), 2_000))]);
            await running;
            expect(requests).toBe(2);
            expect(await provider.saveTerminalSnapshot(child.jobId, { status: 'complete', content: 'late answer', reasoning: '', completedAt: Date.now() }, 'child-worker'))
                .toBe(false);
            await reopen();
            expect(await provider.getJob(child.jobId, actor.userId)).toMatchObject({ status: 'aborted',
                execution: { delegationDispatch: { state: 'started' } } });
            expect(await provider.getJob(parentId, actor.userId)).toMatchObject({ status: 'aborted' });
            expect(await provider.claimJob(parentId, 'late-parent', Date.now(), Date.now() + 60_000)).toBeNull();
            const stoppedChild = (await provider.getJob(child.jobId, actor.userId))!;
            if (stoppedChild.historyPhase === 'finalization_pending')
                expect(await reconcileBackgroundJobHistory(provider, stoppedChild)).toBe('committed');
            expect((await provider.getJob(child.jobId, actor.userId))?.historyPhase).toBe('committed');
            const due = Date.now() + 5_001;
            const staged = (await provider.claimNextDelegationWait('stage-stopped-parent', due, due + 60_000))!;
            expect(staged.id).toBe(parentId);
            expect(await provider.cleanupDelegationWait({ parentJobId: parentId, leaseOwner: 'stage-stopped-parent',
                expectedRevision: getChatJobExecution(staged)!.delegationWait!.revision })).toBe('pending');
            expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(parentId, actor.userId))!)).toBe('committed');
            const saved = await sync.readChatHistory(actor, { kind: 'messages', message_ids: [history.messageId] });
            expect(saved.messages?.[0]?.data).toMatchObject({ tool_calls: expect.arrayContaining([
                expect.objectContaining({ id: 'delegate-call', delegation: expect.objectContaining({ children: [
                    expect.objectContaining({ threadId: child.threadId, outcome: 'unknown' }),
                ] }) }),
            ]) });
            if (change === 'edited' || change === 'deleted') {
                const operation = change === 'deleted' ? 'delete' : 'put';
                const pushed = await sync.push(actor, { scope: { workspaceId: actor.workspaceId }, ops: [{
                    id: `parent-${change}`, tableName: 'messages', operation, pk: history.messageId,
                    ...(operation === 'put' ? { payload: { ...saved.messages![0]!, data: { ...saved.messages![0]!.data, content: 'Later edit' } } } : {}),
                    stamp: { deviceId: 'other-device', opId: `parent-${change}`, hlc: '2026-10-31T00:00:00.000Z-0000', clock: 3 },
                    createdAt: Math.floor(Date.now() / 1000), attempts: 0, status: 'pending',
                }] });
                expect(pushed.results[0]).toMatchObject({ success: true });
            }
            if (change === 'forged receipt') {
                getRawDb().prepare("UPDATE background_generation_receipts SET fingerprint = 'mismatch' WHERE workspace_id = ? AND generation_id = ? AND stage = 'finalization'")
                    .run(actor.workspaceId, history.generationId);
            }
            const releaseAt = Date.now() + 5_001;
            const release = (await provider.claimNextDelegationWait('release-stopped-parent', releaseAt, releaseAt + 60_000))!;
            expect(await provider.cleanupDelegationWait({ parentJobId: parentId, leaseOwner: 'release-stopped-parent',
                expectedRevision: getChatJobExecution(release)!.delegationWait!.revision })).toBe(change === 'forged receipt' ? 'pending' : 'settled');
            if (change === 'forged receipt') {
                expect(await provider.getShutdownBlockerCount()).toBe(1);
                return;
            }
            expect(await provider.getShutdownBlockerCount()).toBe(0);
            if (change === 'edited') {
                const after = await sync.readChatHistory(actor, { kind: 'messages', message_ids: [history.messageId] });
                expect(after.messages?.[0]?.data?.content).toBe('Later edit');
            } else if (change === 'deleted') {
                const after = await sync.readChatHistory(actor, { kind: 'messages', message_ids: [history.messageId] });
                expect(after.messages?.[0]).toMatchObject({ deleted: true });
            }
        } finally { cancelFixture(); await running.catch(() => {}); }
    });

    it('starts a dependent delegation only after the first result survives reopen', async () => {
        const delegate = { type: 'function' as const, function: { name: 'delegate_chat', description: 'Delegate',
            parameters: { type: 'object' as const, properties: {} } } };
        const body = { model: 'fixture/model', messages: [{ role: 'user', content: 'Research in two stages' }], tools: [delegate],
            _toolRuntime: { delegate_chat: 'client' },
            _context: { version: 1, user_max_context_tokens: 50_000, requested_completion_tokens: null } };
        const execution = { version: 1 as const, workspaceId: actor.workspaceId, referer: 'https://example.test',
            apiKeyCiphertext: 'fixture-ciphertext', body, history, delegationRecoveryPolicy: 'v1' as const,
            delegationDefaults: { version: 1 as const, instructions: [] } };
        const parentId = await provider.createJob({ userId: actor.userId, threadId: history.threadId, messageId: history.messageId,
            model: body.model, kind: 'chat', generationId: history.generationId, syncProviderId: 'sqlite', historyPhase: 'ready', execution });
        const parent = await provider.claimJob(parentId, 'parent-worker', Date.now(), Date.now() + 60_000);
        if (!parent) throw new Error('Parent was not claimed');
        let release!: () => void; let entered!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const childStarted = new Promise<void>(resolve => { entered = resolve; });
        const requests: Array<{ messages: Array<{ role: string; content?: unknown; tool_call_id?: string }> }> = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            const request = JSON.parse(String(init.body));
            requests.push(request);
            if (requests.length === 1 || requests.length === 3) {
                const first = requests.length === 1;
                if (!first) expect(request.messages).toEqual(expect.arrayContaining([
                    expect.objectContaining({ role: 'tool', tool_call_id: 'first-call', content: expect.arrayContaining([
                        expect.objectContaining({ type: 'text', text: expect.stringContaining('First answer') }),
                    ]) }),
                ]));
                return sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: first ? 'first-call' : 'second-call',
                    function: { name: 'delegate_chat', arguments: JSON.stringify({ task: first ? 'First task' : 'Use First answer for follow-up' }) } }] },
                    finish_reason: 'tool_calls' }] });
            }
            if (requests.length === 2) {
                entered(); await held;
                return sse({ choices: [{ delta: { content: 'First answer' }, finish_reason: 'stop' }] });
            }
            return sse({ choices: [{ delta: { content: requests.length === 4 ? 'Second answer' : 'Parent summary' }, finish_reason: 'stop' }] });
        }));
        const run = async (current: NonNullable<typeof parent>, owner: string) => {
            const saved = getChatJobExecution(current)!;
            await executeBackgroundJob(current.id, { body: saved.body, apiKey: 'fixture-key', userId: current.userId,
                workspaceId: saved.workspaceId, threadId: current.threadId, messageId: current.messageId,
                referer: saved.referer, execution: saved, leaseOwner: owner }, provider);
        };
        await run(parent, 'parent-worker');
        const childIds: string[] = [];
        const threadIds: string[] = [];
        for (const index of [0, 1]) {
            const coordinator = `coordinator-${index}`;
            const now = Date.now();
            expect(await provider.claimNextDelegationWait(coordinator, now, now + 60_000)).toMatchObject({ id: parentId });
            expect(await admitPreparedDelegationChildren(provider, parentId, actor.userId, coordinator)).toMatchObject({ admitted: 1 });
            const waiting = (await provider.getJob(parentId, actor.userId))!;
            const child = getChatJobExecution(waiting)!.delegationWait!.children[0]!;
            if (child.kind !== 'prepared' || !child.jobId) throw new Error('Child was not admitted');
            childIds.push(child.jobId); threadIds.push(child.threadId);
            expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(child.jobId, actor.userId))!)).toBe('ready');
            const claimed = await provider.claimJob(child.jobId, `child-${index}`, Date.now(), Date.now() + 60_000);
            if (!claimed) throw new Error('Child was not claimed');
            if (index === 0) {
                const running = run(claimed, 'child-0');
                try {
                    await Promise.race([childStarted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('First child did not start')), 2_000))]);
                    expect(requests).toHaveLength(2);
                    expect(await provider.claimJob(parentId, 'early-parent', Date.now(), Date.now() + 60_000)).toBeNull();
                    expect(getRawDb().prepare('SELECT COUNT(*) AS total FROM background_jobs WHERE delegation_parent_id = ?').get(parentId))
                        .toEqual({ total: 1 });
                } finally { release(); await running; }
            } else await run(claimed, 'child-1');
            expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(child.jobId, actor.userId))!)).toBe('committed');
            expect(await reconcileDelegationChild(provider, parentId, actor.userId, coordinator, 0)).toBe('committed');
            await reopen();
            const due = Date.now() + 5_001;
            const resumeCoordinator = `resume-${index}`;
            expect(await provider.claimNextDelegationWait(resumeCoordinator, due, due + 60_000)).toMatchObject({ id: parentId });
            expect(await resumeReconciledDelegation(provider, parentId, actor.userId, resumeCoordinator)).toBe('resumed');
            const continuation = await provider.claimJob(parentId, `parent-${index}`, Date.now(), Date.now() + 60_000);
            if (!continuation) throw new Error('Parent was not claimed after the result');
            await run(continuation, `parent-${index}`);
        }
        expect(requests).toHaveLength(5);
        expect(new Set(childIds).size).toBe(2);
        expect(new Set(threadIds).size).toBe(2);
        expect(requests[3]!.messages.at(-1)?.content).toBe('Use First answer for follow-up');
        const completed = (await provider.getJob(parentId, actor.userId))!;
        expect(completed).toMatchObject({ status: 'complete', content: 'Parent summary' });
        expect(await reconcileBackgroundJobHistory(provider, completed)).toBe('committed');
        const saved = await sync.readChatHistory(actor, { kind: 'messages', message_ids: [history.messageId] });
        expect(saved.messages?.[0]?.data).toMatchObject({ tool_calls: expect.arrayContaining(threadIds.map((threadId, index) =>
            expect.objectContaining({ id: index === 0 ? 'first-call' : 'second-call', delegation: expect.objectContaining({
                children: [expect.objectContaining({ threadId, outcome: 'complete' })],
            }) }))) });
    });

    it.each([1, 2])('runs a two-child batch with %i available model slot(s)', async slots => {
        limits.active = slots;
        const delegate = { type: 'function' as const, function: { name: 'delegate_chat', description: 'Delegate',
            parameters: { type: 'object' as const, properties: {} } } };
        const body = { model: 'fixture/model', messages: [{ role: 'user', content: 'Parent task' }], tools: [delegate],
            _toolRuntime: { delegate_chat: 'client' },
            _context: { version: 1, user_max_context_tokens: 50_000, requested_completion_tokens: null } };
        const execution = { version: 1 as const, workspaceId: actor.workspaceId, referer: 'https://example.test',
            apiKeyCiphertext: 'fixture-ciphertext', body, history, delegationRecoveryPolicy: 'v1' as const,
            delegationDefaults: { version: 1 as const, instructions: [] } };
        const parentId = await provider.createJob({ userId: actor.userId, threadId: history.threadId, messageId: history.messageId,
            model: body.model, kind: 'chat', generationId: history.generationId, syncProviderId: 'sqlite', historyPhase: 'ready', execution });
        const parent = await provider.claimJob(parentId, 'parent-worker', Date.now(), Date.now() + 60_000);
        if (!parent) throw new Error('Parent was not claimed');
        const batch = JSON.stringify({ tasks: [{ task: 'First task' }, { task: 'Second task' }] });
        let release!: () => void;
        const barrier = new Promise<void>(resolve => { release = resolve; });
        let entered!: () => void;
        const allEntered = new Promise<void>(resolve => { entered = resolve; });
        let childRequests = 0;
        let requests = 0;
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            const request = JSON.parse(String(init.body));
            requests++;
            if (requests === 1) return sse({ choices: [{ delta: { tool_calls: [
                { index: 0, id: 'batch-call', function: { name: 'delegate_chat', arguments: batch } },
            ] }, finish_reason: 'tool_calls' }] });
            if (request.messages?.some((message: { role: string }) => message.role === 'tool')) {
                return sse({ choices: [{ delta: { content: 'Parent summary' }, finish_reason: 'stop' }] });
            }
            const task = request.messages?.at(-1)?.content;
            childRequests++;
            if (childRequests === slots) entered();
            await barrier;
            return sse({ choices: [{ delta: { content: `Answer to ${task}` }, finish_reason: 'stop' }] });
        }));
        const run = async (current: NonNullable<typeof parent>, owner: string) => {
            const saved = getChatJobExecution(current)!;
            await executeBackgroundJob(current.id, { body: saved.body, apiKey: 'fixture-key', userId: current.userId,
                workspaceId: saved.workspaceId, threadId: current.threadId, messageId: current.messageId,
                referer: saved.referer, execution: saved, leaseOwner: owner }, provider);
        };
        await run(parent, 'parent-worker');
        await reopen();
        expect(await provider.claimNextDelegationWait('coordinator', Date.now(), Date.now() + 60_000)).toMatchObject({ id: parentId });
        const firstAdmission = await admitPreparedDelegationChildren(provider, parentId, actor.userId, 'coordinator');
        expect(firstAdmission).toMatchObject({ admitted: slots, reason: slots === 1 ? 'capacity' : 'no-pending' });
        let parked = (await provider.getJob(parentId, actor.userId))!;
        const prepared = getChatJobExecution(parked)!.delegationWait!.children;
        const initialIds = prepared.flatMap(child => child.kind === 'prepared' && child.jobId ? [child.jobId] : []);
        expect(initialIds).toHaveLength(slots);
        const running: Promise<void>[] = [];
        for (const [index, id] of initialIds.entries()) {
            expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(id, actor.userId))!)).toBe('ready');
            const claimed = await provider.claimJob(id, `child-${index}`, Date.now(), Date.now() + 60_000);
            if (!claimed) throw new Error('Child was not claimed');
            running.push(run(claimed, `child-${index}`));
        }
        try {
            await Promise.race([allEntered, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Child requests did not overlap')), 2_000))]);
            expect(childRequests).toBe(slots);
        } finally { release(); }
        await Promise.all(running);
        if (slots === 1) {
            expect(await admitPreparedDelegationChildren(provider, parentId, actor.userId, 'coordinator')).toMatchObject({ admitted: 1 });
            parked = (await provider.getJob(parentId, actor.userId))!;
            const second = getChatJobExecution(parked)!.delegationWait!.children[1]!;
            if (second.kind !== 'prepared' || !second.jobId) throw new Error('Second child was not admitted');
            expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(second.jobId, actor.userId))!)).toBe('ready');
            const claimed = await provider.claimJob(second.jobId, 'second-child', Date.now(), Date.now() + 60_000);
            if (!claimed) throw new Error('Second child was not claimed');
            await run(claimed, 'second-child');
        }
        parked = (await provider.getJob(parentId, actor.userId))!;
        const ids = getChatJobExecution(parked)!.delegationWait!.children.map(child => {
            if (child.kind !== 'prepared' || !child.jobId) throw new Error('Missing admitted child');
            return child.jobId;
        });
        for (const id of ids) expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(id, actor.userId))!)).toBe('committed');
        let coordinator = 'coordinator';
        for (const index of [0, 1]) {
            expect(await reconcileDelegationChild(provider, parentId, actor.userId, coordinator, index)).toBe('committed');
            coordinator = `settlement-${index}`;
            const due = Date.now() + 5_001;
            expect(await provider.claimNextDelegationWait(coordinator, due, due + 60_000)).toMatchObject({ id: parentId });
        }
        expect(await resumeReconciledDelegation(provider, parentId, actor.userId, coordinator)).toBe('resumed');
        parked = (await provider.getJob(parentId, actor.userId))!;
        const result = parked.tool_calls?.find(call => call.id === 'batch-call');
        expect(result?.status).toBe('complete');
        expect(result?.result).toContain('Answer to First task');
        expect(result?.result).toContain('Answer to Second task');
        expect(childRequests).toBe(2);
        const resumed = await provider.claimJob(parentId, 'parent-resume', Date.now(), Date.now() + 60_000);
        if (!resumed) throw new Error('Parent was not claimed after the batch');
        await run(resumed, 'parent-resume');
        const completed = (await provider.getJob(parentId, actor.userId))!;
        expect(completed).toMatchObject({ status: 'complete', content: 'Parent summary' });
        expect(requests).toBe(4);
        expect(await reconcileBackgroundJobHistory(provider, completed)).toBe('committed');
    });

    it.each(['available', 'store unavailable'] as const)(
        'expires a mixed batch with authorization %s without losing or replaying work', async authorization => {
        limits.active = 2;
        const startedAt = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
        const delegate = { type: 'function' as const, function: { name: 'delegate_chat', description: 'Delegate',
            parameters: { type: 'object' as const, properties: {} } } };
        const body = { model: 'fixture/model', messages: [{ role: 'user', content: 'Parent task' }], tools: [delegate],
            _toolRuntime: { delegate_chat: 'client' },
            _context: { version: 1, user_max_context_tokens: 50_000, requested_completion_tokens: null } };
        const execution = { version: 1 as const, workspaceId: actor.workspaceId, referer: 'https://example.test',
            apiKeyCiphertext: 'fixture-ciphertext', body, history, delegationRecoveryPolicy: 'v1' as const,
            delegationDefaults: { version: 1 as const, instructions: [] } };
        const parentId = await provider.createJob({ userId: actor.userId, threadId: history.threadId, messageId: history.messageId,
            model: body.model, kind: 'chat', generationId: history.generationId, syncProviderId: 'sqlite', historyPhase: 'ready', execution });
        const parent = await provider.claimJob(parentId, 'parent-worker', startedAt, startedAt + 60_000);
        if (!parent) throw new Error('Parent was not claimed');
        const batch = JSON.stringify({ tasks: [{ task: 'Completed' }, { task: 'Dispatched' }, { task: 'Waiting' }] });
        let release!: () => void;
        const barrier = new Promise<void>(resolve => { release = resolve; });
        let entered!: () => void;
        const dispatched = new Promise<void>(resolve => { entered = resolve; });
        const requests: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            const request = JSON.parse(String(init.body));
            if (request.messages?.some((message: { role: string }) => message.role === 'tool')) {
                requests.push('parent-resume');
                return sse({ choices: [{ delta: { content: 'Parent summary' }, finish_reason: 'stop' }] });
            }
            const task = request.messages?.at(-1)?.content as string;
            requests.push(task);
            if (task === 'Parent task') return sse({ choices: [{ delta: { tool_calls: [
                { index: 0, id: 'batch-call', function: { name: 'delegate_chat', arguments: batch } },
            ] }, finish_reason: 'tool_calls' }] });
            if (task === 'Dispatched') { entered(); await barrier; }
            return sse({ choices: [{ delta: { content: `Answer to ${task}` }, finish_reason: 'stop' }] });
        }));
        const run = async (job: NonNullable<typeof parent>, owner: string) => {
            const saved = getChatJobExecution(job)!;
            await executeBackgroundJob(job.id, { body: saved.body, apiKey: 'fixture-key', userId: job.userId,
                workspaceId: saved.workspaceId, threadId: job.threadId, messageId: job.messageId,
                referer: saved.referer, execution: saved, leaseOwner: owner }, provider);
        };
        await run(parent, 'parent-worker');
        expect(await provider.claimNextDelegationWait('coordinator', startedAt, startedAt + 60_000)).toMatchObject({ id: parentId });
        expect(await admitPreparedDelegationChildren(provider, parentId, actor.userId, 'coordinator')).toMatchObject({ admitted: 2, reason: 'capacity' });
        const waiting = getChatJobExecution((await provider.getJob(parentId, actor.userId))!)!.delegationWait!;
        const ids = waiting.children.slice(0, 2).map(child => {
            if (child.kind !== 'prepared' || !child.jobId) throw new Error('Missing admitted child');
            return child.jobId;
        });
        for (const id of ids) expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(id, actor.userId))!)).toBe('ready');
        const first = await provider.claimJob(ids[0]!, 'first-worker', startedAt, startedAt + 60_000);
        const second = await provider.claimJob(ids[1]!, 'second-worker', startedAt, startedAt + 60_000);
        if (!first || !second) throw new Error('Children were not claimed');
        const held = run(second, 'second-worker').catch(() => {});
        try {
            await Promise.race([dispatched, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Child did not dispatch')), 2_000))]);
            await run(first, 'first-worker');
            expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(ids[0]!, actor.userId))!)).toBe('committed');
            let now = waiting.deadlineAt + 1;
            clock.mockReturnValue(now);
            const unavailable = vi.fn(async () => { throw new Error('Private authorization failure'); });
            if (authorization === 'store unavailable') registerAuthWorkspaceStore({ id: 'sqlite', create: () => ({ listUserWorkspaces: unavailable }) as never });
            expect(await reconcileDueDelegationWaits(provider, 1)).toBe(1);
            if (authorization === 'store unavailable') expect(unavailable).not.toHaveBeenCalled();
            registerAuthWorkspaceStore({ id: 'sqlite', create: () => new SqliteAuthWorkspaceStore() });
            release();
            await held;
            await reopen();
            expect(getChatJobExecution((await provider.getJob(parentId, actor.userId))!)!.delegationWait!.expiredAt).toBe(now);
            const aborted = (await provider.getJob(ids[1]!, actor.userId))!;
            expect(aborted.status).toBe('aborted');
            expect(await reconcileBackgroundJobHistory(provider, aborted)).toBe('committed');
            for (const index of [0, 1]) {
                now += 5_001; clock.mockReturnValue(now);
                const owner = `settlement-${index}`;
                expect(await provider.claimNextDelegationWait(owner, now, now + 60_000)).toMatchObject({ id: parentId });
                expect(await reconcileDelegationChild(provider, parentId, actor.userId, owner, index)).toBe('committed');
            }
            now += 5_001; clock.mockReturnValue(now);
            expect(await provider.claimNextDelegationWait('resume', now, now + 60_000)).toMatchObject({ id: parentId });
            expect(await resumeReconciledDelegation(provider, parentId, actor.userId, 'resume')).toBe('resumed');
            const resumed = (await provider.getJob(parentId, actor.userId))!;
            const result = JSON.parse(resumed.tool_calls!.find(call => call.id === 'batch-call')!.result!);
            expect(result.results.map((item: { status: string }) => item.status)).toEqual(['complete', 'unknown', 'unavailable']);
            expect(result.results[0].content).toContain('Answer to Completed');
            expect(result.results[2].code).toBe('deadline_expired');
            expect(requests).toEqual(['Parent task', 'Dispatched', 'Completed']);
        } finally {
            registerAuthWorkspaceStore({ id: 'sqlite', create: () => new SqliteAuthWorkspaceStore() });
            release(); await held;
        }
    });

    it.each(['committed', 'superseded'] as const)(
        'does not replay an uncertain child request after reopen when history is %s', async historyOutcome => {
        const delegate = { type: 'function' as const, function: { name: 'delegate_chat', description: 'Delegate',
            parameters: { type: 'object' as const, properties: {} } } };
        const body = { model: 'fixture/model', messages: [{ role: 'user', content: 'Parent task' }], tools: [delegate],
            _toolRuntime: { delegate_chat: 'client' },
            _context: { version: 1, user_max_context_tokens: 50_000, requested_completion_tokens: null } };
        const secret = 'fixture-encryption-key-not-used-outside-this-test';
        const execution = { version: 1 as const, workspaceId: actor.workspaceId, referer: 'https://example.test',
            apiKeyCiphertext: encryptBackgroundCredential('fixture-key', secret), body, history,
            delegationRecoveryPolicy: 'v1' as const, delegationDefaults: { version: 1 as const, instructions: [] } };
        const parentId = await provider.createJob({ userId: actor.userId, threadId: history.threadId, messageId: history.messageId,
            model: body.model, kind: 'chat', generationId: history.generationId, syncProviderId: 'sqlite', historyPhase: 'ready', execution });
        const parent = await provider.claimJob(parentId, 'parent-worker', Date.now(), Date.now() + 60_000);
        if (!parent) throw new Error('Parent was not claimed');
        const args = JSON.stringify({ task: 'Research the topic' });
        let release!: () => void; let entered!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const childStarted = new Promise<void>(resolve => { entered = resolve; });
        let requests = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            requests++;
            if (requests === 1) return sse({ choices: [{ delta: { tool_calls: [
                { index: 0, id: 'delegate-call', function: { name: 'delegate_chat', arguments: args } },
            ] }, finish_reason: 'tool_calls' }] });
            if (requests === 2) {
                entered(); await held;
                return sse({ choices: [{ delta: { content: 'late child answer' }, finish_reason: 'stop' }] });
            }
            if (requests === 3) return sse({ choices: [{ delta: { tool_calls: [
                { index: 0, id: 'retry-call', function: { name: 'delegate_chat', arguments: args } },
            ] }, finish_reason: 'tool_calls' }] });
            return sse({ choices: [{ delta: { content: 'The child outcome is unknown.' }, finish_reason: 'stop' }] });
        }));
        const run = async (current: NonNullable<typeof parent>, owner: string) => {
            const saved = getChatJobExecution(current)!;
            await executeBackgroundJob(current.id, { body: saved.body, apiKey: 'fixture-key', userId: current.userId,
                workspaceId: saved.workspaceId, threadId: current.threadId, messageId: current.messageId,
                referer: saved.referer, execution: saved, leaseOwner: owner }, provider);
        };
        await run(parent, 'parent-worker');
        expect(await provider.claimNextDelegationWait('coordinator', Date.now(), Date.now() + 60_000)).toMatchObject({ id: parentId });
        expect(await admitPreparedDelegationChildren(provider, parentId, actor.userId, 'coordinator')).toMatchObject({ admitted: 1 });
        const waiting = (await provider.getJob(parentId, actor.userId))!;
        const child = getChatJobExecution(waiting)!.delegationWait!.children[0]!;
        if (child.kind !== 'prepared' || !child.jobId) throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(child.jobId, actor.userId))!)).toBe('ready');
        const oldJob = await provider.claimJob(child.jobId, 'old-worker', Date.now(), Date.now() + 30_000);
        if (!oldJob) throw new Error('Child was not claimed');
        const oldRun = run(oldJob, 'old-worker');
        try {
            await Promise.race([childStarted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Child request did not start')), 2_000))]);
            expect(getChatJobExecution((await provider.getJob(child.jobId, actor.userId))!)?.delegationDispatch)
                .toMatchObject({ state: 'started', sequence: 1 });
            if (historyOutcome === 'superseded') {
                const deleted = await sync.push(actor, { scope: { workspaceId: actor.workspaceId }, ops: [{
                    id: 'delete-uncertain-child', tableName: 'messages', operation: 'delete', pk: child.assistantMessageId,
                    stamp: { deviceId: 'another-device', opId: 'delete-uncertain-child', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 3 },
                    createdAt: Math.floor(Date.now() / 1000), attempts: 0, status: 'pending',
                }] });
                expect(deleted.results[0]).toMatchObject({ success: true });
            }
            let now = Date.now();
            vi.spyOn(Date, 'now').mockImplementation(() => now);
            await reopen();
            now += 31_000;
            const recovered = await provider.claimJob(child.jobId, 'new-worker', now, now + 60_000);
            if (!recovered) throw new Error('Child could not be reclaimed');
            await runClaimedBackgroundJob(recovered, { provider, encryptionKey: secret, execute: executeBackgroundJob });
            const uncertain = (await provider.getJob(child.jobId, actor.userId))!;
            expect(uncertain.status).toBe('error');
            expect(normalizeError(uncertain.error)).toMatchObject({ code: 'ERR_MODEL_OUTCOME_UNKNOWN' });
            expect(uncertain.historyPhase).toBe(historyOutcome);
            expect(requests).toBe(2);
            release();
            await expect(oldRun).rejects.toMatchObject({ name: 'BackgroundJobLeaseLostError' });
            expect((await provider.getJob(child.jobId, actor.userId))?.content).not.toContain('late child answer');
            expect(await reconcileDelegationChild(provider, parentId, actor.userId, 'coordinator', 0)).toBe('committed');
            const due = Date.now() + 5_001;
            expect(await provider.claimNextDelegationWait('resume-coordinator', due, due + 60_000)).toMatchObject({ id: parentId });
            expect(await resumeReconciledDelegation(provider, parentId, actor.userId, 'resume-coordinator')).toBe('resumed');
            const resumed = (await provider.getJob(parentId, actor.userId))!;
            expect(getChatJobExecution(resumed)?.delegationBlocked).toBe(true);
            const result = JSON.parse(resumed.tool_calls!.find(call => call.id === 'delegate-call')!.result!);
            expect(result).toMatchObject(historyOutcome === 'superseded'
                ? { status: 'unavailable', code: 'history_unavailable', executionUncertain: true }
                : { status: 'unknown', code: 'upstream_uncertain' });
            expect(requests).toBe(2);
            const claimedParent = await provider.claimJob(parentId, 'parent-resume', Date.now(), Date.now() + 60_000);
            if (!claimedParent) throw new Error('Parent was not claimed after uncertain settlement');
            await run(claimedParent, 'parent-resume');
            const completed = (await provider.getJob(parentId, actor.userId))!;
            expect(completed).toMatchObject({ status: 'complete', content: 'The child outcome is unknown.' });
            expect(completed.tool_calls?.find(call => call.id === 'retry-call'))
                .toMatchObject({ status: 'error', error: expect.stringContaining('unknown outcome') });
            expect(requests).toBe(4);
            expect(getRawDb().prepare('SELECT COUNT(*) AS total FROM background_jobs WHERE delegation_parent_id = ?')
                .get(parentId)).toEqual({ total: 1 });
            expect(await reconcileBackgroundJobHistory(provider, completed)).toBe('committed');
            const canonical = await sync.readChatHistory(actor, { kind: 'messages', message_ids: [history.messageId] });
            expect(canonical.messages?.[0]?.data).toMatchObject({ tool_calls: expect.arrayContaining([
                expect.objectContaining({ id: 'delegate-call', delegation: { version: 1, callId: 'delegate-call',
                    children: [historyOutcome === 'superseded'
                        ? { index: 0, threadId: child.threadId, modelName: 'fixture/model', outcome: 'unavailable', executionUncertain: true }
                        : { index: 0, threadId: child.threadId, modelName: 'fixture/model', outcome: 'unknown' }] } }),
            ]) });
        } finally { release(); await oldRun.catch(() => {}); }
    });
});
