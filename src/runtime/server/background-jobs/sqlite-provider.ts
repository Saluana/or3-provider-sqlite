import type {
    BackgroundJob,
    BackgroundJobExecution,
    BackgroundJobProvider,
    CreateJobParams,
    DelegationChildAdmission,
    DelegationChildAdmissionResult,
    DelegationWaitCommit,
    DelegationResume,
    DelegationResumeResult,
    JobUpdate,
    AdmissionCancellationResult,
    GenerationHistoryPhase,
    TerminalGenerationSnapshot
} from '~~/server/utils/background-jobs/types';
import { getJobConfig } from '~~/server/utils/background-jobs/store';
import { getScopedAdmissionKey } from '~~/server/utils/background-jobs/admission-cancels';
import { buildDelegationResume } from '~~/server/utils/background-jobs/delegation-resume';
import { readRequestUsage } from '~~/shared/chat/compaction';
import { DelegationActivitySchema, DelegationDispatchSchema, DelegationWaitSchema, type DelegationDispatch, type DelegationWait } from '~~/shared/chat/delegation-checkpoint';
import { delegationAdmissionFingerprint, delegationChildIdentities } from '~~/shared/chat/delegation-identities';
import { toolCallFingerprint } from '~~/shared/chat/tool-ledger';
import { parseChatGenerationAdmissionEnvelope } from '~~/shared/chat/background-history';
import { matchesToolResultStorage } from '~~/shared/chat/tool-result-artifact';
import { normalizeError, serializeError } from '~~/shared/errors';
import { randomUUID } from 'node:crypto';
import { d1All, d1Run } from '../db/d1';
import { getRawDb, getSqliteDriver, isD1Driver } from '../db/kysely';
import { resolveCanonicalProjectOwnership } from '../sync/canonical-project-ownership';
import { backgroundFinalizationFingerprint } from '../sync/background-history-fingerprint';

type JobRow = {
    id: string;
    user_id: string;
    thread_id: string;
    message_id: string;
    model: string;
    kind: 'chat' | 'workflow' | null;
    status: BackgroundJob['status'];
    content: string;
    reasoning: string;
    generation_id: string | null;
    history_phase: string | null;
    sync_provider_id: string | null;
    chunks_received: number;
    started_at: number;
    last_activity_at: number;
    completed_at: number | null;
    error: string | null;
    tool_calls_json: string | null;
    usage_json: string | null;
    workflow_state_json: string | null;
    execution_json: string | null;
    idempotency_key: string | null;
    lease_owner: string | null;
    lease_expires_at: number | null;
    attempts: number;
    delegation_wait_active: number;
    delegation_wait_deadline: number | null;
};

function hasParkedDeadline(row: JobRow, wait: DelegationWait): boolean {
    return row.delegation_wait_active === 1 && row.delegation_wait_deadline === wait.deadlineAt;
}

function parseJson<T>(value: string | null): T | undefined {
    if (!value) return undefined;
    return JSON.parse(value) as T;
}

function json(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
}

/** Finalize a stopped parent's bounded activity only from canonical, scoped evidence. */
function terminalDelegationCheckpoint(raw: ReturnType<typeof getRawDb>, parent: JobRow,
    execution: BackgroundJobExecution, wait: DelegationWait, parentThreadUnavailable = false): BackgroundJob['tool_calls'] | null {
    if (parent.status === 'streaming' || parent.sync_provider_id !== 'sqlite' || !parent.generation_id ||
        !execution.history || !['admission_pending', 'finalization_pending'].includes(parent.history_phase ?? '')) return null;
    try {
        const history = parseChatGenerationAdmissionEnvelope(execution.history);
        if (history.workspaceId !== execution.workspaceId || history.threadId !== parent.thread_id ||
            history.messageId !== parent.message_id || history.generationId !== parent.generation_id) return null;
    } catch { return null; }
    const membership = raw.prepare(`SELECT m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.workspace_id = ? AND m.user_id = ? AND COALESCE(w.deleted, 0) = 0`)
        .get(execution.workspaceId, parent.user_id) as { role: string } | undefined;
    if (!membership || !['owner', 'editor'].includes(membership.role)) return null;
    let calls: NonNullable<BackgroundJob['tool_calls']>;
    try {
        const stored = parseJson<BackgroundJob['tool_calls']>(parent.tool_calls_json) ?? [];
        if (!Array.isArray(stored) || stored.some(call => !call || typeof call !== 'object')) return null;
        calls = stored;
    } catch { return null; }
    const matches = calls.filter(call => call.id === wait.callId);
    const call = matches[0];
    const previous = call && DelegationActivitySchema.safeParse(call.delegation);
    if (matches.length !== 1 || !call || call.name !== 'delegate_chat' || typeof call.args !== 'string' ||
        toolCallFingerprint(call.name, call.args) !== wait.argumentFingerprint ||
        (!['pending', 'loading'].includes(call.status) && !(call.status === 'error' && execution.delegationTerminalProjection?.version === 1 &&
            previous?.success && previous.data.callId === wait.callId))) return null;

    const threadAvailable = (id: string): boolean | null => {
        const row = raw.prepare('SELECT data_json, deleted FROM s_threads WHERE workspace_id = ? AND id = ?')
            .get(execution.workspaceId, id) as { data_json: string; deleted: number } | undefined;
        if (!row || row.deleted) return false;
        try {
            const thread = JSON.parse(row.data_json) as { id?: unknown; deleted?: unknown; project_id?: unknown };
            if (thread.id !== id || thread.deleted) return false;
            const ownership = resolveCanonicalProjectOwnership(raw, execution.workspaceId, id, thread.project_id);
            return ownership.status === 'resolved' && !ownership.projectId;
        } catch { return null; }
    };
    const parentThread = raw.prepare('SELECT deleted FROM s_threads WHERE workspace_id = ? AND id = ?')
        .get(execution.workspaceId, parent.thread_id) as { deleted: number } | undefined;
    const parentMissing = !parentThread || !!parentThread.deleted;
    if (parentThreadUnavailable ? !parentMissing : !threadAvailable(parent.thread_id)) return null;
    const children: Array<{ index: number; threadId?: string; modelName?: string; outcome: 'complete' | 'failed' | 'stopped' | 'unknown' | 'unavailable'; executionUncertain?: true }> = [];
    for (const child of wait.children) {
        if (child.kind === 'rejected' || !child.jobId) {
            children.push({ index: child.index, ...(child.kind === 'prepared' ? { modelName: child.request.model } : {}), outcome: 'unavailable' });
            continue;
        }
        const row = raw.prepare('SELECT * FROM background_jobs WHERE id = ? AND delegation_parent_id = ?')
            .get(child.jobId, parent.id) as JobRow | undefined;
        let childExecution: BackgroundJobExecution | undefined;
        try { childExecution = row && parseJson<BackgroundJobExecution>(row.execution_json); } catch { return null; }
        if (!row || !childExecution || row.user_id !== parent.user_id || row.thread_id !== child.threadId ||
            row.message_id !== child.assistantMessageId || row.sync_provider_id !== parent.sync_provider_id ||
            childExecution.workspaceId !== execution.workspaceId || !childExecution.history ||
            delegationAdmissionFingerprint(childExecution.history) !== delegationAdmissionFingerprint(child.admission.history as object) ||
            row.generation_id !== childExecution.history.generationId || row.status === 'streaming' ||
            !['committed', 'superseded'].includes(row.history_phase ?? '')) return null;
        const receipt = raw.prepare(`SELECT outcome FROM background_generation_receipts
            WHERE workspace_id = ? AND generation_id = ? AND stage = 'finalization'`)
            .get(execution.workspaceId, row.generation_id) as { outcome: string } | undefined;
        if (row.history_phase === 'committed' ? receipt?.outcome !== 'committed'
            : !receipt || !['deleted', 'missing', 'newer_generation', 'edited'].includes(receipt.outcome)) return null;
        const availableThread = threadAvailable(child.threadId);
        if (availableThread === null) return null;
        const executionUncertain = row.status === 'aborted'
            ? childExecution.delegationDispatch !== undefined
            : row.status === 'error' && normalizeError(row.error).code === 'ERR_MODEL_OUTCOME_UNKNOWN';
        let outcome: typeof children[number]['outcome'] = 'unavailable';
        if (availableThread && row.history_phase === 'committed') {
            const message = raw.prepare('SELECT data_json, clock, deleted FROM s_messages WHERE workspace_id = ? AND id = ?')
                .get(execution.workspaceId, child.assistantMessageId) as { data_json: string; clock: number; deleted: number } | undefined;
            try {
                const record = message && JSON.parse(message.data_json) as { id?: unknown; thread_id?: unknown; role?: unknown; pending?: unknown; deleted?: unknown; data?: Record<string, unknown> } | undefined;
                const expectedState = row.status === 'complete' ? 'complete' : row.status === 'aborted' ? 'aborted' : 'failed';
                if (message && !message.deleted && record && !record.deleted && record.id === child.assistantMessageId &&
                    record.thread_id === child.threadId && record.role === 'assistant' && record.pending === false &&
                    message.clock === childExecution.history.assistantMessage.clock + 1 && record.data?.generation_id === row.generation_id &&
                    record.data?.generation_state === expectedState && record.data?.content === row.content) {
                    outcome = row.status === 'complete' ? 'complete' : row.status === 'aborted'
                        ? (executionUncertain ? 'unknown' : 'stopped')
                        : executionUncertain ? 'unknown' : 'failed';
                }
            } catch { return null; }
        }
        children.push({ index: child.index, ...(availableThread ? { threadId: child.threadId } : {}),
            modelName: child.request.model, outcome,
            ...(outcome === 'unavailable' && executionUncertain ? { executionUncertain: true as const } : {}) });
    }
    const activity = DelegationActivitySchema.safeParse({ version: 1, callId: wait.callId, children });
    if (!activity.success) return null;
    return calls.map(item => item.id === wait.callId ? { ...item, status: 'error' as const,
        error: parent.status === 'aborted' ? 'Delegation stopped.' : 'Delegation could not finish.', delegation: activity.data } : item);
}

function terminalProjectionSettled(raw: ReturnType<typeof getRawDb>, parent: JobRow,
    execution: BackgroundJobExecution, wait: DelegationWait): boolean {
    if (parent.status === 'streaming' || !['committed', 'superseded'].includes(parent.history_phase ?? '') || !parent.generation_id || !execution.history ||
        execution.delegationTerminalProjection?.version !== 1 || parent.completed_at === null) return false;
    try {
        const admission = parseChatGenerationAdmissionEnvelope(execution.history);
        if (admission.workspaceId !== execution.workspaceId || admission.threadId !== parent.thread_id ||
            admission.messageId !== parent.message_id || admission.generationId !== parent.generation_id) return false;
        const job = toJob(parent);
        const calls = job.tool_calls ?? [];
        const matches = calls.filter(call => call.id === wait.callId);
        const call = matches[0];
        if (matches.length !== 1 || !call || call.name !== 'delegate_chat' || typeof call.args !== 'string' ||
            toolCallFingerprint(call.name, call.args) !== wait.argumentFingerprint ||
            !DelegationActivitySchema.safeParse(call.delegation).success) return false;
        const receipt = raw.prepare(`SELECT outcome, fingerprint FROM background_generation_receipts
            WHERE workspace_id = ? AND generation_id = ? AND stage = 'finalization'`)
            .get(execution.workspaceId, parent.generation_id) as { outcome: string; fingerprint: string } | undefined;
        const fingerprint = backgroundFinalizationFingerprint({ admission: execution.history, snapshot: {
            status: job.status, content: job.content, reasoning: job.reasoning, toolCalls: job.tool_calls,
            usage: readRequestUsage(job.usage), error: job.error, completedAt: job.completedAt,
        } });
        // The immutable receipt proves this exact terminal projection settled.
        // Later changes to canonical history must not strand the retained wait.
        return receipt?.fingerprint === fingerprint && (parent.history_phase === 'committed'
            ? receipt.outcome === 'committed'
            : ['deleted', 'missing', 'newer_generation', 'edited'].includes(receipt.outcome));
    } catch { return false; }
}

