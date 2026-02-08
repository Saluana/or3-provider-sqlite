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

/**
 * Get or create the singleton Kysely DB.
 * First call initializes the connection and sets pragmas.
 */
export function getSqliteDb(options?: SqliteDbOptions): Kysely<Or3SqliteDb> {
    if (instance) return instance;

    const path = options?.path ?? process.env.OR3_SQLITE_DB_PATH ?? ':memory:';
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
