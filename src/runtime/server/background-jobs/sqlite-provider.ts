import type {
    BackgroundJob,
    BackgroundJobExecution,
    BackgroundJobProvider,
    CreateJobParams,
    JobUpdate
} from '~~/server/utils/background-jobs/types';
import { getJobConfig } from '~~/server/utils/background-jobs/store';
import { randomUUID } from 'node:crypto';
import { d1All, d1Run } from '../db/d1';
import { getRawDb, isD1Driver } from '../db/kysely';

type JobRow = {
    id: string;
    user_id: string;
    thread_id: string;
    message_id: string;
    model: string;
    kind: 'chat' | 'workflow' | null;
    status: BackgroundJob['status'];
    content: string;
    chunks_received: number;
    started_at: number;
    last_activity_at: number;
    completed_at: number | null;
    error: string | null;
    tool_calls_json: string | null;
    workflow_state_json: string | null;
    execution_json: string | null;
    idempotency_key: string | null;
    lease_owner: string | null;
    lease_expires_at: number | null;
    attempts: number;
};

function parseJson<T>(value: string | null): T | undefined {
    if (!value) return undefined;
    return JSON.parse(value) as T;
}

function json(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
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
        chunksReceived: row.chunks_received,
        startedAt: row.started_at,
        lastActivityAt: row.last_activity_at,
        completedAt: row.completed_at ?? undefined,
        error: row.error ?? undefined,
        tool_calls: parseJson<BackgroundJob['tool_calls']>(row.tool_calls_json),
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
    chunks_received, started_at, last_activity_at, tool_calls_json,
    workflow_state_json, execution_json, idempotency_key, attempts
) VALUES (?, ?, ?, ?, ?, ?, 'streaming', '', 0, ?, ?, ?, ?, ?, ?, 0)`;

const INSERT_JOB_IF_CAPACITY = `INSERT INTO background_jobs (
    id, user_id, thread_id, message_id, model, kind, status, content,
    chunks_received, started_at, last_activity_at, tool_calls_json,
    workflow_state_json, execution_json, idempotency_key, attempts
) SELECT ?, ?, ?, ?, ?, ?, 'streaming', '', 0, ?, ?, ?, ?, ?, ?, 0
  WHERE (SELECT COUNT(*) FROM background_jobs WHERE status = 'streaming') < ?
    AND (SELECT COUNT(*) FROM background_jobs WHERE status = 'streaming' AND user_id = ?) < ?
  ON CONFLICT(idempotency_key) DO NOTHING
  RETURNING id`;

export class SqliteBackgroundJobProvider implements BackgroundJobProvider {
    readonly name = 'sqlite';

    async createJob(params: CreateJobParams): Promise<string> {
        const now = Date.now();
        const id = randomUUID();
        const config = getJobConfig();
        if (isD1Driver()) {
            if (params.idempotencyKey) {
                const existing = await one<{ id: string }>(
                    'SELECT id FROM background_jobs WHERE idempotency_key = ?',
                    params.idempotencyKey
                );
                if (existing) return existing.id;
            }
            const inserted = await all<{ id: string }>(
                INSERT_JOB_IF_CAPACITY,
                ...insertParameters(id, params, now),
                config.maxConcurrentJobs,
                params.userId,
                config.maxConcurrentJobsPerUser
            );
            if (inserted[0]) return inserted[0].id;
            if (params.idempotencyKey) {
                const existing = await one<{ id: string }>(
                    'SELECT id FROM background_jobs WHERE idempotency_key = ?',
                    params.idempotencyKey
                );
                if (existing) return existing.id;
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
                }
                const active = raw
                    .prepare(
                        `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS user_total
                 FROM background_jobs WHERE status = 'streaming'`
                    )
                    .get(params.userId) as {
                    total: number;
                    user_total: number | null;
                };
                if (
                    active.total >= config.maxConcurrentJobs ||
                    (active.user_total ?? 0) >= config.maxConcurrentJobsPerUser
                ) {
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

    async updateJob(jobId: string, update: JobUpdate): Promise<void> {
        const sets = ['last_activity_at = ?'];
        const values: unknown[] = [Date.now()];
        if (update.contentChunk !== undefined) {
            sets.push('content = content || ?');
            values.push(update.contentChunk);
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
        values.push(jobId);
        let where = "id = ? AND status = 'streaming'";
        if (update.leaseOwner) {
            where += ' AND lease_owner = ?';
            values.push(update.leaseOwner);
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
            where += ' AND lease_owner = ?';
            values.push(leaseOwner);
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
                last_activity_at = ?, lease_owner = NULL, lease_expires_at = NULL
             WHERE id = ? AND user_id = ? AND status = 'streaming'`,
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
        const row = await one<JobRow>(
            `UPDATE background_jobs SET lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1
             WHERE id = ? AND status = 'streaming' AND execution_json IS NOT NULL
               AND (lease_owner IS NULL OR lease_expires_at <= ?)
             RETURNING *`,
            leaseOwner,
            leaseExpiresAt,
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
            `UPDATE background_jobs SET lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1
             WHERE id = (
                SELECT id FROM background_jobs
                WHERE status = 'streaming' AND execution_json IS NOT NULL
                  AND (lease_owner IS NULL OR lease_expires_at <= ?)
                ORDER BY started_at ASC LIMIT 1
             ) RETURNING *`,
            leaseOwner,
            leaseExpiresAt,
            now
        );
        return row ? toJob(row) : null;
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
             WHERE id = ? AND status = 'streaming' AND lease_owner = ?`,
                leaseExpiresAt,
                Date.now(),
                jobId,
                leaseOwner
            )) > 0
        );
    }

    async updateJobExecution(
        jobId: string,
        execution: BackgroundJobExecution,
        leaseOwner: string
    ): Promise<boolean> {
        return (
            (await run(
                `UPDATE background_jobs SET execution_json = ?, last_activity_at = ?
             WHERE id = ? AND status = 'streaming' AND lease_owner = ?`,
                json(execution),
                Date.now(),
                jobId,
                leaseOwner
            )) > 0
        );
    }

    async cleanupExpired(): Promise<number> {
        const config = getJobConfig();
        const now = Date.now();
        const timedOut = await run(
            `UPDATE background_jobs SET status = 'error', error = 'Job timed out',
                completed_at = ?, lease_owner = NULL, lease_expires_at = NULL
             WHERE status = 'streaming' AND last_activity_at <= ?`,
            now,
            now - config.jobTimeoutMs
        );
        const removed = await run(
            `DELETE FROM background_jobs
             WHERE status != 'streaming' AND completed_at IS NOT NULL AND completed_at <= ?`,
            now - config.completedJobRetentionMs
        );
        return timedOut + removed;
    }

    async getActiveJobCount(): Promise<number> {
        const row = await one<{ total: number }>(
            "SELECT COUNT(*) AS total FROM background_jobs WHERE status = 'streaming'"
        );
        return row?.total ?? 0;
    }
}

export const sqliteBackgroundJobProvider = new SqliteBackgroundJobProvider();