function readStoredUsage(value: string | null) {
    try {
        return readRequestUsage(parseJson<unknown>(value));
    } catch {
        // Usage is optional telemetry. A damaged legacy value must not hide
        // otherwise readable text or prevent terminal history reconciliation.
        return undefined;
    }
}

function toJob(row: JobRow): BackgroundJob {
    return {
        id: row.id,
        userId: row.user_id,
        threadId: row.thread_id,
        messageId: row.message_id,
        model: row.model,
        kind: row.kind ?? undefined,
        status: row.status,
        content: row.content,
        reasoning: row.reasoning ?? '',
        generationId: row.generation_id ?? undefined,
        historyPhase:
            (row.history_phase as BackgroundJob['historyPhase']) ?? undefined,
        syncProviderId: row.sync_provider_id ?? undefined,
        chunksReceived: row.chunks_received,
        startedAt: row.started_at,
        lastActivityAt: row.last_activity_at,
        completedAt: row.completed_at ?? undefined,
        error: row.error ?? undefined,
        tool_calls: parseJson<BackgroundJob['tool_calls']>(row.tool_calls_json),
        usage: readStoredUsage(row.usage_json),
        workflow_state: parseJson<BackgroundJob['workflow_state']>(
            row.workflow_state_json
        ),
        execution: parseJson<BackgroundJobExecution>(row.execution_json),
        leaseOwner: row.lease_owner ?? undefined,
        leaseExpiresAt: row.lease_expires_at ?? undefined,
        attempts: row.attempts
    };
}

async function all<T>(
    statement: string,
    ...parameters: unknown[]
): Promise<T[]> {
    if (isD1Driver()) return d1All<T>(statement, ...parameters);
    return getRawDb()
        .prepare(statement)
        .all(...parameters) as T[];
}

async function one<T>(
    statement: string,
    ...parameters: unknown[]
): Promise<T | undefined> {
    if (isD1Driver()) return (await d1All<T>(statement, ...parameters))[0];
    return getRawDb()
        .prepare(statement)
        .get(...parameters) as T | undefined;
}

async function run(
    statement: string,
    ...parameters: unknown[]
): Promise<number> {
    if (isD1Driver()) {
        const result = await d1Run(statement, ...parameters);
        return result.meta?.changes ?? 0;
    }
    return getRawDb()
        .prepare(statement)
        .run(...parameters).changes;
}

function leaseLost(): Error {
    const error = new Error('Background job lease was superseded');
    error.name = 'BackgroundJobLeaseLostError';
    return error;
}

const ADMISSION_CANCEL_TTL_MS = 10 * 60 * 1000;

function admissionCancelled(admissionId: string): Error {
    const error = new Error(
        `Background admission ${admissionId} was cancelled`
    );
    error.name = 'AdmissionCancelledError';
    return error;
}

async function isAdmissionCancelled(
    userId: string,
    admissionId: string,
    now: number
): Promise<boolean> {
    const row = await one<{ hit: number }>(
        `SELECT 1 AS hit FROM background_admission_cancels
         WHERE user_id = ? AND admission_id = ? AND expires_at > ?`,
        userId,
        admissionId,
        now
    );
    return row !== undefined;
}

function insertParameters(
    id: string,
    params: CreateJobParams,
    now: number
): unknown[] {
    return [
        id,
        params.userId,
        params.threadId,
        params.messageId,
        params.model,
        params.kind ?? null,
        params.initialContent ?? '',
        params.initialReasoning ?? '',
        params.generationId ?? null,
        params.historyPhase ?? 'ready',
        params.syncProviderId ?? null,
        now,
        now,
        json(params.tool_calls),
        json(params.workflow_state),
        json(params.execution),
        params.idempotencyKey ?? null
    ];
}

const INSERT_JOB = `INSERT INTO background_jobs (
    id, user_id, thread_id, message_id, model, kind, status, content,
    reasoning, generation_id, history_phase, sync_provider_id,
    chunks_received, started_at, last_activity_at, tool_calls_json,
    workflow_state_json, execution_json, idempotency_key, attempts
) VALUES (?, ?, ?, ?, ?, ?, 'streaming', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 0)`;

const INSERT_JOB_IF_CAPACITY = `INSERT INTO background_jobs (
    id, user_id, thread_id, message_id, model, kind, status, content,
    reasoning, generation_id, history_phase, sync_provider_id,
    chunks_received, started_at, last_activity_at, tool_calls_json,
    workflow_state_json, execution_json, idempotency_key, attempts
) SELECT ?, ?, ?, ?, ?, ?, 'streaming', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 0
  WHERE (? = 1 OR (SELECT COUNT(*) FROM background_jobs WHERE status = 'streaming'
           AND json_extract(execution_json, '$.clientToolCall') IS NULL
           AND delegation_wait_active = 0 AND json_type(execution_json, '$.delegationWait') IS NULL) < ?)
    AND (? = 1 OR (SELECT COUNT(*) FROM background_jobs WHERE status = 'streaming' AND user_id = ?
           AND json_extract(execution_json, '$.clientToolCall') IS NULL
           AND delegation_wait_active = 0 AND json_type(execution_json, '$.delegationWait') IS NULL) < ?)
    AND (? = 0 OR (SELECT COUNT(*) FROM background_jobs WHERE status = 'streaming'
           AND (json_extract(execution_json, '$.clientToolCall') IS NOT NULL
             OR delegation_wait_active = 1 OR json_type(execution_json, '$.delegationWait') IS NOT NULL)) < ?)
    AND (? = 0 OR (SELECT COUNT(*) FROM background_jobs WHERE status = 'streaming' AND user_id = ?
           AND (json_extract(execution_json, '$.clientToolCall') IS NOT NULL
             OR delegation_wait_active = 1 OR json_type(execution_json, '$.delegationWait') IS NOT NULL)) < ?)
    AND NOT EXISTS (
        SELECT 1 FROM background_admission_cancels
        WHERE user_id = ? AND admission_id = ? AND expires_at > ?
    )
  ON CONFLICT(idempotency_key) DO NOTHING
  RETURNING id`;

export class SqliteBackgroundJobProvider implements BackgroundJobProvider {
    readonly name = 'sqlite';

    // Advertise only after the native database has completed the required migration.
    // Other drivers remain disabled until their coordination contracts are qualified.
    get delegationCoordinatorVersion(): 1 | undefined {
        if (getSqliteDriver() !== 'better-sqlite3') return undefined;
        try {
            const applied = getRawDb().prepare(
                "SELECT 1 AS applied FROM kysely_migration WHERE name = ?"
            ).get('029_delegation_wait') as { applied?: number } | undefined;
            return applied?.applied === 1 ? 1 : undefined;
        } catch {
            return undefined;
        }
    }
    private lastDelegationDiagnosticCheckAt?: number;

    async createJob(params: CreateJobParams): Promise<string> {
        const now = Date.now();
        const id = randomUUID();
        const config = getJobConfig();
        const execution = params.execution;
        if (execution && 'delegationWait' in execution) {
            throw new Error('Delegation waits must be parked through the fenced transition');
        }
        const parked = Boolean(execution && 'clientToolCall' in execution && execution.clientToolCall != null);
        if (isD1Driver()) {
            if (params.idempotencyKey) {
                const existing = await one<{ id: string }>(
                    'SELECT id FROM background_jobs WHERE idempotency_key = ?',
                    params.idempotencyKey
                );
                if (existing) return existing.id;
                if (
                    await isAdmissionCancelled(
                        params.userId,
                        params.idempotencyKey,
                        now
                    )
                ) {
                    throw admissionCancelled(params.idempotencyKey);
                }
            }
            const inserted = await all<{ id: string }>(
                INSERT_JOB_IF_CAPACITY,
                ...insertParameters(id, params, now),
                Number(parked),
                config.maxConcurrentJobs,
                Number(parked),
                params.userId,
                config.maxConcurrentJobsPerUser,
                Number(parked),
                config.maxConcurrentJobs,
                Number(parked),
                params.userId,
                config.maxConcurrentJobsPerUser,
                params.userId,
                params.idempotencyKey ?? '',
                now
            );
            if (inserted[0]) return inserted[0].id;
            if (params.idempotencyKey) {
                const existing = await one<{ id: string }>(
                    'SELECT id FROM background_jobs WHERE idempotency_key = ?',
                    params.idempotencyKey
                );
                if (existing) return existing.id;
                if (
                    await isAdmissionCancelled(
                        params.userId,
                        params.idempotencyKey,
                        now
                    )
                ) {
                    throw admissionCancelled(params.idempotencyKey);
                }
            }
            throw new Error('Maximum concurrent background jobs reached');
        }

        const raw = getRawDb();
        return raw
            .transaction(() => {
                if (params.idempotencyKey) {
                    const existing = raw
                        .prepare(
                            'SELECT id FROM background_jobs WHERE idempotency_key = ?'
                        )
                        .get(params.idempotencyKey) as
                        | { id: string }
                        | undefined;
                    if (existing) return existing.id;
                    const cancelled = raw
                        .prepare(
                            `SELECT 1 AS hit FROM background_admission_cancels
                             WHERE user_id = ? AND admission_id = ?
                               AND expires_at > ?`
                        )
                        .get(
                            params.userId,
                            params.idempotencyKey,
                            now
                        ) as { hit: number } | undefined;
                    if (cancelled) {
                        throw admissionCancelled(params.idempotencyKey);
                    }
                }
                const active = raw
                    .prepare(
                        `SELECT
                    SUM(CASE WHEN json_extract(execution_json, '$.clientToolCall') IS NULL AND delegation_wait_active = 0 AND json_type(execution_json, '$.delegationWait') IS NULL THEN 1 ELSE 0 END) AS total,
                    SUM(CASE WHEN user_id = ? AND json_extract(execution_json, '$.clientToolCall') IS NULL AND delegation_wait_active = 0 AND json_type(execution_json, '$.delegationWait') IS NULL THEN 1 ELSE 0 END) AS user_total,
                    SUM(CASE WHEN json_extract(execution_json, '$.clientToolCall') IS NOT NULL OR delegation_wait_active = 1 OR json_type(execution_json, '$.delegationWait') IS NOT NULL THEN 1 ELSE 0 END) AS waiting_total,
                    SUM(CASE WHEN user_id = ? AND (json_extract(execution_json, '$.clientToolCall') IS NOT NULL OR delegation_wait_active = 1 OR json_type(execution_json, '$.delegationWait') IS NOT NULL) THEN 1 ELSE 0 END) AS waiting_user_total
                 FROM background_jobs WHERE status = 'streaming'`
                    )
                    .get(params.userId, params.userId) as {
                    total: number | null;
                    user_total: number | null;
                    waiting_total: number | null;
                    waiting_user_total: number | null;
                };
                const capacityExceeded = parked
                    ? (active.waiting_total ?? 0) >= config.maxConcurrentJobs ||
                      (active.waiting_user_total ?? 0) >= config.maxConcurrentJobsPerUser
                    : (active.total ?? 0) >= config.maxConcurrentJobs ||
                      (active.user_total ?? 0) >= config.maxConcurrentJobsPerUser;
                if (capacityExceeded) {
                    throw new Error(
                        'Maximum concurrent background jobs reached'
                    );
                }
                raw.prepare(INSERT_JOB).run(
                    ...insertParameters(id, params, now)
                );
                return id;
            })
            .immediate();
    }

