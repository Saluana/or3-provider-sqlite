import { compareSyncRevision } from './sync-revision';

type SyncRevision = {
    clock: number;
    hlc: string;
    opId: string;
};

type SnapshotItem = {
    kind: 'row' | 'tombstone';
    tableName: string;
    pk: string;
    payload?: Record<string, unknown>;
    revision: SyncRevision;
    serverDeletedAt?: number;
};

type SyncContractAdapter = {
    name: string;
    reset(): Promise<void>;
    seedMaterialized(items: readonly SnapshotItem[], highWatermark: number): Promise<void>;
    bootstrap(): Promise<{ items: SnapshotItem[]; highWatermark: number }>;
    resolveWinner(left: SyncRevision, right: SyncRevision): Promise<SyncRevision>;
};

function canonicalBootstrapFixture(): {
    items: SnapshotItem[];
    highWatermark: number;
} {
    return {
        highWatermark: 7,
        items: [
            {
                kind: 'row',
                tableName: 'messages',
                pk: 'message-live',
                payload: { id: 'message-live', content: 'retained state' },
                revision: { clock: 3, hlc: '1000-0-a', opId: 'put-3' },
            },
            {
                kind: 'tombstone',
                tableName: 'messages',
                pk: 'message-deleted',
                revision: { clock: 4, hlc: '1001-0-a', opId: 'delete-4' },
                serverDeletedAt: 1001,
            },
        ],
    };
}

export async function verifySyncContract(adapter: SyncContractAdapter): Promise<void> {
    const fixture = canonicalBootstrapFixture();
    await adapter.reset();
    await adapter.seedMaterialized(fixture.items, fixture.highWatermark);
    const snapshot = await adapter.bootstrap();
    if (snapshot.highWatermark !== fixture.highWatermark) {
        throw new Error(`${adapter.name} returned the wrong snapshot watermark`);
    }
    const keys = snapshot.items
        .map((item) => `${item.kind}:${item.tableName}:${item.pk}`)
        .sort();
    const expectedKeys = fixture.items
        .map((item) => `${item.kind}:${item.tableName}:${item.pk}`)
        .sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
        throw new Error(`${adapter.name} returned an incomplete materialized snapshot`);
    }

    const left = { clock: 9, hlc: '2000-0-a', opId: 'op-a' };
    const right = { clock: 9, hlc: '2000-0-a', opId: 'op-b' };
    const winner = await adapter.resolveWinner(left, right);
    const expected = compareSyncRevision(left, right) >= 0 ? left : right;
    if (winner.opId !== expected.opId) {
        throw new Error(`${adapter.name} violated deterministic revision ordering`);
    }
}
