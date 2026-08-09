/**
 * Shared database initialization for the SQLite provider.
 *
 * The default remains better-sqlite3. Bun and Turso expose the same
 * synchronous SQLite shape, while Cloudflare D1 uses its native async binding.
 */
import { Kysely, SqliteDialect } from 'kysely';
import { D1Dialect, type D1Database } from './d1-dialect';
import type { Or3SqliteDb } from './schema';

export type SqliteDriver = 'better-sqlite3' | 'bun' | 'turso' | 'd1';

export interface SqliteRawStatement {
    readonly reader?: boolean;
    all(...parameters: unknown[]): unknown[];
    get(...parameters: unknown[]): unknown;
    run(...parameters: unknown[]): {
        changes: number;
        lastInsertRowid?: number | bigint;
    };
    iterate(...parameters: unknown[]): IterableIterator<unknown>;
}

type SqliteTransaction<T> = ((...args: unknown[]) => T) & {
    immediate: (...args: unknown[]) => T;
};

export interface SqliteRawDatabase {
    close(): void;
    prepare(sql: string): SqliteRawStatement;
    pragma?(source: string): unknown;
    exec(source: string): unknown;
    transaction<T>(fn: (...args: unknown[]) => T): SqliteTransaction<T>;
}

export interface SqliteDbOptions {
    /** SQLite file path for better-sqlite3 and Bun. */
    path?: string;
    /** Explicitly selects a native runtime. Defaults to better-sqlite3. */
    driver?: SqliteDriver | string;
    journalMode?: string;
    synchronous?: string;
    /** Turso/libSQL database URL. */
    tursoUrl?: string;
    /** Turso/libSQL auth token. */
    tursoAuthToken?: string;
    /** Cloudflare D1 binding name. Defaults to DB. */
    d1Binding?: string;
    /** Allows integrations and tests to provide a D1 binding directly. */
    d1Database?: D1Database;
}

type BunStatement = {
    columnNames?: string[];
    all(...parameters: unknown[]): unknown[];
    get(...parameters: unknown[]): unknown;
    run(...parameters: unknown[]): {
        changes?: number;
        lastInsertRowid?: number | bigint;
    };
    iterate?(...parameters: unknown[]): IterableIterator<unknown>;
};

type BunDatabase = {
    prepare(sql: string): BunStatement;
    run?(sql: string, ...parameters: unknown[]): unknown;
    exec?(sql: string): unknown;
    close(): void;
    transaction?<T>(fn: (...args: unknown[]) => T): ((...args: unknown[]) => T) & {
        immediate?: (...args: unknown[]) => T;
    };
};

type RuntimeModule = Record<string, unknown>;
type DatabaseConstructor<T> = new (...args: unknown[]) => T;

interface KyselySqliteStatement {
    readonly reader: boolean;
    all(parameters: ReadonlyArray<unknown>): unknown[];
    run(parameters: ReadonlyArray<unknown>): {
        changes: number | bigint;
        lastInsertRowid: number | bigint;
    };
    iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown>;
}

interface KyselySqliteDatabase {
    close(): void;
    prepare(sql: string): KyselySqliteStatement;
}

let instance: Kysely<Or3SqliteDb> | null = null;
let rawDb: SqliteRawDatabase | null = null;
let d1Db: D1Database | null = null;
let selectedDriver: SqliteDriver | null = null;
let initialization: Promise<Kysely<Or3SqliteDb>> | null = null;

