import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    destroySqliteDb,
    getRawDb,
    getSqliteDriver,
    getSqliteDb,
    initializeSqliteDb,
    _resetForTest,
} from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { createD1TestDatabase } from '../../../test/support/d1-test-database';
import { createSqliteWebhookStore } from '../server/webhooks/sqlite-webhook-store';

const bunIt = typeof (globalThis as { Bun?: unknown }).Bun === 'undefined' ? it.skip : it;

describe('sqlite db config guards', () => {
    const originalEnv = { ...process.env };

    beforeEach(async () => {
        await destroySqliteDb();
        _resetForTest();
        process.env = { ...originalEnv };
    });

    afterEach(async () => {
        await destroySqliteDb();
        _resetForTest();
        process.env = { ...originalEnv };
    });

    it('requires OR3_SQLITE_DB_PATH in non-test mode unless in-memory is explicitly allowed', async () => {
        delete process.env.OR3_SQLITE_DB_PATH;
        delete process.env.OR3_SQLITE_ALLOW_IN_MEMORY;
        process.env.VITEST = '';
        process.env.NODE_ENV = 'production';

        await expect(initializeSqliteDb()).rejects.toThrow('OR3_SQLITE_DB_PATH is required');
    });

    it('allows in-memory DB in non-test mode when OR3_SQLITE_ALLOW_IN_MEMORY=true', async () => {
        delete process.env.OR3_SQLITE_DB_PATH;
        process.env.OR3_SQLITE_ALLOW_IN_MEMORY = 'true';
        process.env.VITEST = '';
        process.env.NODE_ENV = 'production';

        await expect(initializeSqliteDb()).resolves.toBeDefined();
    });

    it('warns when falling back to :memory: in non-test mode', async () => {
        delete process.env.OR3_SQLITE_DB_PATH;
        process.env.OR3_SQLITE_ALLOW_IN_MEMORY = 'true';
        process.env.VITEST = '';
        process.env.NODE_ENV = 'production';
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await initializeSqliteDb();

        expect(warnSpy).toHaveBeenCalledWith(
            '[or3-sqlite] OR3_SQLITE_ALLOW_IN_MEMORY=true enabled. Data will be lost on process restart.'
        );
        warnSpy.mockRestore();
    });

    it('keeps better-sqlite3 as the default driver', () => {
        delete process.env.OR3_SQLITE_DRIVER;
        process.env.OR3_SQLITE_TURSO_URL = 'libsql://unused.turso.io';
        process.env.OR3_SQLITE_TURSO_AUTH_TOKEN = 'unused-token';
        process.env.OR3_SQLITE_D1_BINDING = 'DB';
        expect(getSqliteDriver()).toBe('better-sqlite3');
    });

    it('lazily initializes the shared SQLite database for webhook storage', async () => {
        const store = createSqliteWebhookStore({ path: ':memory:' });

        await expect(store.listAdminWebhooks()).resolves.toEqual([]);
        expect(getRawDb()).toBeDefined();
    });

    it('rejects unknown native driver selections', () => {
        process.env.OR3_SQLITE_DRIVER = 'not-a-driver';
        expect(() => getSqliteDriver()).toThrow('Unsupported OR3_SQLITE_DRIVER');
    });

    it('selects Bun\'s built-in SQLite runtime when configured', () => {
        process.env.OR3_SQLITE_DRIVER = 'bun';
        expect(getSqliteDriver()).toBe('bun');
    });

    bunIt('runs migrations and Kysely queries through Bun\'s native SQLite runtime', async () => {
        const db = await initializeSqliteDb({ driver: 'bun', path: ':memory:' });
        await runMigrations(db);

        await expect(
            db.selectNoFrom((eb) => eb.val(1).as('value')).executeTakeFirst()
        ).resolves.toEqual({ value: 1 });
    });

    it('uses the libSQL-compatible runtime for Turso', async () => {
        const db = await initializeSqliteDb({
            driver: 'turso',
            tursoUrl: ':memory:',
            tursoAuthToken: 'test-token',
        });
        await runMigrations(db);
        expect(getSqliteDriver()).toBe('turso');
        getRawDb().exec('CREATE TABLE turso_driver_test (id INTEGER)');
        getRawDb().prepare('INSERT INTO turso_driver_test (id) VALUES (?)').run(1);
        expect(getRawDb().prepare('SELECT id FROM turso_driver_test').get()).toEqual({ id: 1 });
        await expect(
            db.selectNoFrom((eb) => eb.val(1).as('value')).executeTakeFirst()
        ).resolves.toEqual({ value: 1 });
    });

    it('requires Turso connection settings before loading a driver', async () => {
        delete process.env.OR3_SQLITE_TURSO_URL;
        delete process.env.OR3_SQLITE_TURSO_AUTH_TOKEN;
        await expect(initializeSqliteDb({ driver: 'turso' })).rejects.toThrow(
            'OR3_SQLITE_TURSO_URL is required'
        );
    });

    it('uses a supplied D1 binding without loading a local driver', async () => {
        const queries: string[] = [];
        const d1 = {
            prepare(sql: string) {
                queries.push(sql);
                return {
                    bind() {
                        return this;
                    },
                    async all() {
                        return { results: [{ value: 1 }], meta: { changes: 0 } };
                    },
                    async run() {
                        return { results: [], meta: { changes: 0 } };
                    },
                };
            },
            async batch() {
                return [];
            },
        };
        await initializeSqliteDb({ driver: 'd1', d1Database: d1 as never });
        expect(getSqliteDriver()).toBe('d1');
        await expect(
            getSqliteDb().selectNoFrom((eb) => eb.val(1).as('value')).executeTakeFirst()
        ).resolves.toEqual({ value: 1 });
        expect(queries).toHaveLength(1);
        expect(() => getRawDb()).toThrow('Cloudflare D1 uses an async native binding');
    });

    it('reports a clear error when D1 is selected outside a Workers binding runtime', async () => {
        await expect(
            initializeSqliteDb({ driver: 'd1', d1Binding: 'DB' })
        ).rejects.toThrow('requires a Cloudflare Workers runtime with a D1 binding');
    });

    it('runs the full migration set through the D1 dialect', async () => {
        const d1 = createD1TestDatabase();
        const db = await initializeSqliteDb({
            driver: 'd1',
            d1Database: d1.database,
        });

        await runMigrations(db);
        await runMigrations(db);

        const tables = await db.introspection.getTables();
        expect(tables.map((table) => table.name)).toEqual(
            expect.arrayContaining([
                'users',
                'workspaces',
                'change_log',
                'sync_snapshots',
                'rate_limits',
            ])
        );
        d1.close();
    });
});
