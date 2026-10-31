import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { destroySqliteDb, getRawDb, initializeSqliteDb } from '#sqlite-runtime/server/db/kysely';
import { runMigrations } from '#sqlite-runtime/server/db/migrate';
import { SqliteBackgroundJobProvider } from '#sqlite-runtime/server/background-jobs/sqlite-provider';
import { createD1TestDatabase } from '../../../test/support/d1-test-database';
import type { RequestUsage } from '~~/shared/chat/compaction';
import type { BackgroundJobExecution, DelegationChildAdmission, JobUpdate, TerminalGenerationSnapshot } from '~~/server/utils/background-jobs/types';
import { delegationAdmissionFingerprint, delegationChildIdentities } from '~~/shared/chat/delegation-identities';
import { DelegationWaitSchema } from '~~/shared/chat/delegation-checkpoint';
import { getScopedAdmissionKey } from '~~/server/utils/background-jobs/admission-cancels';
import { createNormalizedStreamState } from '~~/shared/chat/normalized-stream-reducer';
import { toolCallFingerprint } from '~~/shared/chat/tool-ledger';
import { prepareToolResultStorage, readToolResultStorage } from '~~/shared/chat/tool-result-artifact';
import type { ChatGenerationAdmissionEnvelope } from '~~/shared/chat/background-history';
import { buildDelegationResume } from '~~/server/utils/background-jobs/delegation-resume';
import { reconstructDelegationChild } from '~~/server/utils/background-jobs/delegation-child';
import { prepareBackgroundHistory } from '~~/server/utils/background-jobs/admission-history';
import { admitPreparedDelegationChildren, inspectCompletedDelegationChild, reconcileDelegationChild, resumeReconciledDelegation } from '~~/server/utils/background-jobs/delegation-coordinator';
import { reconcileBackgroundJobHistory, reconcilePendingBackgroundHistory } from '~~/server/utils/background-jobs/history';
import { SqliteSyncGatewayAdapter } from '#sqlite-runtime/server/sync/sqlite-sync-gateway-adapter';
import { SqliteAuthWorkspaceStore } from '#sqlite-runtime/server/auth/sqlite-auth-workspace-store';
import { registerAuthWorkspaceStore } from '~~/server/auth/store/registry';
import { registerSyncGatewayAdapter } from '~~/server/sync/gateway/registry';
import { normalizeError, serializeError } from '~~/shared/errors';

function measuredUsage(promptTokens = 150, iteration = 0): RequestUsage {
    return {
        prompt_tokens: promptTokens, completion_tokens: 25, model: 'test-model',
        request_id: `request-${iteration}`, iteration, measured_at: 1_800_000_000_000,
        prefix_message_count: iteration + 1, prefix_hash: `prefix-${iteration}`,
        configuration_hash: 'configuration-1', input_estimate_tokens: promptTokens - 10,
    };
}

