/**
 * Kysely singleton for the SQLite provider.
 *
 * Creates a single Kysely instance backed by better-sqlite3.
 * Applies WAL + NORMAL pragmas for safe concurrent reads.
 */
import { Kysely, SqliteDialect } from 'kysely';
import Database from 'better-sqlite3';
import type { Or3SqliteDb } from './schema';

let instance: Kysely<Or3SqliteDb> | null = null;
let rawDb: InstanceType<typeof Database> | null = null;

export interface SqliteDbOptions {
    path: string;
    journalMode?: string;
    synchronous?: string;
}

function envFlag(value: string | undefined): boolean {
    if (!value) return false;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * Get or create the singleton Kysely DB.
 * First call initializes the connection and sets pragmas.
 */
export function getSqliteDb(options?: SqliteDbOptions): Kysely<Or3SqliteDb> {
    if (instance) return instance;

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

    const journalMode = options?.journalMode ?? process.env.OR3_SQLITE_PRAGMA_JOURNAL_MODE ?? 'WAL';
    const synchronous = options?.synchronous ?? process.env.OR3_SQLITE_PRAGMA_SYNCHRONOUS ?? 'NORMAL';

    rawDb = new Database(path);
    rawDb.pragma(`journal_mode = ${journalMode}`);
    rawDb.pragma(`synchronous = ${synchronous}`);
    rawDb.pragma('foreign_keys = ON');

    instance = new Kysely<Or3SqliteDb>({
        dialect: new SqliteDialect({ database: rawDb }),
    });

    return instance;
}

/**
 * Get the underlying better-sqlite3 instance for raw transactions.
 * Only available after getSqliteDb() has been called.
 */
export function getRawDb(): InstanceType<typeof Database> {
    if (!rawDb) throw new Error('SQLite DB not initialized — call getSqliteDb() first');
    return rawDb;
}

/**
 * Destroy the connection (for tests/cleanup).
 */
export async function destroySqliteDb(): Promise<void> {
    if (instance) {
        await instance.destroy();
        instance = null;
        rawDb = null;
    }
}

/**
 * Reset the module-level singleton (for tests only).
 */
export function _resetForTest(): void {
    instance = null;
    rawDb = null;
}
