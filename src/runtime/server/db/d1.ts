/** Native helpers for the D1 operations that need batch-level atomicity. */
import type { D1Result } from './d1-dialect';
import { getD1Database } from './kysely';

export type D1SqlStatement = {
    sql: string;
    parameters?: readonly unknown[];
};

function assertSuccess(result: D1Result): void {
    if (result.success === false) {
        throw new Error(result.error ?? 'Cloudflare D1 statement failed.');
    }
    if (result.error) throw new Error(result.error);
}

export async function d1All<T = Record<string, unknown>>(
    sql: string,
    ...parameters: unknown[]
): Promise<T[]> {
    const result = await getD1Database()
        .prepare(sql)
        .bind(...parameters)
        .all<T>();
    assertSuccess(result);
    return result.results ?? [];
}

export async function d1Run(
    sql: string,
    ...parameters: unknown[]
): Promise<D1Result> {
    const result = await getD1Database()
        .prepare(sql)
        .bind(...parameters)
        .run();
    assertSuccess(result);
    return result;
}

/**
 * D1 runs all statements in a batch sequentially and atomically. It is the
 * native replacement for the local BEGIN IMMEDIATE paths in this provider.
 */
export async function d1Batch(
    statements: readonly D1SqlStatement[]
): Promise<D1Result[]> {
    const database = getD1Database();
    if (!database.batch) {
        throw new Error('The configured D1 binding does not support batch().');
    }
    const results = await database.batch(
        statements.map(({ sql, parameters = [] }) =>
            database.prepare(sql).bind(...parameters)
        )
    );
    for (const result of results) assertSuccess(result);
    return results;
}
