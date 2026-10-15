import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { createSqliteWebhookStore } from '../server/webhooks/sqlite-webhook-store';

// Real independent connections must share registration capacity; counting in
// the route or process memory cannot enforce the persistent store's quota.
it('atomically caps registrations across independent SQLite connections', async () => {
    const dir = await mkdtemp(`${tmpdir()}/or3-webhook-quota-`);
    const databases = [new Database(`${dir}/store.db`), new Database(`${dir}/store.db`)];
    try {
        const stores = databases.map(database => createSqliteWebhookStore({ database }));
        const input = { scope: 'user' as const, user_id: 'member', workspace_id: 'workspace', url: 'https://example.test', label: '', events: ['thread.created'], custom_hooks: [], signing_secret_enc: 'synthetic', enabled: true };
        const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, n) => (stores[n % 2]!.createWebhook as (record: typeof input, limit: number) => Promise<unknown>)(input, 5)));
        expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(5);
        expect(await stores[0]!.listWebhooks('member', 'workspace')).toHaveLength(5);
        for (const outcome of outcomes) if (outcome.status === 'rejected') expect(outcome.reason.code).toBe('WEBHOOK_LIMIT_EXCEEDED');
    } finally { databases.forEach(database => database.close()); await rm(dir, { recursive: true, force: true }); }
});
