type SyncRevision = {
    clock: number;
    hlc: string;
    opId: string;
};

export function compareSyncRevision(
    left: SyncRevision,
    right: SyncRevision,
): number {
    if (left.clock !== right.clock) return left.clock > right.clock ? 1 : -1;
    if (left.hlc !== right.hlc) return left.hlc > right.hlc ? 1 : -1;
    if (left.opId !== right.opId) return left.opId > right.opId ? 1 : -1;
    return 0;
}