    async getJob(jobId: string, userId: string): Promise<BackgroundJob | null> {
        const row = await one<JobRow>(
            `SELECT * FROM background_jobs WHERE id = ?${userId === '*' ? '' : ' AND user_id = ?'}`,
            ...[jobId, ...(userId === '*' ? [] : [userId])]
        );
        return row ? toJob(row) : null;
    }

    async findJobByIdempotencyKey(
        idempotencyKey: string,
        userId: string
    ): Promise<BackgroundJob | null> {
        const row = await one<JobRow>(
            'SELECT * FROM background_jobs WHERE idempotency_key = ? AND user_id = ?',
            idempotencyKey,
            userId
        );
        return row ? toJob(row) : null;
    }

    async cancelAdmission(
        userId: string,
        admissionId: string
    ): Promise<AdmissionCancellationResult> {
        const now = Date.now();
        const expiresAt = now + ADMISSION_CANCEL_TTL_MS;
        const upsertMarker = `INSERT INTO background_admission_cancels
                (user_id, admission_id, expires_at)
             VALUES (?, ?, ?)
             ON CONFLICT(user_id, admission_id)
             DO UPDATE SET expires_at = excluded.expires_at`;
        const abortJob = `UPDATE background_jobs SET status = 'aborted',
                completed_at = ?, last_activity_at = ?, error = ?,
                lease_owner = NULL, lease_expires_at = NULL,
                execution_json = CASE WHEN json_type(execution_json, '$.delegationWait') = 'object'
                    THEN json_set(execution_json, '$.delegationWait.nextCheckAt', ?) ELSE execution_json END,
                history_phase = CASE
                    WHEN generation_id IS NOT NULL
                      AND COALESCE(history_phase, 'ready') = 'ready'
                    THEN 'finalization_pending'
                    ELSE history_phase END
             WHERE id = ? AND status = 'streaming'`;

        if (!isD1Driver()) {
            const raw = getRawDb();
            return raw
                .transaction(() => {
                    raw.prepare(
                        'DELETE FROM background_admission_cancels WHERE expires_at <= ?'
                    ).run(now);
                    raw.prepare(upsertMarker).run(userId, admissionId, expiresAt);
                    const job = raw
                        .prepare(
                            'SELECT id, status FROM background_jobs WHERE user_id = ? AND idempotency_key = ?'
                        )
                        .get(userId, admissionId) as
                        | { id: string; status: BackgroundJob['status'] }
                        | undefined;
                    if (!job) {
                        return { aborted: false, pending: true };
                    }
                    if (job.status === 'streaming') {
                        const changes = raw
                            .prepare(abortJob)
                            .run(
                                now,
                                now,
                                'Cancelled by user',
                                now,
                                job.id
                            ).changes;
                        return {
                            aborted: changes > 0,
                            jobId: job.id,
                            pending: false,
                        };
                    }
                    return { aborted: false, jobId: job.id, pending: false };
                })
                .immediate();
        }

        await run(
            'DELETE FROM background_admission_cancels WHERE expires_at <= ?',
            now
        );
        await run(upsertMarker, userId, admissionId, expiresAt);
        const job = await one<{
            id: string;
            status: BackgroundJob['status'];
        }>(
            'SELECT id, status FROM background_jobs WHERE user_id = ? AND idempotency_key = ?',
            userId,
            admissionId
        );
        if (!job) {
            return { aborted: false, pending: true };
        }
        if (job.status === 'streaming') {
            const changes = await run(
                abortJob,
                now,
                now,
                'Cancelled by user',
                now,
                job.id
            );
            return {
                aborted: changes > 0,
                jobId: job.id,
                pending: false,
            };
        }
        return { aborted: false, jobId: job.id, pending: false };
    }

    async updateJob(jobId: string, update: JobUpdate): Promise<void> {
        const sets = ['last_activity_at = ?'];
        const values: unknown[] = [Date.now()];
        if (update.contentChunk !== undefined) {
            sets.push('content = content || ?');
            values.push(update.contentChunk);
        }
        if (update.reasoningChunk !== undefined) {
            sets.push('reasoning = reasoning || ?');
            values.push(update.reasoningChunk);
        }
        if (update.chunksReceived !== undefined) {
            sets.push('chunks_received = ?');
            values.push(update.chunksReceived);
        }
        if (update.tool_calls !== undefined) {
            sets.push('tool_calls_json = ?');
            values.push(json(update.tool_calls));
        }
        if (update.workflow_state !== undefined) {
            sets.push('workflow_state_json = ?');
            values.push(json(update.workflow_state));
        }
        const usage = readRequestUsage(update.usage);
        if (usage) {
            // Each event is the last measured request, never a token increment.
            sets.push('usage_json = ?');
            values.push(json(usage));
        }
        values.push(jobId);
        let where = "id = ? AND status = 'streaming'";
        if (update.leaseOwner) {
            where += ' AND lease_owner = ? AND lease_expires_at > ?';
            values.push(update.leaseOwner);
            values.push(Date.now());
        } else {
            where += ' AND lease_owner IS NULL';
        }
        const changes = await run(
            `UPDATE background_jobs SET ${sets.join(', ')} WHERE ${where}`,
            ...values
        );
        if (update.leaseOwner && changes === 0) throw leaseLost();
    }

    async completeJob(
        jobId: string,
        finalContent: string,
        leaseOwner?: string
    ): Promise<void> {
        await this.finish(jobId, 'complete', finalContent, null, leaseOwner);
    }

    async failJob(
        jobId: string,
        error: string,
        leaseOwner?: string
    ): Promise<void> {
        await this.finish(jobId, 'error', null, error, leaseOwner);
    }

    private async finish(
        jobId: string,
        status: 'complete' | 'error',
        content: string | null,
        error: string | null,
        leaseOwner?: string
    ): Promise<void> {
        const now = Date.now();
        const values: unknown[] = [status, now, now, error];
        const contentSet = content === null ? '' : ', content = ?';
        if (content !== null) values.push(content);
        values.push(jobId);
        let where = "id = ? AND status = 'streaming'";
        if (leaseOwner) {
            where += ' AND lease_owner = ? AND lease_expires_at > ?';
            values.push(leaseOwner, now);
        } else {
            where += ' AND lease_owner IS NULL';
        }
        const changes = await run(
            `UPDATE background_jobs SET status = ?, completed_at = ?, last_activity_at = ?,
                error = ?, lease_owner = NULL, lease_expires_at = NULL${contentSet}
             WHERE ${where}`,
            ...values
        );
        if (leaseOwner && changes === 0) throw leaseLost();
    }

    async abortJob(jobId: string, userId: string): Promise<boolean> {
        const now = Date.now();
        return (
            (await run(
                `UPDATE background_jobs SET status = 'aborted', completed_at = ?,
                last_activity_at = ?, lease_owner = NULL, lease_expires_at = NULL,
                execution_json = CASE WHEN json_type(execution_json, '$.delegationWait') = 'object'
                    THEN json_set(execution_json, '$.delegationWait.nextCheckAt', ?) ELSE execution_json END,
                history_phase = CASE
                    WHEN generation_id IS NOT NULL
                      AND COALESCE(history_phase, 'ready') = 'ready'
                    THEN 'finalization_pending'
                    ELSE history_phase END
             WHERE id = ? AND user_id = ? AND status = 'streaming'`,
                now,
                now,
                now,
                jobId,
                userId
            )) > 0
        );
    }

    getAbortController(): undefined {
        return undefined;
    }

    async checkJobAborted(jobId: string): Promise<boolean> {
        const row = await one<{ status: BackgroundJob['status'] }>(
            'SELECT status FROM background_jobs WHERE id = ?',
            jobId
        );
        return row?.status === 'aborted';
    }

    async claimJob(
        jobId: string,
        leaseOwner: string,
        now: number,
        leaseExpiresAt: number
    ): Promise<BackgroundJob | null> {
        // Recovery must reproduce the memory/Convex contract: a reclaimed job
        // resets text/iteration progress to its checkpoint before new deltas
        // append. Otherwise the restarted model appends onto pre-crash output.
        const row = await one<JobRow>(
            `UPDATE background_jobs SET
                lease_owner = ?,
                lease_expires_at = ?,
                last_activity_at = ?,
                content = CASE WHEN attempts > 0 AND json_type(execution_json, '$.delegationDispatch') IS NULL
                    THEN COALESCE(json_extract(execution_json, '$.contentBase'), '')
                    ELSE content END,
                reasoning = CASE WHEN attempts > 0 AND json_type(execution_json, '$.delegationDispatch') IS NULL
                    THEN COALESCE(json_extract(execution_json, '$.reasoningBase'), '')
                    ELSE reasoning END,
                usage_json = CASE WHEN attempts > 0 AND json_type(execution_json, '$.delegationDispatch') IS NULL
                    THEN CASE WHEN json_type(execution_json, '$.normalizedToolState.requestUsage') = 'object'
                        THEN json_extract(execution_json, '$.normalizedToolState.requestUsage')
                        ELSE NULL END
                    ELSE usage_json END,
                chunks_received = CASE WHEN attempts > 0 AND json_type(execution_json, '$.delegationDispatch') IS NULL THEN 0 ELSE chunks_received END,
                attempts = attempts + 1
             WHERE id = ? AND status = 'streaming' AND execution_json IS NOT NULL
               AND json_extract(execution_json, '$.clientToolCall') IS NULL
               AND delegation_wait_active = 0 AND json_type(execution_json, '$.delegationWait') IS NULL
               AND COALESCE(history_phase, 'ready') = 'ready'
               AND (lease_owner IS NULL OR lease_expires_at <= ?)
             RETURNING *`,
            leaseOwner,
            leaseExpiresAt,
            now,
            jobId,
            now
        );
        return row ? toJob(row) : null;
    }

