import { createHash } from 'node:crypto';

export function stableJson(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(',')}}`;
}


/** Bind a finalization receipt to its immutable admission and terminal result. */
export function backgroundFinalizationFingerprint(input: { admission: unknown; snapshot: unknown }): string {
    const { expectedWorkspaceRevision: _revision, onlyIfThreadUnavailable: _threadPrecondition, ...snapshot } = input.snapshot as Record<string, unknown>;
    return createHash('sha256').update(stableJson({ ...input, snapshot })).digest('hex');
}