function envFlag(value: string | undefined): boolean {
    if (!value) return false;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function normalizeDriver(value: string | undefined): SqliteDriver {
    switch (value?.trim().toLowerCase()) {
        case undefined:
        case '':
        case 'better-sqlite3':
        case 'better':
        case 'sqlite':
            return 'better-sqlite3';
        case 'bun':
        case 'bun:sqlite':
            return 'bun';
        case 'turso':
        case 'libsql':
            return 'turso';
        case 'd1':
        case 'cloudflare-d1':
        case 'cloudflare':
            return 'd1';
        default:
            throw new Error(
                `Unsupported OR3_SQLITE_DRIVER value "${value}". ` +
                    'Use better-sqlite3, bun, turso, or d1.'
            );
    }
}

function resolveDriver(options: SqliteDbOptions | undefined): SqliteDriver {
    const configured = options?.driver ?? process.env.OR3_SQLITE_DRIVER;
    if (configured) return normalizeDriver(configured);

    // A supplied binding is only used by programmatic integrations/tests. Env
    // settings alone never change the documented better-sqlite3 default.
    if (options?.d1Database) return 'd1';
    return 'better-sqlite3';
}

function resolveLocalPath(options: SqliteDbOptions | undefined): string {
    const isTestEnv = process.env.NODE_ENV === 'test' || envFlag(process.env.VITEST);
    const allowInMemory = envFlag(process.env.OR3_SQLITE_ALLOW_IN_MEMORY);
    const strictMode = envFlag(process.env.OR3_SQLITE_STRICT);
    const configuredPath = options?.path ?? process.env.OR3_SQLITE_DB_PATH;
    const path = configuredPath ?? ':memory:';

    if (!configuredPath && !isTestEnv && !allowInMemory) {
        throw new Error(
            'OR3_SQLITE_DB_PATH is required in non-test environments. ' +
                'Set OR3_SQLITE_ALLOW_IN_MEMORY=true only if you intentionally want ephemeral storage.'
        );
    }

    if (strictMode && path === ':memory:') {
        throw new Error(
            'OR3_SQLITE_STRICT=true forbids in-memory SQLite. Set OR3_SQLITE_DB_PATH to a persistent file path.'
        );
    }

    if (!isTestEnv && path === ':memory:' && !allowInMemory) {
        throw new Error(
            'Using :memory: in non-test environments requires OR3_SQLITE_ALLOW_IN_MEMORY=true.'
        );
    }

    if (!isTestEnv && path === ':memory:' && allowInMemory) {
        console.warn(
            '[or3-sqlite] OR3_SQLITE_ALLOW_IN_MEMORY=true enabled. Data will be lost on process restart.'
        );
    }

    return path;
}

function normalizeParameters(parameters: unknown[]): unknown[] {
    return parameters.length === 1 && Array.isArray(parameters[0])
        ? parameters[0]
        : parameters;
}

function isReaderStatement(sql: string): boolean {
    const normalized = sql.trim().toLowerCase();
    return (
        /^(select|pragma|explain|with)\b/.test(normalized) ||
        /\breturning\b/.test(normalized)
    );
}

class BunStatementAdapter implements SqliteRawStatement {
    constructor(
        private readonly statement: BunStatement,
        private readonly sql: string
    ) {}

    get reader(): boolean {
        return this.statement.columnNames
            ? this.statement.columnNames.length > 0
            : isReaderStatement(this.sql);
    }

    all(...parameters: unknown[]): unknown[] {
        return this.statement.all(...normalizeParameters(parameters));
    }

    get(...parameters: unknown[]): unknown {
        return this.statement.get(...normalizeParameters(parameters));
    }

    run(...parameters: unknown[]): { changes: number; lastInsertRowid?: number | bigint } {
        const result = this.statement.run(...normalizeParameters(parameters));
        return {
            changes: result.changes ?? 0,
            lastInsertRowid: result.lastInsertRowid,
        };
    }

    iterate(...parameters: unknown[]): IterableIterator<unknown> {
        const values = normalizeParameters(parameters);
        return this.statement.iterate
            ? this.statement.iterate(...values)
            : this.statement.all(...values)[Symbol.iterator]();
    }
}

class BunDatabaseAdapter implements SqliteRawDatabase {
    constructor(private readonly database: BunDatabase) {}

    close(): void {
        this.database.close();
    }

    prepare(sql: string): SqliteRawStatement {
        return new BunStatementAdapter(this.database.prepare(sql), sql);
    }

    pragma(source: string): unknown {
        if (this.database.run) return this.database.run(`PRAGMA ${source}`);
        return this.database.exec?.(`PRAGMA ${source}`);
    }

    exec(source: string): unknown {
        return this.database.exec?.(source);
    }

    transaction<T>(
        fn: (...args: unknown[]) => T
    ): SqliteTransaction<T> {
        if (!this.database.transaction) {
            throw new Error('bun:sqlite does not expose transaction() in this Bun runtime.');
        }
        const transaction = this.database.transaction(fn);
        if (!transaction.immediate) {
            transaction.immediate = (...args: unknown[]) => transaction(...args);
        }
        return transaction as SqliteTransaction<T>;
    }
}

function stripLibsqlMetadata(value: unknown): unknown {
    if (!isRecord(value) || !('_metadata' in value)) return value;
    const { _metadata: _ignored, ...row } = value;
    return row;
}

class TursoStatementAdapter implements SqliteRawStatement {
    constructor(private readonly statement: SqliteRawStatement) {}

    get reader(): boolean | undefined {
        return this.statement.reader;
    }

    all(...parameters: unknown[]): unknown[] {
        return this.statement.all(...parameters).map(stripLibsqlMetadata);
    }

    get(...parameters: unknown[]): unknown {
        return stripLibsqlMetadata(this.statement.get(...parameters));
    }

    run(...parameters: unknown[]): {
        changes: number;
        lastInsertRowid?: number | bigint;
    } {
        return stripLibsqlMetadata(
            this.statement.run(...parameters)
        ) as {
            changes: number;
            lastInsertRowid?: number | bigint;
        };
    }

    iterate(...parameters: unknown[]): IterableIterator<unknown> {
        return Array.from(
            this.statement.iterate(...parameters),
            stripLibsqlMetadata
        )[Symbol.iterator]();
    }
}

class TursoDatabaseAdapter implements SqliteRawDatabase {
    constructor(private readonly database: SqliteRawDatabase) {}

    close(): void {
        this.database.close();
    }

    prepare(sql: string): SqliteRawStatement {
        return new TursoStatementAdapter(this.database.prepare(sql));
    }

    pragma(source: string): unknown {
        return this.database.pragma?.(source);
    }

    exec(source: string): unknown {
        return this.database.exec(source);
    }

    transaction<T>(
        fn: (...args: unknown[]) => T
    ): SqliteTransaction<T> {
        return this.database.transaction(fn);
    }
}

class KyselyStatementAdapter implements KyselySqliteStatement {
    constructor(
        private readonly statement: SqliteRawStatement,
        private readonly sql: string
    ) {}

    get reader(): boolean {
        return this.statement.reader ?? isReaderStatement(this.sql);
    }

    all(parameters: ReadonlyArray<unknown>): unknown[] {
        return this.statement.all(parameters);
    }

    run(parameters: ReadonlyArray<unknown>): {
        changes: number | bigint;
        lastInsertRowid: number | bigint;
    } {
        const result = this.statement.run(parameters);
        return {
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid ?? 0,
        };
    }

    iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown> {
        return this.statement.iterate(parameters);
    }
}

class KyselyDatabaseAdapter implements KyselySqliteDatabase {
    constructor(private readonly database: SqliteRawDatabase) {}

    close(): void {
        this.database.close();
    }

    prepare(sql: string): KyselySqliteStatement {
        return new KyselyStatementAdapter(this.database.prepare(sql), sql);
    }
}

function validatePragmaValue(name: string, value: string): string {
    const normalized = value.trim();
    if (!/^[a-z0-9_]+$/i.test(normalized)) {
        throw new Error(`Invalid ${name} pragma value.`);
    }
    return normalized;
}

function applyLocalPragmas(db: SqliteRawDatabase, options?: SqliteDbOptions): void {
    const journalMode = validatePragmaValue(
        'journal_mode',
        options?.journalMode ?? process.env.OR3_SQLITE_PRAGMA_JOURNAL_MODE ?? 'WAL'
    );
    const synchronous = validatePragmaValue(
        'synchronous',
        options?.synchronous ?? process.env.OR3_SQLITE_PRAGMA_SYNCHRONOUS ?? 'NORMAL'
    );
    db.pragma?.(`journal_mode = ${journalMode}`);
    db.pragma?.(`synchronous = ${synchronous}`);
    db.pragma?.('foreign_keys = ON');
}

async function importRuntimeModule(moduleName: string): Promise<RuntimeModule> {
    const imported: unknown = await import(/* @vite-ignore */ moduleName);
    if (!isRecord(imported)) {
        throw new Error(`Runtime module "${moduleName}" did not export an object.`);
    }
    return imported;
}

async function importCloudflareWorkersModule(): Promise<RuntimeModule> {
    return importRuntimeModule('cloudflare:workers');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function asDatabaseConstructor<T>(value: unknown): DatabaseConstructor<T> | null {
    return typeof value === 'function' ? (value as DatabaseConstructor<T>) : null;
}

async function createBetterSqliteDatabase(path: string): Promise<SqliteRawDatabase> {
    let imported: RuntimeModule;
    try {
        imported = await importRuntimeModule('better-sqlite3');
    } catch (error) {
        throw new Error(
            'Unable to load better-sqlite3. Install it or set OR3_SQLITE_DRIVER to bun, turso, or d1.',
            { cause: error }
        );
    }
    const Database = asDatabaseConstructor<SqliteRawDatabase>(imported.default);
    if (!Database) {
        throw new Error('better-sqlite3 did not provide a Database constructor.');
    }
    return new Database(path);
}

async function createBunSqliteDatabase(path: string): Promise<SqliteRawDatabase> {
    let imported: RuntimeModule;
    try {
        imported = await importRuntimeModule('bun:sqlite');
    } catch (error) {
        throw new Error(
            'OR3_SQLITE_DRIVER=bun requires Bun and its built-in bun:sqlite module.',
            { cause: error }
        );
    }
    const Database = asDatabaseConstructor<BunDatabase>(
        imported.Database ?? imported.default
    );
    if (!Database) {
        throw new Error('bun:sqlite did not provide a Database constructor.');
    }
    return new BunDatabaseAdapter(new Database(path));
}

async function createTursoDatabase(options?: SqliteDbOptions): Promise<SqliteRawDatabase> {
    const url = options?.tursoUrl ?? process.env.OR3_SQLITE_TURSO_URL;
    const authToken = options?.tursoAuthToken ?? process.env.OR3_SQLITE_TURSO_AUTH_TOKEN;
    if (!url?.trim()) {
        throw new Error('OR3_SQLITE_TURSO_URL is required when OR3_SQLITE_DRIVER=turso.');
    }
    if (!authToken?.trim()) {
        throw new Error(
            'OR3_SQLITE_TURSO_AUTH_TOKEN is required when OR3_SQLITE_DRIVER=turso.'
        );
    }

    let imported: RuntimeModule;
    try {
        imported = await importRuntimeModule('libsql');
    } catch (error) {
        throw new Error(
            'Unable to load libsql for Turso. Install the libsql package and try again.',
            { cause: error }
        );
    }
    const Database = asDatabaseConstructor<SqliteRawDatabase>(
        imported.default ?? imported.Database
    );
    if (!Database) {
        throw new Error('libsql did not provide a Database constructor.');
    }
    return new TursoDatabaseAdapter(new Database(url, { authToken }));
}

async function resolveD1Database(options?: SqliteDbOptions): Promise<D1Database> {
    if (options?.d1Database) return options.d1Database;

    const binding = (options?.d1Binding ?? process.env.OR3_SQLITE_D1_BINDING ?? 'DB').trim();
    if (!binding) {
        throw new Error('OR3_SQLITE_D1_BINDING must name a Cloudflare D1 binding.');
    }

    let imported: RuntimeModule;
    try {
        imported = await importCloudflareWorkersModule();
    } catch (error) {
        throw new Error(
            'OR3_SQLITE_DRIVER=d1 requires a Cloudflare Workers runtime with a D1 binding.',
            { cause: error }
        );
    }
    const env = imported.env;
    const database = isRecord(env) ? env[binding] : undefined;
    if (!isD1Database(database)) {
        throw new Error(
            `Cloudflare D1 binding "${binding}" was not found. ` +
                'Set OR3_SQLITE_D1_BINDING to the binding name from wrangler.jsonc.'
        );
    }
    return database;
}

function isD1Database(value: unknown): value is D1Database {
    return isRecord(value) && typeof value.prepare === 'function';
}

async function initialize(options?: SqliteDbOptions): Promise<Kysely<Or3SqliteDb>> {
    const driver = resolveDriver(options);
    selectedDriver = driver;

    if (driver === 'd1') {
        d1Db = await resolveD1Database(options);
        instance = new Kysely<Or3SqliteDb>({
            dialect: new D1Dialect(d1Db),
        });
        return instance;
    }

    const path = resolveLocalPath(options);
    rawDb =
        driver === 'bun'
            ? await createBunSqliteDatabase(path)
            : driver === 'turso'
              ? await createTursoDatabase(options)
              : await createBetterSqliteDatabase(path);

    if (driver !== 'turso') applyLocalPragmas(rawDb, options);
    instance = new Kysely<Or3SqliteDb>({
        dialect: new SqliteDialect({ database: new KyselyDatabaseAdapter(rawDb) }),
    });
    return instance;
}

/**
 * Initialize the singleton once during server startup. This is async because
 * all native runtimes are loaded lazily, keeping Workers bundles Node-free.
 */
export async function initializeSqliteDb(
    options?: SqliteDbOptions
): Promise<Kysely<Or3SqliteDb>> {
    if (instance) return instance;
    if (!initialization) {
        initialization = initialize(options).finally(() => {
            initialization = null;
        });
    }
    return initialization;
}

/**
 * Return the initialized Kysely singleton.
 */
export function getSqliteDb(): Kysely<Or3SqliteDb> {
    if (!instance) {
        throw new Error(
            'SQLite DB not initialized — await initializeSqliteDb() before calling getSqliteDb().'
        );
    }
    return instance;
}

/** The selected driver, resolving the current environment before initialization. */
export function getSqliteDriver(): SqliteDriver {
    return selectedDriver ?? resolveDriver(undefined);
}

export function isD1Driver(): boolean {
    return getSqliteDriver() === 'd1';
}

/**
 * Get the native local SQLite connection for synchronous compatibility paths.
 * D1 intentionally has no synchronous raw connection.
 */
export function getRawDb(): SqliteRawDatabase {
    if (!rawDb) {
        const suffix = isD1Driver()
            ? ' Cloudflare D1 uses an async native binding.'
            : '';
        throw new Error(`SQLite raw DB not initialized.${suffix}`);
    }
    return rawDb;
}

/** Return the initialized D1 binding when the D1 driver is selected. */
export function getD1Database(): D1Database {
    if (!d1Db) {
        throw new Error('Cloudflare D1 is not initialized — call initializeSqliteDb() first.');
    }
    return d1Db;
}

/** Destroy the current connection (primarily for tests). */
export async function destroySqliteDb(): Promise<void> {
    if (instance) await instance.destroy();
    instance = null;
    rawDb = null;
    d1Db = null;
    selectedDriver = null;
}

/** Reset module state for tests. */
export function _resetForTest(): void {
    instance = null;
    rawDb = null;
    d1Db = null;
    selectedDriver = null;
    initialization = null;
}