    async claimNextJob(
        leaseOwner: string,
        now: number,
        leaseExpiresAt: number
    ): Promise<BackgroundJob | null> {
        const row = await one<JobRow>(
            `UPDATE background_jobs SET
                lease_owner = ?,
                lease_expires_at = ?,
                last_activity_at = ?,
                content = CASE WHEN attempts > 0 AND json_type(execution_json, '$.delegationDispatch') IS NULL
                    THEN COALESCE(json_extract(execution_json, '$.contentBase'), '')
                    ELSE content END,
                reasoning = CASE WHEN attempts > 0 AND json_type(execution_json, '$.delegationDispatch') IS NULL
                    THEN COALESCE(json_extract(execution_json, '$.reasoningBase'), '')
                    ELSE reasoning END,
                usage_json = CASE WHEN attempts > 0 AND json_type(execution_json, '$.delegationDispatch') IS NULL
                    THEN CASE WHEN json_type(execution_json, '$.normalizedToolState.requestUsage') = 'object'
                        THEN json_extract(execution_json, '$.normalizedToolState.requestUsage')
                        ELSE NULL END
                    ELSE usage_json END,
                chunks_received = CASE WHEN attempts > 0 AND json_type(execution_json, '$.delegationDispatch') IS NULL THEN 0 ELSE chunks_received END,
                attempts = attempts + 1
             WHERE id = (
                SELECT id FROM background_jobs
                WHERE status = 'streaming' AND execution_json IS NOT NULL
                  AND json_extract(execution_json, '$.clientToolCall') IS NULL
                  AND delegation_wait_active = 0 AND json_type(execution_json, '$.delegationWait') IS NULL
                  AND COALESCE(history_phase, 'ready') = 'ready'
                  AND (lease_owner IS NULL OR lease_expires_at <= ?)
                ORDER BY started_at ASC LIMIT 1
             ) RETURNING *`,
            leaseOwner,
            leaseExpiresAt,
            now,
            now
        );
        return row ? toJob(row) : null;
    }

    async beginDelegationDispatch(jobId: string, leaseOwner: string): Promise<DelegationDispatch | null> {
        if (isD1Driver()) throw new Error('Delegation dispatch is unavailable for D1');
        const now = Date.now();
        const row = await one<{ execution_json: string }>(
            `UPDATE background_jobs SET execution_json = json_set(execution_json,
                '$.delegationDispatchSequence', COALESCE(json_extract(execution_json, '$.delegationDispatchSequence'), 0) + 1,
                '$.delegationDispatch', json_object('version', 1, 'sequence',
                    COALESCE(json_extract(execution_json, '$.delegationDispatchSequence'), 0) + 1, 'state', 'started')),
                last_activity_at = ?
             WHERE id = ? AND status = 'streaming' AND lease_owner = ? AND lease_expires_at > ?
               AND COALESCE(history_phase, 'ready') = 'ready'
               AND json_extract(execution_json, '$.delegationRecoveryPolicy') = 'v1'
               AND json_type(execution_json, '$.delegationDispatch') IS NULL
               AND delegation_wait_active = 0 AND json_type(execution_json, '$.delegationWait') IS NULL
               AND json_type(execution_json, '$.clientToolCall') IS NULL
               AND json_type(execution_json, '$.cancellationRequestedAt') IS NULL
               AND (json_type(execution_json, '$.delegationDispatchSequence') IS NULL OR
                    (json_type(execution_json, '$.delegationDispatchSequence') = 'integer'
                     AND json_extract(execution_json, '$.delegationDispatchSequence') BETWEEN 0 AND 9007199254740990))
             RETURNING execution_json`, now, jobId, leaseOwner, now
        );
        return row ? DelegationDispatchSchema.parse(JSON.parse(row.execution_json).delegationDispatch) : null;
    }

    async commitDelegationDispatch(jobId: string, leaseOwner: string, sequence: number,
        execution: BackgroundJobExecution, toolCalls: BackgroundJob['tool_calls']): Promise<boolean> {
        if (isD1Driver()) throw new Error('Delegation dispatch is unavailable for D1');
        if (!Number.isSafeInteger(sequence) || sequence < 1 || execution.version !== 1 ||
            execution.delegationRecoveryPolicy !== 'v1' || execution.delegationDispatchSequence !== sequence ||
            execution.delegationDispatch !== undefined || execution.cancellationRequestedAt !== undefined ||
            execution.delegationWait !== undefined || execution.clientToolCall !== undefined) return false;
        const now = Date.now();
        return (await run(`UPDATE background_jobs SET execution_json = ?, tool_calls_json = ?, last_activity_at = ?
            WHERE id = ? AND status = 'streaming' AND lease_owner = ? AND lease_expires_at > ?
              AND COALESCE(history_phase, 'ready') = 'ready'
              AND json_extract(execution_json, '$.workspaceId') = ?
              AND json_extract(execution_json, '$.delegationRecoveryPolicy') = 'v1'
              AND json_extract(execution_json, '$.delegationDispatchSequence') = ?
              AND json_extract(execution_json, '$.delegationDispatch.version') = 1
              AND json_extract(execution_json, '$.delegationDispatch.state') = 'started'
              AND json_extract(execution_json, '$.delegationDispatch.sequence') = ?
              AND json_extract(execution_json, '$.delegationDefaults') IS json_extract(?, '$.delegationDefaults')
              AND json_type(execution_json, '$.cancellationRequestedAt') IS NULL`,
            json(execution), json(toolCalls), now, jobId, leaseOwner, now, execution.workspaceId, sequence, sequence, json(execution))) > 0;
    }

    async parkDelegationWait(
        jobId: string,
        leaseOwner: string,
        execution: BackgroundJobExecution,
        toolCalls: BackgroundJob['tool_calls']
    ): Promise<boolean> {
        const now = Date.now();
        const parsed = DelegationWaitSchema.safeParse(execution.delegationWait);
        if (!parsed.success || execution.version !== 1 || execution.delegationRecoveryPolicy !== 'v1' ||
            (execution.delegationDispatchSequence !== undefined && (!Number.isSafeInteger(execution.delegationDispatchSequence) || execution.delegationDispatchSequence < 0)) || execution.clientToolCall ||
            execution.cancellationRequestedAt !== undefined || execution.delegationDispatch || parsed.data.expiredAt !== undefined || parsed.data.deadlineAt <= now)
            throw new Error('Invalid delegation wait checkpoint');
        const config = getJobConfig();
        const row = await one<{ id: string }>(
            `UPDATE background_jobs SET execution_json = ?, tool_calls_json = ?, delegation_wait_active = 1, delegation_wait_deadline = ?,
                lease_owner = NULL, lease_expires_at = NULL, last_activity_at = ?
             WHERE id = ? AND status = 'streaming' AND lease_owner = ? AND lease_expires_at > ?
               AND COALESCE(history_phase, 'ready') = 'ready'
               AND json_extract(execution_json, '$.workspaceId') = ?
               AND json_extract(execution_json, '$.delegationRecoveryPolicy') = 'v1'
               AND json_extract(execution_json, '$.delegationDefaults') IS json_extract(?, '$.delegationDefaults')
               AND json_type(execution_json, '$.delegationDispatch') IS NULL
               AND (json_type(execution_json, '$.delegationDispatchSequence') IS NULL OR
                    (json_type(execution_json, '$.delegationDispatchSequence') = 'integer'
                     AND json_extract(execution_json, '$.delegationDispatchSequence') BETWEEN 0 AND 9007199254740991))
               AND COALESCE(json_extract(execution_json, '$.delegationDispatchSequence'), 0) = ?
               AND json_type(execution_json, '$.cancellationRequestedAt') IS NULL
               AND delegation_wait_active = 0 AND json_type(execution_json, '$.delegationWait') IS NULL
               AND json_extract(execution_json, '$.clientToolCall') IS NULL
               AND (SELECT COUNT(*) FROM background_jobs WHERE status = 'streaming'
                    AND (json_extract(execution_json, '$.clientToolCall') IS NOT NULL
                         OR delegation_wait_active = 1 OR json_type(execution_json, '$.delegationWait') IS NOT NULL)) < ?
               AND (SELECT COUNT(*) FROM background_jobs WHERE status = 'streaming'
                    AND user_id = (SELECT user_id FROM background_jobs WHERE id = ?)
                    AND (json_extract(execution_json, '$.clientToolCall') IS NOT NULL
                         OR delegation_wait_active = 1 OR json_type(execution_json, '$.delegationWait') IS NOT NULL)) < ?
             RETURNING id`,
            json(execution), json(toolCalls), parsed.data.deadlineAt, now, jobId, leaseOwner, now, execution.workspaceId, json(execution), execution.delegationDispatchSequence ?? 0,
            config.maxConcurrentJobs, jobId, config.maxConcurrentJobsPerUser
        );
        return Boolean(row);
    }

