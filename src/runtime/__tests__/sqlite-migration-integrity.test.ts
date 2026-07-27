import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    _resetForTest,
    destroySqliteDb,
    getRawDb,
    getSqliteDb,
} from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';

beforeEach(() => {
    _resetForTest();
});

afterEach(async () => {
    await destroySqliteDb();
});

describe('SQLite migration integrity boundaries', () => {
    it('refuses to start from a database created by a newer migration set', async () => {
        const db = getSqliteDb({ path: ':memory:' });
        await runMigrations(db);
        const raw = getRawDb();
        raw.prepare(
            'INSERT INTO kysely_migration (name, timestamp) VALUES (?, ?)'
        ).run('999_future_release', new Date().toISOString());

        await expect(runMigrations(db)).rejects.toThrow(
            /corrupted migrations|previously executed migration/i
        );

        expect(
            raw
                .prepare(
                    "SELECT COUNT(*) AS count FROM kysely_migration WHERE name = '999_future_release'"
                )
                .get()
        ).toMatchObject({ count: 1 });
    });

    it('fails closed when the migration ledger is current but required schema is missing', async () => {
        const db = getSqliteDb({ path: ':memory:' });
        await runMigrations(db);
        const raw = getRawDb();
        raw.exec('DROP TABLE upload_intents');

        await expect(runMigrations(db)).rejects.toThrow(
            /schema integrity check failed.*upload_intents/i
        );
    });
});