async function checkSeparateWaitingCapacity(provider: SqliteBackgroundJobProvider) {
    const params = {
        userId: 'capacity-user', threadId: 'capacity-thread', messageId: 'capacity-message',
        model: 'test-model', kind: 'chat' as const,
    };
    const execution: BackgroundJobExecution = {
        version: 1, body: { model: 'test-model', messages: [] }, workspaceId: 'capacity-workspace',
        referer: 'https://example.test', apiKeyCiphertext: 'test-only-not-a-credential', delegationRecoveryPolicy: 'v1',
    };
    const now = Date.now();
    const waiting = { ...execution, delegationWait: {
        version: 1 as const, revision: 0, callId: 'call', argumentFingerprint: `sha256:v1:${'a'.repeat(64)}`,
        deadlineAt: now + 7_200_000, nextCheckAt: now,
        children: [{ kind: 'rejected' as const, index: 0, settlement: { kind: 'unavailable' as const, code: 'unsupported' } }],
    } };
    for (let i = 0; i < 5; i++) {
        const parent = await provider.createJob({ ...params, execution });
        await provider.claimJob(parent, 'parent-worker', now, now + 60_000);
        expect(await provider.parkDelegationWait(parent, 'parent-worker', waiting, [])).toBe(true);
    }
    const child = await provider.createJob({ ...params, execution });
    expect(await provider.claimJob(child, 'child-worker', now, now + 60_000)).toBeTruthy();
    expect(await provider.parkDelegationWait(child, 'child-worker', waiting, [])).toBe(false);
    await expect(provider.createJob({ ...params, execution: { ...execution, clientToolCall: { callId: 'waiting' } as never } }))
        .rejects.toThrow('Maximum concurrent background jobs reached');
    await expect(provider.createJob({ ...params, execution: { ...execution, delegationWait: null } as never }))
        .rejects.toThrow('fenced transition');
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
        apiKeyCiphertext: 'test-only-not-a-credential', contentBase: 'checkpoint', delegationRecoveryPolicy: 'v1',
        delegationDefaults: { version: 1, instructions: [] },
    };
    const ids = delegationChildIdentities({ userId: params.userId, workspaceId: execution.workspaceId,
        parentGenerationId: params.generationId, callId: 'call', index: 0 });
    const admissionKey = getScopedAdmissionKey(params.userId, execution.workspaceId, ids.admissionId);

    async function reopen() {
        await destroySqliteDb();
        await runMigrations(await initializeSqliteDb({ path: databasePath }));
        provider = new SqliteBackgroundJobProvider();
    }

    async function prepareChildAdmission(deadlineOffset = 7_200_000, withQueue = false, recoveryPolicy = true, parentHistory?: ChatGenerationAdmissionEnvelope, buildChild = false,
        tool?: { type: 'function'; function: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, never> } } }): Promise<DelegationChildAdmission> {
        const now = Date.now();
        const args = JSON.stringify({ tasks: [{ task: 'Research', model: 'test-model' }] });
        const toolCall = { id: 'call', type: 'function' as const, function: { name: 'delegate_chat', arguments: args } };
        const laterCall = { id: 'later', type: 'function' as const, function: { name: 'later_tool', arguments: '{}' } };
        const fingerprint = withQueue ? toolCallFingerprint('delegate_chat', args) : `sha256:v1:${'b'.repeat(64)}`;
        const normalized = createNormalizedStreamState();
        const parentBody = tool ? { ...execution.body, tools: [tool], _toolRuntime: { [tool.function.name]: 'server' } } : execution.body;
        const baseParentExecution = { ...execution, body: parentBody, ...(parentHistory ? { history: parentHistory } : {}), delegationRecoveryPolicy: 'v1' as const };
        const parentExecution = withQueue ? { ...baseParentExecution, body: { ...parentBody, messages: [
            { role: 'assistant', content: [], tool_calls: [toolCall, laterCall] },
        ] }, pendingToolCalls: [toolCall, laterCall], normalizedToolState: { ...normalized,
            iterationToolCallIds: ['call', 'later'], tools: { call: { id: 'call', name: 'delegate_chat', arguments: args, status: 'pending' as const },
                later: { id: 'later', name: 'later_tool', arguments: '{}', status: 'pending' as const } } } } : baseParentExecution;
        const toolCalls = withQueue ? [{ id: 'call', name: 'delegate_chat', args, status: 'pending' as const, argument_fingerprint: fingerprint },
            { id: 'later', name: 'later_tool', args: '{}', status: 'pending' as const }] : undefined;
        const parentJobId = await provider.createJob({ ...params, syncProviderId: 'sqlite', execution: parentExecution, tool_calls: toolCalls });
        await provider.claimJob(parentJobId, 'model', now, now + 60_000);
        let child: DelegationChildAdmission['child'] = {
            userId: params.userId, threadId: ids.threadId, messageId: ids.assistantMessageId, model: 'test-model',
            kind: 'chat', syncProviderId: 'sqlite', idempotencyKey: admissionKey,
            generationId: ids.generationId, historyPhase: 'admission_pending',
            execution: { version: 1, workspaceId: execution.workspaceId, referer: execution.referer,
                apiKeyCiphertext: execution.apiKeyCiphertext, credentialSource: execution.credentialSource,
                contentBase: '', reasoningBase: '', checkpointedToolCallIds: [],
                ...(recoveryPolicy ? { delegationRecoveryPolicy: 'v1' as const } : {}),
                body: { model: 'test-model', messages: [{ role: 'user', content: 'Research' }],
                    ...(tool ? { tools: [tool], _toolRuntime: { [tool.function.name]: 'server' } } : {}) },
                history: JSON.parse(JSON.stringify(prepareBackgroundHistory({ version: 1, kind: 'new-turn', admissionId: ids.admissionId, generationId: ids.generationId,
                    workspaceId: execution.workspaceId, threadId: ids.threadId, messageId: ids.assistantMessageId,
                    thread: { id: ids.threadId, clock: 1 },
                    userMessage: { id: ids.userMessageId, clock: 1, role: 'user', thread_id: ids.threadId },
                    assistantMessage: { id: ids.assistantMessageId, clock: 1, role: 'assistant', thread_id: ids.threadId,
                        pending: true, data: { content: '', generation_id: ids.generationId, generation_state: 'streaming' } } },
                    { admissionId: ids.admissionId, workspaceId: execution.workspaceId, threadId: ids.threadId,
                        messageId: ids.assistantMessageId, syncProviderId: 'sqlite' }))) },
        };
        if (buildChild) {
            const { prepareNewDelegationChild } = await import('~~/server/utils/background-jobs/delegation-child');
            child = prepareNewDelegationChild((await provider.getJob(parentJobId, params.userId))!, {
                callId: 'call', index: 0, task: 'Research', body: (child.execution as BackgroundJobExecution).body,
                createdAt: now,
            });
        }
        const delegationWait = DelegationWaitSchema.parse({
            version: 1 as const, revision: 0, callId: 'call', argumentFingerprint: fingerprint,
            deadlineAt: now + deadlineOffset, nextCheckAt: now,
            children: [{ kind: 'prepared' as const, index: 0, admissionId: ids.admissionId, threadId: ids.threadId,
                userMessageId: ids.userMessageId, assistantMessageId: ids.assistantMessageId,
                admissionFingerprint: delegationAdmissionFingerprint(child),
                admission: { body: (child.execution as BackgroundJobExecution).body, history: (child.execution as BackgroundJobExecution).history! },
                request: { task: 'Research', model: 'test-model' } }],
        });
        expect(await provider.parkDelegationWait(parentJobId, 'model', { ...parentExecution, delegationWait }, toolCalls ?? [])).toBe(true);
        expect(await provider.claimNextDelegationWait('coordinator', now, now + 60_000)).toBeTruthy();
        return {
            parentJobId, leaseOwner: 'coordinator', revision: 0, callId: delegationWait.callId,
            argumentFingerprint: delegationWait.argumentFingerprint, childIndex: 0,
            child,
        };
    }

    // Drain failure inventory: parked and workflow jobs omitted by worker counts;
    // terminal history delivery mistaken for idle; double counting; state lost at
    // reopen; a missing/unavailable database mistaken for an empty database.
    it('keeps restart blocked across reopen until every durable job and history delivery settles', async () => {
        expect(await provider.getShutdownBlockerCount()).toBe(0);
        const parked = await provider.createJob({ ...params, execution: {
            ...execution, clientToolCall: { callId: 'parked' } as never,
        } });
        const workflow = await provider.createJob({ ...params, kind: 'workflow', generationId: undefined });
        const admission = await provider.createJob({ ...params, historyPhase: 'admission_pending' });
        expect(await provider.getShutdownBlockerCount()).toBe(3);
        await provider.abortJob(admission, params.userId);
        const terminal = [];
        for (const status of ['complete', 'error', 'aborted'] as const) {
            const id = await provider.createJob(params);
            await provider.saveTerminalSnapshot(id, { status, content: 'saved', reasoning: '', completedAt: Date.now() });
            terminal.push(id);
        }
        await reopen();
        expect(await provider.getActiveJobCount()).toBe(1);
        expect(await provider.getShutdownBlockerCount()).toBe(6);
        await provider.abortJob(parked, params.userId);
        await provider.abortJob(workflow, params.userId);
        expect(await provider.getShutdownBlockerCount()).toBe(5);
        for (const id of [parked, admission, ...terminal]) {
            await provider.setHistoryPhase(id, 'committed');
        }
        await reopen();
        expect(await provider.getShutdownBlockerCount()).toBe(0);
        expect((await provider.getJob(terminal[0]!, params.userId))?.content).toBe('saved');
        await destroySqliteDb();
        await expect(provider.getShutdownBlockerCount()).rejects.toThrow();
    });

    beforeEach(async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        directory = await mkdtemp(join(tmpdir(), 'or3-sqlite-usage-'));
        databasePath = join(directory, 'history.sqlite');
        await runMigrations(await initializeSqliteDb({ path: databasePath }));
        provider = new SqliteBackgroundJobProvider();
        getRawDb().prepare('INSERT INTO workspaces (id, name, owner_user_id) VALUES (?, ?, ?)').run(execution.workspaceId, 'Delegation', params.userId);
        getRawDb().prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)').run('delegation-member', execution.workspaceId, params.userId, 'owner');
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        await destroySqliteDb();
        await rm(directory, { recursive: true, force: true });
    });

    const parentHistory: ChatGenerationAdmissionEnvelope = { version: 1, kind: 'new-turn', admissionId: 'parent-admission', generationId: params.generationId,
        workspaceId: execution.workspaceId, threadId: params.threadId, messageId: params.messageId,
        thread: { id: params.threadId, clock: 1 },
        userMessage: { id: 'parent-user', clock: 1, role: 'user', thread_id: params.threadId },
        assistantMessage: { id: params.messageId, clock: 1, role: 'assistant', thread_id: params.threadId,
            pending: true, data: { generation_id: params.generationId } } };

    async function prepareCanonicalWorkspace() {
        const raw = getRawDb();
        raw.prepare('INSERT OR IGNORE INTO workspaces (id, name, owner_user_id) VALUES (?, ?, ?)').run(execution.workspaceId, 'Delegation', params.userId);
        raw.prepare('INSERT OR IGNORE INTO workspace_members (id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)').run('delegation-member', execution.workspaceId, params.userId, 'owner');
        const adapter = new SqliteSyncGatewayAdapter();
        registerSyncGatewayAdapter({ id: 'sqlite', create: () => adapter });
        registerAuthWorkspaceStore({ id: 'sqlite', create: () => new SqliteAuthWorkspaceStore() });
        vi.stubGlobal('useRuntimeConfig', () => ({ public: { sync: { provider: 'sqlite' } } }));
        const actor = { userId: params.userId, workspaceId: execution.workspaceId };
        await adapter.admitChatGeneration(actor, parentHistory);
        return adapter;
    }

    it('creates a scoped child admission with canonical ordered history', async () => {
        const adapter = await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory, true);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        const history = await adapter.readChatHistory({ userId: params.userId, workspaceId: execution.workspaceId },
            { kind: 'messages', message_ids: [ids.userMessageId, ids.assistantMessageId] });
        if (history.status !== 'ok' || !history.messages) throw new Error('Child history unavailable');
        const user = history.messages.find(message => message.id === ids.userMessageId)!;
        const assistant = history.messages.find(message => message.id === ids.assistantMessageId)!;
        expect(user).toMatchObject({ thread_id: ids.threadId, role: 'user', index: 0, data: { content: 'Research' } });
        expect(assistant).toMatchObject({ thread_id: ids.threadId, role: 'assistant', index: 1, pending: true,
            data: { generation_id: ids.generationId, generation_state: 'streaming', delegated_model: 'test-model' } });
        expect(typeof user.order_key).toBe('string');
        expect(typeof assistant.order_key).toBe('string');
        expect(user.order_key).not.toBe(assistant.order_key);
    });

    it('does not give a child tools outside its parent admission', async () => {
        const { prepareNewDelegationChild } = await import('~~/server/utils/background-jobs/delegation-child');
        const { registerServerTool } = await import('~~/server/utils/chat/tool-registry');
        const definition = { type: 'function' as const, function: { name: 'scoped_server_tool', description: 'Test',
            parameters: { type: 'object' as const, properties: {} } } };
        const unregister = registerServerTool(definition, () => 'ok', { runtime: 'server' });
        try {
            const now = Date.now();
            const parentId = await provider.createJob({ ...params, syncProviderId: 'sqlite', execution });
            await provider.claimJob(parentId, 'model', now, now + 60_000);
            const parent = (await provider.getJob(parentId, params.userId))!;
            const input = { callId: 'call', index: 0, task: 'Research', createdAt: now,
                body: { model: 'test-model', messages: [{ role: 'user', content: 'Research' }],
                    tools: [definition], _toolRuntime: { scoped_server_tool: 'server' } } };
            expect(() => prepareNewDelegationChild(parent, input)).toThrow(/parent|admitted/i);
            const authorizedId = await provider.createJob({ ...params, syncProviderId: 'sqlite', execution: {
                ...execution, body: { ...execution.body, tools: [definition], _toolRuntime: { scoped_server_tool: 'server' } },
            } });
            await provider.claimJob(authorizedId, 'model', now, now + 60_000);
            const authorizedParent = (await provider.getJob(authorizedId, params.userId))!;
            expect((prepareNewDelegationChild(authorizedParent, input).execution as BackgroundJobExecution).body.tools).toEqual([definition]);
            expect(() => prepareNewDelegationChild(authorizedParent, { ...input, body: { ...input.body,
                messages: [{ role: 'system', content: 'Not an authorized parent default' }, ...input.body.messages] } })).toThrow(/instructions/i);
            const instruction = { role: 'system' as const, content: 'Captured user instruction' };
            const developer = { role: 'developer' as const, content: 'Captured developer instruction' };
            const instructedId = await provider.createJob({ ...params, syncProviderId: 'sqlite', execution: {
                ...execution, body: { ...execution.body, messages: [instruction, developer], tools: [definition], _toolRuntime: { scoped_server_tool: 'server' } },
                delegationDefaults: { version: 1, instructions: [instruction, developer] },
            } });
            await provider.claimJob(instructedId, 'model', now, now + 60_000);
            const instructedParent = (await provider.getJob(instructedId, params.userId))!;
            const instructedInput = { ...input, body: { ...input.body, messages: [instruction, developer, ...input.body.messages] } };
            expect((prepareNewDelegationChild(instructedParent, instructedInput).execution as BackgroundJobExecution).body.messages)
                .toEqual([instruction, developer, ...input.body.messages]);
            expect(() => prepareNewDelegationChild(instructedParent, input)).toThrow(/instructions/i);
            expect(() => prepareNewDelegationChild(authorizedParent, { ...input, body: { ...input.body,
                messages: [{ role: 'assistant', content: 'Private conversation' }, ...input.body.messages] } })).toThrow(/task and effective instructions/i);
            expect(() => prepareNewDelegationChild(authorizedParent, { ...input, body: { ...input.body,
                messages: [{ role: 'system', content: [{ type: 'image_url', image_url: 'private' }] }, ...input.body.messages] } })).toThrow(/task and effective instructions/i);
            const recursive = { type: 'function' as const, function: { name: 'delegate_chat', description: 'Delegate',
                parameters: { type: 'object' as const, properties: {} } } };
            const removeRecursive = registerServerTool(recursive, () => 'unexpected', { runtime: 'server' });
            try {
                const recursiveId = await provider.createJob({ ...params, syncProviderId: 'sqlite', execution: {
                    ...execution, body: { ...execution.body, tools: [recursive], _toolRuntime: { delegate_chat: 'server' } },
                } });
                await provider.claimJob(recursiveId, 'model', now, now + 60_000);
                const recursiveParent = (await provider.getJob(recursiveId, params.userId))!;
                expect(() => prepareNewDelegationChild(recursiveParent, { ...input, body: { ...input.body,
                    tools: [recursive], _toolRuntime: { delegate_chat: 'server' } } })).toThrow(/recursive delegation/i);
            } finally { removeRecursive(); }
            unregister();
            expect(() => prepareNewDelegationChild(authorizedParent, input)).toThrow(/unavailable/i);
            const changed = registerServerTool({ ...definition, function: { ...definition.function, description: 'Changed contract' } },
                () => 'unexpected', { runtime: 'server' });
            try { expect(() => prepareNewDelegationChild(authorizedParent, input)).toThrow(/unavailable/i); }
            finally { changed(); }
        } finally {
            unregister();
        }
    });

    it('settles a prepared child when its server tool disappears before admission', async () => {
        await prepareCanonicalWorkspace();
        const { registerServerTool } = await import('~~/server/utils/chat/tool-registry');
        const definition = { type: 'function' as const, function: { name: 'removed_server_tool', description: 'Test',
            parameters: { type: 'object' as const, properties: {} } } };
        const unregister = registerServerTool(definition, () => 'ok', { runtime: 'server' });
        try {
            const input = await prepareChildAdmission(7_200_000, true, true, parentHistory, true, definition);
            unregister();
            expect(await admitPreparedDelegationChildren(provider, input.parentJobId, params.userId, input.leaseOwner))
                .toMatchObject({ admitted: 0 });
            await reopen();
            const parent = await provider.getJob(input.parentJobId, params.userId);
            const child = (parent!.execution as BackgroundJobExecution).delegationWait!.children[0]!;
            expect(child).toMatchObject({ kind: 'prepared', settlement: { kind: 'unavailable', code: 'tool_unavailable' } });
            expect(child).not.toHaveProperty('jobId');
            expect(await provider.claimNextDelegationWait('resume-worker', Date.now(), Date.now() + 60_000)).toBeTruthy();
            expect(await resumeReconciledDelegation(provider, input.parentJobId, params.userId, 'resume-worker')).toBe('resumed');
            const resumed = await provider.getJob(input.parentJobId, params.userId);
            const result = JSON.parse(resumed!.tool_calls![0]!.result!);
            expect(result.results[0]).toMatchObject({ status: 'unavailable', code: 'tool_unavailable' });
            expect(result.results[0]).not.toHaveProperty('threadId');
        } finally {
            unregister();
        }
    });

    it('verifies only the saved exact child generation under current workspace access', async () => {
        const adapter = await prepareCanonicalWorkspace();
        const raw = getRawDb();
        const input = await prepareChildAdmission();
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        const content = 'Canonical answer '.repeat(1_200);
        const settle = () => reconcileDelegationChild(provider, input.parentJobId, params.userId, input.leaseOwner, 0);
        const inspect = () => inspectCompletedDelegationChild(provider, input.parentJobId, params.userId, input.leaseOwner, 0);
        expect(await inspect()).toEqual({ status: 'pending' });
        expect(await settle()).toBe('pending');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content, reasoning: '', completedAt: Date.now() });
        expect(await inspect()).toEqual({ status: 'pending' });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('committed');
        expect(await inspect()).toEqual({ status: 'verified', content });
        const original = raw.prepare('SELECT clock, data_json, deleted FROM s_messages WHERE workspace_id = ? AND id = ?')
            .get(execution.workspaceId, ids.assistantMessageId) as { clock: number; data_json: string; deleted: number };
        const restore = () => raw.prepare('UPDATE s_messages SET clock = ?, data_json = ?, deleted = ? WHERE workspace_id = ? AND id = ?')
            .run(original.clock, original.data_json, original.deleted, execution.workspaceId, ids.assistantMessageId);
        raw.prepare("UPDATE s_messages SET clock = clock + 1, data_json = json_set(data_json, '$.data.content', 'Edited answer') WHERE workspace_id = ? AND id = ?")
            .run(execution.workspaceId, ids.assistantMessageId);
        expect(await inspect()).toEqual({ status: 'unavailable' });
        restore();
        raw.prepare("UPDATE s_messages SET data_json = json_set(data_json, '$.data.generation_id', 'another-generation') WHERE workspace_id = ? AND id = ?")
            .run(execution.workspaceId, ids.assistantMessageId);
        expect(await inspect()).toEqual({ status: 'unavailable' });
        restore();
        raw.prepare('UPDATE s_messages SET deleted = 1 WHERE workspace_id = ? AND id = ?').run(execution.workspaceId, ids.assistantMessageId);
        expect(await inspect()).toEqual({ status: 'unavailable' });
        restore();
        let changed = false;
        const racingAdapter = Object.create(adapter) as SqliteSyncGatewayAdapter;
        racingAdapter.readChatHistory = async (...args) => {
            const result = await adapter.readChatHistory(...args);
            if (!changed && args[1].kind === 'messages') {
                changed = true;
                raw.prepare('UPDATE s_messages SET clock = clock + 1 WHERE workspace_id = ? AND id = ?').run(execution.workspaceId, ids.assistantMessageId);
            }
            return result;
        };
        registerSyncGatewayAdapter({ id: 'sqlite', create: () => racingAdapter });
        expect(await inspect()).toEqual({ status: 'retry' });
        registerSyncGatewayAdapter({ id: 'sqlite', create: () => adapter });
        restore();
        raw.prepare("DELETE FROM workspace_members WHERE id = 'delegation-member'").run();
        await expect(inspect()).rejects.toThrow();
        await expect(settle()).rejects.toThrow();
        raw.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)').run('delegation-member', execution.workspaceId, params.userId, 'owner');
        expect(await settle()).toBe('committed');
        await reopen();
        const stored = await provider.getJob(input.parentJobId, params.userId);
        expect((stored!.execution as BackgroundJobExecution).delegationWait!.children[0]).toMatchObject({ settlement: {
            kind: 'complete', assistantMessageId: ids.assistantMessageId, result: { kind: 'inline', value: content },
        } });
    });

    it('keeps an oversized child unsettled when canonical artifact retention is unavailable', async () => {
        await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission();
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        const content = 'x'.repeat(140_000);
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content, reasoning: '', completedAt: Date.now() });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('committed');
        expect(await reconcileDelegationChild(provider, input.parentJobId, params.userId, input.leaseOwner, 0)).toBe('pending');
        await reopen();
        const parent = await provider.getJob(input.parentJobId, params.userId);
        expect((parent!.execution as BackgroundJobExecution).delegationWait!.children[0]).not.toHaveProperty('settlement');
        expect((await provider.getJob(admitted.jobId, params.userId))?.content).toBe(content);
    });

    it.each(['unadmitted', 'undispatched', 'dispatched'] as const)(
        'expires %s child work without inventing a failure', async (stage) => {
        await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(1_000, true, true, parentHistory);
        let childId: string | undefined;
        if (stage !== 'unadmitted') {
            const admitted = await provider.admitDelegationChild(input);
            if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
            childId = admitted.jobId;
            expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(childId, params.userId))!)).toBe('ready');
            await provider.claimJob(childId, 'child-worker', Date.now(), Date.now() + 60_000);
            if (stage === 'dispatched') await provider.beginDelegationDispatch(childId, 'child-worker');
        }
        const parent = await provider.getJob(input.parentJobId, params.userId);
        const wait = (parent!.execution as BackgroundJobExecution).delegationWait!;
        expect(await provider.commitDelegationWait({ parentJobId: input.parentJobId, leaseOwner: input.leaseOwner,
            expectedRevision: wait.revision, wait: { ...wait, revision: wait.revision + 1 } })).toBe(true);
        vi.mocked(Date.now).mockReturnValue(Date.now() + 1_001);
        const { reconcileDueDelegationWaits } = await import('~~/server/utils/background-jobs/delegation-coordinator');
        let eligible = provider;
        expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        await reopen();
        eligible = provider;
        const expired = await provider.getJob(input.parentJobId, params.userId);
        expect((expired!.execution as BackgroundJobExecution).delegationWait).toHaveProperty('expiredAt');
        if (childId) {
            expect(await provider.getJob(childId, params.userId)).toMatchObject({ status: 'aborted' });
            expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(childId, params.userId))!)).toBe('committed');
            vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
            expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        }
        vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
        expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        const resumed = await provider.getJob(input.parentJobId, params.userId);
        expect((resumed!.execution as BackgroundJobExecution).delegationWait).toBeUndefined();
        const result = JSON.parse(resumed!.tool_calls![0]!.result!).results[0];
        expect(result.status).toBe(stage === 'unadmitted' ? 'unavailable' : stage === 'dispatched' ? 'unknown' : 'stopped');
        expect(Boolean((resumed!.execution as BackgroundJobExecution).delegationBlocked)).toBe(stage === 'dispatched');
        if (stage === 'unadmitted') expect(result).not.toHaveProperty('threadId');
    });

    it('recovers a parked parent through admission, settlement and resume', async () => {
        await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const original = await provider.getJob(input.parentJobId, params.userId);
        const wait = (original!.execution as BackgroundJobExecution).delegationWait!;
        expect(await provider.commitDelegationWait({ parentJobId: input.parentJobId, leaseOwner: input.leaseOwner,
            expectedRevision: wait.revision, wait: { ...wait, revision: wait.revision + 1 } })).toBe(true);
        await reopen();
        const { reconcileDueDelegationWaits } = await import('~~/server/utils/background-jobs/delegation-coordinator');
        const legacy = Object.create(provider) as SqliteBackgroundJobProvider;
        Object.defineProperty(legacy, 'delegationCoordinatorVersion', { value: undefined });
        expect(await reconcileDueDelegationWaits(legacy, 1)).toBe(0);
        const eligible = provider;
        const { getShutdownRuntime } = await import('~~/server/utils/shutdown/runtime');
        const phase = vi.spyOn(getShutdownRuntime().controller, 'phase').mockReturnValue('preparing');
        const admission = vi.spyOn(getShutdownRuntime().controller, 'canStartWork').mockReturnValue(false);
        expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        const duringDrain = await provider.getJob(input.parentJobId, params.userId);
        expect((duringDrain!.execution as BackgroundJobExecution).delegationWait!.children[0]).not.toHaveProperty('jobId');
        phase.mockRestore();
        admission.mockRestore();
        vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
        expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        const admitted = await provider.getJob(input.parentJobId, params.userId);
        const child = (admitted!.execution as BackgroundJobExecution).delegationWait!.children[0]!;
        if (child.kind !== 'prepared' || !child.jobId) throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(child.jobId, params.userId))!)).toBe('ready');
        await provider.saveTerminalSnapshot(child.jobId, { status: 'complete', content: 'saved answer', reasoning: '', completedAt: Date.now() });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(child.jobId, params.userId))!)).toBe('committed');
        await reopen();
        vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
        const recovered = provider;
        expect(await reconcileDueDelegationWaits(recovered, 1)).toBe(1);
        vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
        expect(await reconcileDueDelegationWaits(recovered, 1)).toBe(1);
        const parent = await provider.getJob(input.parentJobId, params.userId);
        expect((parent!.execution as BackgroundJobExecution).delegationWait).toBeUndefined();
        expect(parent!.tool_calls![0]).toMatchObject({ status: 'complete', delegation: { children: [{ outcome: 'complete' }] } });
        expect(JSON.parse(parent!.tool_calls![0]!.result!).results[0]).toMatchObject({ status: 'complete', content: 'saved answer' });
    });

    it('retains a large settled child in canonical KV across reopen', async () => {
        const sync = await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        const content = 'x'.repeat(140_000);
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content, reasoning: '', completedAt: Date.now() });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('committed');
        expect(await reconcileDelegationChild(provider, input.parentJobId, params.userId, input.leaseOwner, 0)).toBe('committed');
        await reopen();
        const parent = await provider.getJob(input.parentJobId, params.userId);
        const child = (parent!.execution as BackgroundJobExecution).delegationWait!.children[0]!;
        if (child.kind !== 'prepared' || child.settlement?.kind !== 'complete' || child.settlement.result.kind !== 'artifact')
            throw new Error('Expected retained child artifact');
        const actual = await readToolResultStorage(child.settlement.result.reference, async id => {
            const row = getRawDb().prepare('SELECT data_json, deleted FROM s_kv WHERE workspace_id = ? AND id = ?')
                .get(execution.workspaceId, id) as { data_json: string; deleted: number } | undefined;
            return row ? { ...(JSON.parse(row.data_json) as { value: string }), deleted: !!row.deleted } : undefined;
        });
        expect(actual).toBe(content);
        vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
        expect(await provider.claimNextDelegationWait('resume-worker', Date.now(), Date.now() + 60_000)).toMatchObject({ id: input.parentJobId });
        const resume = () => resumeReconciledDelegation(provider, input.parentJobId, params.userId, 'resume-worker');
        getRawDb().prepare('UPDATE s_messages SET deleted = 1 WHERE workspace_id = ? AND id = ?').run(execution.workspaceId, ids.assistantMessageId);
        expect(await inspectCompletedDelegationChild(provider, input.parentJobId, params.userId, 'resume-worker', 0)).toEqual({ status: 'unavailable' });
        getRawDb().prepare('UPDATE s_messages SET deleted = 0 WHERE workspace_id = ? AND id = ?').run(execution.workspaceId, ids.assistantMessageId);
        getRawDb().prepare("DELETE FROM workspace_members WHERE id = 'delegation-member'").run();
        await expect(resume()).rejects.toThrow();
        getRawDb().prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)')
            .run('delegation-member', execution.workspaceId, params.userId, 'owner');
        const racing = Object.create(provider) as SqliteBackgroundJobProvider;
        racing.resumeDelegationWait = async input => {
            const pushed = await sync.push({} as never, { scope: { workspaceId: execution.workspaceId }, ops: [{
                id: 'race-op', tableName: 'threads', operation: 'put', pk: params.threadId,
                payload: { id: params.threadId, title: 'Edited during resume' },
                stamp: { deviceId: 'race-device', opId: 'race-op', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 2 },
                createdAt: Math.floor(Date.now() / 1000), attempts: 0, status: 'pending',
            }] });
            expect(pushed.results[0]).toMatchObject({ success: true });
            return provider.resumeDelegationWait(input);
        };
        expect(await resumeReconciledDelegation(racing, input.parentJobId, params.userId, 'resume-worker')).toBe('retry');
        const authRace = Object.create(provider) as SqliteBackgroundJobProvider;
        authRace.resumeDelegationWait = async input => {
            getRawDb().prepare("DELETE FROM workspace_members WHERE id = 'delegation-member'").run();
            return provider.resumeDelegationWait(input);
        };
        expect(await resumeReconciledDelegation(authRace, input.parentJobId, params.userId, 'resume-worker')).toBe('retry');
        getRawDb().prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)')
            .run('delegation-member', execution.workspaceId, params.userId, 'owner');
        expect(await resume()).toBe('resumed');
        await reopen();
        const resumed = await provider.getJob(input.parentJobId, params.userId);
        expect((resumed!.execution as BackgroundJobExecution).delegationWait).toBeUndefined();
        expect((resumed!.execution as BackgroundJobExecution).pendingToolCalls?.map(call => call.id)).toEqual(['later']);
        expect(resumed!.tool_calls![0]).toMatchObject({ status: 'complete', delegation: { children: [{ outcome: 'complete' }] } });
        const aggregateReference = resumed!.tool_calls![0]!.result!;
        expect(aggregateReference.startsWith('or3-tool-result:v1/')).toBe(true);
        const adapter = new SqliteSyncGatewayAdapter();
        const aggregate = await adapter.readChatToolResult({ userId: params.userId, workspaceId: execution.workspaceId },
            { admission: parentHistory, callId: 'call', reference: aggregateReference });
        expect(JSON.parse(aggregate)).toMatchObject({ results: [{ status: 'complete', content: 'x'.repeat(18_000), truncated: true }] });
    });

    it.each(['deleted', 'corrupt'] as const)(
        'reports a %s retained child result as unavailable, but retries transient storage errors', async (damage) => {
        const adapter = await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content: 'x'.repeat(140_000), reasoning: '', completedAt: Date.now() });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('committed');
        expect(await reconcileDelegationChild(provider, input.parentJobId, params.userId, input.leaseOwner, 0)).toBe('committed');
        vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
        await provider.claimNextDelegationWait('resume-worker', Date.now(), Date.now() + 60_000);
        const resume = () => resumeReconciledDelegation(provider, input.parentJobId, params.userId, 'resume-worker');
        const offline = Object.create(adapter) as SqliteSyncGatewayAdapter;
        offline.readChatToolResult = async () => { throw new Error('temporary storage outage'); };
        registerSyncGatewayAdapter({ id: 'sqlite', create: () => offline });
        await expect(resume()).rejects.toThrow('temporary storage outage');
        expect((await provider.getJob(input.parentJobId, params.userId))!.execution).toHaveProperty('delegationWait');
        registerSyncGatewayAdapter({ id: 'sqlite', create: () => adapter });
        const row = getRawDb().prepare("SELECT id FROM s_kv WHERE workspace_id = ? AND json_extract(data_json, '$.name') LIKE ? LIMIT 1")
            .get(execution.workspaceId, `chat.tool-result:${encodeURIComponent(params.threadId)}:%`) as { id: string };
        if (damage === 'deleted') {
            const deleted = await adapter.push({} as never, { scope: { workspaceId: execution.workspaceId }, ops: [{
                id: 'delete-artifact', tableName: 'kv', operation: 'delete', pk: row.id,
                stamp: { deviceId: 'another-device', opId: 'delete-artifact', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 2 },
                createdAt: Math.floor(Date.now() / 1000), attempts: 0, status: 'pending',
            }] });
            expect(deleted.results[0]).toMatchObject({ success: true });
        } else {
            getRawDb().prepare('UPDATE s_kv SET data_json = ? WHERE workspace_id = ? AND id = ?')
                .run('{bad json', execution.workspaceId, row.id);
        }
        expect(await resume()).toBe('resumed');
        const parent = await provider.getJob(input.parentJobId, params.userId);
        expect(parent!.tool_calls![0]).toMatchObject({ status: 'complete', delegation: { children: [{ outcome: 'unavailable' }] } });
        const result = JSON.parse(parent!.tool_calls![0]!.result!);
        expect(result.results[0]).toMatchObject({ status: 'unavailable', code: 'result_unavailable' });
        expect(result.results[0]).not.toHaveProperty('content');
    });

    it('reports a child deleted after settlement as unavailable when resuming', async () => {
        const adapter = await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content: 'saved answer', reasoning: '', completedAt: Date.now() });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('committed');
        expect(await reconcileDelegationChild(provider, input.parentJobId, params.userId, input.leaseOwner, 0)).toBe('committed');
        const deleted = await adapter.push({} as never, { scope: { workspaceId: execution.workspaceId }, ops: [{
            id: 'delete-child', tableName: 'messages', operation: 'delete', pk: ids.assistantMessageId,
            stamp: { deviceId: 'another-device', opId: 'delete-child', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 3 },
            createdAt: Math.floor(Date.now() / 1000), attempts: 0, status: 'pending',
        }] });
        expect(deleted.results[0]).toMatchObject({ success: true });
        vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
        await provider.claimNextDelegationWait('resume-worker', Date.now(), Date.now() + 60_000);
        expect(await resumeReconciledDelegation(provider, input.parentJobId, params.userId, 'resume-worker')).toBe('resumed');
        const parent = await provider.getJob(input.parentJobId, params.userId);
        expect(parent!.tool_calls![0]).toMatchObject({ status: 'complete', delegation: { children: [{ outcome: 'unavailable' }] } });
        const result = JSON.parse(parent!.tool_calls![0]!.result!);
        expect(result.results[0]).toMatchObject({ status: 'unavailable', code: 'history_unavailable' });
        expect(result.results[0]).not.toHaveProperty('content');
    });

    it.each([
        { outcome: 'unknown', deleted: true }, { outcome: 'failed', deleted: true }, { outcome: 'stopped', deleted: true },
        { outcome: 'unknown', deleted: false }, { outcome: 'failed', deleted: false }, { outcome: 'stopped', deleted: false },
    ] as const)(
        'reconciles $outcome child history when deleted=$deleted and preserves uncertainty', async ({ outcome, deleted }) => {
            const adapter = await prepareCanonicalWorkspace();
            const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
            const admitted = await provider.admitDelegationChild(input);
            if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
            expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
            await provider.claimJob(admitted.jobId, 'child-worker', Date.now(), Date.now() + 60_000);
            if (outcome === 'unknown') await provider.beginDelegationDispatch(admitted.jobId, 'child-worker');
            if (outcome === 'stopped') await provider.abortJob(admitted.jobId, params.userId);
            else {
                const code = outcome === 'unknown' ? 'ERR_MODEL_OUTCOME_UNKNOWN' : 'ERR_STREAM_FAILURE';
                const error = serializeError(Object.assign(new Error('Fixture error'), { code, retryable: false }));
                await provider.saveTerminalSnapshot(admitted.jobId, { status: 'error', error, content: '', reasoning: '', completedAt: Date.now() }, 'child-worker');
            }
            expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('committed');
            expect(await reconcileDelegationChild(provider, input.parentJobId, params.userId, input.leaseOwner, 0)).toBe('committed');
            if (deleted) {
                const result = await adapter.push({} as never, { scope: { workspaceId: execution.workspaceId }, ops: [{
                    id: 'delete-terminal-child', tableName: 'messages', operation: 'delete', pk: ids.assistantMessageId,
                    stamp: { deviceId: 'another-device', opId: 'delete-terminal-child', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 3 },
                    createdAt: Math.floor(Date.now() / 1000), attempts: 0, status: 'pending',
                }] });
                expect(result.results[0]).toMatchObject({ success: true });
            }
            vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
            await provider.claimNextDelegationWait('resume-worker', Date.now(), Date.now() + 60_000);
            expect(await resumeReconciledDelegation(provider, input.parentJobId, params.userId, 'resume-worker')).toBe('resumed');
            const parent = (await provider.getJob(input.parentJobId, params.userId))!;
            expect(JSON.parse(parent.tool_calls![0]!.result!).results[0]).toMatchObject(deleted
                ? { status: 'unavailable', code: 'history_unavailable' } : { status: outcome });
            expect(parent.tool_calls![0]!.delegation?.children[0]?.outcome).toBe(deleted ? 'unavailable' : outcome);
            if (outcome === 'unknown') {
                expect((parent.execution as BackgroundJobExecution).delegationBlocked).toBe(true);
                if (deleted) {
                    expect(JSON.parse(parent.tool_calls![0]!.result!).results[0].executionUncertain).toBe(true);
                    expect(parent.tool_calls![0]!.delegation?.children[0]).toMatchObject({ executionUncertain: true });
                }
            }
        });

    it.each(['unknown error', 'dispatched stop', 'confirmed stop', 'confirmed failure', 'complete', 'missing job', 'mismatched job'] as const)(
        'preserves uncertainty when child history is unavailable before settlement: %s', async outcome => {
        const adapter = await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        if (outcome === 'missing job') {
            getRawDb().prepare('DELETE FROM background_jobs WHERE id = ?').run(admitted.jobId);
        } else if (outcome === 'mismatched job') {
            getRawDb().prepare('UPDATE background_jobs SET thread_id = ? WHERE id = ?').run('different-thread', admitted.jobId);
        } else {
            expect(await provider.claimJob(admitted.jobId, 'child-worker', Date.now(), Date.now() + 60_000)).toBeTruthy();
            if (outcome === 'unknown error' || outcome === 'dispatched stop')
                expect(await provider.beginDelegationDispatch(admitted.jobId, 'child-worker')).toBeTruthy();
            if (outcome === 'dispatched stop' || outcome === 'confirmed stop') expect(await provider.abortJob(admitted.jobId, params.userId)).toBe(true);
            else if (outcome === 'complete') expect(await provider.saveTerminalSnapshot(admitted.jobId,
                { status: 'complete', content: 'Saved result', reasoning: '', completedAt: Date.now() }, 'child-worker')).toBe(true);
            else {
                const code = outcome === 'unknown error' ? 'ERR_MODEL_OUTCOME_UNKNOWN' : 'ERR_STREAM_FAILURE';
                const error = serializeError(Object.assign(new Error('Child error'), { code, retryable: false }));
                expect(await provider.saveTerminalSnapshot(admitted.jobId,
                    { status: 'error', error, content: '', reasoning: '', completedAt: Date.now() }, 'child-worker')).toBe(true);
            }
            const deleted = await adapter.push({} as never, { scope: { workspaceId: execution.workspaceId }, ops: [{
                id: 'delete-before-settlement', tableName: 'messages', operation: 'delete', pk: ids.assistantMessageId,
                stamp: { deviceId: 'another-device', opId: 'delete-before-settlement', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 3 },
                createdAt: Math.floor(Date.now() / 1000), attempts: 0, status: 'pending',
            }] });
            expect(deleted.results[0]).toMatchObject({ success: true });
            expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('superseded');
        }
        const uncertain = outcome === 'unknown error' || outcome === 'dispatched stop' || outcome === 'missing job' || outcome === 'mismatched job';
        expect(await reconcileDelegationChild(provider, input.parentJobId, params.userId, input.leaseOwner, 0)).toBe('committed');
        expect((await provider.getJob(input.parentJobId, params.userId))?.execution).toMatchObject({
            delegationWait: { children: [{ settlement: uncertain
                ? { kind: 'unknown', code: 'upstream_uncertain' }
                : { kind: 'unavailable', code: 'history_unavailable' } }] },
        });
        await reopen();
        vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
        expect(await provider.claimNextDelegationWait('resume-worker', Date.now(), Date.now() + 60_000)).toBeTruthy();
        expect(await resumeReconciledDelegation(provider, input.parentJobId, params.userId, 'resume-worker')).toBe('resumed');
        const parent = (await provider.getJob(input.parentJobId, params.userId))!;
        const result = JSON.parse(parent.tool_calls![0]!.result!).results[0];
        expect(result).toMatchObject({ status: 'unavailable', code: 'history_unavailable' });
        expect(result.executionUncertain).toBe(uncertain ? true : undefined);
        expect(parent.tool_calls![0]!.delegation?.children[0]).toMatchObject({ outcome: 'unavailable' });
        const activity = parent.tool_calls![0]!.delegation?.children[0];
        expect(activity && 'executionUncertain' in activity ? activity.executionUncertain : undefined).toBe(uncertain ? true : undefined);
        expect(Boolean((parent.execution as BackgroundJobExecution).delegationBlocked)).toBe(uncertain);
    });

    it('does not resume if the parent is stopped while reading a retained child', async () => {
        const adapter = await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content: 'x'.repeat(20_000), reasoning: '', completedAt: Date.now() });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('committed');
        expect(await reconcileDelegationChild(provider, input.parentJobId, params.userId, input.leaseOwner, 0)).toBe('committed');
        vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
        await provider.claimNextDelegationWait('resume-worker', Date.now(), Date.now() + 60_000);
        const racing = Object.create(adapter) as SqliteSyncGatewayAdapter;
        racing.readChatToolResult = async (...args) => {
            const result = await adapter.readChatToolResult(...args);
            await provider.abortJob(input.parentJobId, params.userId);
            return result;
        };
        registerSyncGatewayAdapter({ id: 'sqlite', create: () => racing });
        expect(await resumeReconciledDelegation(provider, input.parentJobId, params.userId, 'resume-worker')).toBe('retry');
        await reopen();
        expect(await provider.getJob(input.parentJobId, params.userId)).toMatchObject({ status: 'aborted',
            execution: { delegationWait: { children: [{ settlement: { kind: 'complete' } }] } } });
    });

    it.each(['error', 'aborted'] as const)(
        'settles a persisted uncertain %s child as unknown', async (status) => {
            await prepareCanonicalWorkspace();
            const input = await prepareChildAdmission();
            const admitted = await provider.admitDelegationChild(input);
            if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
            expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
            await provider.claimJob(admitted.jobId, 'child-worker', Date.now(), Date.now() + 60_000);
            await provider.beginDelegationDispatch(admitted.jobId, 'child-worker');
            if (status === 'aborted') await provider.abortJob(admitted.jobId, params.userId);
            else {
                const error = serializeError(Object.assign(new Error('Unknown outcome'), { code: 'ERR_MODEL_OUTCOME_UNKNOWN', retryable: false }));
                await provider.saveTerminalSnapshot(admitted.jobId, { status, error, content: '', reasoning: '', completedAt: Date.now() }, 'child-worker');
            }
            expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('committed');
            expect(await reconcileDelegationChild(provider, input.parentJobId, params.userId, input.leaseOwner, 0)).toBe('committed');
            await reopen();
            const parent = await provider.getJob(input.parentJobId, params.userId);
            expect((parent!.execution as BackgroundJobExecution).delegationWait!.children[0]).toMatchObject({
                settlement: { kind: 'unknown', code: 'upstream_uncertain' },
            });
        });

    it('admits active children when the waiting budget is full', async () => {
        await checkSeparateWaitingCapacity(provider);
    });

    it('retains uncertain dispatch evidence across reclaim and fences Stop and stale workers', async () => {
        const now = Date.now();
        const safeExecution = { ...execution, delegationRecoveryPolicy: 'v1' as const };
        const jobId = await provider.createJob({ ...params, execution: safeExecution });
        expect(await provider.claimJob(jobId, 'first', now, now + 60_000)).toBeTruthy();
        const marker = await provider.beginDelegationDispatch(jobId, 'first');
        expect(marker).toEqual({ version: 1, sequence: 1, state: 'started' });
        expect(await provider.beginDelegationDispatch(jobId, 'first')).toBeNull();
        await provider.updateJob(jobId, { contentChunk: 'partial evidence', reasoningChunk: 'partial reasoning', leaseOwner: 'first' });
        await reopen();
        vi.mocked(Date.now).mockReturnValue(now + 60_001);
        const recovered = await provider.claimJob(jobId, 'second', now + 60_001, now + 120_000);
        expect(recovered).toMatchObject({ content: 'partial evidence', reasoning: 'partial reasoning', execution: { delegationDispatch: marker } });
        expect(await provider.beginDelegationDispatch(jobId, 'first')).toBeNull();
        expect(await provider.beginDelegationDispatch(jobId, 'second')).toBeNull();
        expect(await provider.abortJob(jobId, params.userId)).toBe(true);
        expect(await provider.beginDelegationDispatch(jobId, 'second')).toBeNull();
        expect(await provider.getJob(jobId, params.userId)).toMatchObject({ status: 'aborted',
            execution: { delegationDispatch: marker } });
    });

    it('does not replace captured parent instructions during checkpoints or parking', async () => {
        const now = Date.now();
        const guarded = { ...execution, delegationRecoveryPolicy: 'v1' as const };
        const changedDefaults = { version: 1 as const, instructions: [{ role: 'system' as const, content: 'Injected' }] };
        const jobId = await provider.createJob({ ...params, execution: guarded });
        await provider.claimJob(jobId, 'worker', now, now + 60_000);
        expect(await provider.updateJobExecution(jobId, { ...guarded, delegationDefaults: changedDefaults }, 'worker')).toBe(false);
        expect(await provider.updateJobExecution(jobId, guarded, 'worker')).toBe(true);
        expect(await provider.beginDelegationDispatch(jobId, 'worker')).toBeTruthy();
        const checkpoint = { ...guarded, delegationDispatchSequence: 1 };
        expect(await provider.commitDelegationDispatch(jobId, 'worker', 1, { ...checkpoint, delegationDefaults: changedDefaults }, [])).toBe(false);
        expect(await provider.commitDelegationDispatch(jobId, 'worker', 1, checkpoint, [])).toBe(true);
        const wait = { version: 1 as const, revision: 0, callId: 'call', argumentFingerprint: `sha256:v1:${'a'.repeat(64)}`,
            deadlineAt: now + 7_200_000, nextCheckAt: now,
            children: [{ kind: 'rejected' as const, index: 0, settlement: { kind: 'unavailable' as const, code: 'unsupported' } }] };
        expect(await provider.parkDelegationWait(jobId, 'worker', { ...checkpoint, delegationDefaults: changedDefaults, delegationWait: wait }, [])).toBe(false);
        expect(await provider.parkDelegationWait(jobId, 'worker', { ...checkpoint, delegationWait: wait }, [])).toBe(true);
        await reopen();
        expect((await provider.getJob(jobId, params.userId))?.execution).toMatchObject({ delegationDefaults: guarded.delegationDefaults });
    });

    it('only clears a dispatch marker with the matching fenced tool checkpoint', async () => {
        const now = Date.now();
        const safeExecution = { ...execution, delegationRecoveryPolicy: 'v1' as const };
        const jobId = await provider.createJob({ ...params, execution: safeExecution });
        await provider.claimJob(jobId, 'worker', now, now + 60_000);
        const marker = await provider.beginDelegationDispatch(jobId, 'worker');
        expect(marker?.sequence).toBe(1);
        const checkpoint = { ...safeExecution, delegationDispatchSequence: 1,
            body: { model: 'test-model', messages: [{ role: 'assistant', content: 'Ready' }] } };
        expect(await provider.commitDelegationDispatch(jobId, 'stale', 1, checkpoint, [])).toBe(false);
        expect(await provider.commitDelegationDispatch(jobId, 'worker', 2, checkpoint, [])).toBe(false);
        expect((await provider.getJob(jobId, params.userId))?.execution).toMatchObject({ delegationDispatch: marker });
        expect(await provider.commitDelegationDispatch(jobId, 'worker', 1, checkpoint, [])).toBe(true);
        await reopen();
        const stored = await provider.getJob(jobId, params.userId);
        expect(stored?.execution).toMatchObject({ delegationDispatchSequence: 1, body: checkpoint.body });
        expect((stored?.execution as BackgroundJobExecution).delegationDispatch).toBeUndefined();
        expect(await provider.beginDelegationDispatch(jobId, 'worker')).toEqual({ version: 1, sequence: 2, state: 'started' });
        await provider.abortJob(jobId, params.userId);
        expect(await provider.commitDelegationDispatch(jobId, 'worker', 2, { ...checkpoint, delegationDispatchSequence: 2 }, [])).toBe(false);
        expect(await provider.getJob(jobId, params.userId)).toMatchObject({ status: 'aborted', execution: { delegationDispatch: { sequence: 2 } } });
    });

    it('keeps an uncertain model outcome distinct when idle cleanup times out a job', async () => {
        const now = Date.now();
        const jobId = await provider.createJob({ ...params, execution: { ...execution, delegationRecoveryPolicy: 'v1' } });
        await provider.claimJob(jobId, 'worker', now, now + 60_000);
        expect(await provider.beginDelegationDispatch(jobId, 'worker')).toBeTruthy();
        vi.mocked(Date.now).mockReturnValue(now + 8_000_000);
        await provider.cleanupExpired();
        const job = await provider.getJob(jobId, params.userId);
        expect(job?.status).toBe('error');
        expect(normalizeError(job?.error)).toMatchObject({ code: 'ERR_MODEL_OUTCOME_UNKNOWN', retryable: false });
        expect((job?.execution as BackgroundJobExecution).delegationDispatch).toMatchObject({ sequence: 1 });
    });

    it('does not park an unguarded parent or erase an outstanding dispatch marker', async () => {
        const now = Date.now();
        const guarded = { ...execution, delegationRecoveryPolicy: 'v1' as const };
        const waiting = { ...guarded, delegationWait: {
            version: 1 as const, revision: 0, callId: 'call', argumentFingerprint: `sha256:v1:${'a'.repeat(64)}`,
            deadlineAt: now + 7_200_000, nextCheckAt: now,
            children: [{ kind: 'rejected' as const, index: 0, settlement: { kind: 'unavailable' as const, code: 'unsupported' } }],
        } };
        const unguarded = await provider.createJob({ ...params, execution: { ...execution, delegationRecoveryPolicy: undefined } });
        await provider.claimJob(unguarded, 'unguarded', now, now + 60_000);
        expect(await provider.parkDelegationWait(unguarded, 'unguarded', waiting, [])).toBe(false);
        const damaged = await provider.createJob({ ...params, execution: guarded });
        getRawDb().prepare(`UPDATE background_jobs SET execution_json = json_set(execution_json,
            '$.delegationDispatchSequence', json('null')) WHERE id = ?`).run(damaged);
        await provider.claimJob(damaged, 'damaged', now, now + 60_000);
        expect(await provider.parkDelegationWait(damaged, 'damaged', waiting, [])).toBe(false);
        const dispatched = await provider.createJob({ ...params, execution: guarded });
        await provider.claimJob(dispatched, 'dispatched', now, now + 60_000);
        expect(await provider.beginDelegationDispatch(dispatched, 'dispatched')).toBeTruthy();
        expect(await provider.parkDelegationWait(dispatched, 'dispatched', waiting, [])).toBe(false);
        expect((await provider.getJob(dispatched, params.userId))?.execution).toMatchObject({ delegationDispatch: { sequence: 1 } });
        expect(await provider.commitDelegationDispatch(dispatched, 'dispatched', 1,
            { ...guarded, delegationDispatchSequence: 1 }, [])).toBe(true);
        expect(await provider.parkDelegationWait(dispatched, 'dispatched', waiting, [])).toBe(false);
        expect(await provider.parkDelegationWait(dispatched, 'dispatched', { ...waiting, delegationDispatchSequence: 1 }, [])).toBe(true);
    });

    it('atomically links a canonical child and replays its admission even at capacity', async () => {
        const input = await prepareChildAdmission();
        const admitted = await provider.admitDelegationChild(input);
        expect(admitted).toMatchObject({ status: 'admitted', replayed: false });
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await provider.getJob(input.parentJobId, params.userId)).toMatchObject({
            execution: { delegationWait: { revision: 1, children: [{ jobId: admitted.jobId }] } },
        });
        expect(await provider.getJob(admitted.jobId, params.userId)).toMatchObject({ historyPhase: 'admission_pending' });
        expect(await provider.claimJob(admitted.jobId, 'model', Date.now(), Date.now() + 60_000)).toBeNull();
        for (let i = 0; i < 4; i++) await provider.createJob({ ...params, execution });
        await reopen();
        expect(await provider.admitDelegationChild(input)).toEqual({ status: 'admitted', jobId: admitted.jobId, replayed: true });
        const childExecution = input.child.execution as BackgroundJobExecution;
        await expect(provider.admitDelegationChild({ ...input, child: { ...input.child, execution: {
            ...childExecution, body: { ...childExecution.body, messages: [{ role: 'user', content: 'Different task' }] },
        } } })).rejects.toThrow('Delegation child admission does not match its checkpoint');
        expect(await provider.findJobByIdempotencyKey(admissionKey, params.userId)).toMatchObject({ id: admitted.jobId });
    });

    it('refuses changed child work before the first admission', async () => {
        const input = await prepareChildAdmission();
        const childExecution = input.child.execution as BackgroundJobExecution;
        const altered = [
            { ...childExecution, body: { ...childExecution.body, messages: [{ role: 'user', content: 'Different task' }] } },
            { ...childExecution, body: { ...childExecution.body, reasoning: { effort: 'high' } } },
            { ...childExecution, history: { ...childExecution.history!, thread: { ...childExecution.history!.thread!, title: 'Changed' } } },
        ];
        for (const changed of altered) {
            await expect(provider.admitDelegationChild({ ...input, child: { ...input.child, execution: changed } }))
                .rejects.toThrow('Delegation child admission does not match its checkpoint');
            expect(await provider.findJobByIdempotencyKey(admissionKey, params.userId)).toBeNull();
        }
        expect(await provider.admitDelegationChild(input)).toMatchObject({ status: 'admitted', replayed: false });
    });

    it('retains the prepared child request and canonical history across database reopen', async () => {
        const input = await prepareChildAdmission();
        const childExecution = input.child.execution as BackgroundJobExecution;
        await reopen();
        const parent = await provider.getJob(input.parentJobId, params.userId);
        expect((parent?.execution as BackgroundJobExecution).delegationWait?.children[0]).toMatchObject({
            admission: { body: childExecution.body, history: childExecution.history },
        });
        const rebuilt = reconstructDelegationChild(parent!, 0);
        expect(await provider.admitDelegationChild({ ...input, child: rebuilt })).toMatchObject({ status: 'admitted', replayed: false });
    });

    it('admits available children and defers the rest at capacity without waiting for completion', async () => {
        const input = await prepareChildAdmission();
        const secondIds = delegationChildIdentities({ userId: params.userId, workspaceId: execution.workspaceId,
            parentGenerationId: params.generationId, callId: input.callId, index: 1 });
        const original = input.child.execution as BackgroundJobExecution;
        const oldHistory = original.history!;
        const history = { ...oldHistory, admissionId: secondIds.admissionId, generationId: secondIds.generationId,
            threadId: secondIds.threadId, messageId: secondIds.assistantMessageId,
            thread: { ...oldHistory.thread!, id: secondIds.threadId },
            userMessage: { ...oldHistory.userMessage!, id: secondIds.userMessageId, thread_id: secondIds.threadId },
            assistantMessage: { ...oldHistory.assistantMessage, id: secondIds.assistantMessageId, thread_id: secondIds.threadId } };
        const second = { ...input.child, threadId: secondIds.threadId, messageId: secondIds.assistantMessageId,
            idempotencyKey: getScopedAdmissionKey(params.userId, execution.workspaceId, secondIds.admissionId),
            generationId: secondIds.generationId, execution: { ...original, history } };
        const saved = { kind: 'prepared', index: 1, admissionId: secondIds.admissionId, threadId: secondIds.threadId,
            userMessageId: secondIds.userMessageId, assistantMessageId: secondIds.assistantMessageId,
            request: { task: 'Research', model: 'test-model' }, admissionFingerprint: delegationAdmissionFingerprint(second),
            admission: { body: second.execution.body, history } };
        getRawDb().prepare(`UPDATE background_jobs SET execution_json = json_insert(execution_json,
            '$.delegationWait.children[#]', json(?)) WHERE id = ?`).run(JSON.stringify(saved), input.parentJobId);
        let activeProvider = 'sqlite';
        let switchDuringRead = false;
        vi.stubGlobal('useRuntimeConfig', () => ({ public: { sync: { provider: activeProvider } } }));
        let role = 'viewer';
        registerAuthWorkspaceStore({ id: 'sqlite', create: () => ({ listUserWorkspaces: async () =>
            [{ id: execution.workspaceId, name: 'Fixture', role }] }) as never });
        registerSyncGatewayAdapter({ id: 'sqlite', create: () => ({ capabilities: { canonicalChatHistory: 'v1' },
            readChatHistory: async () => {
                if (switchDuringRead) activeProvider = 'another-provider';
                return { status: 'ok', project_ownership: 'resolved',
                    thread: { id: params.threadId, clock: 1, project_id: null } };
            } }) as never });
        await expect(admitPreparedDelegationChildren(provider, input.parentJobId, params.userId, input.leaseOwner)).rejects.toThrow();
        expect(await provider.findJobByIdempotencyKey(admissionKey, params.userId)).toBeNull();
        role = 'owner';
        switchDuringRead = true;
        await expect(admitPreparedDelegationChildren(provider, input.parentJobId, params.userId, input.leaseOwner)).rejects.toThrow('sync provider');
        expect(await provider.findJobByIdempotencyKey(admissionKey, params.userId)).toBeNull();
        switchDuringRead = false;
        activeProvider = 'sqlite';
        const fillers = [];
        for (let i = 0; i < 4; i++) fillers.push(await provider.createJob({ ...params, execution }));
        const first = await admitPreparedDelegationChildren(provider, input.parentJobId, params.userId, input.leaseOwner);
        expect(first).toMatchObject({ admitted: 1, reason: 'capacity' });
        const afterFirst = await provider.getJob(input.parentJobId, params.userId);
        const children = (afterFirst!.execution as BackgroundJobExecution).delegationWait!.children;
        expect(children[0]).toHaveProperty('jobId');
        expect(children[1]).not.toHaveProperty('jobId');
        const firstId = children[0]!.kind === 'prepared' ? children[0]!.jobId! : '';
        expect(await provider.getJob(firstId, params.userId)).toMatchObject({ status: 'streaming', historyPhase: 'admission_pending' });
        await provider.abortJob(fillers[0]!, params.userId);
        const secondResult = await admitPreparedDelegationChildren(provider, input.parentJobId, params.userId, input.leaseOwner);
        expect(secondResult).toMatchObject({ admitted: 1, reason: 'no-pending' });
        const afterSecond = await provider.getJob(input.parentJobId, params.userId);
        expect((afterSecond!.execution as BackgroundJobExecution).delegationWait!.children[1]).toHaveProperty('jobId');
        expect(await provider.getJob(firstId, params.userId)).toMatchObject({ status: 'streaming' });
    });

    it('does not admit a child if the parent is stopped during the authorization read', async () => {
        const input = await prepareChildAdmission();
        vi.stubGlobal('useRuntimeConfig', () => ({ public: { sync: { provider: 'sqlite' } } }));
        registerAuthWorkspaceStore({ id: 'sqlite', create: () => ({ listUserWorkspaces: async () =>
            [{ id: execution.workspaceId, name: 'Fixture', role: 'owner' }] }) as never });
        registerSyncGatewayAdapter({ id: 'sqlite', create: () => ({ capabilities: { canonicalChatHistory: 'v1' },
            readChatHistory: async () => {
                await provider.abortJob(input.parentJobId, params.userId);
                return { status: 'ok', project_ownership: 'resolved', thread: { id: params.threadId, clock: 1, project_id: null } };
            } }) as never });
        expect(await admitPreparedDelegationChildren(provider, input.parentJobId, params.userId, input.leaseOwner))
            .toMatchObject({ admitted: 0, reason: 'not-owned' });
        expect(await provider.findJobByIdempotencyKey(admissionKey, params.userId)).toBeNull();
    });

    it('refuses a child when its saved request differs from the fingerprinted admission', async () => {
        const input = await prepareChildAdmission();
        getRawDb().prepare(`UPDATE background_jobs SET execution_json = json_set(execution_json,
            '$.delegationWait.children[0].admission.body.messages[0].content', 'Other task') WHERE id = ?`)
            .run(input.parentJobId);
        await expect(provider.admitDelegationChild(input)).rejects.toThrow('Delegation child admission does not match its saved request');
        expect(await provider.findJobByIdempotencyKey(admissionKey, params.userId)).toBeNull();
    });

    it('rejects an unguarded child even when its saved admission matches', async () => {
        const input = await prepareChildAdmission(7_200_000, false, false);
        await expect(provider.admitDelegationChild(input)).rejects.toThrow('Delegation child authority or identity mismatch');
        expect(await provider.findJobByIdempotencyKey(admissionKey, params.userId)).toBeNull();
    });

    it('refuses stale, canceled, conflicting and capacity-bound admission without creating a child', async () => {
        const input = await prepareChildAdmission();
        expect(await provider.admitDelegationChild({ ...input, leaseOwner: 'stale' })).toEqual({ status: 'not-owned' });
        expect(await provider.admitDelegationChild({ ...input, revision: 1 })).toEqual({ status: 'not-owned' });
        await expect(provider.admitDelegationChild({ ...input, argumentFingerprint: `sha256:v1:${'c'.repeat(64)}` }))
            .rejects.toThrow('Conflicting delegation identity');
        const foreign = { ...input.child, userId: 'another-user' };
        await expect(provider.admitDelegationChild({ ...input, child: foreign })).rejects.toThrow('mismatch');
        for (let i = 0; i < 5; i++) await provider.createJob({ ...params, execution });
        expect(await provider.admitDelegationChild(input)).toEqual({ status: 'capacity' });
        expect(await provider.findJobByIdempotencyKey(admissionKey, params.userId)).toBeNull();
        expect(await provider.abortJob(input.parentJobId, params.userId)).toBe(true);
        expect(await provider.admitDelegationChild(input)).toEqual({ status: 'not-owned' });
        expect(await provider.findJobByIdempotencyKey(admissionKey, params.userId)).toBeNull();
    });

    it('rejects a self-consistent child identity derived from another workspace', async () => {
        const input = await prepareChildAdmission();
        const foreign = delegationChildIdentities({ userId: params.userId, workspaceId: 'another-workspace',
            parentGenerationId: params.generationId, callId: input.callId, index: 0 });
        const childExecution = input.child.execution as BackgroundJobExecution;
        const history = childExecution.history!;
        const foreignKey = getScopedAdmissionKey(params.userId, execution.workspaceId, foreign.admissionId);
        const child = { ...input.child, idempotencyKey: foreignKey, threadId: foreign.threadId,
            messageId: foreign.assistantMessageId, generationId: foreign.generationId,
            execution: { ...childExecution, history: { ...history, admissionId: foreign.admissionId,
                generationId: foreign.generationId, threadId: foreign.threadId, messageId: foreign.assistantMessageId,
                thread: { ...history.thread!, id: foreign.threadId },
                userMessage: { ...history.userMessage!, id: foreign.userMessageId, thread_id: foreign.threadId },
                assistantMessage: { ...history.assistantMessage, id: foreign.assistantMessageId, thread_id: foreign.threadId } } } };
        getRawDb().prepare(`UPDATE background_jobs SET execution_json = json_set(execution_json,
            '$.delegationWait.children[0].admissionId', ?, '$.delegationWait.children[0].threadId', ?,
            '$.delegationWait.children[0].userMessageId', ?, '$.delegationWait.children[0].assistantMessageId', ?,
            '$.delegationWait.children[0].admissionFingerprint', ?, '$.delegationWait.children[0].admission', json(?))
            WHERE id = ?`).run(foreign.admissionId, foreign.threadId, foreign.userMessageId, foreign.assistantMessageId,
            delegationAdmissionFingerprint(child), JSON.stringify({ body: child.execution.body, history: child.execution.history }), input.parentJobId);
        await expect(provider.admitDelegationChild({ ...input, child })).rejects.toThrow('outside its parent scope');
        expect(await provider.findJobByIdempotencyKey(foreignKey, params.userId)).toBeNull();
    });

    it('respects child admission cancellation before creating a child', async () => {
        const input = await prepareChildAdmission();
        expect(await provider.cancelAdmission(params.userId, admissionKey)).toMatchObject({ pending: true });
        expect(await provider.admitDelegationChild(input)).toEqual({ status: 'cancelled' });
        expect(await provider.findJobByIdempotencyKey(admissionKey, params.userId)).toBeNull();
        expect(await provider.getJob(input.parentJobId, params.userId)).toMatchObject({
            execution: { delegationWait: { revision: 0, children: [{ admissionId: ids.admissionId }] } },
        });
    });

    it('does not start a child after the persisted delegation deadline', async () => {
        const now = Date.now();
        const input = await prepareChildAdmission(1_000);
        vi.mocked(Date.now).mockReturnValue(now + 1_001);
        expect(await provider.admitDelegationChild(input)).toEqual({ status: 'expired' });
        expect(await provider.findJobByIdempotencyKey(admissionKey, params.userId)).toBeNull();
    });

    it('does not start a child after the coordinator lease expires', async () => {
        const now = Date.now();
        const input = await prepareChildAdmission();
        vi.mocked(Date.now).mockReturnValue(now + 60_001);
        expect(await provider.admitDelegationChild(input)).toEqual({ status: 'not-owned' });
        expect(await provider.findJobByIdempotencyKey(admissionKey, params.userId)).toBeNull();
    });

    it.each(['revoked access', 'deleted parent', 'superseded parent'] as const)(
        'stops a parked parent and its admitted child after %s', async invalidation => {
        const adapter = await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        await provider.claimJob(admitted.jobId, 'child-worker', Date.now(), Date.now() + 120_000);
        if (invalidation === 'revoked access') {
            getRawDb().prepare("UPDATE workspace_members SET role = 'viewer' WHERE workspace_id = ? AND user_id = ?")
                .run(execution.workspaceId, params.userId);
        } else {
            const deleted = await adapter.push({} as never, { scope: { workspaceId: execution.workspaceId }, ops: [{
                id: 'change-parent', tableName: 'messages', operation: invalidation === 'deleted parent' ? 'delete' : 'put', pk: params.messageId,
                ...(invalidation === 'superseded parent' ? { payload: { id: params.messageId, thread_id: params.threadId,
                    role: 'assistant', data: { generation_id: 'newer-generation', content: 'newer' } } } : {}),
                stamp: { deviceId: 'other-device', opId: 'change-parent', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 3 },
                createdAt: Math.floor(Date.now() / 1000), attempts: 0, status: 'pending',
            }] });
            expect(deleted.results[0]).toMatchObject({ success: true });
        }
        await reopen();
        vi.mocked(Date.now).mockReturnValue(Date.now() + 60_001);
        const before = (await provider.getJob(input.parentJobId, params.userId))!;
        expect(await provider.stopInvalidDelegationWait({ parentJobId: input.parentJobId, leaseOwner: input.leaseOwner,
            expectedRevision: (before.execution as BackgroundJobExecution).delegationWait!.revision })).toBe('not-owned');
        expect((await provider.getJob(admitted.jobId, params.userId))?.status).toBe('streaming');
        if (invalidation === 'superseded parent') {
            const claimed = (await provider.claimNextDelegationWait('interrupted-coordinator', Date.now(), Date.now() + 30_000))!;
            expect(await provider.stopInvalidDelegationWait({ parentJobId: claimed.id, leaseOwner: 'interrupted-coordinator',
                expectedRevision: (claimed.execution as BackgroundJobExecution).delegationWait!.revision })).toBe('stopped');
            await reopen();
            vi.mocked(Date.now).mockReturnValue(Date.now() + 30_001);
        }
        const { reconcileDueDelegationWaits } = await import('~~/server/utils/background-jobs/delegation-coordinator');
        const eligible = provider;
        expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        expect(await provider.getJob(input.parentJobId, params.userId)).toMatchObject({ status: 'aborted', execution: { delegationWait: expect.any(Object) } });
        expect((await provider.getJob(admitted.jobId, params.userId))?.status).toBe('aborted');
        expect(await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content: 'late', reasoning: '', completedAt: Date.now() }, 'child-worker')).toBe(false);
    });

    it.each(['deleted', 'superseded'] as const)(
        'releases settled child evidence after the parent is %s without changing canonical history', async state => {
        const adapter = await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content: 'Saved research', reasoning: '', completedAt: Date.now() });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('committed');
        const pushed = await adapter.push({} as never, { scope: { workspaceId: execution.workspaceId }, ops: [{
            id: 'change-parent', tableName: 'messages', operation: state === 'deleted' ? 'delete' : 'put', pk: params.messageId,
            ...(state === 'superseded' ? { payload: { id: params.messageId, thread_id: params.threadId,
                role: 'assistant', data: { generation_id: 'newer-generation', content: 'Newer answer' } } } : {}),
            stamp: { deviceId: 'other-device', opId: 'change-parent', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 3 },
            createdAt: 1, attempts: 0, status: 'pending',
        }] });
        expect(pushed.results[0]).toMatchObject({ success: true });
        await reopen();
        vi.mocked(Date.now).mockReturnValue(Date.now() + 60_001);
        const { reconcileDueDelegationWaits } = await import('~~/server/utils/background-jobs/delegation-coordinator');
        let eligible = provider;
        expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        const parent = (await provider.getJob(input.parentJobId, params.userId))!;
        expect(parent.status).toBe('aborted');
        expect((parent.execution as BackgroundJobExecution).delegationTerminalProjection).toBeDefined();
        const interrupted = Object.create(provider) as SqliteBackgroundJobProvider;
        interrupted.setHistoryPhase = async (id, phase, options) => {
            if (phase === 'superseded') throw new Error('Lost job-store acknowledgement');
            return provider.setHistoryPhase(id, phase, options);
        };
        await expect(reconcileBackgroundJobHistory(interrupted, parent)).rejects.toThrow('Lost job-store acknowledgement');
        await reopen();
        vi.mocked(Date.now).mockReturnValue(Date.now() + 3_600_001);
        await provider.cleanupExpired();
        expect(await provider.getJob(admitted.jobId, params.userId)).not.toBeNull();
        eligible = provider;
        expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        expect((await provider.getJob(parent.id, params.userId))!.execution).toHaveProperty('delegationWait');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(parent.id, params.userId))!)).toBe('superseded');
        vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
        expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        expect((await provider.getJob(parent.id, params.userId))!.execution).not.toHaveProperty('delegationWait');
        const row = getRawDb().prepare('SELECT data_json, deleted FROM s_messages WHERE workspace_id = ? AND id = ?')
            .get(execution.workspaceId, params.messageId) as { data_json: string; deleted: number };
        if (state === 'deleted') expect(row.deleted).toBe(1);
        else expect(JSON.parse(row.data_json)).toMatchObject({ data: { generation_id: 'newer-generation', content: 'Newer answer' } });
        expect((await provider.getJob(admitted.jobId, params.userId))?.historyPhase).toBe('committed');
        await provider.cleanupExpired();
        await provider.cleanupExpired();
        expect(await provider.getJob(admitted.jobId, params.userId)).toBeNull();
        const childHistory = await adapter.readChatHistory({ userId: params.userId, workspaceId: execution.workspaceId },
            { kind: 'messages', message_ids: [ids.assistantMessageId] });
        expect(childHistory.messages?.[0]?.data).toMatchObject({ content: 'Saved research', generation_id: ids.generationId });
    });

    it('retains a superseded child when its finalization receipt is missing', async () => {
        const adapter = await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content: 'Saved research', reasoning: '', completedAt: Date.now() });
        const deleted = await adapter.push({} as never, { scope: { workspaceId: execution.workspaceId }, ops: [{
            id: 'delete-child', tableName: 'messages', operation: 'delete', pk: ids.assistantMessageId,
            stamp: { deviceId: 'other-device', opId: 'delete-child', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 3 },
            createdAt: 1, attempts: 0, status: 'pending',
        }] });
        expect(deleted.results[0]).toMatchObject({ success: true });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('superseded');
        expect(getRawDb().prepare("DELETE FROM background_generation_receipts WHERE workspace_id = ? AND generation_id = ? AND stage = 'finalization'")
            .run(execution.workspaceId, ids.generationId).changes).toBe(1);
        expect(await provider.abortJob(input.parentJobId, params.userId)).toBe(true);
        const parent = (await provider.claimNextDelegationWait('cleanup', Date.now(), Date.now() + 60_000))!;
        expect(await provider.cleanupDelegationWait({ parentJobId: parent.id, leaseOwner: 'cleanup',
            expectedRevision: (parent.execution as BackgroundJobExecution).delegationWait!.revision })).toBe('pending');
        const after = (await provider.getJob(parent.id, params.userId))!;
        expect((after.execution as BackgroundJobExecution).delegationTerminalProjection).toBeUndefined();
        expect(await reconcileBackgroundJobHistory(provider, after)).toBe('unchanged');
        vi.mocked(Date.now).mockReturnValue(Date.now() + 3_600_001);
        await reopen();
        await provider.cleanupExpired();
        expect(await provider.getJob(admitted.jobId, params.userId)).not.toBeNull();
    });

    it.each(['unchanged', 'restored', 'forged receipt'] as const)('settles deleted-thread evidence after %s', async change => {
        const adapter = await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content: 'Saved research', reasoning: '', completedAt: Date.now() });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('committed');
        const deleted = await adapter.push({} as never, { scope: { workspaceId: execution.workspaceId }, ops: [{
            id: 'delete-thread', tableName: 'threads', operation: 'delete', pk: params.threadId,
            stamp: { deviceId: 'other-device', opId: 'delete-thread', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 3 },
            createdAt: 1, attempts: 0, status: 'pending',
        }] });
        expect(deleted.results[0]).toMatchObject({ success: true });
        const before = getRawDb().prepare('SELECT data_json, deleted FROM s_messages WHERE workspace_id = ? AND id = ?')
            .get(execution.workspaceId, params.messageId);
        await reopen();
        vi.mocked(Date.now).mockReturnValue(Date.now() + 60_001);
        const { reconcileDueDelegationWaits } = await import('~~/server/utils/background-jobs/delegation-coordinator');
        const eligible = provider;
        expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        const parent = (await provider.getJob(input.parentJobId, params.userId))!;
        expect(parent.status).toBe('aborted');
        expect(await reconcileBackgroundJobHistory(provider, parent)).toBe('superseded');
        expect(getRawDb().prepare('SELECT data_json, deleted FROM s_messages WHERE workspace_id = ? AND id = ?')
            .get(execution.workspaceId, params.messageId)).toEqual(before);
        if (change === 'restored') {
            const restored = await adapter.push({} as never, { scope: { workspaceId: execution.workspaceId }, ops: [{
                id: 'restore-after-receipt', tableName: 'threads', operation: 'put', pk: params.threadId,
                payload: { id: params.threadId },
                stamp: { deviceId: 'other-device', opId: 'restore-after-receipt', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 4 },
                createdAt: 1, attempts: 0, status: 'pending',
            }] });
            expect(restored.results[0]).toMatchObject({ success: true });
        } else if (change === 'forged receipt') {
            getRawDb().prepare("UPDATE background_generation_receipts SET fingerprint = 'mismatch' WHERE workspace_id = ? AND generation_id = ? AND stage = 'finalization'")
                .run(execution.workspaceId, params.generationId);
        }
        vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
        expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        if (change === 'forged receipt') {
            expect((await provider.getJob(parent.id, params.userId))!.execution).toHaveProperty('delegationWait');
            expect(await provider.getShutdownBlockerCount()).toBe(1);
        } else {
            expect((await provider.getJob(parent.id, params.userId))!.execution).not.toHaveProperty('delegationWait');
            expect(await provider.getShutdownBlockerCount()).toBe(0);
        }
        expect(getRawDb().prepare('SELECT data_json, deleted FROM s_messages WHERE workspace_id = ? AND id = ?')
            .get(execution.workspaceId, params.messageId)).toEqual(before);
        expect((await provider.getJob(admitted.jobId, params.userId))?.historyPhase).toBe('committed');
    });

    it('retries if the deleted parent thread is restored during finalization', async () => {
        const adapter = await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content: 'Saved research', reasoning: '', completedAt: Date.now() });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('committed');
        const deleted = await adapter.push({} as never, { scope: { workspaceId: execution.workspaceId }, ops: [{
            id: 'delete-thread', tableName: 'threads', operation: 'delete', pk: params.threadId,
            stamp: { deviceId: 'other-device', opId: 'delete-thread', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 3 },
            createdAt: 1, attempts: 0, status: 'pending',
        }] });
        expect(deleted.results[0]).toMatchObject({ success: true });
        vi.mocked(Date.now).mockReturnValue(Date.now() + 60_001);
        const { reconcileDueDelegationWaits } = await import('~~/server/utils/background-jobs/delegation-coordinator');
        const eligible = provider;
        expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        const parent = (await provider.getJob(input.parentJobId, params.userId))!;
        const before = getRawDb().prepare('SELECT data_json, clock, deleted FROM s_messages WHERE workspace_id = ? AND id = ?')
            .get(execution.workspaceId, params.messageId);
        const finalize = adapter.finalizeChatGeneration.bind(adapter);
        vi.spyOn(adapter, 'finalizeChatGeneration').mockImplementationOnce(async (actor, request) => {
            const restored = await adapter.push({} as never, { scope: { workspaceId: execution.workspaceId }, ops: [{
                id: 'restore-thread', tableName: 'threads', operation: 'put', pk: params.threadId,
                payload: { id: params.threadId },
                stamp: { deviceId: 'other-device', opId: 'restore-thread', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 4 },
                createdAt: 1, attempts: 0, status: 'pending',
            }] });
            expect(restored.results[0]).toMatchObject({ success: true });
            return finalize(actor, request);
        });
        await expect(reconcileBackgroundJobHistory(provider, parent)).rejects.toMatchObject({ historyFailure: 'retry' });
        expect(getRawDb().prepare('SELECT data_json, clock, deleted FROM s_messages WHERE workspace_id = ? AND id = ?')
            .get(execution.workspaceId, params.messageId)).toEqual(before);
        expect(getRawDb().prepare("SELECT 1 FROM background_generation_receipts WHERE generation_id = ? AND stage = 'finalization'")
            .get(params.generationId)).toBeUndefined();
        vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
        expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(parent.id, params.userId))!)).toBe('committed');
        vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
        expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        expect((await provider.getJob(parent.id, params.userId))!.execution).not.toHaveProperty('delegationWait');
    });

    it('refuses a deleted-thread finalization if the thread is live', async () => {
        const adapter = await prepareCanonicalWorkspace();
        const before = getRawDb().prepare('SELECT data_json, clock, deleted FROM s_messages WHERE workspace_id = ? AND id = ?')
            .get(execution.workspaceId, params.messageId);
        await expect(adapter.finalizeChatGeneration({ userId: params.userId, workspaceId: execution.workspaceId }, {
            admission: parentHistory, snapshot: { status: 'aborted', content: '', reasoning: '', completedAt: Date.now(),
                onlyIfThreadUnavailable: true },
        })).rejects.toMatchObject({ code: 'ERR_DELEGATION_HISTORY_REVISION' });
        expect(getRawDb().prepare('SELECT data_json, clock, deleted FROM s_messages WHERE workspace_id = ? AND id = ?')
            .get(execution.workspaceId, params.messageId)).toEqual(before);
        expect(getRawDb().prepare("SELECT 1 FROM background_generation_receipts WHERE generation_id = ? AND stage = 'finalization'")
            .get(params.generationId)).toBeUndefined();
    });

    it.each(['explicit', 'legacy', 'released'] as const)(
        'honors %s project ownership while children are admitted', async ownership => {
        const adapter = await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        const ops = [{ id: 'new-project', tableName: 'projects', operation: 'put', pk: 'new-project',
            payload: { id: 'new-project', name: 'Project', data: ownership !== 'explicit' ? [params.threadId] : [] },
            stamp: { deviceId: 'other-device', opId: 'new-project', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 2 },
            createdAt: Math.floor(Date.now() / 1000), attempts: 0, status: 'pending' }];
        if (ownership !== 'legacy') ops.push({ id: 'move-parent', tableName: 'threads', operation: 'put', pk: params.threadId,
            payload: { id: params.threadId, project_id: ownership === 'explicit' ? 'new-project' : 'missing-project' } as never,
            stamp: { deviceId: 'other-device', opId: 'move-parent', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 3 },
            createdAt: Math.floor(Date.now() / 1000), attempts: 0, status: 'pending' });
        const pushed = await adapter.push({} as never, { scope: { workspaceId: execution.workspaceId }, ops: ops as never });
        expect(pushed.results).toEqual(ops.map(() => expect.objectContaining({ success: true })));
        const thread = await adapter.readChatHistory({ userId: params.userId, workspaceId: execution.workspaceId },
            { kind: 'thread', thread_id: params.threadId });
        expect(thread.thread?.project_id).toBe(ownership === 'released' ? null : 'new-project');
        await reopen();
        vi.mocked(Date.now).mockReturnValue(Date.now() + 60_001);
        const { reconcileDueDelegationWaits } = await import('~~/server/utils/background-jobs/delegation-coordinator');
        const eligible = provider;
        expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        const expectedStatus = ownership === 'released' ? 'streaming' : 'aborted';
        expect((await provider.getJob(input.parentJobId, params.userId))?.status).toBe(expectedStatus);
        expect((await provider.getJob(admitted.jobId, params.userId))?.status).toBe(expectedStatus);
    });

    it('stops admitted children when an authorization constraint denies execution', async () => {
        await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        const { initializeAuthHookEngine, _resetAuthHookEngineForTesting } = await import('~~/server/auth/hooks');
        const { createHookEngine } = await import('~~/server/hooks/hook-engine');
        _resetAuthHookEngineForTesting();
        const auth = initializeAuthHookEngine(createHookEngine());
        auth.addAuthorizationConstraint({ id: 'deny-delegation', evaluate: ({ decision }) =>
            decision.permission === 'workspace.write' ? { allowed: false, reason: 'restricted' } : { allowed: true } });
        try {
            await reopen();
            vi.mocked(Date.now).mockReturnValue(Date.now() + 60_001);
            const { reconcileDueDelegationWaits } = await import('~~/server/utils/background-jobs/delegation-coordinator');
            const eligible = provider;
            expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
            expect((await provider.getJob(input.parentJobId, params.userId))?.status).toBe('aborted');
            expect((await provider.getJob(admitted.jobId, params.userId))?.status).toBe('aborted');
            expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('unchanged');
            expect(getRawDb().prepare("SELECT 1 FROM background_generation_receipts WHERE generation_id = ? AND stage = 'admission'")
                .get(ids.generationId)).toBeUndefined();
        } finally { _resetAuthHookEngineForTesting(); }
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('committed');
    });

    it.each(['authorization constraint', 'membership downgrade'] as const)(
        'retains terminal child activity through %s until access is restored', async denial => {
        const adapter = await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content: 'Saved research', reasoning: '', completedAt: Date.now() });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('committed');
        const { initializeAuthHookEngine, _resetAuthHookEngineForTesting } = await import('~~/server/auth/hooks');
        const { createHookEngine } = await import('~~/server/hooks/hook-engine');
        _resetAuthHookEngineForTesting();
        if (denial === 'authorization constraint') initializeAuthHookEngine(createHookEngine()).addAuthorizationConstraint({ id: 'deny-delivery', evaluate: ({ decision }) =>
            decision.permission === 'workspace.write' ? { allowed: false, reason: 'restricted' } : { allowed: true } });
        else getRawDb().prepare("UPDATE workspace_members SET role = 'viewer' WHERE workspace_id = ? AND user_id = ?")
            .run(execution.workspaceId, params.userId);
        try {
            await reopen();
            vi.mocked(Date.now).mockReturnValue(Date.now() + 60_001);
            const { reconcileDueDelegationWaits } = await import('~~/server/utils/background-jobs/delegation-coordinator');
            const eligible = provider;
            expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
            const parent = (await provider.getJob(input.parentJobId, params.userId))!;
            expect(parent.status).toBe('aborted');
            expect(await reconcileBackgroundJobHistory(provider, parent)).toBe('unchanged');
            expect(getRawDb().prepare("SELECT 1 FROM background_generation_receipts WHERE generation_id = ? AND stage = 'finalization'")
                .get(parentHistory.generationId)).toBeUndefined();
            vi.mocked(Date.now).mockReturnValue(Date.now() + 3_600_001);
            await provider.cleanupExpired();
            await reopen();
            expect(await provider.getJob(admitted.jobId, params.userId)).not.toBeNull();
            expect((await provider.getJob(parent.id, params.userId))!.execution).toHaveProperty('delegationWait');
            _resetAuthHookEngineForTesting();
            if (denial === 'membership downgrade') getRawDb().prepare("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?")
                .run(execution.workspaceId, params.userId);
            vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
            expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
            expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(parent.id, params.userId))!)).toBe('committed');
            const history = await adapter.readChatHistory({ userId: params.userId, workspaceId: execution.workspaceId },
                { kind: 'messages', message_ids: [params.messageId] });
            expect(history.messages?.[0]?.data).toMatchObject({ tool_calls: expect.arrayContaining([
                expect.objectContaining({ id: 'call', delegation: { version: 1, callId: 'call', children: [
                    { index: 0, threadId: ids.threadId, modelName: 'test-model', outcome: 'complete' },
                ] } }),
            ]) });
            vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
            expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
            expect((await provider.getJob(parent.id, params.userId))!.execution).not.toHaveProperty('delegationWait');
        } finally { _resetAuthHookEngineForTesting(); }
    });

    it.each(['membership removed', 'workspace deleted'] as const)(
        'stops dispatched work and retains evidence after permanent %s', async loss => {
        const now = Date.now();
        await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory, true);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        expect(await provider.claimJob(admitted.jobId, 'child-worker', now, now + 60_000)).toBeTruthy();
        expect(await provider.beginDelegationDispatch(admitted.jobId, 'child-worker')).toMatchObject({ state: 'started' });
        if (loss === 'membership removed') getRawDb().prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
            .run(execution.workspaceId, params.userId);
        else getRawDb().prepare('UPDATE workspaces SET deleted = 1 WHERE id = ?').run(execution.workspaceId);
        await reopen();
        vi.mocked(Date.now).mockReturnValue(now + 60_001);
        const { reconcileDueDelegationWaits } = await import('~~/server/utils/background-jobs/delegation-coordinator');
        const eligible = provider;
        expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        expect(await provider.getJob(input.parentJobId, params.userId)).toMatchObject({ status: 'aborted' });
        expect(await provider.getJob(admitted.jobId, params.userId)).toMatchObject({ status: 'aborted', execution: { delegationDispatch: { state: 'started' } } });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('unchanged');
        vi.mocked(Date.now).mockReturnValue(now + 180 * 24 * 60 * 60_000);
        await provider.cleanupExpired();
        await reopen();
        expect((await provider.getJob(input.parentJobId, params.userId))!.execution).toHaveProperty('delegationWait');
        expect(await provider.getJob(admitted.jobId, params.userId)).toMatchObject({ status: 'aborted', execution: { delegationDispatch: { state: 'started' } } });
        expect(await provider.getShutdownBlockerCount()).toBeGreaterThan(0);
        expect(getRawDb().prepare("SELECT 1 FROM background_generation_receipts WHERE generation_id IN (?, ?) AND stage = 'finalization'")
            .get(params.generationId, ids.generationId)).toBeUndefined();
        const unrelated = await provider.createJob({ ...params, userId: 'another-user', execution: { ...execution, workspaceId: 'another-workspace' } });
        expect(await provider.claimJob(unrelated, 'other-worker', Date.now(), Date.now() + 60_000)).toMatchObject({ id: unrelated });
    });

    it('does not finalize a child after its project ownership changes', async () => {
        const adapter = await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content: 'Saved research', reasoning: '', completedAt: Date.now() });
        const finalize = adapter.finalizeChatGeneration.bind(adapter);
        vi.spyOn(adapter, 'finalizeChatGeneration').mockImplementationOnce(async (actor, request) => {
            const pushed = await adapter.push({} as never, { scope: { workspaceId: execution.workspaceId }, ops: [
                { id: 'new-project', tableName: 'projects', operation: 'put', pk: 'new-project', payload: { id: 'new-project', name: 'Project', data: [] },
                    stamp: { deviceId: 'other-device', opId: 'new-project', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 2 }, createdAt: 1, attempts: 0, status: 'pending' },
                { id: 'move-child', tableName: 'threads', operation: 'put', pk: ids.threadId, payload: { id: ids.threadId, project_id: 'new-project' },
                    stamp: { deviceId: 'other-device', opId: 'move-child', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 3 }, createdAt: 1, attempts: 0, status: 'pending' },
            ] });
            expect(pushed.results).toEqual([expect.objectContaining({ success: true }), expect.objectContaining({ success: true })]);
            return finalize(actor, request);
        });
        await expect(reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!))
            .rejects.toMatchObject({ historyFailure: 'retry' });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('unchanged');
        expect(getRawDb().prepare("SELECT 1 FROM background_generation_receipts WHERE generation_id = ? AND stage = 'finalization'")
            .get(ids.generationId)).toBeUndefined();
    });

    it('replays child finalization after a lost acknowledgement and a later edit', async () => {
        const adapter = await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content: 'Saved research', reasoning: '', completedAt: Date.now() });
        const interrupted = Object.create(provider) as SqliteBackgroundJobProvider;
        interrupted.setHistoryPhase = async (id, phase, options) => {
            if (phase === 'committed') throw new Error('Lost job-store acknowledgement');
            return provider.setHistoryPhase(id, phase, options);
        };
        await expect(reconcileBackgroundJobHistory(interrupted, (await provider.getJob(admitted.jobId, params.userId))!))
            .rejects.toThrow('Lost job-store acknowledgement');
        const pushed = await adapter.push({} as never, { scope: { workspaceId: execution.workspaceId }, ops: [{
            id: 'later-edit', tableName: 'threads', operation: 'put', pk: 'other-thread', payload: { id: 'other-thread' },
            stamp: { deviceId: 'other-device', opId: 'later-edit', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 2 },
            createdAt: 1, attempts: 0, status: 'pending',
        }] });
        expect(pushed.results[0]).toMatchObject({ success: true });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('committed');
        expect((await provider.getJob(admitted.jobId, params.userId))?.historyPhase).toBe('committed');
    });

    it.each(['denied', 'store error'] as const)(
        'yields a %s history row to unrelated pending work and retries it after reopen', async reason => {
        await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        vi.mocked(Date.now).mockReturnValue(Date.now() + 1);
        const otherHistory: ChatGenerationAdmissionEnvelope = { ...parentHistory, admissionId: 'other-admission', generationId: 'other-generation',
            threadId: 'other-thread', messageId: 'other-message', thread: { id: 'other-thread', clock: 1 },
            userMessage: { id: 'other-user', clock: 1, role: 'user', thread_id: 'other-thread' },
            assistantMessage: { id: 'other-message', clock: 1, role: 'assistant', thread_id: 'other-thread', pending: true,
                data: { generation_id: 'other-generation' } } };
        const unrelated = await provider.createJob({ ...params, threadId: 'other-thread', messageId: 'other-message',
            generationId: 'other-generation', historyPhase: 'admission_pending', syncProviderId: 'sqlite',
            execution: { ...execution, delegationRecoveryPolicy: undefined, history: otherHistory } });
        const { initializeAuthHookEngine, _resetAuthHookEngineForTesting } = await import('~~/server/auth/hooks');
        const { createHookEngine } = await import('~~/server/hooks/hook-engine');
        _resetAuthHookEngineForTesting();
        if (reason === 'denied') initializeAuthHookEngine(createHookEngine()).addAuthorizationConstraint({ id: 'deny-history', evaluate: ({ decision }) =>
            decision.permission === 'workspace.write' ? { allowed: false, reason: 'restricted' } : { allowed: true } });
        else registerAuthWorkspaceStore({ id: 'sqlite', create: () => ({ listUserWorkspaces: async () => { throw new Error('Store unavailable'); } }) as never });
        try {
            expect((await provider.getPendingHistoryJobs(1))[0]?.id).toBe(admitted.jobId);
            if (reason === 'denied') expect(await reconcilePendingBackgroundHistory(provider, 1)).toBe(0);
            else await expect(reconcilePendingBackgroundHistory(provider, 2)).rejects.toThrow('Store unavailable');
            await reopen();
            if (reason === 'denied') expect((await provider.getPendingHistoryJobs(1))[0]?.id).toBe(unrelated);
            else expect((await provider.getJob(unrelated, params.userId))?.historyPhase).toBe('ready');
            vi.mocked(Date.now).mockReturnValue(Date.now() + 30_001);
            expect((await provider.getPendingHistoryJobs(1))[0]?.id).toBe(admitted.jobId);
            expect(await provider.setHistoryPhase(admitted.jobId, 'ready', { from: ['admission_pending'] })).toBe(true);
            expect(await provider.setHistoryPhase(admitted.jobId, 'finalization_pending', { from: ['ready'] })).toBe(true);
            expect(await provider.deferDelegationHistory({ jobId: admitted.jobId, userId: params.userId,
                generationId: ids.generationId, phase: 'admission_pending' })).toBe(false);
            expect((await provider.getPendingHistoryJobs(1))[0]?.id).toBe(admitted.jobId);
        } finally {
            _resetAuthHookEngineForTesting();
            registerAuthWorkspaceStore({ id: 'sqlite', create: () => new SqliteAuthWorkspaceStore() });
        }
    });

    it('keeps work pending when the authorization store is unavailable', async () => {
        await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        registerAuthWorkspaceStore({ id: 'sqlite', create: () => ({ listUserWorkspaces: async () => { throw new Error('Store unavailable'); } }) as never });
        try {
            await reopen();
            vi.mocked(Date.now).mockReturnValue(Date.now() + 60_001);
            const { reconcileDueDelegationWaits } = await import('~~/server/utils/background-jobs/delegation-coordinator');
            const eligible = provider;
            expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
            const parent = await provider.getJob(input.parentJobId, params.userId);
            expect(parent?.status).toBe('streaming');
            expect((parent?.execution as BackgroundJobExecution).delegationWait?.nextCheckAt).toBeGreaterThan(Date.now());
            expect((await provider.getJob(admitted.jobId, params.userId))?.status).toBe('streaming');
        } finally { registerAuthWorkspaceStore({ id: 'sqlite', create: () => new SqliteAuthWorkspaceStore() }); }
    });

    it.each(['provider unavailable', 'store error', 'healthy access'] as const)(
        'stops dispatched children at the fixed deadline with %s', async mode => {
        const now = Date.now();
        await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(1_000, true, true, parentHistory, true);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        expect(await provider.claimJob(admitted.jobId, 'child-worker', now, now + 60_000)).toBeTruthy();
        expect(await provider.beginDelegationDispatch(admitted.jobId, 'child-worker')).toMatchObject({ state: 'started' });
        const wait = ((await provider.getJob(input.parentJobId, params.userId))!.execution as BackgroundJobExecution).delegationWait!;
        expect(await provider.commitDelegationWait({ parentJobId: input.parentJobId, leaseOwner: input.leaseOwner,
            expectedRevision: wait.revision, wait: { ...wait, revision: wait.revision + 1 } })).toBe(true);
        if (mode === 'provider unavailable') vi.stubGlobal('useRuntimeConfig', () => ({ public: { sync: { provider: 'unavailable' } } }));
        if (mode === 'store error') registerAuthWorkspaceStore({ id: 'sqlite', create: () => ({ listUserWorkspaces: async () => {
            throw new Error('Private store failure');
        } }) as never });
        try {
            await reopen();
            const { reconcileDueDelegationWaits } = await import('~~/server/utils/background-jobs/delegation-coordinator');
            const eligible = provider;
            vi.mocked(Date.now).mockReturnValue(now + 500);
            expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
            const deferred = (await provider.getJob(input.parentJobId, params.userId))!;
            expect(deferred.leaseOwner).toBeUndefined();
            expect((deferred.execution as BackgroundJobExecution).delegationWait?.nextCheckAt).toBe(now + 1_000);
            expect((await provider.getJob(admitted.jobId, params.userId))?.status).toBe('streaming');
            await reopen();
            vi.mocked(Date.now).mockReturnValue(now + 1_000);
            expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
            const child = await provider.getJob(admitted.jobId, params.userId);
            expect(child).toMatchObject({ status: 'aborted', execution: { delegationDispatch: { state: 'started' } } });
            const parent = (await provider.getJob(input.parentJobId, params.userId))!;
            expect((parent.execution as BackgroundJobExecution).delegationWait?.expiredAt).toBe(now + 1_000);
            expect(await provider.claimJob(admitted.jobId, 'late-worker', Date.now(), Date.now() + 60_000)).toBeNull();
        } finally { registerAuthWorkspaceStore({ id: 'sqlite', create: () => new SqliteAuthWorkspaceStore() }); }
    });

    it('defers cleanup when parent history cannot be interpreted', async () => {
        await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        getRawDb().prepare('UPDATE s_messages SET data_json = ? WHERE workspace_id = ? AND id = ?')
            .run('{}', execution.workspaceId, params.messageId);
        await reopen();
        vi.mocked(Date.now).mockReturnValue(Date.now() + 60_001);
        const { reconcileDueDelegationWaits } = await import('~~/server/utils/background-jobs/delegation-coordinator');
        const eligible = provider;
        expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        expect((await provider.getJob(input.parentJobId, params.userId))?.status).toBe('streaming');
        expect((await provider.getJob(admitted.jobId, params.userId))?.status).toBe('streaming');
    });

    it.each([
        'unrelated edit', 'deleted child', 'deleted unknown error', 'deleted failure', 'deleted before dispatch',
    ] as const)(
        'propagates stopped-parent cleanup across reopen and fences %s', async scenario => {
        const deleted = scenario !== 'unrelated edit';
        const errorCode = scenario === 'deleted unknown error' ? 'ERR_MODEL_OUTCOME_UNKNOWN'
            : scenario === 'deleted failure' ? 'ERR_STREAM_FAILURE' : undefined;
        const uncertain = scenario === 'deleted child' || scenario === 'deleted unknown error';
        const adapter = await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        await provider.claimJob(admitted.jobId, 'child-worker', Date.now(), Date.now() + 60_000);
        if (scenario !== 'deleted before dispatch') expect(await provider.beginDelegationDispatch(admitted.jobId, 'child-worker')).toBeTruthy();
        if (errorCode) {
            const error = serializeError(Object.assign(new Error('Child error'), { code: errorCode, retryable: false }));
            expect(await provider.saveTerminalSnapshot(admitted.jobId, { status: 'error', error, content: '', reasoning: '', completedAt: Date.now() }, 'child-worker')).toBe(true);
        }
        const active = await provider.getJob(input.parentJobId, params.userId);
        const activeWait = (active!.execution as BackgroundJobExecution).delegationWait!;
        expect(await provider.cleanupDelegationWait({ parentJobId: input.parentJobId, leaseOwner: input.leaseOwner, expectedRevision: activeWait.revision })).toBe('not-owned');
        expect((await provider.getJob(admitted.jobId, params.userId))!.status).toBe(errorCode ? 'error' : 'streaming');
        expect(await provider.abortJob(input.parentJobId, params.userId)).toBe(true);
        if (scenario === 'unrelated edit') {
            getRawDb().prepare("UPDATE background_jobs SET history_phase = 'admission_pending' WHERE id = ?").run(input.parentJobId);
            expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(input.parentJobId, params.userId))!)).toBe('ready');
            expect((await provider.getJob(input.parentJobId, params.userId))?.historyPhase).toBe('finalization_pending');
            expect(getRawDb().prepare("SELECT 1 FROM background_generation_receipts WHERE generation_id = ? AND stage = 'finalization'")
                .get(parentHistory.generationId)).toBeUndefined();
        }
        await reopen();
        const stopped = await provider.getJob(input.parentJobId, params.userId);
        const wait = (stopped!.execution as BackgroundJobExecution).delegationWait!;
        expect(await provider.cleanupDelegationWait({ parentJobId: input.parentJobId, leaseOwner: 'stale', expectedRevision: wait.revision })).toBe('not-owned');
        const { reconcileDueDelegationWaits } = await import('~~/server/utils/background-jobs/delegation-coordinator');
        const { getShutdownRuntime } = await import('~~/server/utils/shutdown/runtime');
        vi.spyOn(getShutdownRuntime().controller, 'phase').mockReturnValue('preparing');
        vi.spyOn(getShutdownRuntime().controller, 'canStartWork').mockReturnValue(false);
        const eligible = provider;
        expect(await reconcileDueDelegationWaits(eligible, 1)).toBe(1);
        const child = await provider.getJob(admitted.jobId, params.userId);
        expect(child).toMatchObject({ status: errorCode ? 'error' : 'aborted', historyPhase: 'finalization_pending' });
        if (scenario !== 'deleted before dispatch') expect(child?.execution).toHaveProperty('delegationDispatch.version', 1);
        expect((await provider.getPendingHistoryJobs(1))[0]?.id).toBe(admitted.jobId);
        expect(await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content: 'late', reasoning: '', completedAt: Date.now() }, 'child-worker')).toBe(false);
        expect((await provider.getJob(input.parentJobId, params.userId))!.execution).toHaveProperty('delegationWait');
        await reopen();
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('committed');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(input.parentJobId, params.userId))!)).toBe('unchanged');
        vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
        const retried = await provider.claimNextDelegationWait('cleanup-again', Date.now(), Date.now() + 60_000);
        const nextWait = (retried!.execution as BackgroundJobExecution).delegationWait!;
        expect(await provider.cleanupDelegationWait({ parentJobId: input.parentJobId, leaseOwner: 'cleanup-again', expectedRevision: nextWait.revision })).toBe('pending');
        expect((await provider.getJob(input.parentJobId, params.userId))!.execution).toHaveProperty('delegationWait');
        expect(await provider.getJob(admitted.jobId, params.userId)).toMatchObject({ status: errorCode ? 'error' : 'aborted', historyPhase: 'committed' });
        expect(await provider.getShutdownBlockerCount()).toBe(1);
        const pushed = await adapter.push({} as never, { scope: { workspaceId: execution.workspaceId }, ops: [{
            id: 'terminal-race', tableName: deleted ? 'messages' : 'threads',
            operation: deleted ? 'delete' : 'put',
            pk: deleted ? ids.assistantMessageId : 'another-thread',
            payload: deleted ? { deleted_at: 1 } : { id: 'another-thread', title: 'Concurrent edit' },
            stamp: { deviceId: 'race-device', opId: 'terminal-race', hlc: '2026-10-31T00:00:00.000Z-0000', clock: 3 },
            createdAt: Math.floor(Date.now() / 1000), attempts: 0, status: 'pending',
        }] });
        expect(pushed.results[0]).toMatchObject({ success: true });
        await expect(reconcileBackgroundJobHistory(provider, (await provider.getJob(input.parentJobId, params.userId))!))
            .rejects.toMatchObject({ historyFailure: 'retry' });
        expect((await provider.getJob(input.parentJobId, params.userId))!.execution).toHaveProperty('delegationWait');
        vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
        const refresh = (await provider.claimNextDelegationWait('refresh-projection', Date.now(), Date.now() + 60_000))!;
        expect(await provider.cleanupDelegationWait({ parentJobId: input.parentJobId, leaseOwner: 'refresh-projection',
            expectedRevision: (refresh.execution as BackgroundJobExecution).delegationWait!.revision })).toBe('pending');
        const staged = (await provider.getJob(input.parentJobId, params.userId))!;
        const interrupted = Object.create(provider) as SqliteBackgroundJobProvider;
        interrupted.setHistoryPhase = async (id, phase, options) => {
            if (phase === 'committed') throw new Error('Lost job-store acknowledgement');
            return provider.setHistoryPhase(id, phase, options);
        };
        await expect(reconcileBackgroundJobHistory(interrupted, staged)).rejects.toThrow('Lost job-store acknowledgement');
        vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
        const afterReceipt = (await provider.claimNextDelegationWait('receipt-retry', Date.now(), Date.now() + 60_000))!;
        expect(await provider.cleanupDelegationWait({ parentJobId: input.parentJobId, leaseOwner: 'receipt-retry',
            expectedRevision: (afterReceipt.execution as BackgroundJobExecution).delegationWait!.revision })).toBe('pending');
        expect((await provider.getJob(input.parentJobId, params.userId))?.tool_calls).toEqual(staged.tool_calls);
        expect(((await provider.getJob(input.parentJobId, params.userId))?.execution as BackgroundJobExecution).delegationTerminalProjection)
            .toEqual((staged.execution as BackgroundJobExecution).delegationTerminalProjection);
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(input.parentJobId, params.userId))!)).toBe('committed');
        const history = await adapter.readChatHistory({ userId: params.userId, workspaceId: execution.workspaceId },
            { kind: 'messages', message_ids: [params.messageId] });
        const storedCalls = (history.messages?.[0]?.data as { tool_calls: Array<{ id: string; delegation?: { children: Array<{ executionUncertain?: boolean }> } }> }).tool_calls;
        expect(storedCalls.find(call => call.id === 'call')?.delegation?.children[0]?.executionUncertain).toBe(uncertain ? true : undefined);
        expect(history.messages?.[0]?.data).toMatchObject({ tool_calls: expect.arrayContaining([
            expect.objectContaining({ id: 'call', delegation: { version: 1, callId: 'call', children: [
                { index: 0, threadId: ids.threadId, modelName: 'test-model', outcome: deleted ? 'unavailable' : 'unknown',
                    ...(uncertain ? { executionUncertain: true } : {}) },
            ] } }),
        ]) });
        expect(await provider.getShutdownBlockerCount()).toBe(1);
        vi.mocked(Date.now).mockReturnValue(Date.now() + 5_001);
        const release = (await provider.claimNextDelegationWait('release-evidence', Date.now(), Date.now() + 60_000))!;
        expect(await provider.cleanupDelegationWait({ parentJobId: input.parentJobId, leaseOwner: 'release-evidence',
            expectedRevision: (release.execution as BackgroundJobExecution).delegationWait!.revision })).toBe('settled');
        expect((await provider.getJob(input.parentJobId, params.userId))!.execution).not.toHaveProperty('delegationWait');
        expect(await provider.getShutdownBlockerCount()).toBe(0);
    });

    it('preserves a completed child when its parent stops before settlement', async () => {
        const adapter = await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content: 'Saved research', reasoning: '', completedAt: Date.now() });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('committed');
        expect(await provider.abortJob(input.parentJobId, params.userId)).toBe(true);
        const parent = (await provider.claimNextDelegationWait('cleanup', Date.now(), Date.now() + 60_000))!;
        expect(await provider.cleanupDelegationWait({ parentJobId: parent.id, leaseOwner: 'cleanup',
            expectedRevision: (parent.execution as BackgroundJobExecution).delegationWait!.revision })).toBe('pending');
        expect(await provider.getJob(admitted.jobId, params.userId)).toMatchObject({ status: 'complete', content: 'Saved research' });
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(parent.id, params.userId))!)).toBe('committed');
        const history = await adapter.readChatHistory({ userId: params.userId, workspaceId: execution.workspaceId },
            { kind: 'messages', message_ids: [params.messageId] });
        expect(history.messages?.[0]?.data).toMatchObject({ tool_calls: expect.arrayContaining([
            expect.objectContaining({ id: 'call', delegation: { version: 1, callId: 'call', children: [
                { index: 0, threadId: ids.threadId, modelName: 'test-model', outcome: 'complete' },
            ] } }),
        ]) });
    });

    it.each(['{', '[null]'])(
        'still stops a child if terminal activity is malformed: %s', async corrupt => {
        await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await provider.abortJob(input.parentJobId, params.userId)).toBe(true);
        const parent = (await provider.claimNextDelegationWait('cleanup', Date.now(), Date.now() + 60_000))!;
        const wait = (parent.execution as BackgroundJobExecution).delegationWait!;
        getRawDb().prepare('UPDATE background_jobs SET tool_calls_json = ? WHERE id = ?').run(corrupt, parent.id);
        expect(await provider.cleanupDelegationWait({ parentJobId: parent.id, leaseOwner: 'cleanup', expectedRevision: wait.revision })).toBe('pending');
        expect((await provider.getJob(admitted.jobId, params.userId))?.status).toBe('aborted');
        const saved = getRawDb().prepare('SELECT execution_json FROM background_jobs WHERE id = ?').get(parent.id) as { execution_json: string };
        expect(JSON.parse(saved.execution_json)).toHaveProperty('delegationWait');
    });

    it.each(['tool_calls_json', 'workflow_state_json'] as const)(
        'quarantines malformed %s without starving work or losing stopped-child cleanup', async column => {
        const now = Date.now();
        await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await provider.abortJob(input.parentJobId, params.userId)).toBe(true);
        getRawDb().prepare(`UPDATE background_jobs SET ${column} = ? WHERE id = ?`).run('{private broken data', input.parentJobId);

        const healthy = await provider.createJob({ ...params, execution });
        await provider.claimJob(healthy, 'healthy-worker', now, now + 60_000);
        const healthyWait = { ...execution, delegationWait: {
            version: 1 as const, revision: 0, callId: 'healthy-call', argumentFingerprint: `sha256:v1:${'a'.repeat(64)}`,
            deadlineAt: now + 7_200_000, nextCheckAt: now + 1,
            children: [{ kind: 'rejected' as const, index: 0, settlement: { kind: 'unavailable' as const, code: 'unsupported' } }],
        } };
        expect(await provider.parkDelegationWait(healthy, 'healthy-worker', healthyWait, [])).toBe(true);
        await expect(provider.claimNextDelegationWait('damaged-worker', now + 1, now + 60_000))
            .rejects.toThrow(`Invalid delegation job checkpoint (job ${input.parentJobId})`);
        const saved = getRawDb().prepare(`SELECT execution_json, ${column}, lease_owner FROM background_jobs WHERE id = ?`)
            .get(input.parentJobId) as { execution_json: string; lease_owner: string | null } & Record<typeof column, string>;
        expect(saved[column]).toBe('{private broken data');
        expect(JSON.parse(saved.execution_json)).toMatchObject({ delegationQuarantinedAt: now + 1 });
        expect(saved.lease_owner).toBeNull();
        getRawDb().prepare("UPDATE background_jobs SET history_phase = 'admission_pending' WHERE id = ?").run(input.parentJobId);
        expect((await provider.getPendingHistoryJobs(10)).map(job => job.id)).toContain(admitted.jobId);

        await reopen();
        expect((await provider.claimNextDelegationWait('healthy-coordinator', now + 2, now + 60_000))?.id).toBe(healthy);
        expect((await provider.getJob(admitted.jobId, params.userId))?.status).toBe('aborted');
        expect(await provider.getShutdownBlockerCount()).toBeGreaterThanOrEqual(2);
        const retained = getRawDb().prepare(`SELECT ${column} FROM background_jobs WHERE id = ?`).get(input.parentJobId) as Record<typeof column, string>;
        expect(retained[column]).toBe('{private broken data');
    });

    it('holds a damaged active parent and stops its dispatched child only at the original deadline', async () => {
        const now = Date.now();
        await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(1_000, true, true, parentHistory, true);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        expect(await provider.claimJob(admitted.jobId, 'child-worker', now, now + 60_000)).toBeTruthy();
        expect(await provider.beginDelegationDispatch(admitted.jobId, 'child-worker')).toMatchObject({ state: 'started' });
        const wait = ((await provider.getJob(input.parentJobId, params.userId))!.execution as BackgroundJobExecution).delegationWait!;
        expect(await provider.commitDelegationWait({ parentJobId: input.parentJobId, leaseOwner: input.leaseOwner,
            expectedRevision: wait.revision, wait: { ...wait, revision: wait.revision + 1 } })).toBe(true);
        getRawDb().prepare('UPDATE background_jobs SET tool_calls_json = ? WHERE id = ?').run('{private broken data', input.parentJobId);
        await expect(provider.claimNextDelegationWait('damaged-worker', now, now + 60_000))
            .rejects.toThrow(`Invalid delegation job checkpoint (job ${input.parentJobId})`);
        await reopen();
        vi.mocked(Date.now).mockReturnValue(now + 999);
        expect(await provider.claimNextDelegationWait('before-deadline', Date.now(), Date.now() + 60_000)).toBeNull();
        expect((await provider.getJob(admitted.jobId, params.userId))?.status).toBe('streaming');
        vi.mocked(Date.now).mockReturnValue(now + 1_000);
        expect(await provider.claimNextDelegationWait('at-deadline', Date.now(), Date.now() + 60_000)).toBeNull();
        expect(await provider.getJob(admitted.jobId, params.userId)).toMatchObject({ status: 'aborted', execution: { delegationDispatch: { state: 'started' } } });
        expect(await provider.claimJob(input.parentJobId, 'replay', Date.now(), Date.now() + 60_000)).toBeNull();
        expect(await provider.getShutdownBlockerCount()).toBeGreaterThan(0);
    });

    it('retains the admitted child link when the parent is stopped', async () => {
        const input = await prepareChildAdmission();
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        getRawDb().prepare(`UPDATE background_jobs SET execution_json =
            json_set(execution_json, '$.delegationWait.nextCheckAt', ?) WHERE id = ?`)
            .run(Date.now() + 600_000, input.parentJobId);
        expect(await provider.abortJob(input.parentJobId, params.userId)).toBe(true);
        await reopen();
        expect(await provider.getJob(input.parentJobId, params.userId)).toMatchObject({
            status: 'aborted', execution: { delegationWait: { children: [{ jobId: admitted.jobId }] } },
        });
        expect(await provider.claimNextDelegationWait('cleanup', Date.now(), Date.now() + 60_000))
            .toMatchObject({ id: input.parentJobId, status: 'aborted', execution: { delegationWait: { children: [{ jobId: admitted.jobId }] } } });
        expect(await provider.renewJobLease(input.parentJobId, 'cleanup', Date.now(), Date.now() + 120_000)).toBe(true);
        expect(await provider.admitDelegationChild(input)).toEqual({ status: 'not-owned' });
        expect(await provider.getJob(admitted.jobId, params.userId)).toMatchObject({ status: 'streaming' });
        // Propagating Stop to that child is a separate coordinator responsibility.
    });

    it('retains a stopped parent and its completed child past normal job retention', async () => {
        const now = Date.now();
        const input = await prepareChildAdmission();
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        await provider.setHistoryPhase(admitted.jobId, 'ready');
        await provider.claimJob(admitted.jobId, 'child-worker', now, now + 60_000);
        expect(await provider.saveTerminalSnapshot(admitted.jobId, {
            status: 'complete', content: 'saved research', reasoning: '', completedAt: now,
        }, 'child-worker')).toBe(true);
        await provider.setHistoryPhase(admitted.jobId, 'committed');
        expect(await provider.abortJob(input.parentJobId, params.userId)).toBe(true);
        await provider.setHistoryPhase(input.parentJobId, 'committed');
        const ordinary = await provider.createJob({ ...params, execution });
        await provider.saveTerminalSnapshot(ordinary, { status: 'complete', content: '', reasoning: '', completedAt: now });
        await provider.setHistoryPhase(ordinary, 'committed');
        vi.mocked(Date.now).mockReturnValue(now + 61 * 60_000);
        await provider.cleanupExpired();
        await reopen();
        expect(await provider.getJob(ordinary, params.userId)).toBeNull();
        expect(await provider.getJob(input.parentJobId, params.userId)).toMatchObject({ status: 'aborted' });
        expect(await provider.getJob(admitted.jobId, params.userId)).toMatchObject({ status: 'complete', content: 'saved research' });
        expect(await provider.getShutdownBlockerCount()).toBe(1);
        const claimed = await provider.claimNextDelegationWait('cleanup', Date.now(), Date.now() + 60_000);
        const wait = (claimed!.execution as BackgroundJobExecution).delegationWait!;
        expect(await provider.cleanupDelegationWait({ parentJobId: input.parentJobId, leaseOwner: 'cleanup', expectedRevision: wait.revision })).toBe('pending');
        expect(await provider.getJob(admitted.jobId, params.userId)).toMatchObject({ status: 'complete', content: 'saved research' });
        expect(await provider.getShutdownBlockerCount()).toBe(1);
        await provider.cleanupExpired();
        expect(await provider.getJob(input.parentJobId, params.userId)).not.toBeNull();
        expect(await provider.getJob(admitted.jobId, params.userId)).not.toBeNull();
    });

    it('only records a child completion after its exact history is committed, and fences stale updates', async () => {
        const now = Date.now();
        const input = await prepareChildAdmission();
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        await provider.setHistoryPhase(admitted.jobId, 'ready');
        await provider.claimJob(admitted.jobId, 'child-worker', now, now + 60_000);
        expect(await provider.saveTerminalSnapshot(admitted.jobId, {
            status: 'complete', content: 'saved research', reasoning: '', completedAt: now,
        }, 'child-worker')).toBe(true);
        const parent = await provider.getJob(input.parentJobId, params.userId);
        const wait = (parent?.execution as BackgroundJobExecution).delegationWait!;
        const prepared = wait.children[0]!;
        if (prepared.kind !== 'prepared') throw new Error('Expected prepared child');
        const nextWait = { ...wait, revision: wait.revision + 1, nextCheckAt: now + 1,
            children: [{ ...prepared, settlement: { kind: 'complete' as const, assistantMessageId: prepared.assistantMessageId, result: { kind: 'inline' as const, value: 'saved research' } } }] };
        const commit = { parentJobId: input.parentJobId, leaseOwner: 'coordinator', expectedRevision: wait.revision, wait: nextWait };
        await expect(provider.commitDelegationWait(commit)).rejects.toThrow('outcome is not confirmed');
        expect((await provider.getJob(input.parentJobId, params.userId))?.execution).toMatchObject({ delegationWait: { revision: wait.revision } });
        await provider.setHistoryPhase(admitted.jobId, 'committed');
        await expect(provider.commitDelegationWait({ ...commit, wait: { ...nextWait, children: [{ ...nextWait.children[0]!,
            settlement: { ...nextWait.children[0]!.settlement, result: { kind: 'inline' as const, value: 'substituted answer' } } }] } }))
            .rejects.toThrow('Delegation child result does not match');
        expect(await provider.commitDelegationWait(commit)).toBe(true);
        expect(await provider.commitDelegationWait(commit)).toBe(false);
        expect(await provider.claimNextDelegationWait('new-coordinator', now + 1, now + 60_000)).toMatchObject({ id: input.parentJobId });
        expect(await provider.commitDelegationWait({ ...commit, leaseOwner: 'new-coordinator' })).toBe(false);
        await expect(provider.commitDelegationWait({ ...commit, leaseOwner: 'new-coordinator', expectedRevision: nextWait.revision,
            wait: { ...nextWait, revision: nextWait.revision + 1, deadlineAt: nextWait.deadlineAt + 1 } }))
            .rejects.toThrow('Invalid delegation wait transition');
        await expect(provider.commitDelegationWait({ ...commit, leaseOwner: 'new-coordinator', expectedRevision: nextWait.revision,
            wait: { ...nextWait, revision: nextWait.revision + 1, children: [{ ...nextWait.children[0]!,
                settlement: { ...nextWait.children[0]!.settlement, result: { kind: 'inline' as const, value: 'changed' } } }] } }))
            .rejects.toThrow('Invalid delegation child transition');
    });

    it.each(['error', 'aborted'] as const)('does not report uncertain dispatched work as a confirmed %s outcome', async (terminalStatus) => {
        const now = Date.now();
        const input = await prepareChildAdmission();
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        await provider.setHistoryPhase(admitted.jobId, 'ready');
        await provider.claimJob(admitted.jobId, 'child-worker', now, now + 60_000);
        expect(await provider.beginDelegationDispatch(admitted.jobId, 'child-worker')).toMatchObject({ state: 'started' });
        if (terminalStatus === 'aborted') {
            expect(await provider.abortJob(admitted.jobId, params.userId)).toBe(true);
        } else {
            const error = serializeError(Object.assign(new Error('Unknown outcome'), { code: 'ERR_MODEL_OUTCOME_UNKNOWN', retryable: false }));
            expect(await provider.saveTerminalSnapshot(admitted.jobId, { status: 'error', content: '', reasoning: '', error, completedAt: now }, 'child-worker')).toBe(true);
        }
        const parent = await provider.getJob(input.parentJobId, params.userId);
        const wait = (parent!.execution as BackgroundJobExecution).delegationWait!;
        const child = wait.children[0]!;
        if (child.kind !== 'prepared') throw new Error('Expected prepared child');
        const proposed = { ...wait, revision: wait.revision + 1, nextCheckAt: now,
            children: [{ ...child, settlement: { kind: terminalStatus === 'error' ? 'failed' as const : 'stopped' as const, code: 'confirmed' } }] };
        const commit = { parentJobId: input.parentJobId, leaseOwner: input.leaseOwner, expectedRevision: wait.revision, wait: proposed };
        await expect(provider.commitDelegationWait(commit)).rejects.toThrow('Delegation child outcome is uncertain');
        expect(await provider.commitDelegationWait({ ...commit, wait: { ...proposed, children: [{ ...child,
            settlement: { kind: 'unknown' as const, code: 'upstream_uncertain' } }] } })).toBe(true);
    });

    it('retains a confirmed rejection as failed even after dispatch was recorded', async () => {
        const now = Date.now();
        const input = await prepareChildAdmission();
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        await provider.setHistoryPhase(admitted.jobId, 'ready');
        await provider.claimJob(admitted.jobId, 'child-worker', now, now + 60_000);
        await provider.beginDelegationDispatch(admitted.jobId, 'child-worker');
        const error = serializeError(Object.assign(new Error('Rejected'), { code: 'ERR_AUTH' }));
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'error', content: '', reasoning: '', error, completedAt: now }, 'child-worker');
        const parent = await provider.getJob(input.parentJobId, params.userId);
        const wait = (parent!.execution as BackgroundJobExecution).delegationWait!;
        const child = wait.children[0]!;
        if (child.kind !== 'prepared') throw new Error('Expected prepared child');
        const proposed = { ...wait, revision: wait.revision + 1, nextCheckAt: now,
            children: [{ ...child, settlement: { kind: 'failed' as const, code: 'rejected' } }] };
        expect(await provider.commitDelegationWait({ parentJobId: input.parentJobId, leaseOwner: input.leaseOwner,
            expectedRevision: wait.revision, wait: proposed })).toBe(true);
    });

    it('keeps parent Stop authoritative over stale coordination and permits terminal cleanup', async () => {
        const now = Date.now();
        const input = await prepareChildAdmission();
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        const parent = await provider.getJob(input.parentJobId, params.userId);
        const wait = (parent?.execution as BackgroundJobExecution).delegationWait!;
        const prepared = wait.children[0]!;
        if (prepared.kind !== 'prepared') throw new Error('Expected prepared child');
        const nextWait = { ...wait, revision: wait.revision + 1, nextCheckAt: now + 1,
            children: [{ ...prepared, settlement: { kind: 'stopped' as const, code: 'user_stop' } }] };
        const commit = { parentJobId: input.parentJobId, leaseOwner: 'coordinator', expectedRevision: wait.revision, wait: nextWait };
        expect(await provider.abortJob(input.parentJobId, params.userId)).toBe(true);
        expect(await provider.commitDelegationWait(commit)).toBe(false);
        expect(await provider.abortJob(admitted.jobId, params.userId)).toBe(true);
        expect(await provider.claimNextDelegationWait('cleanup', now, now + 60_000)).toMatchObject({ id: input.parentJobId });
        expect(await provider.commitDelegationWait({ ...commit, leaseOwner: 'cleanup' })).toBe(true);
        expect(await provider.getJob(input.parentJobId, params.userId)).toMatchObject({ status: 'aborted',
            execution: { delegationWait: { children: [{ settlement: { kind: 'stopped' } }] } } });
        expect(await provider.claimJob(input.parentJobId, 'model', now, now + 60_000)).toBeNull();
        expect(await provider.claimNextDelegationWait('cleanup-again', now + 1, now + 60_000))
            .toMatchObject({ id: input.parentJobId, status: 'aborted' });
        expect(await provider.resumeDelegationWait({ parentJobId: input.parentJobId, leaseOwner: 'cleanup-again', expectedRevision: nextWait.revision, expectedSyncRevision: '0' }))
            .toBe('not-owned');
    });

    it('does not resume an expired wait even when its child completed', async () => {
        const now = Date.now();
        const input = await prepareChildAdmission(1_000, true);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        await provider.setHistoryPhase(admitted.jobId, 'ready');
        await provider.claimJob(admitted.jobId, 'child-worker', now, now + 60_000);
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content: 'answer', reasoning: '', completedAt: now }, 'child-worker');
        await provider.setHistoryPhase(admitted.jobId, 'committed');
        const parent = await provider.getJob(input.parentJobId, params.userId);
        const wait = (parent!.execution as BackgroundJobExecution).delegationWait!;
        const child = wait.children[0]!;
        if (child.kind !== 'prepared') throw new Error('Expected prepared child');
        const settled = { ...wait, revision: wait.revision + 1, nextCheckAt: now,
            children: [{ ...child, settlement: { kind: 'complete' as const, assistantMessageId: child.assistantMessageId, result: { kind: 'inline' as const, value: 'answer' } } }] };
        expect(await provider.commitDelegationWait({ parentJobId: input.parentJobId, leaseOwner: input.leaseOwner, expectedRevision: wait.revision, wait: settled })).toBe(true);
        await provider.claimNextDelegationWait('resume-worker', now, now + 60_000);
        const claimed = await provider.getJob(input.parentJobId, params.userId);
        const claimedExecution = claimed!.execution as BackgroundJobExecution;
        expect(await provider.expireDelegationWait({ parentJobId: input.parentJobId, leaseOwner: 'resume-worker', expectedRevision: settled.revision })).toBe('not-owned');
        await expect(provider.commitDelegationWait({ parentJobId: input.parentJobId, leaseOwner: 'resume-worker', expectedRevision: settled.revision,
            wait: { ...settled, revision: settled.revision + 1, expiredAt: settled.deadlineAt } })).rejects.toThrow('Invalid delegation wait transition');
        expect(await provider.updateJobExecution(input.parentJobId, { ...claimedExecution, delegationWait: undefined }, 'resume-worker')).toBe(false);
        vi.mocked(Date.now).mockReturnValue(now + 1_001);
        expect(await provider.resumeDelegationWait({ parentJobId: input.parentJobId, leaseOwner: 'resume-worker', expectedRevision: settled.revision, expectedSyncRevision: '0' })).toBe('not-owned');
        expect((await provider.getJob(input.parentJobId, params.userId))!.execution).toHaveProperty('delegationWait');
    });

    it('atomically inserts one aggregate and retains the remaining tool queue when capacity frees', async () => {
        const now = Date.now();
        const content = `or3-tool-result:v1/fake/${'a'.repeat(64)}/${'b'.repeat(64)}/1`;
        const input = await prepareChildAdmission(7_200_000, true);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        await provider.setHistoryPhase(admitted.jobId, 'ready');
        await provider.claimJob(admitted.jobId, 'child-worker', now, now + 60_000);
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content, reasoning: '', completedAt: now }, 'child-worker');
        await provider.setHistoryPhase(admitted.jobId, 'committed');
        const parent = await provider.getJob(input.parentJobId, params.userId);
        const wait = (parent?.execution as BackgroundJobExecution).delegationWait!;
        const child = wait.children[0]!;
        if (child.kind !== 'prepared') throw new Error('Expected prepared child');
        const settled = { ...wait, revision: wait.revision + 1, nextCheckAt: now,
            children: [{ ...child, settlement: { kind: 'complete' as const, assistantMessageId: child.assistantMessageId, result: { kind: 'inline' as const, value: content } } }] };
        expect(await provider.commitDelegationWait({ parentJobId: input.parentJobId, leaseOwner: 'coordinator', expectedRevision: wait.revision, wait: settled })).toBe(true);
        expect(await provider.claimNextDelegationWait('resume-worker', now, now + 60_000)).toMatchObject({ id: input.parentJobId });
        const fillers = [];
        for (let i = 0; i < 5; i++) fillers.push(await provider.createJob({ ...params, execution }));
        const resume = { parentJobId: input.parentJobId, leaseOwner: 'resume-worker', expectedRevision: settled.revision, expectedSyncRevision: '0' };
        expect(await provider.resumeDelegationWait(resume)).toBe('capacity');
        expect((await provider.getJob(input.parentJobId, params.userId))?.execution).toMatchObject({ delegationWait: { revision: settled.revision } });
        await provider.abortJob(fillers[0]!, params.userId);
        expect(await provider.resumeDelegationWait(resume)).toBe('resumed');
        expect(await provider.resumeDelegationWait(resume)).toBe('not-owned');
        await reopen();
        const resumed = await provider.getJob(input.parentJobId, params.userId);
        const resumedExecution = resumed?.execution as BackgroundJobExecution;
        expect(resumedExecution.delegationWait).toBeUndefined();
        expect(resumedExecution.pendingToolCalls?.map(call => call.id)).toEqual(['later']);
        expect(resumedExecution.checkpointedToolCallIds).toEqual(['call']);
        const toolMessage = (resumedExecution.body.messages as Array<Record<string, unknown>>).filter(message => message.role === 'tool');
        expect(toolMessage).toHaveLength(1);
        expect(JSON.parse(((toolMessage[0]!.content as Array<{ text: string }>)[0]!).text)).toMatchObject({ results: [{
            index: 0, threadId: ids.threadId, status: 'complete', content,
        }] });
        expect(resumed?.tool_calls?.[0]).toMatchObject({ status: 'complete', delegation: { children: [{
            threadId: ids.threadId, outcome: 'complete',
        }] } });
        expect(await provider.claimJob(input.parentJobId, 'model', now, now + 60_000)).toMatchObject({ id: input.parentJobId });
    });

    it('blocks further delegation when an aggregate contains an unknown child outcome', async () => {
        const now = Date.now();
        const input = await prepareChildAdmission(7_200_000, true);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        const parent = await provider.getJob(input.parentJobId, params.userId);
        const wait = (parent?.execution as BackgroundJobExecution).delegationWait!;
        const child = wait.children[0]!;
        if (child.kind !== 'prepared') throw new Error('Expected prepared child');
        const settled = { ...wait, revision: wait.revision + 1, nextCheckAt: now,
            children: [{ ...child, settlement: { kind: 'unknown' as const, code: 'upstream_uncertain' } }] };
        expect(await provider.commitDelegationWait({ parentJobId: input.parentJobId, leaseOwner: 'coordinator', expectedRevision: wait.revision, wait: settled })).toBe(true);
        await provider.claimNextDelegationWait('resume-worker', now, now + 60_000);
        expect(await provider.resumeDelegationWait({ parentJobId: input.parentJobId, leaseOwner: 'resume-worker', expectedRevision: settled.revision, expectedSyncRevision: '0' })).toBe('resumed');
        expect((await provider.getJob(input.parentJobId, params.userId))?.execution).toMatchObject({ delegationBlocked: true });
    });

    it('rejects a pending queue that no longer matches the assistant tool-call order', async () => {
        const now = Date.now();
        const input = await prepareChildAdmission(7_200_000, true);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        const parent = await provider.getJob(input.parentJobId, params.userId);
        const wait = (parent?.execution as BackgroundJobExecution).delegationWait!;
        const child = wait.children[0]!;
        if (child.kind !== 'prepared') throw new Error('Expected prepared child');
        const settled = { ...wait, revision: wait.revision + 1, nextCheckAt: now,
            children: [{ ...child, settlement: { kind: 'unknown' as const, code: 'upstream_uncertain' } }] };
        expect(await provider.commitDelegationWait({ parentJobId: input.parentJobId, leaseOwner: 'coordinator', expectedRevision: wait.revision, wait: settled })).toBe(true);
        await provider.claimNextDelegationWait('resume-worker', now, now + 60_000);
        getRawDb().prepare(`UPDATE background_jobs SET execution_json = json_set(execution_json,
            '$.body.messages[0].tool_calls', json_array(json_extract(execution_json, '$.body.messages[0].tool_calls[1]'),
            json_extract(execution_json, '$.body.messages[0].tool_calls[0]'))) WHERE id = ?`).run(input.parentJobId);
        await expect(provider.resumeDelegationWait({ parentJobId: input.parentJobId, leaseOwner: 'resume-worker', expectedRevision: settled.revision, expectedSyncRevision: '0' }))
            .rejects.toThrow('transcript order');
        expect((await provider.getJob(input.parentJobId, params.userId))?.execution).toMatchObject({ delegationWait: { revision: settled.revision } });
    });

    it('accepts only an aggregate artifact bound to the exact parent call and result', async () => {
        const now = Date.now();
        const input = await prepareChildAdmission(7_200_000, true);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        const content = 'x'.repeat(20_000);
        await provider.setHistoryPhase(admitted.jobId, 'ready');
        await provider.claimJob(admitted.jobId, 'child-worker', now, now + 60_000);
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content, reasoning: '', completedAt: now }, 'child-worker');
        await provider.setHistoryPhase(admitted.jobId, 'committed');
        const parent = await provider.getJob(input.parentJobId, params.userId);
        const wait = (parent?.execution as BackgroundJobExecution).delegationWait!;
        const child = wait.children[0]!;
        if (child.kind !== 'prepared') throw new Error('Expected prepared child');
        const childArtifact = await prepareToolResultStorage(content, { threadId: parent!.threadId, parentAssistantId: parent!.messageId, callId: 'call:child:0' });
        const settled = { ...wait, revision: wait.revision + 1, nextCheckAt: now,
            children: [{ ...child, settlement: { kind: 'complete' as const, assistantMessageId: child.assistantMessageId,
                result: { kind: 'artifact' as const, reference: childArtifact.result } } }] };
        const commit = { parentJobId: input.parentJobId, leaseOwner: 'coordinator', expectedRevision: wait.revision, wait: settled };
        await expect(provider.commitDelegationWait({ ...commit, wait: { ...settled, children: [{ ...settled.children[0]!,
            settlement: { ...settled.children[0]!.settlement, result: { kind: 'artifact' as const, reference: childArtifact.result.replace(/\/\d+$/, '/2') } } }] } }))
            .rejects.toThrow('Delegation child result does not match');
        expect(await provider.commitDelegationWait(commit)).toBe(true);
        await provider.claimNextDelegationWait('resume-worker', now, now + 60_000);
        const ready = (await provider.getJob(input.parentJobId, params.userId))!;
        const aggregate = buildDelegationResume(ready, { resolvedResults: { 0: content } }).rawResult;
        const artifact = await prepareToolResultStorage(aggregate, { threadId: ready.threadId, parentAssistantId: ready.messageId, callId: 'call' });
        expect(artifact.rows.length).toBeGreaterThan(0);
        const resume = { parentJobId: ready.id, leaseOwner: 'resume-worker', expectedRevision: settled.revision, expectedSyncRevision: '0', resolvedResults: { 0: content } };
        await expect(provider.resumeDelegationWait({ ...resume, durableResult: artifact.result.replace(/\/\d+$/, '/2') }))
            .rejects.toThrow('aggregate artifact is inconsistent');
        expect(await provider.resumeDelegationWait({ ...resume, durableResult: artifact.result })).toBe('resumed');
        expect((await provider.getJob(ready.id, params.userId))?.tool_calls?.[0]?.result).toBe(artifact.result);
    });

    it('rolls back child creation if linking the parent fails', async () => {
        const input = await prepareChildAdmission();
        getRawDb().exec(`CREATE TRIGGER fail_delegation_link BEFORE UPDATE OF execution_json ON background_jobs
            WHEN json_type(NEW.execution_json, '$.delegationWait') IS NOT NULL
            BEGIN SELECT RAISE(ABORT, 'link interrupted'); END`);
        await expect(provider.admitDelegationChild(input)).rejects.toThrow('link interrupted');
        expect(await provider.findJobByIdempotencyKey(admissionKey, params.userId)).toBeNull();
        expect(await provider.getJob(input.parentJobId, params.userId)).toMatchObject({
            execution: { delegationWait: { revision: 0, children: [{ admissionId: ids.admissionId }] } },
        });
    });

    it('parks a delegated parent without a model slot and recovers it after reopen', async () => {
        const now = Date.now();
        const id = await provider.createJob({ ...params, execution });
        await provider.claimJob(id, 'model-worker', now, now + 60_000);
        const waiting = { ...execution, delegationWait: {
            version: 1 as const, revision: 0, callId: 'call', argumentFingerprint: `sha256:v1:${'a'.repeat(64)}`,
            deadlineAt: now + 7_200_000, nextCheckAt: now,
            children: [{ kind: 'prepared' as const, index: 0, admissionId: 'admission', threadId: 'child',
                userMessageId: ids.userMessageId, assistantMessageId: ids.assistantMessageId,
                admissionFingerprint: `sha256:v1:${'b'.repeat(64)}`,
                admission: { body: { model: 'test-model', messages: [] }, history: { version: 1, kind: 'new-turn',
                    admissionId: 'admission', generationId: 'generation', workspaceId: execution.workspaceId,
                    threadId: 'child', messageId: ids.assistantMessageId, thread: { id: 'child', clock: 1 },
                    userMessage: { id: ids.userMessageId, clock: 1, role: 'user', thread_id: 'child' },
                    assistantMessage: { id: ids.assistantMessageId, clock: 1, role: 'assistant', thread_id: 'child' } } },
                request: { task: 'Research', model: 'test-model' } }],
        } };
        expect(await provider.parkDelegationWait(id, 'wrong-worker', waiting, [])).toBe(false);
        expect(await provider.parkDelegationWait(id, 'model-worker', waiting, [])).toBe(true);
        expect(await provider.getActiveJobCount()).toBe(0);
        expect(await provider.getShutdownBlockerCount()).toBe(1);
        expect(await provider.claimNextJob('model-next', now, now + 60_000)).toBeNull();
        await reopen();
        const claimed = await provider.claimNextDelegationWait('coordinator', now, now + 60_000);
        expect(claimed).toMatchObject({ id, attempts: 1, leaseOwner: 'coordinator', execution: { delegationWait: { callId: 'call' } } });
        expect(await provider.claimNextDelegationWait('other', now, now + 60_000)).toBeNull();
        const reclaimed = await provider.claimNextDelegationWait('new-coordinator', now + 60_001, now + 120_000);
        expect(reclaimed).toMatchObject({ id, attempts: 1, leaseOwner: 'new-coordinator' });
    });

    it('rejects malformed waits before parking and does not time out a parked parent', async () => {
        const now = Date.now();
        const id = await provider.createJob({ ...params, execution });
        await provider.claimJob(id, 'worker', now, now + 60_000);
        const waiting = { ...execution, delegationWait: {
            version: 1 as const, revision: 0, callId: 'call', argumentFingerprint: `sha256:v1:${'a'.repeat(64)}`,
            deadlineAt: now + 7_200_000, nextCheckAt: now,
            children: [{ kind: 'rejected' as const, index: 0, settlement: { kind: 'unavailable' as const, code: 'unsupported' } }],
        } };
        await expect(provider.parkDelegationWait(id, 'worker', { ...waiting, delegationWait: { ...waiting.delegationWait, version: 2 } } as never, []))
            .rejects.toThrow('Invalid delegation wait');
        expect(await provider.parkDelegationWait(id, 'worker', waiting, [])).toBe(true);
        vi.setSystemTime(now + 31 * 60_000);
        await provider.cleanupExpired();
        expect(await provider.getJob(id, params.userId)).toMatchObject({ status: 'streaming' });
    });

    it('retains a parent whose entire delegation wait is missing without replaying it', async () => {
        const now = Date.now();
        const id = await provider.createJob({ ...params, execution });
        await provider.claimJob(id, 'worker', now, now + 60_000);
        expect(await provider.parkDelegationWait(id, 'worker', { ...execution, delegationWait: {
            version: 1, revision: 0, callId: 'call', argumentFingerprint: `sha256:v1:${'a'.repeat(64)}`,
            deadlineAt: now + 7_200_000, nextCheckAt: now,
            children: [{ kind: 'rejected', index: 0, settlement: { kind: 'unavailable', code: 'unsupported' } }],
        } }, [])).toBe(true);
        getRawDb().prepare(`UPDATE background_jobs SET execution_json =
            json_remove(execution_json, '$.delegationWait') WHERE id = ?`).run(id);
        await reopen();
        expect(await provider.claimJob(id, 'replay', now, now + 60_000)).toBeNull();
        expect(await provider.claimNextJob('replay-next', now, now + 60_000)).toBeNull();
        expect(await provider.getActiveJobCount()).toBe(0);
        await provider.abortJob(id, params.userId);
        await provider.setHistoryPhase(id, 'committed');
        vi.setSystemTime(now + 48 * 60 * 60_000);
        await provider.cleanupExpired();
        await reopen();
        expect(await provider.getJob(id, params.userId)).toMatchObject({ status: 'aborted' });
        expect(await provider.getShutdownBlockerCount()).toBe(1);
    });

    it('retains linked child evidence when a terminal parent loses its wait', async () => {
        const now = Date.now();
        await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory, true);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        await provider.saveTerminalSnapshot(admitted.jobId, { status: 'complete', content: 'child result', reasoning: '', completedAt: now });
        await provider.setHistoryPhase(admitted.jobId, 'committed');
        getRawDb().prepare(`UPDATE background_jobs SET execution_json =
            json_remove(execution_json, '$.delegationWait') WHERE id = ?`).run(input.parentJobId);
        await provider.abortJob(input.parentJobId, params.userId);
        await provider.setHistoryPhase(input.parentJobId, 'committed');
        vi.setSystemTime(now + 48 * 60 * 60_000);
        await provider.cleanupExpired();
        await reopen();
        expect(await provider.getJob(input.parentJobId, params.userId)).toMatchObject({ status: 'aborted' });
        expect(await provider.getJob(admitted.jobId, params.userId)).toMatchObject({ status: 'complete', content: 'child result' });
        expect(await provider.getShutdownBlockerCount()).toBe(1);
        const healthy = await provider.createJob({ ...params, execution });
        expect(await provider.claimNextJob('healthy-worker', Date.now(), Date.now() + 60_000)).toMatchObject({ id: healthy });
    });

    it('stops linked work for a canceled parent with a missing wait', async () => {
        const now = Date.now();
        await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory, true);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        getRawDb().prepare(`UPDATE background_jobs SET execution_json =
            json_remove(execution_json, '$.delegationWait') WHERE id = ?`).run(input.parentJobId);
        expect(await provider.abortJob(input.parentJobId, params.userId)).toBe(true);
        await reopen();
        await provider.claimNextDelegationWait('recovery', now + 60_001, now + 120_000);
        expect(await provider.getJob(admitted.jobId, params.userId)).toMatchObject({ status: 'aborted' });
        expect(await provider.getJob(input.parentJobId, params.userId)).toMatchObject({ status: 'aborted' });
    });

    it.each(['missing', 'null', 'scalar'] as const)('stops linked work at the fixed deadline for a $0 wait', async (damage) => {
        const now = Date.now();
        await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(1_000, true, true, parentHistory, true);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        expect(await reconcileBackgroundJobHistory(provider, (await provider.getJob(admitted.jobId, params.userId))!)).toBe('ready');
        expect(await provider.claimJob(admitted.jobId, 'child-worker', now, now + 60_000)).toBeTruthy();
        expect(await provider.beginDelegationDispatch(admitted.jobId, 'child-worker')).toMatchObject({ state: 'started' });
        const damagedJson = damage === 'missing' ? `json_remove(execution_json, '$.delegationWait')`
            : damage === 'null' ? `json_set(execution_json, '$.delegationWait', json('null'))`
                : `json_set(execution_json, '$.delegationWait', 'invalid')`;
        getRawDb().prepare(`UPDATE background_jobs SET execution_json = ${damagedJson} WHERE id = ?`).run(input.parentJobId);
        await reopen();
        vi.mocked(Date.now).mockReturnValue(now + 999);
        await provider.claimNextDelegationWait('before-deadline', Date.now(), Date.now() + 60_000);
        expect(await provider.getJob(admitted.jobId, params.userId)).toMatchObject({ status: 'streaming' });
        vi.mocked(Date.now).mockReturnValue(now + 1_000);
        await provider.claimNextDelegationWait('at-deadline', Date.now(), Date.now() + 60_000);
        expect(await provider.getJob(admitted.jobId, params.userId)).toMatchObject({ status: 'aborted', execution: { delegationDispatch: { state: 'started' } } });
        expect(await provider.getJob(input.parentJobId, params.userId)).toMatchObject({ status: 'streaming' });
        expect(await provider.claimJob(input.parentJobId, 'replay', Date.now(), Date.now() + 60_000)).toBeNull();
        expect(await provider.getShutdownBlockerCount()).toBeGreaterThan(0);
    });

    it('does not deliver a terminal projection after its delegation wait disappears', async () => {
        const now = Date.now();
        const id = await provider.createJob({ ...params, execution });
        await provider.claimJob(id, 'worker', now, now + 60_000);
        expect(await provider.parkDelegationWait(id, 'worker', { ...execution, delegationWait: {
            version: 1, revision: 0, callId: 'call', argumentFingerprint: `sha256:v1:${'a'.repeat(64)}`,
            deadlineAt: now + 7_200_000, nextCheckAt: now,
            children: [{ kind: 'rejected', index: 0, settlement: { kind: 'unavailable', code: 'unsupported' } }],
        } }, [])).toBe(true);
        getRawDb().prepare(`UPDATE background_jobs SET status = 'aborted', history_phase = 'finalization_pending',
            execution_json = json_set(json_remove(execution_json, '$.delegationWait'),
                '$.delegationTerminalProjection', json('{"version":1,"workspaceRevision":"0"}')) WHERE id = ?`).run(id);
        await reopen();
        expect((await provider.getPendingHistoryJobs(100)).map(job => job.id)).not.toContain(id);
        expect(await provider.getShutdownBlockerCount()).toBe(1);
    });

    it('stops linked work when both the wait and its independent deadline are missing', async () => {
        const now = Date.now();
        await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(7_200_000, true, true, parentHistory, true);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        getRawDb().prepare(`UPDATE background_jobs SET delegation_wait_deadline = NULL,
            execution_json = json_remove(execution_json, '$.delegationWait') WHERE id = ?`).run(input.parentJobId);
        await reopen();
        await provider.claimNextDelegationWait('recovery', now, now + 60_000);
        expect(await provider.getJob(admitted.jobId, params.userId)).toMatchObject({ status: 'aborted' });
        expect(await provider.getJob(input.parentJobId, params.userId)).toMatchObject({ status: 'streaming' });
        expect(await provider.claimJob(input.parentJobId, 'replay', now, now + 60_000)).toBeNull();
    });

    it('quarantines a wait whose deadline no longer matches the parked deadline', async () => {
        const now = Date.now();
        await prepareCanonicalWorkspace();
        const input = await prepareChildAdmission(1_000, true, true, parentHistory, true);
        const admitted = await provider.admitDelegationChild(input);
        if (admitted.status !== 'admitted') throw new Error('Child was not admitted');
        getRawDb().prepare(`UPDATE background_jobs SET execution_json =
            json_set(execution_json, '$.delegationWait.deadlineAt', ?) WHERE id = ?`).run(now + 7_200_000, input.parentJobId);
        vi.mocked(Date.now).mockReturnValue(now + 60_001);
        await expect(provider.claimNextDelegationWait('recovery', Date.now(), Date.now() + 60_000))
            .rejects.toThrow('Invalid delegation wait checkpoint');
        await provider.claimNextDelegationWait('cleanup', Date.now(), Date.now() + 60_000);
        expect(await provider.getJob(admitted.jobId, params.userId)).toMatchObject({ status: 'aborted' });
        expect((await provider.getJob(input.parentJobId, params.userId))?.execution).toMatchObject({ delegationQuarantinedAt: expect.any(Number) });
    });

    it('quarantines corrupt waits without starving other due parents', async () => {
        const now = Date.now();
        const waiting = { ...execution, delegationWait: {
            version: 1 as const, revision: 0, callId: 'call', argumentFingerprint: `sha256:v1:${'a'.repeat(64)}`,
            deadlineAt: now + 7_200_000, nextCheckAt: now,
            children: [{ kind: 'rejected' as const, index: 0, settlement: { kind: 'unavailable' as const, code: 'unsupported' } }],
        } };
        const corrupt = await provider.createJob({ ...params, execution });
        await provider.claimJob(corrupt, 'worker-1', now, now + 60_000);
        expect(await provider.parkDelegationWait(corrupt, 'worker-1', waiting, [])).toBe(true);
        const healthy = await provider.createJob({ ...params, execution });
        await provider.claimJob(healthy, 'worker-2', now, now + 60_000);
        expect(await provider.parkDelegationWait(healthy, 'worker-2', { ...waiting,
            delegationWait: { ...waiting.delegationWait, nextCheckAt: now + 1 },
        }, [])).toBe(true);
        getRawDb().prepare(`UPDATE background_jobs SET execution_json =
            json_set(execution_json, '$.delegationWait.children', json('null')) WHERE id = ?`).run(corrupt);

        await expect(provider.claimNextDelegationWait('coordinator-1', now + 1, now + 60_000))
            .rejects.toThrow('Invalid delegation wait checkpoint');
        const quarantined = await provider.getJob(corrupt, params.userId);
        expect(quarantined?.execution).toMatchObject({ delegationQuarantinedAt: now + 1, delegationWait: { children: null } });
        expect((await provider.claimNextDelegationWait('coordinator-2', now + 1, now + 60_000))?.id).toBe(healthy);
        expect(await provider.claimNextDelegationWait('coordinator-3', now + 1, now + 60_000)).toBeNull();
        expect(await provider.getShutdownBlockerCount()).toBe(2);
        await provider.abortJob(healthy, params.userId);
        await reopen();
        expect((await provider.claimNextDelegationWait('after-restart', now + 60_001, now + 120_000))?.id).toBe(healthy);
        expect(await provider.claimNextDelegationWait('after-restart-2', now + 60_001, now + 120_000)).toBeNull();
        expect((await provider.getJob(corrupt, params.userId))?.execution)
            .toMatchObject({ delegationQuarantinedAt: now + 1, delegationWait: { children: null } });
    });

    it.each([
        { label: 'missing', value: undefined },
        { label: 'null', value: null },
        { label: 'text', value: 'not-a-time' },
        { label: 'fractional', value: 1.5 },
        { label: 'negative', value: -1 },
        { label: 'outside the safe integer range', value: Number.MAX_SAFE_INTEGER + 1 },
    ])('quarantines a wait with a $label next-check time without starving a healthy wait', async ({ value }) => {
        const now = Date.now();
        const waiting = { ...execution, delegationWait: {
            version: 1 as const, revision: 0, callId: 'call', argumentFingerprint: `sha256:v1:${'a'.repeat(64)}`,
            deadlineAt: now + 7_200_000, nextCheckAt: now,
            children: [{ kind: 'rejected' as const, index: 0, settlement: { kind: 'unavailable' as const, code: 'unsupported' } }],
        } };
        const damaged = await provider.createJob({ ...params, execution });
        await provider.claimJob(damaged, 'worker-1', now, now + 60_000);
        expect(await provider.parkDelegationWait(damaged, 'worker-1', waiting, [])).toBe(true);
        const healthy = await provider.createJob({ ...params, execution });
        await provider.claimJob(healthy, 'worker-2', now, now + 60_000);
        expect(await provider.parkDelegationWait(healthy, 'worker-2', { ...waiting,
            delegationWait: { ...waiting.delegationWait, nextCheckAt: now + 1 },
        }, [])).toBe(true);
        if (value === undefined) getRawDb().prepare(`UPDATE background_jobs SET execution_json =
            json_remove(execution_json, '$.delegationWait.nextCheckAt') WHERE id = ?`).run(damaged);
        else getRawDb().prepare(`UPDATE background_jobs SET execution_json =
            json_set(execution_json, '$.delegationWait.nextCheckAt', ?) WHERE id = ?`).run(value, damaged);

        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect((await provider.claimNextDelegationWait('coordinator', now + 1, now + 60_000))?.id).toBe(healthy);
        expect(warning).toHaveBeenCalledOnce();
        expect(String(warning.mock.calls[0]![0])).toContain(damaged);
        expect(String(warning.mock.calls[0]![0])).not.toContain('test-only-not-a-credential');
        expect(await provider.claimNextDelegationWait('next', now + 1, now + 60_000)).toBeNull();
        await reopen();
        expect((await provider.getJob(damaged, params.userId))?.execution).toMatchObject({ delegationQuarantinedAt: now + 1 });
        expect(await provider.getShutdownBlockerCount()).toBe(2);
        warning.mockClear();
        expect(await provider.claimNextDelegationWait('after-restart', now + 2, now + 60_000)).toBeNull();
        expect(warning).toHaveBeenCalledOnce();
        expect(String(warning.mock.calls[0]![0])).toContain(damaged);
        expect(String(warning.mock.calls[0]![0])).not.toContain('test-only-not-a-credential');
    });

    it('leaves a newer wait version untouched while processing supported work', async () => {
        const now = Date.now();
        const waiting = { ...execution, delegationWait: {
            version: 1 as const, revision: 0, callId: 'call', argumentFingerprint: `sha256:v1:${'a'.repeat(64)}`,
            deadlineAt: now + 7_200_000, nextCheckAt: now,
            children: [{ kind: 'rejected' as const, index: 0, settlement: { kind: 'unavailable' as const, code: 'unsupported' } }],
        } };
        const newer = await provider.createJob({ ...params, execution });
        await provider.claimJob(newer, 'worker-1', now, now + 60_000);
        expect(await provider.parkDelegationWait(newer, 'worker-1', waiting, [])).toBe(true);
        const healthy = await provider.createJob({ ...params, execution });
        await provider.claimJob(healthy, 'worker-2', now, now + 60_000);
        expect(await provider.parkDelegationWait(healthy, 'worker-2', waiting, [])).toBe(true);
        getRawDb().prepare(`UPDATE background_jobs SET execution_json =
            json_set(execution_json, '$.delegationWait.version', 2) WHERE id = ?`).run(newer);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect((await provider.claimNextDelegationWait('coordinator', now, now + 60_000))?.id).toBe(healthy);
        expect(warning).toHaveBeenCalledOnce();
        expect(String(warning.mock.calls[0]![0])).toContain(newer);
        expect(String(warning.mock.calls[0]![0])).not.toContain('test-only-not-a-credential');
        expect(await provider.claimNextDelegationWait('next', now, now + 60_000)).toBeNull();
        expect(warning).toHaveBeenCalledOnce();
        await provider.claimNextDelegationWait('later', now + 60_001, now + 120_000);
        expect(warning).toHaveBeenCalledTimes(2);
        await reopen();
        const saved = (await provider.getJob(newer, params.userId))?.execution;
        expect(saved).toMatchObject({ delegationWait: { version: 2 } });
        expect(saved).not.toHaveProperty('delegationQuarantinedAt');
        expect(await provider.getShutdownBlockerCount()).toBe(2);
    });

    it('does not quarantine a malformed wait while a coordinator owns an unexpired lease', async () => {
        const now = Date.now();
        const id = await provider.createJob({ ...params, execution });
        await provider.claimJob(id, 'worker', now, now + 60_000);
        expect(await provider.parkDelegationWait(id, 'worker', { ...execution, delegationWait: {
            version: 1, revision: 0, callId: 'call', argumentFingerprint: `sha256:v1:${'a'.repeat(64)}`,
            deadlineAt: now + 7_200_000, nextCheckAt: now,
            children: [{ kind: 'rejected', index: 0, settlement: { kind: 'unavailable', code: 'unsupported' } }],
        } }, [])).toBe(true);
        expect((await provider.claimNextDelegationWait('owner', now, now + 60_000))?.id).toBe(id);
        getRawDb().prepare(`UPDATE background_jobs SET execution_json =
            json_remove(execution_json, '$.delegationWait.nextCheckAt') WHERE id = ?`).run(id);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await provider.claimNextDelegationWait('other', now + 1, now + 60_000)).toBeNull();
        expect((await provider.getJob(id, params.userId))).toMatchObject({ leaseOwner: 'owner' });
        expect((await provider.getJob(id, params.userId))?.execution).not.toHaveProperty('delegationQuarantinedAt');
        expect(warning).not.toHaveBeenCalled();
        expect(await provider.claimNextDelegationWait('after-expiry', now + 60_001, now + 120_000)).toBeNull();
        expect((await provider.getJob(id, params.userId))?.execution).toMatchObject({ delegationQuarantinedAt: now + 60_001 });
        expect(String(warning.mock.calls[0]![0])).toContain(id);
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
            delegationDefaults: { version: 1 as const, instructions: [] },
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
        await expect(provider.settleClientToolCall(jobId, 'user-1', 'call-1', 'token-1', {
            ...settled, delegationDefaults: { version: 1, instructions: [{ role: 'system', content: 'Injected' }] },
        }, [{ id: 'call-1', name: 'client_tool', status: 'complete' }])).resolves.toBe(false);
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
        expect(resumed?.execution).not.toHaveProperty('clientToolCall');
        expect(resumed?.execution).not.toHaveProperty('pendingToolCalls');
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

    it('admits active children when the waiting budget is full', async () => {
        await checkSeparateWaitingCapacity(new SqliteBackgroundJobProvider());
    });

    it('quarantines a missing wait time through the D1 statement path', async () => {
        const provider = new SqliteBackgroundJobProvider();
        const now = Date.now();
        const execution: BackgroundJobExecution = { version: 1, workspaceId: 'workspace', referer: 'https://example.test',
            apiKeyCiphertext: 'test-only', body: { messages: [] }, delegationRecoveryPolicy: 'v1' };
        const id = await provider.createJob({ userId: 'owner', threadId: 'thread', messageId: 'message', model: 'test', execution });
        await provider.claimJob(id, 'worker', now, now + 60_000);
        expect(await provider.parkDelegationWait(id, 'worker', { ...execution, delegationWait: {
            version: 1, revision: 0, callId: 'call', argumentFingerprint: `sha256:v1:${'a'.repeat(64)}`,
            deadlineAt: now + 7_200_000, nextCheckAt: now,
            children: [{ kind: 'rejected', index: 0, settlement: { kind: 'unavailable', code: 'unsupported' } }],
        } }, [])).toBe(true);
        await d1.database.prepare(`UPDATE background_jobs SET execution_json =
            json_remove(execution_json, '$.delegationWait.nextCheckAt') WHERE id = ?`).bind(id).run();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(provider.claimNextDelegationWait('coordinator', now, now + 60_000)).resolves.toBeNull();
        expect(String(warning.mock.calls[0]![0])).toContain(id);
        expect((await provider.getJob(id, 'owner'))?.execution).toMatchObject({ delegationQuarantinedAt: now });
        expect(await provider.claimNextDelegationWait('next', now, now + 60_000)).toBeNull();
    });

    it('refuses delegation admission without an interactive transaction', async () => {
        const provider = new SqliteBackgroundJobProvider();
        expect(provider.delegationCoordinatorVersion).toBeUndefined();
        await expect(provider.admitDelegationChild({} as never))
            .rejects.toThrow('unavailable for D1');
        await expect(provider.commitDelegationWait({} as never)).rejects.toThrow('unavailable for D1');
        await expect(provider.cleanupDelegationWait({} as never)).rejects.toThrow('unavailable for D1');
        await expect(provider.expireDelegationWait({} as never)).rejects.toThrow('unavailable for D1');
        await expect(provider.resumeDelegationWait({} as never)).rejects.toThrow('unavailable for D1');
        await expect(provider.beginDelegationDispatch('job', 'worker')).rejects.toThrow('unavailable for D1');
        await expect(provider.commitDelegationDispatch('job', 'worker', 1, {} as never, [])).rejects.toThrow('unavailable for D1');
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