    async claimNextDelegationWait(
        leaseOwner: string,
        now: number,
        leaseExpiresAt: number
    ): Promise<BackgroundJob | null> {
        if (!leaseOwner || !Number.isSafeInteger(now) || !Number.isSafeInteger(leaseExpiresAt) || leaseExpiresAt <= now)
            throw new Error('Invalid delegation coordinator lease');
        // A damaged checkpoint cannot reconstruct settlements, but terminal parents
        // still must stop their own linked children. Preserve every row for repair.
        // Process a bounded batch and check the owner on both sides of the link.
        await run(`UPDATE background_jobs SET status = 'aborted', completed_at = ?, last_activity_at = ?,
                lease_owner = NULL, lease_expires_at = NULL,
                history_phase = CASE WHEN generation_id IS NOT NULL AND COALESCE(history_phase, 'ready') = 'ready'
                    THEN 'finalization_pending' ELSE history_phase END
            WHERE status = 'streaming' AND id IN (
                SELECT child.id FROM background_jobs AS parent CROSS JOIN background_jobs AS child
                WHERE child.delegation_parent_id = parent.id AND child.user_id = parent.user_id
                  AND parent.delegation_wait_active = 1 AND parent.status != 'streaming'
                  AND (json_type(parent.execution_json, '$.delegationWait') IS NOT 'object' OR
                    (json_extract(parent.execution_json, '$.delegationWait.version') = 1 AND
                      (json_type(parent.execution_json, '$.delegationQuarantinedAt') IS NOT NULL OR
                       json_extract(parent.execution_json, '$.delegationWait.deadlineAt') IS NOT parent.delegation_wait_deadline)))
                  AND child.status = 'streaming'
                ORDER BY parent.started_at, parent.id, child.id LIMIT 20
            )`, now, now);
        // The original deadline is independent of the checkpoint. If that
        // checkpoint is missing, quarantined, or has a changed v1 deadline,
        // request cancellation without fabricating a parent or child result.
        await run(`UPDATE background_jobs SET status = 'aborted', completed_at = ?, last_activity_at = ?,
                lease_owner = NULL, lease_expires_at = NULL,
                history_phase = CASE WHEN generation_id IS NOT NULL AND COALESCE(history_phase, 'ready') = 'ready'
                    THEN 'finalization_pending' ELSE history_phase END
            WHERE status = 'streaming' AND id IN (
                SELECT child.id FROM background_jobs AS parent CROSS JOIN background_jobs AS child
                WHERE child.delegation_parent_id = parent.id AND child.user_id = parent.user_id
                  AND parent.delegation_wait_active = 1 AND parent.status = 'streaming'
                  AND (parent.delegation_wait_deadline IS NULL OR parent.delegation_wait_deadline <= ?)
                  AND (json_type(parent.execution_json, '$.delegationWait') IS NOT 'object' OR
                    (json_extract(parent.execution_json, '$.delegationWait.version') = 1 AND
                      (json_type(parent.execution_json, '$.delegationQuarantinedAt') IS NOT NULL OR
                       json_extract(parent.execution_json, '$.delegationWait.deadlineAt') IS NOT parent.delegation_wait_deadline)))
                  AND child.status = 'streaming'
                ORDER BY parent.delegation_wait_deadline, parent.started_at, parent.id, child.id LIMIT 20
            )`, now, now, now);
        if (this.lastDelegationDiagnosticCheckAt === undefined || now < this.lastDelegationDiagnosticCheckAt ||
            now - this.lastDelegationDiagnosticCheckAt >= 60_000) {
            const unsupported = await all<{ id: string }>(
                `SELECT id FROM background_jobs WHERE status IN ('streaming', 'complete', 'error', 'aborted')
                   AND json_type(execution_json, '$.delegationWait') IS NOT NULL
                   AND (json_extract(execution_json, '$.version') IS NOT 1
                        OR json_extract(execution_json, '$.delegationWait.version') IS NOT 1)
                 ORDER BY started_at, id LIMIT 20`
            );
            const quarantined = await all<{ id: string }>(
                `SELECT id FROM background_jobs WHERE status IN ('streaming', 'complete', 'error', 'aborted')
                   AND json_type(execution_json, '$.delegationQuarantinedAt') IS NOT NULL
                 ORDER BY started_at, id LIMIT 20`
            );
            const missing = await all<{ id: string }>(
                `SELECT id FROM background_jobs WHERE delegation_wait_active = 1
                   AND json_type(execution_json, '$.delegationWait') IS NULL
                 ORDER BY started_at, id LIMIT 20`
            );
            this.lastDelegationDiagnosticCheckAt = now;
            const blocked = [
                missing.length && `missing wait: ${missing.map(row => row.id).join(', ')}`,
                unsupported.length && `unsupported: ${unsupported.map(row => row.id).join(', ')}`,
                quarantined.length && `quarantined: ${quarantined.map(row => row.id).join(', ')}`,
            ].filter(Boolean);
            if (blocked.length) console.warn(`[background-jobs] Delegation checkpoints block recovery (up to 20 job IDs per category): ${blocked.join('; ')}.`);
        }
        // A missing or invalid due time can never enter the normal due queue.
        // Quarantine at most one such v1 row atomically, then still claim due
        // work so a damaged backlog cannot monopolize the recovery worker.
        const invalid = await one<{ id: string }>(
            `UPDATE background_jobs SET
                execution_json = json_set(execution_json, '$.delegationQuarantinedAt', ?),
                lease_owner = NULL, lease_expires_at = NULL
             WHERE id = (
                 SELECT id FROM background_jobs WHERE status IN ('streaming', 'complete', 'error', 'aborted')
                   AND json_extract(execution_json, '$.version') = 1
                   AND json_type(execution_json, '$.delegationWait') IS NOT NULL
                   AND json_extract(execution_json, '$.delegationWait.version') = 1
                   AND json_type(execution_json, '$.delegationQuarantinedAt') IS NULL
                   AND (COALESCE(json_type(execution_json, '$.delegationWait.nextCheckAt'), 'missing') NOT IN ('integer', 'real')
                        OR json_extract(execution_json, '$.delegationWait.nextCheckAt') < 0
                        OR json_extract(execution_json, '$.delegationWait.nextCheckAt') > 9007199254740991
                        OR json_extract(execution_json, '$.delegationWait.nextCheckAt') != CAST(json_extract(execution_json, '$.delegationWait.nextCheckAt') AS INTEGER))
                   AND (lease_owner IS NULL OR lease_expires_at <= ?)
                 ORDER BY started_at, id LIMIT 1
             ) RETURNING id`, now, now
        );
        if (invalid) console.warn(`[background-jobs] Quarantined delegation wait with invalid next-check time (job ${invalid.id}).`);
        const row = await one<JobRow>(
            `UPDATE background_jobs SET lease_owner = ?, lease_expires_at = ?, last_activity_at = ?
             WHERE id = (
                 SELECT id FROM background_jobs WHERE status IN ('streaming', 'complete', 'error', 'aborted')
                   AND json_extract(execution_json, '$.version') = 1
                   AND json_type(execution_json, '$.delegationWait') IS NOT NULL
                   AND json_extract(execution_json, '$.delegationWait.version') = 1
                   AND json_type(execution_json, '$.delegationQuarantinedAt') IS NULL
                   AND json_type(execution_json, '$.delegationWait.nextCheckAt') IN ('integer', 'real')
                   AND json_extract(execution_json, '$.delegationWait.nextCheckAt') >= 0
                   AND json_extract(execution_json, '$.delegationWait.nextCheckAt') = CAST(json_extract(execution_json, '$.delegationWait.nextCheckAt') AS INTEGER)
                   AND json_extract(execution_json, '$.delegationWait.nextCheckAt') <= ?
                   AND (lease_owner IS NULL OR lease_expires_at <= ?)
                 ORDER BY json_extract(execution_json, '$.delegationWait.nextCheckAt'), started_at, id
                 LIMIT 1
             ) RETURNING *`, leaseOwner, leaseExpiresAt, now, now, now
        );
        if (!row) return null;
        const quarantineClaim = async () => {
            const changed = await run(`UPDATE background_jobs SET
                execution_json = json_set(execution_json, '$.delegationQuarantinedAt', ?),
                lease_owner = NULL, lease_expires_at = NULL
                WHERE id = ? AND status IN ('streaming', 'complete', 'error', 'aborted') AND lease_owner = ?
                  AND lease_expires_at > ?`, now, row.id, leaseOwner, Date.now());
            if (!changed) throw leaseLost();
        };
        let job: BackgroundJob;
        try {
            job = toJob(row);
        } catch {
            // Preserve unreadable columns and the wait while removing this row
            // from the due queue. The damage scan still stops linked children.
            await quarantineClaim();
            throw new Error(`Invalid delegation job checkpoint (job ${row.id})`);
        }
        const wait = DelegationWaitSchema.safeParse((job.execution as BackgroundJobExecution | undefined)?.delegationWait);
        if (!wait.success || !hasParkedDeadline(row, wait.data)) {
            // Preserve the checkpoint for diagnosis, but don't let a corrupt row
            // repeatedly monopolize the head of the due queue after each lease.
            await quarantineClaim();
            // Job IDs are opaque provider-generated identifiers; never log the
            // checkpoint, which can contain credentials and private messages.
            throw new Error(`Invalid delegation wait checkpoint (job ${job.id})`);
        }
        return job;
    }

    async admitDelegationChild(input: DelegationChildAdmission): Promise<DelegationChildAdmissionResult> {
        // D1 does not expose the native interactive transaction needed here.
        // Do not substitute multiple independent statements for an atomic link.
        if (isD1Driver()) throw new Error('Atomic delegation admission is unavailable for D1');
        const config = getJobConfig();
        const raw = getRawDb();
        return raw.transaction(() => {
            const now = Date.now();
            const parent = raw.prepare('SELECT * FROM background_jobs WHERE id = ?').get(input.parentJobId) as JobRow | undefined;
            if (!parent || parent.status !== 'streaming' || (parent.history_phase ?? 'ready') !== 'ready' ||
                parent.lease_owner !== input.leaseOwner ||
                !parent.lease_expires_at || parent.lease_expires_at <= now) return { status: 'not-owned' };
            const execution = parseJson<BackgroundJobExecution>(parent.execution_json);
            const parsed = DelegationWaitSchema.safeParse(execution?.delegationWait);
            if (!execution || 'delegationQuarantinedAt' in execution || !parsed.success || !hasParkedDeadline(parent, parsed.data))
                throw new Error('Invalid delegation wait checkpoint');
            const wait = parsed.data;
            if (wait.callId !== input.callId || wait.argumentFingerprint !== input.argumentFingerprint)
                throw new Error('Conflicting delegation identity');
            const prepared = wait.children[input.childIndex];
            if (!prepared || prepared.kind !== 'prepared' || prepared.index !== input.childIndex || prepared.settlement)
                throw new Error('Invalid delegation child');
            if (!parent.generation_id) throw new Error('Delegation parent has no generation identity');
            const identities = delegationChildIdentities({ userId: parent.user_id, workspaceId: execution.workspaceId,
                parentGenerationId: parent.generation_id, callId: wait.callId, index: prepared.index });
            if (prepared.admissionId !== identities.admissionId || prepared.threadId !== identities.threadId ||
                prepared.userMessageId !== identities.userMessageId || prepared.assistantMessageId !== identities.assistantMessageId)
                throw new Error('Delegation child identity is outside its parent scope');
            const admissionKey = getScopedAdmissionKey(parent.user_id, execution.workspaceId, prepared.admissionId);

            const params = input.child;
            const childExecution = params.execution;
            if (!childExecution || 'kind' in childExecution || childExecution.version !== 1 ||
                params.kind !== 'chat' || params.historyPhase !== 'admission_pending' ||
                params.userId !== parent.user_id || params.syncProviderId !== parent.sync_provider_id ||
                !params.syncProviderId || params.idempotencyKey !== admissionKey ||
                params.threadId !== prepared.threadId || params.messageId !== prepared.assistantMessageId ||
                params.model !== prepared.request.model || childExecution.body.model !== params.model ||
                params.initialContent || params.initialReasoning || params.tool_calls || params.workflow_state ||
                childExecution.workspaceId !== execution.workspaceId ||
                childExecution.apiKeyCiphertext !== execution.apiKeyCiphertext ||
                childExecution.credentialSource !== execution.credentialSource || childExecution.referer !== execution.referer ||
                childExecution.delegationRecoveryPolicy !== 'v1' ||
                childExecution.delegationWait || childExecution.clientToolCall || childExecution.delegationDispatch ||
                childExecution.cancellationRequestedAt !== undefined)
                throw new Error('Delegation child authority or identity mismatch');
            const history = parseChatGenerationAdmissionEnvelope(childExecution.history);
            if (history.version !== 1 || history.kind !== 'new-turn' ||
                history.admissionId !== prepared.admissionId || history.generationId !== params.generationId ||
                params.generationId !== identities.generationId || history.workspaceId !== execution.workspaceId ||
                history.threadId !== prepared.threadId || history.messageId !== prepared.assistantMessageId ||
                history.thread?.id !== prepared.threadId || history.userMessage?.id !== prepared.userMessageId ||
                history.userMessage.thread_id !== prepared.threadId || history.userMessage.role !== 'user' ||
                history.assistantMessage.id !== prepared.assistantMessageId ||
                history.assistantMessage.thread_id !== prepared.threadId || history.assistantMessage.role !== 'assistant')
                throw new Error('Delegation child history mismatch');

            const digest = delegationAdmissionFingerprint(params);
            if (digest !== prepared.admissionFingerprint)
                throw new Error('Delegation child admission does not match its checkpoint');
            if (delegationAdmissionFingerprint({ body: childExecution.body, history: childExecution.history }) !==
                delegationAdmissionFingerprint(prepared.admission))
                throw new Error('Delegation child admission does not match its saved request');
            if (execution.cancellationRequestedAt !== undefined) return { status: 'cancelled' };
            if (prepared.jobId) {
                const previous = raw.prepare(`SELECT id, delegation_admission_digest FROM background_jobs
                    WHERE id = ? AND user_id = ? AND idempotency_key = ? AND delegation_parent_id = ?`).get(
                    prepared.jobId, parent.user_id, admissionKey, parent.id
                ) as { id: string; delegation_admission_digest: string | null } | undefined;
                if (!previous || previous.delegation_admission_digest !== digest)
                    throw new Error('Conflicting delegation child admission');
                return { status: 'admitted', jobId: previous.id, replayed: true };
            }
            if (wait.deadlineAt <= now) return { status: 'expired' };
            if (wait.revision !== input.revision) return { status: 'not-owned' };
            const existing = raw.prepare('SELECT id FROM background_jobs WHERE idempotency_key = ?')
                .get(admissionKey);
            if (existing) throw new Error('Conflicting delegation child admission');
            const cancelled = raw.prepare(`SELECT 1 AS hit FROM background_admission_cancels
                WHERE user_id = ? AND admission_id = ? AND expires_at > ?`)
                .get(parent.user_id, admissionKey, now);
            if (cancelled) return { status: 'cancelled' };
            const active = raw.prepare(`SELECT COUNT(*) AS total,
                SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS user_total
                FROM background_jobs WHERE status = 'streaming'
                  AND json_extract(execution_json, '$.clientToolCall') IS NULL
                  AND delegation_wait_active = 0 AND json_type(execution_json, '$.delegationWait') IS NULL`)
                .get(parent.user_id) as { total: number; user_total: number | null };
            if (active.total >= config.maxConcurrentJobs || (active.user_total ?? 0) >= config.maxConcurrentJobsPerUser)
                return { status: 'capacity' };

            const admissionAt = Date.now();
            if (parent.lease_expires_at <= admissionAt) return { status: 'not-owned' };
            if (wait.deadlineAt <= admissionAt) return { status: 'expired' };
            const jobId = randomUUID();
            const children = wait.children.map((child, index) => index === input.childIndex ? { ...prepared, jobId } : child);
            const nextWait = DelegationWaitSchema.parse({ ...wait, children, revision: wait.revision + 1 });
            raw.prepare(INSERT_JOB).run(...insertParameters(jobId, params, admissionAt));
            raw.prepare('UPDATE background_jobs SET delegation_admission_digest = ?, delegation_parent_id = ? WHERE id = ?')
                .run(digest, parent.id, jobId);
            raw.prepare('UPDATE background_jobs SET execution_json = ?, last_activity_at = ? WHERE id = ?')
                .run(json({ ...execution, delegationWait: nextWait }), admissionAt, parent.id);
            return { status: 'admitted', jobId, replayed: false };
        }).immediate() as DelegationChildAdmissionResult;
    }

