import { createError } from 'h3';
import { getRawDb, isD1Driver } from '../db/kysely';
import { d1All, d1Batch, type D1SqlStatement } from '../db/d1';

export function validHistoryIncarnation(value: unknown): value is string {
    return typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value);
}

export function historyChanged(historyIncarnation: string): never {
    throw createError({
        statusCode: 409,
        statusMessage: 'Sync history changed',
        data: { code: 'OR3_SYNC_HISTORY_CHANGED', historyIncarnation, requiresSnapshot: true },
    });
}

export function validateExpectedHistory(value: unknown): asserts value is string | null {
    if (value !== null && !validHistoryIncarnation(value)) {
        throw createError({ statusCode: 400, statusMessage: 'Invalid history incarnation' });
    }
}

export async function readHistoryIncarnation(): Promise<string> {
    const query = 'SELECT id,incarnation FROM sync_history LIMIT 2';
    const rows = isD1Driver()
        ? await d1All<{ id: number; incarnation: string }>(query)
        : getRawDb().prepare(query).all() as { id: number; incarnation: string }[];
    if (rows.length !== 1 || rows[0]?.id !== 1 || !validHistoryIncarnation(rows[0]?.incarnation)) {
        throw new Error('Invalid sync history singleton; offline recovery required');
    }
    return rows[0].incarnation;
}

/** SQL assertion is evaluated inside the same atomic batch/transaction as writes. */
export function historyAssertion(expected: string): D1SqlStatement {
    return {
        sql: `SELECT json_extract('{}', CASE WHEN (SELECT incarnation FROM sync_history WHERE id=1) = ?
            THEN '$' ELSE 'OR3_SYNC_HISTORY_CHANGED' END)`,
        parameters: [expected],
    };
}

export async function historyBatch(statements: D1SqlStatement[], expected?: string): Promise<void> {
    try {
        if (isD1Driver()) {
            await d1Batch(statements);
            return;
        }
        const raw = getRawDb();
        raw.transaction(() => {
            for (const statement of statements) {
                const prepared = raw.prepare(statement.sql);
                if (prepared.reader) prepared.all(...statement.parameters ?? []);
                else prepared.run(...statement.parameters ?? []);
            }
        }).immediate();
    } catch (error) {
        if (expected && String(error).includes('OR3_SYNC_HISTORY_CHANGED')) {
            historyChanged(await readHistoryIncarnation());
        }
        throw error;
    }
}

/** Only for a stopped replacement candidate. The caller durably journals a fresh
 * UUID before extraction and fences every writer/startup. Reconciliation may
 * repeat that UUID only for the same stopped bytes; any extraction needs a new one. */
export async function rotateSyncHistory(incarnation: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(incarnation)) {
        throw new Error('Journaled fresh UUID required');
    }
    const expected = await readHistoryIncarnation();
    await historyBatch([
        historyAssertion(expected),
        { sql: 'DELETE FROM sync_snapshot_items' },
        { sql: 'DELETE FROM sync_snapshots' },
        { sql: 'DELETE FROM device_cursors' },
        { sql: 'UPDATE sync_history SET incarnation=? WHERE id=1', parameters: [incarnation] },
    ], expected);
    if (await readHistoryIncarnation() !== incarnation) throw new Error('Sync history reset verification failed');
}
