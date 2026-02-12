import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSqliteDb, destroySqliteDb, _resetForTest } from '../server/db/kysely';

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

    it('requires OR3_SQLITE_DB_PATH in non-test mode unless in-memory is explicitly allowed', () => {
        delete process.env.OR3_SQLITE_DB_PATH;
        delete process.env.OR3_SQLITE_ALLOW_IN_MEMORY;
        process.env.VITEST = '';
        process.env.NODE_ENV = 'production';

        expect(() => getSqliteDb()).toThrow('OR3_SQLITE_DB_PATH is required');
    });

    it('allows in-memory DB in non-test mode when OR3_SQLITE_ALLOW_IN_MEMORY=true', () => {
        delete process.env.OR3_SQLITE_DB_PATH;
        process.env.OR3_SQLITE_ALLOW_IN_MEMORY = 'true';
        process.env.VITEST = '';
        process.env.NODE_ENV = 'production';

        expect(() => getSqliteDb()).not.toThrow();
    });

    it('warns when falling back to :memory: in non-test mode', () => {
        delete process.env.OR3_SQLITE_DB_PATH;
        process.env.OR3_SQLITE_ALLOW_IN_MEMORY = 'true';
        process.env.VITEST = '';
        process.env.NODE_ENV = 'production';
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        getSqliteDb();

        expect(warnSpy).toHaveBeenCalledWith(
            '[or3-sqlite] OR3_SQLITE_ALLOW_IN_MEMORY=true enabled. Data will be lost on process restart.'
        );
        warnSpy.mockRestore();
    });
});