    async commitDelegationWait(input: DelegationWaitCommit): Promise<boolean> {
        if (isD1Driver()) throw new Error('Atomic delegation coordination is unavailable for D1');
        const proposed = DelegationWaitSchema.parse(input.wait);
        const raw = getRawDb();
        return raw.transaction(() => {
            const now = Date.now();
            const parent = raw.prepare('SELECT * FROM background_jobs WHERE id = ?').get(input.parentJobId) as JobRow | undefined;
            if (!parent || parent.lease_owner !== input.leaseOwner || !parent.lease_expires_at ||
                parent.lease_expires_at <= now) return false;
            const execution = parseJson<BackgroundJobExecution>(parent.execution_json);
            const previous = DelegationWaitSchema.safeParse(execution?.delegationWait);
            if (!execution || 'delegationQuarantinedAt' in execution || !previous.success || !hasParkedDeadline(parent, previous.data))
                throw new Error('Invalid delegation wait checkpoint');
            const wait = previous.data;
            if (wait.revision !== input.expectedRevision) return false;
            if (proposed.revision !== wait.revision + 1 || proposed.callId !== wait.callId ||
                proposed.argumentFingerprint !== wait.argumentFingerprint || proposed.deadlineAt !== wait.deadlineAt || proposed.expiredAt !== wait.expiredAt ||
                proposed.children.length !== wait.children.length)
                throw new Error('Invalid delegation wait transition');

            for (let index = 0; index < wait.children.length; index++) {
                const before = wait.children[index]!;
                const after = proposed.children[index]!;
                const { settlement: beforeSettlement, ...beforeIdentity } = before;
                const { settlement: afterSettlement, ...afterIdentity } = after;
                if (JSON.stringify(beforeIdentity) !== JSON.stringify(afterIdentity) ||
                    (beforeSettlement && JSON.stringify(beforeSettlement) !== JSON.stringify(afterSettlement)))
                    throw new Error('Invalid delegation child transition');
                if (!beforeSettlement && afterSettlement && after.kind === 'prepared' && after.jobId &&
                    ['complete', 'failed', 'stopped'].includes(afterSettlement.kind)) {
                    const child = raw.prepare(`SELECT status, history_phase, message_id, thread_id, content, error, execution_json FROM background_jobs
                        WHERE id = ? AND user_id = ? AND delegation_parent_id = ?`).get(
                        after.jobId, parent.user_id, parent.id
                    ) as Pick<JobRow, 'status' | 'history_phase' | 'message_id' | 'thread_id' | 'content' | 'error' | 'execution_json'> | undefined;
                    const expectedStatus = afterSettlement.kind === 'complete' ? 'complete'
                        : afterSettlement.kind === 'failed' ? 'error' : 'aborted';
                    if (!child || child.status !== expectedStatus || child.message_id !== after.assistantMessageId ||
                        child.thread_id !== after.threadId ||
                        (afterSettlement.kind === 'complete' && child.history_phase !== 'committed'))
                        throw new Error('Delegation child outcome is not confirmed');
                    if (afterSettlement.kind === 'failed' && normalizeError(child.error).code === 'ERR_MODEL_OUTCOME_UNKNOWN')
                        throw new Error('Delegation child outcome is uncertain');
                    if (afterSettlement.kind === 'stopped') {
                        const childExecution = parseJson<BackgroundJobExecution>(child.execution_json);
                        if (!childExecution || childExecution.delegationDispatch !== undefined)
                            throw new Error('Delegation child outcome is uncertain');
                    }
                    if (afterSettlement.kind === 'complete') {
                        const result = afterSettlement.result;
                        const matches = result.kind === 'inline' ? result.value === child.content
                            : matchesToolResultStorage(result.reference, child.content,
                                { threadId: parent.thread_id, parentAssistantId: parent.message_id, callId: `${wait.callId}:child:${index}` });
                        if (!matches) throw new Error('Delegation child result does not match its completed job');
                    }
                }
            }
            // Change only the wait path, preserving any other authoritative parent state.
            // The transaction serializes this update with Stop and admission.
            const committedAt = Date.now();
            if (parent.lease_expires_at <= committedAt) return false;
            return raw.prepare(`UPDATE background_jobs SET
                execution_json = json_set(execution_json, '$.delegationWait', json(?)),
                last_activity_at = ?, lease_owner = NULL, lease_expires_at = NULL
                WHERE id = ? AND status = ? AND lease_owner = ? AND lease_expires_at > ?
                  AND json_extract(execution_json, '$.delegationWait.revision') = ?`)
                .run(JSON.stringify(proposed), committedAt, parent.id, parent.status,
                    input.leaseOwner, committedAt, input.expectedRevision).changes > 0;
        }).immediate() as boolean;
    }

    async stopInvalidDelegationWait(input: {
        parentJobId: string; leaseOwner: string; expectedRevision: number; authorizationDenied?: boolean;
    }): Promise<'valid' | 'stopped' | 'not-owned' | 'unavailable'> {
        if (isD1Driver()) throw new Error('Atomic delegation coordination is unavailable for D1');
        const raw = getRawDb();
        return raw.transaction(() => {
            const now = Date.now();
            const parent = raw.prepare('SELECT * FROM background_jobs WHERE id = ?').get(input.parentJobId) as JobRow | undefined;
            if (!parent || parent.status !== 'streaming' || parent.lease_owner !== input.leaseOwner ||
                !parent.lease_expires_at || parent.lease_expires_at <= now) return 'not-owned';
            let execution: BackgroundJobExecution | undefined;
            try { execution = parseJson<BackgroundJobExecution>(parent.execution_json); } catch { return 'unavailable'; }
            const parsed = DelegationWaitSchema.safeParse(execution?.delegationWait);
            if (!execution || !parsed.success || !hasParkedDeadline(parent, parsed.data) || parsed.data.revision !== input.expectedRevision) return 'not-owned';
            if (parent.sync_provider_id !== 'sqlite' || !execution.history || !parent.generation_id) return 'unavailable';
            let admission: ReturnType<typeof parseChatGenerationAdmissionEnvelope>;
            try { admission = parseChatGenerationAdmissionEnvelope(execution.history); } catch { return 'unavailable'; }
            if (admission.workspaceId !== execution.workspaceId || admission.threadId !== parent.thread_id ||
                admission.messageId !== parent.message_id || admission.generationId !== parent.generation_id) return 'unavailable';
            const member = raw.prepare(`SELECT m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
                WHERE m.workspace_id = ? AND m.user_id = ? AND COALESCE(w.deleted, 0) = 0`)
                .get(execution.workspaceId, parent.user_id) as { role: string } | undefined;
            const thread = raw.prepare('SELECT data_json, deleted FROM s_threads WHERE workspace_id = ? AND id = ?')
                .get(execution.workspaceId, parent.thread_id) as { data_json: string; deleted: number } | undefined;
            const message = raw.prepare('SELECT data_json, clock, deleted FROM s_messages WHERE workspace_id = ? AND id = ?')
                .get(execution.workspaceId, parent.message_id) as { data_json: string; clock: number; deleted: number } | undefined;
            let invalid = input.authorizationDenied === true || !member || !['owner', 'editor'].includes(member.role) || !thread || !!thread.deleted || !message || !!message.deleted;
            if (!invalid && thread) {
                try {
                    const record = JSON.parse(thread.data_json) as { id?: unknown; project_id?: unknown; deleted?: unknown };
                    if (!record || typeof record !== 'object' || record.id !== parent.thread_id) return 'unavailable';
                    const ownership = resolveCanonicalProjectOwnership(raw, execution.workspaceId, parent.thread_id, record.project_id);
                    invalid = !!record.deleted || !!ownership.projectId;
                    if (!invalid && ownership.status !== 'resolved') return 'unavailable';
                } catch { return 'unavailable'; }
            }
            if (!invalid && message) {
                try {
                    const record = JSON.parse(message.data_json) as { id?: unknown; thread_id?: unknown; deleted?: unknown; data?: { generation_id?: unknown } };
                    if (!record || typeof record !== 'object' || typeof record.id !== 'string' || typeof record.thread_id !== 'string' ||
                        !record.data || typeof record.data !== 'object' || typeof record.data.generation_id !== 'string') return 'unavailable';
                    invalid = record.id !== parent.message_id || record.thread_id !== parent.thread_id || !!record.deleted ||
                        record.data?.generation_id !== parent.generation_id || message.clock !== admission.assistantMessage.clock;
                } catch { return 'unavailable'; }
            }
            if (!invalid) return 'valid';
            const changedAt = Date.now();
            const changed = raw.prepare(`UPDATE background_jobs SET status = 'aborted', completed_at = ?, last_activity_at = ?,
                history_phase = CASE WHEN generation_id IS NOT NULL AND COALESCE(history_phase, 'ready') = 'ready'
                    THEN 'finalization_pending' ELSE history_phase END
                WHERE id = ? AND status = 'streaming' AND lease_owner = ? AND lease_expires_at > ?
                  AND json_extract(execution_json, '$.delegationWait.revision') = ?`)
                .run(changedAt, changedAt, parent.id, input.leaseOwner, changedAt, input.expectedRevision);
            return changed.changes ? 'stopped' : 'not-owned';
        }).immediate() as 'valid' | 'stopped' | 'not-owned' | 'unavailable';
    }

