import type {
    RateLimitConfig,
    RateLimitProvider,
    RateLimitResult,
    RateLimitStats,
} from '~~/server/utils/rate-limit/types';
import { getRawDb } from '../db/kysely';

interface RateLimitRow {
    count: number;
    window_started_at: number;
    expires_at: number;
}

export class SqliteRateLimitProvider implements RateLimitProvider {
    readonly name = 'sqlite';

    async checkAndRecord(
        key: string,
        config: RateLimitConfig
    ): Promise<RateLimitResult> {
        requireConfig(config);
        const now = Date.now();
        const db = getRawDb();
        return db.transaction(() => {
            const row = db
                .prepare(
                    `SELECT count, window_started_at, expires_at
                     FROM rate_limits WHERE key = ?`
                )
                .get(key) as RateLimitRow | undefined;
            if (!row || row.expires_at <= now) {
                db.prepare(
                    `INSERT INTO rate_limits (
                        key, count, window_started_at, expires_at
                     ) VALUES (?, 1, ?, ?)
                     ON CONFLICT(key) DO UPDATE SET
                        count = 1,
                        window_started_at = excluded.window_started_at,
                        expires_at = excluded.expires_at`
                ).run(key, now, now + config.windowMs);
                return {
                    allowed: true,
                    remaining: config.maxRequests - 1,
                };
            }
            if (row.count >= config.maxRequests) {
                return {
                    allowed: false,
                    remaining: 0,
                    retryAfterMs: Math.max(0, row.expires_at - now),
                };
            }
            db.prepare(
                `UPDATE rate_limits SET count = count + 1 WHERE key = ?`
            ).run(key);
            return {
                allowed: true,
                remaining: config.maxRequests - row.count - 1,
            };
        })();
    }

    async getStats(
        key: string,
        config: RateLimitConfig
    ): Promise<RateLimitStats | null> {
        requireConfig(config);
        const now = Date.now();
        const row = getRawDb()
            .prepare(
                `SELECT count, window_started_at, expires_at
                 FROM rate_limits WHERE key = ?`
            )
            .get(key) as RateLimitRow | undefined;
        if (!row || row.expires_at <= now) {
            return {
                limit: config.maxRequests,
                remaining: config.maxRequests,
                resetMs: config.windowMs,
            };
        }
        return {
            limit: config.maxRequests,
            remaining: Math.max(0, config.maxRequests - row.count),
            resetMs: Math.max(0, row.expires_at - now),
        };
    }
}

export const sqliteRateLimitProvider = new SqliteRateLimitProvider();

function requireConfig(config: RateLimitConfig): void {
    if (
        !Number.isSafeInteger(config.windowMs) ||
        config.windowMs <= 0 ||
        !Number.isSafeInteger(config.maxRequests) ||
        config.maxRequests <= 0
    ) {
        throw new Error('Invalid SQLite rate-limit configuration');
    }
}
