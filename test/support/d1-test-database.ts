import Database from 'better-sqlite3';
import type {
    D1Database,
    D1PreparedStatement,
    D1Result,
} from '../../src/runtime/server/db/d1-dialect';

/**
 * Lightweight D1 contract emulator backed by an in-memory SQLite database.
 * It exercises the provider's D1 dialect and batch paths without requiring a
 * Cloudflare account in the unit-test suite.
 */
export function createD1TestDatabase(): {
    database: D1Database;
    close(): void;
} {
    const local = new Database(':memory:');
    const executors = new WeakMap<object, () => D1Result>();

    const createStatement = (
        query: string,
        parameters: unknown[] = []
    ): D1PreparedStatement => {
        const execute = (): D1Result => {
            const statement = local.prepare(query);
            if (statement.reader) {
                return {
                    results: statement.all(...parameters),
                    meta: { changes: 0 },
                };
            }
            const result = statement.run(...parameters);
            return {
                results: [],
                meta: {
                    changes: result.changes,
                    last_row_id: result.lastInsertRowid?.toString(),
                },
            };
        };
        const statement: D1PreparedStatement = {
            bind: (...values) => createStatement(query, values),
            all: async <T>() => execute() as D1Result<T>,
            run: async <T>() => execute() as D1Result<T>,
        };
        executors.set(statement, execute);
        return statement;
    };

    return {
        database: {
            prepare(query: string): D1PreparedStatement {
                return createStatement(query);
            },
            async batch<T = unknown>(statements: D1PreparedStatement[]) {
                return local.transaction(() =>
                    statements.map((statement) => {
                        const execute = executors.get(statement);
                        if (!execute) {
                            throw new Error('Unknown D1 test statement.');
                        }
                        return execute() as D1Result<T>;
                    })
                )();
            },
        },
        close(): void {
            local.close();
        },
    };
}