    async cleanupDelegationWait(input: {
        parentJobId: string; leaseOwner: string; expectedRevision: number;
    }): Promise<'not-owned' | 'pending' | 'settled'> {
        return this.stopDelegationChildren(input, false);
    }

    async expireDelegationWait(input: {
        parentJobId: string; leaseOwner: string; expectedRevision: number;
    }): Promise<'not-owned' | 'pending'> {
        const result = await this.stopDelegationChildren(input, true);
        if (result === 'settled') throw new Error('Unexpected terminal delegation expiry');
        return result;
    }

    private async stopDelegationChildren(input: {
        parentJobId: string; leaseOwner: string; expectedRevision: number;
    }, expired: boolean): Promise<'not-owned' | 'pending' | 'settled'> {
        if (isD1Driver()) throw new Error('Atomic delegation coordination is unavailable for D1');
        const raw = getRawDb();
        const leaseLost = Symbol('delegation cleanup lease lost');
        try {
            return raw.transaction(() => {
                const now = Date.now();
                const parent = raw.prepare('SELECT * FROM background_jobs WHERE id = ?').get(input.parentJobId) as JobRow | undefined;
                if (!parent || parent.lease_owner !== input.leaseOwner || !parent.lease_expires_at || parent.lease_expires_at <= now)
                    return 'not-owned';
                const execution = parseJson<BackgroundJobExecution>(parent.execution_json);
                const parsed = DelegationWaitSchema.safeParse(execution?.delegationWait);
                if (!execution || 'delegationQuarantinedAt' in execution || !parsed.success || !hasParkedDeadline(parent, parsed.data))
                    throw new Error('Invalid delegation wait checkpoint');
                const wait = parsed.data;
                if (wait.revision !== input.expectedRevision || (expired
                    ? parent.status !== 'streaming' || execution.cancellationRequestedAt !== undefined || wait.expiredAt !== undefined || now < wait.deadlineAt
                    : parent.status === 'streaming' && execution.cancellationRequestedAt === undefined))
                    return 'not-owned';
                const linked = raw.prepare('SELECT id, user_id, thread_id, message_id FROM background_jobs WHERE delegation_parent_id = ?')
                    .all(parent.id) as Array<Pick<JobRow, 'id' | 'user_id' | 'thread_id' | 'message_id'>>;
                const prepared = wait.children.filter(child => child.kind === 'prepared' && child.jobId);
                if (linked.length !== prepared.length || linked.some(job => job.user_id !== parent.user_id || !prepared.some(child =>
                    child.kind === 'prepared' && child.jobId === job.id && child.threadId === job.thread_id && child.assistantMessageId === job.message_id)))
                    throw new Error('Delegation child links are inconsistent');
                raw.prepare(`UPDATE background_jobs SET status = 'aborted', completed_at = ?, last_activity_at = ?,
                    lease_owner = NULL, lease_expires_at = NULL,
                    history_phase = CASE WHEN generation_id IS NOT NULL AND COALESCE(history_phase, 'ready') = 'ready'
                        THEN 'finalization_pending' ELSE history_phase END
                    WHERE delegation_parent_id = ? AND user_id = ? AND status = 'streaming'`)
                    .run(now, now, parent.id, parent.user_id);
                const committedAt = Date.now();
                if (parent.lease_expires_at <= committedAt) throw leaseLost;
                if (!expired && terminalProjectionSettled(raw, parent, execution, wait)) {
                    const { delegationWait: _wait, delegationTerminalProjection: _projection, ...finishedExecution } = execution;
                    const result = raw.prepare(`UPDATE background_jobs SET execution_json = ?, tool_calls_json = ?, delegation_wait_active = 0, delegation_wait_deadline = NULL,
                        last_activity_at = ?, lease_owner = NULL, lease_expires_at = NULL
                        WHERE id = ? AND status != 'streaming' AND lease_owner = ? AND lease_expires_at > ?
                          AND json_extract(execution_json, '$.delegationWait.revision') = ?`)
                        .run(json(finishedExecution), parent.tool_calls_json, committedAt, parent.id,
                            input.leaseOwner, committedAt, input.expectedRevision);
                    if (!result.changes) throw leaseLost;
                    return 'settled';
                }
                const receipt = !expired && parent.generation_id && raw.prepare(`SELECT outcome FROM background_generation_receipts
                    WHERE workspace_id = ? AND generation_id = ? AND stage = 'finalization'`)
                    .get(execution.workspaceId, parent.generation_id);
                const parentThread = raw.prepare('SELECT deleted FROM s_threads WHERE workspace_id = ? AND id = ?')
                    .get(execution.workspaceId, parent.thread_id) as { deleted: number } | undefined;
                const parentThreadUnavailable = !parentThread || !!parentThread.deleted;
                const terminalCalls = !expired && !receipt
                    ? terminalDelegationCheckpoint(raw, parent, execution, wait, parentThreadUnavailable) : null;
                if (terminalCalls) {
                    const counter = raw.prepare('SELECT value FROM server_version_counter WHERE workspace_id = ?')
                        .get(execution.workspaceId) as { value: number } | undefined;
                    const nextWait = DelegationWaitSchema.parse({ ...wait, nextCheckAt: committedAt + 5_000, revision: wait.revision + 1 });
                    const staged = { ...execution, delegationWait: nextWait,
                        delegationTerminalProjection: { version: 1 as const, workspaceRevision: String(counter?.value ?? 0),
                            ...(parentThreadUnavailable ? { parentThreadUnavailable: true as const } : {}) } };
                    const result = raw.prepare(`UPDATE background_jobs SET execution_json = ?, tool_calls_json = ?,
                        last_activity_at = ?, lease_owner = NULL, lease_expires_at = NULL
                        WHERE id = ? AND status != 'streaming' AND lease_owner = ? AND lease_expires_at > ?
                          AND json_extract(execution_json, '$.delegationWait.revision') = ?`)
                        .run(json(staged), json(terminalCalls), committedAt, parent.id,
                            input.leaseOwner, committedAt, input.expectedRevision);
                    if (!result.changes) throw leaseLost;
                    return 'pending';
                }
                const nextWait = DelegationWaitSchema.parse({ ...wait, nextCheckAt: committedAt + 5_000, revision: wait.revision + 1,
                    ...(expired ? { expiredAt: committedAt, children: wait.children.map(child =>
                        child.kind === 'prepared' && !child.jobId && !child.settlement
                            ? { ...child, settlement: { kind: 'unavailable', code: 'deadline_expired' } } : child) } : {}) });
                // Keep the hold even after history settles: release also requires
                // the parent's canonical activity to contain every child link.
                const nextExecution = raw.prepare(`UPDATE background_jobs SET
                    execution_json = json_set(execution_json, '$.delegationWait', json(?)),
                    last_activity_at = ?, lease_owner = NULL, lease_expires_at = NULL
                    WHERE id = ? AND lease_owner = ? AND lease_expires_at > ?
                      AND json_extract(execution_json, '$.delegationWait.revision') = ?`)
                    .run(JSON.stringify(nextWait), committedAt, parent.id, input.leaseOwner, committedAt, input.expectedRevision);
                if (!nextExecution.changes) throw leaseLost;
                return 'pending';
            }).immediate() as 'not-owned' | 'pending' | 'settled';
        } catch (error) {
            if (error === leaseLost) return 'not-owned';
            throw error;
        }
    }

    async resumeDelegationWait(input: DelegationResume): Promise<DelegationResumeResult> {
        if (isD1Driver()) throw new Error('Atomic delegation coordination is unavailable for D1');
        const config = getJobConfig();
        const raw = getRawDb();
        return raw.transaction(() => {
            const now = Date.now();
            const parent = raw.prepare('SELECT * FROM background_jobs WHERE id = ?').get(input.parentJobId) as JobRow | undefined;
            if (!parent || parent.status !== 'streaming' || (parent.history_phase ?? 'ready') !== 'ready' ||
                parent.lease_owner !== input.leaseOwner || !parent.lease_expires_at || parent.lease_expires_at <= now)
                return 'not-owned';
            const job = toJob(parent);
            const execution = job.execution as BackgroundJobExecution | undefined;
            const wait = DelegationWaitSchema.safeParse(execution?.delegationWait);
            if (!execution || 'delegationQuarantinedAt' in execution || !wait.success || !hasParkedDeadline(parent, wait.data))
                throw new Error('Invalid delegation wait checkpoint');
            if (execution.cancellationRequestedAt !== undefined || wait.data.revision !== input.expectedRevision ||
                (wait.data.deadlineAt <= now && wait.data.expiredAt === undefined))
                return 'not-owned';
            if (parent.sync_provider_id !== 'sqlite' || typeof input.expectedSyncRevision !== 'string' ||
                !/^(0|[1-9][0-9]*)$/.test(input.expectedSyncRevision)) return 'not-owned';
            const access = raw.prepare(`SELECT m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
                WHERE m.workspace_id = ? AND m.user_id = ? AND COALESCE(w.deleted, 0) = 0`)
                .get(execution.workspaceId, parent.user_id) as { role: string } | undefined;
            const syncCounter = raw.prepare('SELECT value FROM server_version_counter WHERE workspace_id = ?')
                .get(execution.workspaceId) as { value: number } | undefined;
            if (!access || !['owner', 'editor'].includes(access.role) || String(syncCounter?.value ?? 0) !== input.expectedSyncRevision)
                return 'not-owned';
            const checkpoint = buildDelegationResume(job, input);
            const active = raw.prepare(`SELECT COUNT(*) AS total,
                SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS user_total
                FROM background_jobs WHERE status = 'streaming'
                  AND json_extract(execution_json, '$.clientToolCall') IS NULL
                  AND delegation_wait_active = 0 AND json_type(execution_json, '$.delegationWait') IS NULL`)
                .get(parent.user_id) as { total: number; user_total: number | null };
            if (active.total >= config.maxConcurrentJobs || (active.user_total ?? 0) >= config.maxConcurrentJobsPerUser)
                return 'capacity';
            const resumedAt = Date.now();
            if (parent.lease_expires_at <= resumedAt || (wait.data.deadlineAt <= resumedAt && wait.data.expiredAt === undefined)) return 'not-owned';
            const changed = raw.prepare(`UPDATE background_jobs SET execution_json = ?, tool_calls_json = ?, delegation_wait_active = 0, delegation_wait_deadline = NULL,
                lease_owner = NULL, lease_expires_at = NULL, last_activity_at = ?
                WHERE id = ? AND status = 'streaming' AND lease_owner = ? AND lease_expires_at > ?
                  AND json_type(execution_json, '$.cancellationRequestedAt') IS NULL
                  AND json_extract(execution_json, '$.delegationWait.revision') = ?`)
                .run(json(checkpoint.execution), json(checkpoint.toolCalls), resumedAt,
                    parent.id, input.leaseOwner, resumedAt, input.expectedRevision).changes;
            return changed ? 'resumed' : 'not-owned';
        }).immediate() as DelegationResumeResult;
    }

