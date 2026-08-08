import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    destroySqliteDb,
    initializeSqliteDb,
} from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { SqliteRateLimitProvider } from '../server/rate-limit/sqlite-provider';
import { createD1TestDatabase } from '../../../test/support/d1-test-database';

describe('SQLite rate-limit provider', () => {
    beforeEach(async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        await runMigrations(await initializeSqliteDb({ path: ':memory:' }));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await destroySqliteDb();
    });

    it('shares an atomic request budget across provider instances', async () => {
        const first = new SqliteRateLimitProvider();
        const second = new SqliteRateLimitProvider();
        const config = { windowMs: 60_000, maxRequests: 2 };

        await expect(first.checkAndRecord('connect:poll', config)).resolves.toEqual({
            allowed: true,
            remaining: 1,
        });
        await expect(second.checkAndRecord('connect:poll', config)).resolves.toEqual({
            allowed: true,
            remaining: 0,
        });
        await expect(first.checkAndRecord('connect:poll', config)).resolves.toEqual({
            allowed: false,
            remaining: 0,
            retryAfterMs: 60_000,
        });
    });
});

describe('SQLite rate-limit provider with D1', () => {
    let d1: ReturnType<typeof createD1TestDatabase>;

    beforeEach(async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        d1 = createD1TestDatabase();
        await runMigrations(
            await initializeSqliteDb({
                driver: 'd1',
                d1Database: d1.database,
            })
        );
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await destroySqliteDb();
        d1.close();
    });

    it('enforces the same request budget with the native D1 upsert', async () => {
        const provider = new SqliteRateLimitProvider();
        const config = { windowMs: 60_000, maxRequests: 2 };

        await expect(provider.checkAndRecord('d1:poll', config)).resolves.toEqual({
            allowed: true,
            remaining: 1,
        });
        await expect(provider.checkAndRecord('d1:poll', config)).resolves.toEqual({
            allowed: true,
            remaining: 0,
        });
        await expect(provider.checkAndRecord('d1:poll', config)).resolves.toEqual({
            allowed: false,
            remaining: 0,
            retryAfterMs: 60_000,
        });
    });
});
