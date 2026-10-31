import type { getRawDb } from '../db/kysely';

/** Resolve explicit and legacy chat ownership inside the caller's SQLite snapshot. */
export function resolveCanonicalProjectOwnership(
    raw: ReturnType<typeof getRawDb>, workspaceId: string, threadId: string, explicitOwner: unknown,
): { projectId: string | null; status: 'resolved' | 'conflict' } {
    if (explicitOwner) {
        if (typeof explicitOwner !== 'string') throw new Error('Canonical project ownership is unresolved.');
        const owner = raw.prepare('SELECT id FROM s_projects WHERE workspace_id = ? AND id = ? AND COALESCE(deleted, 0) = 0')
            .get(workspaceId, explicitOwner);
        return { projectId: owner ? explicitOwner : null, status: 'resolved' };
    }
    const projects = raw.prepare('SELECT id, data_json FROM s_projects WHERE workspace_id = ? AND COALESCE(deleted, 0) = 0')
        .all(workspaceId) as { id: string; data_json: string }[];
    const owners = projects.filter(project => {
        const payload = JSON.parse(project.data_json);
        const entries: unknown = typeof payload.data === 'string' ? JSON.parse(payload.data) : payload.data ?? [];
        if (!Array.isArray(entries)) throw new Error('Canonical project membership is unresolved.');
        return entries.some(entry => {
            if (typeof entry === 'string') return entry.trim() === threadId;
            if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string') return false;
            const kind = typeof entry.kind === 'string' ? entry.kind.trim().toLowerCase() : entry.kind;
            return (kind === undefined || kind === 'chat') && entry.id.trim() === threadId;
        });
    });
    return { projectId: owners[0]?.id ?? null, status: owners.length > 1 ? 'conflict' : 'resolved' };
}