    async renewJobLease(
        jobId: string,
        leaseOwner: string,
        _now: number,
        leaseExpiresAt: number
    ): Promise<boolean> {
        return (
            (await run(
                `UPDATE background_jobs SET lease_expires_at = ?, last_activity_at = ?
             WHERE id = ? AND (status = 'streaming' OR delegation_wait_active = 1 OR json_type(execution_json, '$.delegationWait') IS NOT NULL)
               AND lease_owner = ?
               AND lease_expires_at > ?`,
                leaseExpiresAt,
                Date.now(),
                jobId,
                leaseOwner,
                Date.now()
            )) > 0
        );
    }

    async updateJobExecution(
        jobId: string,
        execution: BackgroundJobExecution,
        leaseOwner: string
    ): Promise<boolean> {
        if (execution.delegationWait !== undefined) return false;
        return (
            (await run(
                `UPDATE background_jobs SET execution_json = ?, last_activity_at = ?
             WHERE id = ? AND status = 'streaming' AND lease_owner = ?
               AND delegation_wait_active = 0 AND json_type(execution_json, '$.delegationWait') IS NULL
               AND json_extract(execution_json, '$.delegationDefaults') IS json_extract(?, '$.delegationDefaults')
               AND lease_expires_at > ?`,
                json(execution),
                Date.now(),
                jobId,
                leaseOwner,
                json(execution),
                Date.now()
            )) > 0
        );
    }

    async claimClientToolCall(
        jobId: string,
        userId: string,
        callId: string,
        claimToken: string,
        claimExpiresAt: number
    ): Promise<BackgroundJob | null> {
        const now = Date.now();
        const row = await one<JobRow>(
            `UPDATE background_jobs SET
                execution_json = json_set(
                    execution_json,
                    '$.clientToolCall.claimToken', ?,
                    '$.clientToolCall.claimExpiresAt', ?
                ),
                last_activity_at = ?
             WHERE id = ? AND user_id = ? AND status = 'streaming'
               AND json_extract(execution_json, '$.clientToolCall.callId') = ?
               AND (
                    json_extract(execution_json, '$.clientToolCall.claimToken') IS NULL
                    OR COALESCE(json_extract(execution_json, '$.clientToolCall.claimExpiresAt'), 0) <= ?
               )
             RETURNING *`,
            claimToken,
            claimExpiresAt,
            now,
            jobId,
            userId,
            callId,
            now
        );
        return row ? toJob(row) : null;
    }

    async settleClientToolCall(
        jobId: string,
        userId: string,
        callId: string,
        claimToken: string,
        execution: BackgroundJobExecution,
        toolCalls: BackgroundJob['tool_calls']
    ): Promise<boolean> {
        const now = Date.now();
        return (
            (await run(
                `UPDATE background_jobs SET execution_json = ?, tool_calls_json = ?,
                    lease_owner = NULL, lease_expires_at = NULL, last_activity_at = ?
                 WHERE id = ? AND user_id = ? AND status = 'streaming'
                   AND json_extract(execution_json, '$.clientToolCall.callId') = ?
                   AND json_extract(execution_json, '$.clientToolCall.claimToken') = ?
                   AND json_extract(execution_json, '$.delegationDefaults') IS json_extract(?, '$.delegationDefaults')
                   AND COALESCE(json_extract(execution_json, '$.clientToolCall.claimExpiresAt'), 0) > ?`,
                json(execution),
                json(toolCalls),
                now,
                jobId,
                userId,
                callId,
                claimToken,
                json(execution),
                now
            )) > 0
        );
    }

    async saveTerminalSnapshot(
        jobId: string,
        snapshot: TerminalGenerationSnapshot,
        leaseOwner?: string
    ): Promise<boolean> {
        const values: unknown[] = [
            snapshot.status,
            snapshot.content,
            snapshot.reasoning,
            json(snapshot.toolCalls),
            json(readRequestUsage(snapshot.usage)),
            snapshot.error ?? null,
            snapshot.completedAt,
            snapshot.completedAt,
        ];
        let where = "id = ? AND status = 'streaming'";
        values.push(jobId);
        if (leaseOwner) {
            where += ' AND lease_owner = ? AND lease_expires_at > ?';
            values.push(leaseOwner, Date.now());
        } else {
            where += ' AND lease_owner IS NULL';
        }
        return (
            (await run(
                `UPDATE background_jobs SET status = ?, content = ?, reasoning = ?,
                    tool_calls_json = ?, usage_json = COALESCE(?, usage_json), error = ?, completed_at = ?,
                    history_phase = 'finalization_pending',
                    last_activity_at = ?, lease_owner = NULL, lease_expires_at = NULL
                 WHERE ${where}`,
                ...values
            )) > 0
        );
    }

    async setHistoryPhase(
        jobId: string,
        phase: GenerationHistoryPhase,
        options?: { from?: GenerationHistoryPhase[] }
    ): Promise<boolean> {
        const values: unknown[] = [phase, jobId];
        let where = 'id = ?';
        if (options?.from && options.from.length > 0) {
            const placeholders = options.from.map(() => '?').join(', ');
            where += ` AND COALESCE(history_phase, 'ready') IN (${placeholders})`;
            values.push(...options.from);
        }
        return (await run(`UPDATE background_jobs SET history_phase = ?, delegation_history_retry_at = 0 WHERE ${where}`, ...values)) > 0;
    }

    async deferDelegationHistory(input: { jobId: string; userId: string; generationId: string;
        phase: 'admission_pending' | 'finalization_pending' }): Promise<boolean> {
        if (!['admission_pending', 'finalization_pending'].includes(input.phase)) return false;
        return (await run(`UPDATE background_jobs SET delegation_history_retry_at = ?
            WHERE id = ? AND user_id = ? AND generation_id = ? AND history_phase = ?
              AND json_extract(execution_json, '$.delegationRecoveryPolicy') = 'v1'`,
            Date.now() + 30_000, input.jobId, input.userId, input.generationId, input.phase)) > 0;
    }

    async getPendingHistoryJobs(limit: number): Promise<BackgroundJob[]> {
        const rows = await all<JobRow>(
            `SELECT * FROM background_jobs
             WHERE history_phase IN ('admission_pending', 'finalization_pending')
               AND NOT EXISTS (SELECT 1 FROM background_job_execution_quarantine AS evidence
                   WHERE evidence.job_id = background_jobs.id)
               AND json_type(execution_json, '$.delegationQuarantinedAt') IS NULL
               AND delegation_history_retry_at <= ?
               AND (status = 'streaming' OR history_phase = 'admission_pending'
                 OR (delegation_wait_active = 0 AND json_type(execution_json, '$.delegationWait') IS NULL)
                 OR (delegation_wait_active = 1 AND json_type(execution_json, '$.delegationWait') = 'object'
                   AND json_type(execution_json, '$.delegationQuarantinedAt') IS NULL
                   AND json_extract(execution_json, '$.delegationWait.deadlineAt') = delegation_wait_deadline
                   AND json_extract(execution_json, '$.delegationTerminalProjection.version') = 1
                   AND json_type(execution_json, '$.delegationTerminalProjection.workspaceRevision') = 'text'
                   AND length(json_extract(execution_json, '$.delegationTerminalProjection.workspaceRevision')) BETWEEN 1 AND 16
                   AND json_extract(execution_json, '$.delegationTerminalProjection.workspaceRevision') NOT GLOB '*[^0-9]*'
                   AND (json_extract(execution_json, '$.delegationTerminalProjection.workspaceRevision') = '0'
                     OR substr(json_extract(execution_json, '$.delegationTerminalProjection.workspaceRevision'), 1, 1) != '0')))
             ORDER BY started_at ASC
             LIMIT ?`,
            Date.now(), Math.max(1, Math.min(100, Math.floor(limit)))
        );
        return rows.map(toJob);
    }

    async cleanupExpired(): Promise<number> {
        const config = getJobConfig();
        const now = Date.now();
        const timedOut = await run(
            `UPDATE background_jobs SET status = 'error', error = CASE
                    WHEN json_type(execution_json, '$.delegationDispatch') IS NOT NULL THEN ?
                    ELSE 'Job timed out' END,
                completed_at = ?, lease_owner = NULL, lease_expires_at = NULL,
                history_phase = CASE
                    WHEN generation_id IS NOT NULL
                      AND COALESCE(history_phase, 'ready') = 'ready'
                    THEN 'finalization_pending'
                    ELSE history_phase END
             WHERE status = 'streaming' AND last_activity_at <= ?
               AND delegation_wait_active = 0 AND json_type(execution_json, '$.delegationWait') IS NULL`,
            serializeError(Object.assign(new Error('Model request outcome is unknown.'), { code: 'ERR_MODEL_OUTCOME_UNKNOWN', retryable: false }), { source: 'provider' }),
            now,
            now - config.jobTimeoutMs
        );
        const removed = await run(
            `DELETE FROM background_jobs
             WHERE status != 'streaming' AND completed_at IS NOT NULL AND completed_at <= ?
               AND delegation_wait_active = 0 AND json_type(execution_json, '$.delegationWait') IS NULL
               AND (delegation_parent_id IS NULL OR NOT EXISTS (
                 SELECT 1 FROM background_jobs AS parent
                 WHERE parent.id = background_jobs.delegation_parent_id
                   AND (parent.status = 'streaming'
                     OR COALESCE(parent.history_phase, '') NOT IN ('committed', 'superseded')
                     OR parent.delegation_wait_active = 1
                     OR json_type(parent.execution_json, '$.delegationWait') IS NOT NULL)
               ))
               AND (
                 history_phase IS NULL
                 OR history_phase IN ('ready', 'committed', 'superseded')
               )`,
            now - config.completedJobRetentionMs
        );
        return timedOut + removed;
    }

    async getActiveJobCount(): Promise<number> {
        const row = await one<{ total: number }>(
            `SELECT COUNT(*) AS total FROM background_jobs WHERE status = 'streaming'
             AND json_extract(execution_json, '$.clientToolCall') IS NULL
             AND delegation_wait_active = 0 AND json_type(execution_json, '$.delegationWait') IS NULL`
        );
        return row?.total ?? 0;
    }

    async getShutdownBlockerCount(): Promise<number> {
        // Disjoint counts include terminal waits that still require child cleanup.
        const row = await one<{ total: number }>(
            `SELECT
                (SELECT COUNT(*) FROM background_jobs WHERE status = 'streaming') +
                (SELECT COUNT(*) FROM background_jobs
                 WHERE status != 'streaming' AND (
                     history_phase IN ('admission_pending', 'finalization_pending')
                     OR delegation_wait_active = 1 OR json_type(execution_json, '$.delegationWait') IS NOT NULL
                 )) AS total`
        );
        if (!row) throw new Error('SQLite shutdown accounting unavailable');
        return row.total;
    }
}

export const sqliteBackgroundJobProvider = new SqliteBackgroundJobProvider();
