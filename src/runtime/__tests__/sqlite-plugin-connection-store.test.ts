/**
 * Unit tests for the SQLite plugin connection store.
 *
 * Uses in-memory SQLite so the insert-only, compare-and-swap and evidence-ordering
 * guarantees are proven against real SQL, not a stand-in.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    _resetForTest,
    destroySqliteDb,
    getRawDb,
    initializeSqliteDb,
} from '../server/db/kysely';
import { createSqlitePluginConnectionStore } from '../server/plugin-connections/sqlite-connection-store';
import type { PluginConnectionStore } from '~~/server/utils/plugins/connections/store/registry';
import type { StoredPluginConnection } from '~~/shared/plugins/connections/contracts';

let store: PluginConnectionStore;

function connection(overrides: Partial<StoredPluginConnection> = {}): StoredPluginConnection {
    return {
        id: 'conn1',
        ownerUserId: 'user_1',
        workspaceId: 'ws_1',
        pluginId: 'example.plugin',
        providerId: 'fake',
        slotId: 'docs',
        label: 'Fake provider',
        scopes: ['read:items'],
        revision: 1,
        secretCiphertext: 'pcv1.a.b.c',
        createdAt: 1_000,
        updatedAt: 1_000,
        ...overrides,
    };
}

beforeEach(async () => {
    _resetForTest();
    await initializeSqliteDb({ path: ':memory:' });
    store = createSqlitePluginConnectionStore({ database: getRawDb() });
});

afterEach(() => {
    destroySqliteDb();
});

describe('sqlite plugin connection store', () => {
    it('inserts only and never reassigns an existing record', async () => {
        expect(await store.insert(connection())).toBe(true);
        // Same id, different owner: the second insert must not land at all.
        expect(
            await store.insert(connection({ ownerUserId: 'user_2', secretCiphertext: 'other' }))
        ).toBe(false);

        const stored = await store.get('conn1');
        expect(stored).toMatchObject({ ownerUserId: 'user_1', secretCiphertext: 'pcv1.a.b.c' });
        expect(stored?.slotId).toBe('docs');
    });

    it('lists by owner, workspace and plugin only', async () => {
        await store.insert(connection());
        await store.insert(connection({ id: 'conn2', ownerUserId: 'user_2' }));
        expect(
            await store.list({ ownerUserId: 'user_1', workspaceId: 'ws_1' })
        ).toHaveLength(1);
        expect(
            await store.list({ ownerUserId: 'user_1', workspaceId: 'ws_1', pluginId: 'other' })
        ).toHaveLength(0);
    });

    it('updates only with the expected revision and freezes identity fields', async () => {
        await store.insert(connection());
        expect(
            await store.update({
                id: 'conn1',
                expectedRevision: 1,
                revision: 2,
                updatedAt: 2_000,
                secretCiphertext: 'pcv1.next',
                scopes: ['read:items', 'write:items'],
            })
        ).toBe(true);
        // The same revision is no longer current.
        expect(
            await store.update({
                id: 'conn1',
                expectedRevision: 1,
                revision: 2,
                updatedAt: 3_000,
                secretCiphertext: 'pcv1.loser',
            })
        ).toBe(false);

        const stored = await store.get('conn1');
        expect(stored).toMatchObject({
            revision: 2,
            secretCiphertext: 'pcv1.next',
            ownerUserId: 'user_1',
            workspaceId: 'ws_1',
            providerId: 'fake',
            slotId: 'docs',
        });
        expect(stored?.scopes).toEqual(['read:items', 'write:items']);
    });

    it('refuses evidence for a revision that is not current', async () => {
        await store.insert(connection());
        expect(
            await store.setTestEvidence({
                connectionId: 'conn1',
                revision: 1,
                operationId: 'items.list',
                ok: true,
                checkedAt: 2_000,
            })
        ).toBe(true);
        // Rotate, then a late completion for revision 1 must be dropped.
        await store.update({
            id: 'conn1',
            expectedRevision: 1,
            revision: 2,
            updatedAt: 3_000,
            secretCiphertext: 'pcv1.next',
        });
        expect(
            await store.setTestEvidence({
                connectionId: 'conn1',
                revision: 1,
                operationId: 'items.list',
                ok: true,
                checkedAt: 9_999,
            })
        ).toBe(false);
        // A higher revision always wins, even with an earlier clock.
        expect(
            await store.setTestEvidence({
                connectionId: 'conn1',
                revision: 2,
                operationId: 'invalidated',
                ok: false,
                code: 'bad-credentials',
                checkedAt: 1,
            })
        ).toBe(true);
        expect(await store.getTestEvidence('conn1')).toMatchObject({ revision: 2, ok: false });
    });

    it('does not let an older completion replace newer evidence for the same revision', async () => {
        await store.insert(connection());
        await store.setTestEvidence({
            connectionId: 'conn1',
            revision: 1,
            operationId: 'items.list',
            ok: true,
            checkedAt: 5_000,
        });
        expect(
            await store.setTestEvidence({
                connectionId: 'conn1',
                revision: 1,
                operationId: 'items.list',
                ok: false,
                code: 'bad-credentials',
                checkedAt: 1_000,
            })
        ).toBe(false);
        expect(await store.getTestEvidence('conn1')).toMatchObject({ ok: true, checkedAt: 5_000 });
    });

    it('deletes a connection and its evidence together', async () => {
        await store.insert(connection());
        await store.setTestEvidence({
            connectionId: 'conn1',
            revision: 1,
            operationId: 'items.list',
            ok: true,
            checkedAt: 1_000,
        });
        await store.delete('conn1');
        expect(await store.get('conn1')).toBeNull();
        expect(await store.getTestEvidence('conn1')).toBeNull();
    });
});
