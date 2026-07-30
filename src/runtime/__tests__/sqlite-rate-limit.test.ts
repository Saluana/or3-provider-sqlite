import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    destroySqliteDb,
    getSqliteDb,
} from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { SqliteRateLimitProvider } from '../server/rate-limit/sqlite-provider';

describe('SQLite rate-limit provider', () => {
    beforeEach(async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        await runMigrations(getSqliteDb({ path: ':memory:' }));
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
