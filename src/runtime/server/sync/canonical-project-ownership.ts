import type { getRawDb } from '../db/kysely';

/** Resolve explicit and legacy chat ownership inside the caller's SQLite snapshot. */
export function resolveCanonicalProjectOwnership(
    raw: ReturnType<typeof getRawDb>, workspaceId: string, threadId: string, explicitOwner: unknown,
): { projectId: string | null; status: 'resolved' | 'conflict' | 'unresolved' } {
    const unresolved = { projectId: null, status: 'unresolved' } as const;
    if (explicitOwner !== undefined && explicitOwner !== null && explicitOwner !== '') {
        if (typeof explicitOwner !== 'string') return unresolved;
        const owner = raw.prepare('SELECT id FROM s_projects WHERE workspace_id = ? AND id = ? AND COALESCE(deleted, 0) = 0')
            .get(workspaceId, explicitOwner);
        return { projectId: owner ? explicitOwner : null, status: 'resolved' };
    }
    // Stream legacy memberships and bound each transfer by the sync payload
    // ceiling. Unknown membership is uncertainty, never permission to run an
    // otherwise unowned chat. Explicit owners do not depend on this scan.
    const projects = raw.prepare(`SELECT id,
        CASE WHEN length(cast(data_json AS blob)) <= 262144 THEN data_json END AS data_json
        FROM s_projects WHERE workspace_id = ? AND COALESCE(deleted, 0) = 0`)
        .iterate(workspaceId) as IterableIterator<{ id: string; data_json: string | null }>;
    let owner: string | null = null;
    for (const project of projects) {
        if (project.data_json === null) return unresolved;
        let entries: unknown;
        try {
            const payload = JSON.parse(project.data_json) as Record<string, unknown> | null;
            if (!payload || Array.isArray(payload) || payload.id !== project.id) return unresolved;
            entries = typeof payload.data === 'string' ? JSON.parse(payload.data) : payload.data ?? [];
        } catch { return unresolved; }
        if (!Array.isArray(entries)) return unresolved;
        const owns = entries.some(entry => {
            if (typeof entry === 'string') return entry.trim() === threadId;
            if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string') return false;
            const kind = typeof entry.kind === 'string' ? entry.kind.trim().toLowerCase() : entry.kind;
            return (kind === undefined || kind === 'chat') && entry.id.trim() === threadId;
        });
        if (owns) {
            if (owner !== null) return { projectId: owner, status: 'conflict' };
            owner = project.id;
        }
    }
    return { projectId: owner, status: 'resolved' };
}
