/**
 * Small Kysely dialect for a Cloudflare D1 binding.
 *
 * D1 exposes an asynchronous prepared-statement API. Keeping this adapter
 * local avoids pulling a Node-only database driver into a Workers bundle.
 */
import {
    SqliteAdapter,
    SqliteIntrospector,
    SqliteQueryCompiler,
    type DatabaseConnection,
    type DatabaseIntrospector,
    type Dialect,
    type Driver,
    type Kysely,
    type QueryCompiler,
    type QueryResult,
} from 'kysely';

export interface D1Result<T = unknown> {
    success?: boolean;
    results?: T[];
    meta?: {
        changes?: number;
        last_row_id?: number | string | null;
    };
    error?: string;
}

export interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    all<T = unknown>(): Promise<D1Result<T>>;
    run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
    prepare(query: string): D1PreparedStatement;
    batch?<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

/**
 * D1 does not expose SQL BEGIN/COMMIT transactions. Callers that require an
 * atomic write use D1Database.batch(), which is intentionally kept outside
 * the general-purpose Kysely transaction API.
 */
export const D1_TRANSACTION_ERROR =
    'Cloudflare D1 does not support Kysely transactions. Use the D1-specific atomic operation instead.';

export class D1Dialect implements Dialect {
    constructor(private readonly database: D1Database) {}

    createAdapter(): SqliteAdapter {
        return new SqliteAdapter();
    }

    createDriver(): Driver {
        return new D1Driver(this.database);
    }

    createQueryCompiler(): QueryCompiler {
        return new SqliteQueryCompiler();
    }

    createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
        return new SqliteIntrospector(db);
    }
}

class D1Driver implements Driver {
    private readonly connection: D1Connection;

    constructor(database: D1Database) {
        this.connection = new D1Connection(database);
    }

    async init(): Promise<void> {}

    async acquireConnection(): Promise<DatabaseConnection> {
        return this.connection;
    }

    async beginTransaction(): Promise<void> {
        throw new Error(D1_TRANSACTION_ERROR);
    }

    async commitTransaction(): Promise<void> {
        throw new Error(D1_TRANSACTION_ERROR);
    }

    async rollbackTransaction(): Promise<void> {
        throw new Error(D1_TRANSACTION_ERROR);
    }

    async releaseConnection(): Promise<void> {}

    async destroy(): Promise<void> {}
}

class D1Connection implements DatabaseConnection {
    constructor(private readonly database: D1Database) {}

    async executeQuery<R>(compiledQuery: {
        sql: string;
        parameters: readonly unknown[];
    }): Promise<QueryResult<R>> {
        const statement = this.database
            .prepare(compiledQuery.sql)
            .bind(...compiledQuery.parameters);
        const result = await statement.all<R>();
        if (result.success === false) {
            throw new Error(result.error ?? 'Cloudflare D1 query failed.');
        }
        if (result.error) throw new Error(result.error);

        const changes = result.meta?.changes;
        const lastRowId = result.meta?.last_row_id;
        return {
            rows: result.results ?? [],
            numAffectedRows:
                changes === undefined || changes === null
                    ? undefined
                    : BigInt(changes),
            insertId:
                lastRowId === undefined || lastRowId === null
                    ? undefined
                    : BigInt(lastRowId),
        };
    }

    async *streamQuery<R>(compiledQuery: {
        sql: string;
        parameters: readonly unknown[];
    }): AsyncIterableIterator<QueryResult<R>> {
        yield await this.executeQuery<R>(compiledQuery);
    }
}
