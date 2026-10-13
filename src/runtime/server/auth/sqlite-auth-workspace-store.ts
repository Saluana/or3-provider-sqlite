/**
 * SQLite implementation of AuthWorkspaceStore.
 *
 * Maps provider identity -> internal user and manages workspace CRUD.
 * Uses Kysely for all queries. No Convex or Clerk SDK imports.
 */
import type {
    AuthWorkspaceStore,
    SignupInviteSummary,
    SignupProvisionResult,
    SignupValidationResult,
    InviteProvisionResult,
    InviteValidationResult,
} from '~~/server/auth/store/types';
import type { WorkspaceRole } from '~~/app/core/hooks/hook-types';
import { getRawDb, getSqliteDb, isD1Driver } from '../db/kysely';
import type { SignupInvitesTable } from '../db/schema';
import { d1All, d1Batch, d1Run } from '../db/d1';

function uid(): string {
    return globalThis.crypto.randomUUID();
}

function nowEpoch(): number {
    return Math.floor(Date.now() / 1000);
}

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

export class SqliteAuthWorkspaceStore implements AuthWorkspaceStore {
    constructor() {
        // D1 has no synchronous transaction spanning validation and all inserts.
        if (isD1Driver()) {
            Object.assign(this, { createSignupInvite: undefined, listSignupInvites: undefined,
                revokeSignupInvite: undefined, validateSignupInvite: undefined,
                acceptSignupInviteAndProvisionUser: undefined });
        }
    }

    private cleanupSignupInvites(): void {
        getRawDb().prepare('DELETE FROM signup_invites WHERE id IN (SELECT id FROM signup_invites WHERE retain_until < ? ORDER BY retain_until LIMIT 100)').run(Date.now());
    }

    async createSignupInvite(input: { id: string; email: string; token_hash: string; expires_at: number; created_by_admin: string }): Promise<{ id: string }> {
        this.db;
        this.cleanupSignupInvites();
        getRawDb().prepare('INSERT INTO signup_invites (id, email, token_hash, expires_at, created_at, created_by_admin, retain_until) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(input.id, normalizeEmail(input.email), input.token_hash, input.expires_at, Date.now(), input.created_by_admin, input.expires_at + 90 * 86400_000);
        return { id: input.id };
    }

    async listSignupInvites(input: { limit: number; cursor?: string }): Promise<{ invites: SignupInviteSummary[]; next_cursor: string | null }> {
        this.db;
        this.cleanupSignupInvites();
        let cursor: { created_at: number; id: string } | null = null;
        if (input.cursor) {
            try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()); } catch { throw new Error('Invalid invite cursor'); }
            if (!cursor || !Number.isSafeInteger(cursor.created_at) || typeof cursor.id !== 'string') throw new Error('Invalid invite cursor');
        }
        const limit = Math.min(100, Math.max(1, Math.trunc(input.limit)));
        const rows = getRawDb().prepare(
            'SELECT id, email, status, expires_at, created_at, created_by_admin, revoked_at, accepted_at, user_id, workspace_id FROM signup_invites ' +
            (cursor ? 'WHERE (created_at, id) < (?, ?) ' : '') + 'ORDER BY created_at DESC, id DESC LIMIT ?'
        ).all(...(cursor ? [cursor.created_at, cursor.id] : []), limit + 1) as SignupInviteSummary[];
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return { invites: page.map(row => ({ ...row, status: row.status === 'pending' && row.expires_at <= Date.now() ? 'expired' : row.status })),
            next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString('base64url') : null };
    }

    async revokeSignupInvite(input: { id: string }): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'already_used' }> {
        this.db;
        const raw = getRawDb();
        return raw.transaction(() => {
            const invite = raw.prepare('SELECT status, expires_at FROM signup_invites WHERE id = ?').get(input.id) as SignupInvitesTable | undefined;
            if (!invite) return { ok: false as const, reason: 'not_found' as const };
            if (invite.status !== 'pending' || invite.expires_at <= Date.now()) return { ok: false as const, reason: 'already_used' as const };
            const now = Date.now();
            raw.prepare("UPDATE signup_invites SET status = 'revoked', revoked_at = ?, retain_until = ? WHERE id = ?").run(now, now + 90 * 86400_000, input.id);
            return { ok: true as const };
        }).immediate();
    }

    private checkSignupInvite(invite: SignupInvitesTable | undefined, input: { email: string; token_hash: string }): SignupValidationResult {
        if (!invite) return { ok: false, reason: 'not_found' };
        if (invite.token_hash !== input.token_hash) return { ok: false, reason: 'token_mismatch' };
        if (invite.email !== normalizeEmail(input.email)) return { ok: false, reason: 'email_mismatch' };
        if (invite.status === 'accepted') return { ok: false, reason: 'already_used' };
        if (invite.status === 'revoked') return { ok: false, reason: 'revoked' };
        if (invite.expires_at <= Date.now()) return { ok: false, reason: 'expired' };
        return { ok: true };
    }

    async validateSignupInvite(input: { id: string; email: string; token_hash: string }): Promise<SignupValidationResult> {
        this.db;
        const invite = getRawDb().prepare('SELECT * FROM signup_invites WHERE id = ?').get(input.id) as SignupInvitesTable | undefined;
        return this.checkSignupInvite(invite, input);
    }

    async acceptSignupInviteAndProvisionUser(input: { invite_id: string; token_hash: string; provider: string; provider_user_id: string; email: string; display_name?: string }): Promise<SignupProvisionResult> {
        this.db;
        const raw = getRawDb();
        return raw.transaction((): SignupProvisionResult => {
            const invite = raw.prepare('SELECT * FROM signup_invites WHERE id = ?').get(input.invite_id) as SignupInvitesTable | undefined;
            if (invite?.status === 'accepted' && invite.token_hash === input.token_hash && invite.email === normalizeEmail(input.email)
                && invite.accepted_provider === input.provider && invite.accepted_provider_user_id === input.provider_user_id) {
                // A receipt is not membership: do not recreate deleted records or reset selection.
                return { ok: true, user_id: invite.user_id!, workspace_id: invite.workspace_id!, workspace_name: 'My Workspace', created: false };
            }
            const validation = this.checkSignupInvite(invite, input);
            if (!validation.ok) return validation;
            const email = normalizeEmail(input.email);
            if (raw.prepare('SELECT id FROM auth_accounts WHERE provider = ? AND provider_user_id = ?').get(input.provider, input.provider_user_id)
                || raw.prepare('SELECT id FROM users WHERE lower(trim(email)) = ?').get(email)) return { ok: false, reason: 'account_exists' };
            const userId = uid(); const workspaceId = uid(); const now = nowEpoch();
            raw.prepare('INSERT INTO users (id, email, display_name, active_workspace_id, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, email, input.display_name ?? null, workspaceId, now);
            raw.prepare('INSERT INTO auth_accounts (id, user_id, provider, provider_user_id, created_at) VALUES (?, ?, ?, ?, ?)').run(uid(), userId, input.provider, input.provider_user_id, now);
            raw.prepare('INSERT INTO workspaces (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)').run(workspaceId, 'My Workspace', userId, now);
            raw.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)').run(uid(), workspaceId, userId, 'owner', now);
            const acceptedAt = Date.now();
            raw.prepare("UPDATE signup_invites SET status = 'accepted', accepted_at = ?, user_id = ?, workspace_id = ?, accepted_provider = ?, accepted_provider_user_id = ?, retain_until = ? WHERE id = ?")
                .run(acceptedAt, userId, workspaceId, input.provider, input.provider_user_id, acceptedAt + 90 * 86400_000, input.invite_id);
            return { ok: true, user_id: userId, workspace_id: workspaceId, workspace_name: 'My Workspace', created: true };
        }).immediate();
    }

    private get db() {
        return getSqliteDb();
    }

    protected onInviteProvisionStep(
        _step:
            | 'invite_validated'
            | 'user_created'
            | 'membership_created'
            | 'invite_consumed'
    ): void {}

    async getOrCreateUser(input: {
        provider: string;
        providerUserId: string;
        email?: string;
        displayName?: string;
    }): Promise<{ userId: string }> {
        if (isD1Driver()) {
            return this.getOrCreateUserInD1(input);
        }
        // Ensure singleton is initialized before raw access.
        this.db;
        const raw = getRawDb();

        const userId = raw
            .transaction(() => {
                const existing = raw
                    .prepare(
                        `SELECT user_id
                         FROM auth_accounts
                         WHERE provider = ? AND provider_user_id = ?`
                    )
                    .get(input.provider, input.providerUserId) as
                    | { user_id: string }
                    | undefined;

                if (existing) {
                    return existing.user_id;
                }

                const candidateUserId = uid();
                const now = nowEpoch();

                raw.prepare(
                    `INSERT OR IGNORE INTO users (id, email, display_name, active_workspace_id, created_at)
                     VALUES (?, ?, ?, NULL, ?)`
                ).run(
                    candidateUserId,
                    input.email ?? null,
                    input.displayName ?? null,
                    now
                );

                raw.prepare(
                    `INSERT OR IGNORE INTO auth_accounts (id, user_id, provider, provider_user_id, created_at)
                     VALUES (?, ?, ?, ?, ?)`
                ).run(
                    uid(),
                    candidateUserId,
                    input.provider,
                    input.providerUserId,
                    now
                );

                const winner = raw
                    .prepare(
                        `SELECT user_id
                         FROM auth_accounts
                         WHERE provider = ? AND provider_user_id = ?`
                    )
                    .get(input.provider, input.providerUserId) as
                    | { user_id: string }
                    | undefined;

                if (!winner) {
                    throw new Error('Failed to resolve auth account after get-or-create attempt');
                }

                if (winner.user_id !== candidateUserId) {
                    raw.prepare(
                        `DELETE FROM users
                         WHERE id = ?
                           AND NOT EXISTS (
                               SELECT 1 FROM auth_accounts WHERE user_id = ?
                           )`
                    ).run(candidateUserId, candidateUserId);
                }

                return winner.user_id;
            })
            .immediate();

        return { userId };
    }

    async getUser(input: {
        provider: string;
        providerUserId: string;
    }): Promise<
        | {
              userId: string;
              email?: string;
              displayName?: string;
          }
        | null
    > {
        const db = this.db;
        const row = await db
            .selectFrom('auth_accounts')
            .innerJoin('users', 'users.id', 'auth_accounts.user_id')
            .select([
                'users.id as user_id',
                'users.email as email',
                'users.display_name as display_name',
            ])
            .where('auth_accounts.provider', '=', input.provider)
            .where('auth_accounts.provider_user_id', '=', input.providerUserId)
            .executeTakeFirst();

        if (!row) return null;
        return {
            userId: row.user_id,
            email: row.email ?? undefined,
            displayName: row.display_name ?? undefined,
        };
    }

    async getOrCreateDefaultWorkspace(
        userId: string
    ): Promise<{ workspaceId: string; workspaceName: string; created?: boolean }> {
        const db = this.db;

        // Prefer the user's current active workspace when it is valid.
        const activeMembership = await db
            .selectFrom('users')
            .innerJoin('workspaces', 'workspaces.id', 'users.active_workspace_id')
            .innerJoin(
                'workspace_members',
                (join) =>
                    join
                        .onRef(
                            'workspace_members.workspace_id',
                            '=',
                            'workspaces.id'
                        )
                        .onRef('workspace_members.user_id', '=', 'users.id')
            )
            .select(['workspaces.id', 'workspaces.name'])
            .where('users.id', '=', userId)
            .where('workspaces.deleted', '=', 0)
            .executeTakeFirst();

        if (activeMembership) {
            return {
                workspaceId: activeMembership.id,
                workspaceName: activeMembership.name,
                created: false,
            };
        }

        // Check if user has workspace memberships
        const membership = await db
            .selectFrom('workspace_members')
            .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
            .select([
                'workspaces.id',
                'workspaces.name',
            ])
            .where('workspace_members.user_id', '=', userId)
            .where('workspaces.deleted', '=', 0)
            .orderBy('workspace_members.created_at', 'asc')
            .executeTakeFirst();

        if (membership) {
            // Repair stale/missing active workspace pointer.
            await db
                .updateTable('users')
                .set({ active_workspace_id: membership.id })
                .where('id', '=', userId)
                .execute();

            return {
                workspaceId: membership.id,
                workspaceName: membership.name,
                created: false,
            };
        }

        // Create default workspace
        const workspaceId = uid();
        const memberId = uid();
        const now = nowEpoch();
        const name = 'My Workspace';

        if (isD1Driver()) {
            await d1Batch([
                {
                    sql: `INSERT INTO workspaces (
                        id, name, description, owner_user_id, created_at, deleted, deleted_at
                    ) VALUES (?, ?, NULL, ?, ?, 0, NULL)`,
                    parameters: [workspaceId, name, userId, now],
                },
                {
                    sql: `INSERT INTO workspace_members (
                        id, workspace_id, user_id, role, created_at
                    ) VALUES (?, ?, ?, 'owner', ?)`,
                    parameters: [memberId, workspaceId, userId, now],
                },
                {
                    sql: 'UPDATE users SET active_workspace_id = ? WHERE id = ?',
                    parameters: [workspaceId, userId],
                },
            ]);
        } else {
            await db.transaction().execute(async (tx) => {
            await tx
                .insertInto('workspaces')
                .values({
                    id: workspaceId,
                    name,
                    description: null,
                    owner_user_id: userId,
                    created_at: now,
                    deleted: 0,
                    deleted_at: null,
                })
                .execute();

            await tx
                .insertInto('workspace_members')
                .values({
                    id: memberId,
                    workspace_id: workspaceId,
                    user_id: userId,
                    role: 'owner',
                    created_at: now,
                })
                .execute();

            await tx
                .updateTable('users')
                .set({ active_workspace_id: workspaceId })
                .where('id', '=', userId)
                .execute();
            });
        }

        return { workspaceId, workspaceName: name, created: true };
    }

    async getWorkspaceRole(input: {
        userId: string;
        workspaceId: string;
    }): Promise<WorkspaceRole | null> {
        const db = this.db;

        const member = await db
            .selectFrom('workspace_members')
            .select('role')
            .where('workspace_id', '=', input.workspaceId)
            .where('user_id', '=', input.userId)
            .executeTakeFirst();

        if (!member) return null;
        return member.role as WorkspaceRole;
    }

    async listUserWorkspaces(
        userId: string
    ): Promise<
        Array<{
            id: string;
            name: string;
            description?: string | null;
            role: WorkspaceRole;
            createdAt?: number;
            isActive?: boolean;
        }>
    > {
        const db = this.db;

        const user = await db
            .selectFrom('users')
            .select('active_workspace_id')
            .where('id', '=', userId)
            .executeTakeFirst();

        const activeId = user?.active_workspace_id ?? null;

        const rows = await db
            .selectFrom('workspace_members')
            .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
            .select([
                'workspaces.id',
                'workspaces.name',
                'workspaces.description',
                'workspaces.created_at',
                'workspace_members.role',
            ])
            .where('workspace_members.user_id', '=', userId)
            .where('workspaces.deleted', '=', 0)
            .execute();

        return rows.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            role: r.role as WorkspaceRole,
            createdAt: r.created_at,
            isActive: r.id === activeId,
        }));
    }

    async createWorkspace(input: {
        userId: string;
        name: string;
        description?: string | null;
    }): Promise<{ workspaceId: string }> {
        const db = this.db;
        const workspaceId = uid();
        const memberId = uid();
        const now = nowEpoch();

        if (isD1Driver()) {
            await d1Batch([
                {
                    sql: `INSERT INTO workspaces (
                        id, name, description, owner_user_id, created_at, deleted, deleted_at
                    ) VALUES (?, ?, ?, ?, ?, 0, NULL)`,
                    parameters: [
                        workspaceId,
                        input.name,
                        input.description ?? null,
                        input.userId,
                        now,
                    ],
                },
                {
                    sql: `INSERT INTO workspace_members (
                        id, workspace_id, user_id, role, created_at
                    ) VALUES (?, ?, ?, 'owner', ?)`,
                    parameters: [memberId, workspaceId, input.userId, now],
                },
            ]);
        } else {
            await db.transaction().execute(async (tx) => {
            await tx
                .insertInto('workspaces')
                .values({
                    id: workspaceId,
                    name: input.name,
                    description: input.description ?? null,
                    owner_user_id: input.userId,
                    created_at: now,
                    deleted: 0,
                    deleted_at: null,
                })
                .execute();

            await tx
                .insertInto('workspace_members')
                .values({
                    id: memberId,
                    workspace_id: workspaceId,
                    user_id: input.userId,
                    role: 'owner',
                    created_at: now,
                })
                .execute();
            });
        }

        return { workspaceId };
    }

    async updateWorkspace(input: {
        userId: string;
        workspaceId: string;
        name: string;
        description?: string | null;
    }): Promise<void> {
        const db = this.db;

        // Verify membership with owner/editor role
        const member = await db
            .selectFrom('workspace_members')
            .select('role')
            .where('workspace_id', '=', input.workspaceId)
            .where('user_id', '=', input.userId)
            .executeTakeFirst();

        if (!member || member.role === 'viewer') {
            throw new Error('Forbidden: insufficient workspace role');
        }

        await db
            .updateTable('workspaces')
            .set({
                name: input.name,
                description: input.description ?? null,
            })
            .where('id', '=', input.workspaceId)
            .where('deleted', '=', 0)
            .execute();
    }

    async removeWorkspace(input: { userId: string; workspaceId: string }): Promise<void> {
        const db = this.db;

        // Must be owner
        const member = await db
            .selectFrom('workspace_members')
            .select('role')
            .where('workspace_id', '=', input.workspaceId)
            .where('user_id', '=', input.userId)
            .executeTakeFirst();

        if (!member || member.role !== 'owner') {
            throw new Error('Forbidden: only owner can remove workspace');
        }

        const now = nowEpoch();

        if (isD1Driver()) {
            await d1Batch([
                {
                    sql: 'UPDATE workspaces SET deleted = 1, deleted_at = ? WHERE id = ?',
                    parameters: [now, input.workspaceId],
                },
                {
                    sql: `UPDATE users
                        SET active_workspace_id = (
                            SELECT workspace_members.workspace_id
                            FROM workspace_members
                            INNER JOIN workspaces
                                ON workspaces.id = workspace_members.workspace_id
                            WHERE workspace_members.user_id = users.id
                              AND workspaces.deleted = 0
                              AND workspaces.id <> ?
                            ORDER BY workspace_members.created_at ASC
                            LIMIT 1
                        )
                        WHERE active_workspace_id = ?`,
                    parameters: [input.workspaceId, input.workspaceId],
                },
            ]);
            return;
        }

        await db.transaction().execute(async (tx) => {
            // Soft-delete
            await tx
                .updateTable('workspaces')
                .set({ deleted: 1, deleted_at: now })
                .where('id', '=', input.workspaceId)
                .execute();

            // Re-home every user currently pointing at this workspace.
            const affectedUsers = await tx
                .selectFrom('users')
                .select('id')
                .where('active_workspace_id', '=', input.workspaceId)
                .execute();

            for (const affectedUser of affectedUsers) {
                const next = await tx
                    .selectFrom('workspace_members')
                    .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
                    .select('workspaces.id')
                    .where('workspace_members.user_id', '=', affectedUser.id)
                    .where('workspaces.deleted', '=', 0)
                    .where('workspaces.id', '!=', input.workspaceId)
                    .executeTakeFirst();

                await tx
                    .updateTable('users')
                    .set({ active_workspace_id: next?.id ?? null })
                    .where('id', '=', affectedUser.id)
                    .execute();
            }
        });
    }

    async setActiveWorkspace(input: {
        userId: string;
        workspaceId: string;
    }): Promise<void> {
        const db = this.db;

        // Verify membership
        const member = await db
            .selectFrom('workspace_members')
            .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
            .select('workspace_members.id')
            .where('workspace_members.workspace_id', '=', input.workspaceId)
            .where('workspace_members.user_id', '=', input.userId)
            .where('workspaces.deleted', '=', 0)
            .executeTakeFirst();

        if (!member) {
            throw new Error('Forbidden: not a member of this workspace');
        }

        await db
            .updateTable('users')
            .set({ active_workspace_id: input.workspaceId })
            .where('id', '=', input.userId)
            .execute();
    }

    async createInvite(input: {
        workspaceId: string;
        email: string;
        role: WorkspaceRole;
        invitedByUserId: string;
        expiresAt: number;
        tokenHash: string;
    }): Promise<{ inviteId: string }> {
        const db = this.db;
        const inviteId = uid();
        const now = nowEpoch();

        await db
            .insertInto('auth_invites')
            .values({
                id: inviteId,
                workspace_id: input.workspaceId,
                email: normalizeEmail(input.email),
                role: input.role,
                status: 'pending',
                invited_by_user_id: input.invitedByUserId,
                token_hash: input.tokenHash,
                expires_at: input.expiresAt,
                accepted_at: null,
                accepted_user_id: null,
                revoked_at: null,
                created_at: now,
                updated_at: now,
            })
            .execute();

        return { inviteId };
    }

    async listInvites(input: {
        workspaceId: string;
        status?: 'pending' | 'accepted' | 'revoked' | 'expired';
        limit?: number;
    }) {
        const db = this.db;
        const now = nowEpoch();

        await db
            .updateTable('auth_invites')
            .set({ status: 'expired', updated_at: now })
            .where('workspace_id', '=', input.workspaceId)
            .where('status', '=', 'pending')
            .where('expires_at', '<=', now)
            .execute();

        let query = db
            .selectFrom('auth_invites')
            .selectAll()
            .where('workspace_id', '=', input.workspaceId)
            .orderBy('created_at', 'desc');

        if (input.status) {
            query = query.where('status', '=', input.status);
        }

        const rows = await query.limit(Math.max(1, Math.min(input.limit ?? 100, 500))).execute();

        return rows.map((row) => ({
            id: row.id,
            workspaceId: row.workspace_id,
            email: row.email,
            role: row.role as WorkspaceRole,
            status: row.status as 'pending' | 'accepted' | 'revoked' | 'expired',
            invitedByUserId: row.invited_by_user_id,
            expiresAt: row.expires_at,
            tokenHash: row.token_hash,
            acceptedAt: row.accepted_at,
            acceptedUserId: row.accepted_user_id,
            revokedAt: row.revoked_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }));
    }

    async revokeInvite(input: {
        workspaceId: string;
        inviteId: string;
        revokedByUserId: string;
    }): Promise<void> {
        const db = this.db;
        const now = nowEpoch();
        const row = await db
            .selectFrom('auth_invites')
            .select(['id', 'status'])
            .where('workspace_id', '=', input.workspaceId)
            .where('id', '=', input.inviteId)
            .executeTakeFirst();

        if (!row) {
            throw new Error('Invite not found');
        }

        if (row.status !== 'pending') return;

        await db
            .updateTable('auth_invites')
            .set({
                status: 'revoked',
                revoked_at: now,
                updated_at: now,
            })
            .where('workspace_id', '=', input.workspaceId)
            .where('id', '=', input.inviteId)
            .execute();

        void input.revokedByUserId;
    }

    async validateInvite(input: {
        workspaceId: string;
        email: string;
        tokenHash: string;
    }): Promise<InviteValidationResult> {
        if (isD1Driver()) {
            return this.validateInviteInD1(input);
        }
        this.db;
        const raw = getRawDb();
        const now = nowEpoch();
        const invite = raw
            .prepare(
                `SELECT role, status, email, expires_at
                 FROM auth_invites
                 WHERE workspace_id = ? AND token_hash = ?
                 LIMIT 1`
            )
            .get(input.workspaceId, input.tokenHash) as
            | {
                  role: WorkspaceRole;
                  status: 'pending' | 'accepted' | 'revoked' | 'expired';
                  email: string;
                  expires_at: number;
              }
            | undefined;

        if (!invite) return { ok: false, reason: 'not_found' };
        if (invite.email !== normalizeEmail(input.email)) {
            return { ok: false, reason: 'email_mismatch' };
        }
        if (invite.status === 'accepted') return { ok: false, reason: 'already_used' };
        if (invite.status === 'revoked') return { ok: false, reason: 'revoked' };
        if (invite.status === 'expired' || invite.expires_at <= now) {
            return { ok: false, reason: 'expired' };
        }
        return { ok: true, role: invite.role };
    }

    async acceptInviteAndProvisionUser(input: {
        provider: string;
        providerUserId: string;
        email: string;
        displayName?: string;
        workspaceId: string;
        tokenHash: string;
    }): Promise<InviteProvisionResult> {
        if (isD1Driver()) {
            return this.acceptInviteAndProvisionUserInD1(input);
        }
        this.db;
        const raw = getRawDb();
        const now = nowEpoch();
        const normalizedEmail = normalizeEmail(input.email);

        return raw
            .transaction(() => {
                const invite = raw
                    .prepare(
                        `SELECT id, role, status, email, expires_at
                         FROM auth_invites
                         WHERE workspace_id = ? AND token_hash = ?
                         LIMIT 1`
                    )
                    .get(input.workspaceId, input.tokenHash) as
                    | {
                          id: string;
                          role: WorkspaceRole;
                          status: 'pending' | 'accepted' | 'revoked' | 'expired';
                          email: string;
                          expires_at: number;
                      }
                    | undefined;

                if (!invite) return { ok: false as const, reason: 'not_found' as const };
                if (invite.email !== normalizedEmail) {
                    return { ok: false as const, reason: 'email_mismatch' as const };
                }
                if (invite.status === 'accepted') {
                    return { ok: false as const, reason: 'already_used' as const };
                }
                if (invite.status === 'revoked') {
                    return { ok: false as const, reason: 'revoked' as const };
                }
                if (invite.status === 'expired' || invite.expires_at <= now) {
                    return { ok: false as const, reason: 'expired' as const };
                }
                this.onInviteProvisionStep('invite_validated');

                const existingAccount = raw
                    .prepare(
                        `SELECT user_id
                         FROM auth_accounts
                         WHERE provider = ? AND provider_user_id = ?
                         LIMIT 1`
                    )
                    .get(input.provider, input.providerUserId) as
                    | { user_id: string }
                    | undefined;

                const userId = existingAccount?.user_id ?? uid();
                const createdUser = !existingAccount;
                if (createdUser) {
                    raw.prepare(
                        `INSERT INTO users (id, email, display_name, active_workspace_id, created_at)
                         VALUES (?, ?, ?, NULL, ?)`
                    ).run(userId, normalizedEmail, input.displayName ?? null, now);
                    raw.prepare(
                        `INSERT INTO auth_accounts (id, user_id, provider, provider_user_id, created_at)
                         VALUES (?, ?, ?, ?, ?)`
                    ).run(uid(), userId, input.provider, input.providerUserId, now);
                }
                this.onInviteProvisionStep('user_created');

                const existingMembership = raw
                    .prepare(
                        `SELECT id FROM workspace_members
                         WHERE workspace_id = ? AND user_id = ?
                         LIMIT 1`
                    )
                    .get(input.workspaceId, userId) as { id: string } | undefined;
                if (existingMembership) {
                    raw.prepare('UPDATE workspace_members SET role = ? WHERE id = ?').run(
                        invite.role,
                        existingMembership.id
                    );
                } else {
                    raw.prepare(
                        `INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at)
                         VALUES (?, ?, ?, ?, ?)`
                    ).run(uid(), input.workspaceId, userId, invite.role, now);
                }
                raw.prepare('UPDATE users SET active_workspace_id = ? WHERE id = ?').run(
                    input.workspaceId,
                    userId
                );
                this.onInviteProvisionStep('membership_created');

                const consumed = raw.prepare(
                    `UPDATE auth_invites
                     SET status = 'accepted', accepted_at = ?, accepted_user_id = ?, updated_at = ?
                     WHERE id = ? AND status = 'pending'`
                ).run(now, userId, now, invite.id);
                if (consumed.changes !== 1) {
                    throw new Error('Invite state changed during atomic acceptance');
                }
                this.onInviteProvisionStep('invite_consumed');

                return {
                    ok: true as const,
                    userId,
                    role: invite.role,
                    createdUser,
                };
            })
            .immediate();
    }

    async consumeInvite(input: {
        workspaceId: string;
        email: string;
        tokenHash: string;
        acceptedUserId: string;
    }): Promise<
        | { ok: true; role: WorkspaceRole }
        | {
              ok: false;
              reason:
                  | 'not_found'
                  | 'expired'
                  | 'revoked'
                  | 'already_used'
                  | 'token_mismatch';
          }
    > {
        if (isD1Driver()) {
            return this.consumeInviteInD1(input);
        }
        // Ensure singleton initialized before raw transaction usage.
        this.db;
        const raw = getRawDb();
        const now = nowEpoch();
        const normalized = normalizeEmail(input.email);

        return raw
            .transaction(() => {
                raw.prepare(
                    `UPDATE auth_invites
                     SET status = 'expired', updated_at = ?
                     WHERE workspace_id = ?
                       AND status = 'pending'
                       AND expires_at <= ?`
                ).run(now, input.workspaceId, now);

                const invite = raw
                    .prepare(
                        `SELECT *
                         FROM auth_invites
                         WHERE workspace_id = ?
                           AND email = ?
                         ORDER BY created_at ASC
                         LIMIT 1`
                    )
                    .get(input.workspaceId, normalized) as
                    | {
                          id: string;
                          role: WorkspaceRole;
                          status: 'pending' | 'accepted' | 'revoked' | 'expired';
                          token_hash: string;
                          expires_at: number;
                      }
                    | undefined;

                if (!invite) {
                    return { ok: false as const, reason: 'not_found' as const };
                }
                if (invite.status === 'revoked') {
                    return { ok: false as const, reason: 'revoked' as const };
                }
                if (invite.status === 'accepted') {
                    return { ok: false as const, reason: 'already_used' as const };
                }
                if (invite.status === 'expired' || invite.expires_at <= now) {
                    return { ok: false as const, reason: 'expired' as const };
                }
                if (invite.token_hash !== input.tokenHash) {
                    return { ok: false as const, reason: 'token_mismatch' as const };
                }

                raw.prepare(
                    `UPDATE auth_invites
                     SET status = 'accepted', accepted_at = ?, accepted_user_id = ?, updated_at = ?
                     WHERE id = ?`
                ).run(now, input.acceptedUserId, now, invite.id);

                const existingMember = raw
                    .prepare(
                        `SELECT id FROM workspace_members
                         WHERE workspace_id = ? AND user_id = ?
                         LIMIT 1`
                    )
                    .get(input.workspaceId, input.acceptedUserId) as
                    | { id: string }
                    | undefined;

                if (existingMember) {
                    raw.prepare(
                        `UPDATE workspace_members
                         SET role = ?
                         WHERE id = ?`
                    ).run(invite.role, existingMember.id);
                } else {
                    raw.prepare(
                        `INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at)
                         VALUES (?, ?, ?, ?, ?)`
                    ).run(uid(), input.workspaceId, input.acceptedUserId, invite.role, now);
                }

                raw.prepare(
                    `UPDATE users
                     SET active_workspace_id = ?
                     WHERE id = ?`
                ).run(input.workspaceId, input.acceptedUserId);

                return { ok: true as const, role: invite.role };
            })
            .immediate();
    }

    private async getOrCreateUserInD1(input: {
        provider: string;
        providerUserId: string;
        email?: string;
        displayName?: string;
    }): Promise<{ userId: string }> {
        const candidateUserId = uid();
        const now = nowEpoch();
        const results = await d1Batch([
            {
                sql: `INSERT OR IGNORE INTO users (
                    id, email, display_name, active_workspace_id, created_at
                ) VALUES (?, ?, ?, NULL, ?)`,
                parameters: [
                    candidateUserId,
                    input.email ?? null,
                    input.displayName ?? null,
                    now,
                ],
            },
            {
                sql: `INSERT OR IGNORE INTO auth_accounts (
                    id, user_id, provider, provider_user_id, created_at
                ) VALUES (?, ?, ?, ?, ?)`,
                parameters: [
                    uid(),
                    candidateUserId,
                    input.provider,
                    input.providerUserId,
                    now,
                ],
            },
            {
                sql: `SELECT user_id
                    FROM auth_accounts
                    WHERE provider = ? AND provider_user_id = ?`,
                parameters: [input.provider, input.providerUserId],
            },
        ]);
        const winner = (results[2]?.results ?? [])[0] as
            | { user_id?: string }
            | undefined;
        if (!winner?.user_id) {
            throw new Error('Failed to resolve auth account after get-or-create attempt');
        }
        if (winner.user_id !== candidateUserId) {
            await d1Run(
                `DELETE FROM users
                 WHERE id = ?
                   AND NOT EXISTS (
                       SELECT 1 FROM auth_accounts WHERE user_id = ?
                   )`,
                candidateUserId,
                candidateUserId
            );
        }
        return { userId: winner.user_id };
    }

    private async validateInviteInD1(input: {
        workspaceId: string;
        email: string;
        tokenHash: string;
    }): Promise<InviteValidationResult> {
        const now = nowEpoch();
        const [invite] = await d1All<{
            role: WorkspaceRole;
            status: 'pending' | 'accepted' | 'revoked' | 'expired';
            email: string;
            expires_at: number;
        }>(
            `SELECT role, status, email, expires_at
             FROM auth_invites
             WHERE workspace_id = ? AND token_hash = ?
             LIMIT 1`,
            input.workspaceId,
            input.tokenHash
        );

        if (!invite) return { ok: false, reason: 'not_found' };
        if (invite.email !== normalizeEmail(input.email)) {
            return { ok: false, reason: 'email_mismatch' };
        }
        if (invite.status === 'accepted') return { ok: false, reason: 'already_used' };
        if (invite.status === 'revoked') return { ok: false, reason: 'revoked' };
        if (invite.status === 'expired' || invite.expires_at <= now) {
            return { ok: false, reason: 'expired' };
        }
        return { ok: true, role: invite.role };
    }

    private async acceptInviteAndProvisionUserInD1(input: {
        provider: string;
        providerUserId: string;
        email: string;
        displayName?: string;
        workspaceId: string;
        tokenHash: string;
    }): Promise<InviteProvisionResult> {
        const now = nowEpoch();
        const normalizedEmail = normalizeEmail(input.email);
        const validation = await this.validateInviteInD1({
            workspaceId: input.workspaceId,
            email: normalizedEmail,
            tokenHash: input.tokenHash,
        });
        if (!validation.ok) return validation;
        this.onInviteProvisionStep('invite_validated');

        const [existingAccount] = await d1All<{ user_id: string }>(
            `SELECT user_id FROM auth_accounts
             WHERE provider = ? AND provider_user_id = ?
             LIMIT 1`,
            input.provider,
            input.providerUserId
        );
        const { userId } = await this.getOrCreateUserInD1({
            provider: input.provider,
            providerUserId: input.providerUserId,
            email: normalizedEmail,
            displayName: input.displayName,
        });
        const createdUser = !existingAccount;
        this.onInviteProvisionStep('user_created');

        const results = await d1Batch([
            {
                sql: `UPDATE auth_invites
                    SET status = 'accepted', accepted_at = ?, accepted_user_id = ?, updated_at = ?
                    WHERE workspace_id = ?
                      AND token_hash = ?
                      AND email = ?
                      AND status = 'pending'
                      AND expires_at > ?`,
                parameters: [
                    now,
                    userId,
                    now,
                    input.workspaceId,
                    input.tokenHash,
                    normalizedEmail,
                    now,
                ],
            },
            {
                sql: `INSERT INTO workspace_members (
                    id, workspace_id, user_id, role, created_at
                )
                SELECT ?, ?, ?, role, ?
                FROM auth_invites
                WHERE workspace_id = ?
                  AND token_hash = ?
                  AND status = 'accepted'
                  AND accepted_user_id = ?
                ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
                parameters: [
                    uid(),
                    input.workspaceId,
                    userId,
                    now,
                    input.workspaceId,
                    input.tokenHash,
                    userId,
                ],
            },
            {
                sql: `UPDATE users SET active_workspace_id = ?
                    WHERE id = ?
                      AND EXISTS (
                          SELECT 1 FROM workspace_members
                          WHERE workspace_id = ? AND user_id = ?
                      )`,
                parameters: [input.workspaceId, userId, input.workspaceId, userId],
            },
        ]);
        if ((results[0]?.meta?.changes ?? 0) !== 1) {
            return this.inviteProvisionFailureInD1(input.workspaceId, normalizedEmail, input.tokenHash);
        }
        this.onInviteProvisionStep('membership_created');
        this.onInviteProvisionStep('invite_consumed');
        return { ok: true, userId, role: validation.role, createdUser };
    }

    private async consumeInviteInD1(input: {
        workspaceId: string;
        email: string;
        tokenHash: string;
        acceptedUserId: string;
    }): Promise<
        | { ok: true; role: WorkspaceRole }
        | {
              ok: false;
              reason:
                  | 'not_found'
                  | 'expired'
                  | 'revoked'
                  | 'already_used'
                  | 'token_mismatch';
          }
    > {
        const now = nowEpoch();
        const normalized = normalizeEmail(input.email);
        await d1Run(
            `UPDATE auth_invites SET status = 'expired', updated_at = ?
             WHERE workspace_id = ?
               AND status = 'pending'
               AND expires_at <= ?`,
            now,
            input.workspaceId,
            now
        );
        const [invite] = await d1All<{
            id: string;
            role: WorkspaceRole;
            status: 'pending' | 'accepted' | 'revoked' | 'expired';
            token_hash: string;
            expires_at: number;
        }>(
            `SELECT * FROM auth_invites
             WHERE workspace_id = ? AND email = ?
             ORDER BY created_at ASC
             LIMIT 1`,
            input.workspaceId,
            normalized
        );
        if (!invite) return { ok: false, reason: 'not_found' };
        if (invite.status === 'revoked') return { ok: false, reason: 'revoked' };
        if (invite.status === 'accepted') return { ok: false, reason: 'already_used' };
        if (invite.status === 'expired' || invite.expires_at <= now) {
            return { ok: false, reason: 'expired' };
        }
        if (invite.token_hash !== input.tokenHash) {
            return { ok: false, reason: 'token_mismatch' };
        }

        const results = await d1Batch([
            {
                sql: `UPDATE auth_invites
                    SET status = 'accepted', accepted_at = ?, accepted_user_id = ?, updated_at = ?
                    WHERE id = ? AND status = 'pending' AND token_hash = ?`,
                parameters: [
                    now,
                    input.acceptedUserId,
                    now,
                    invite.id,
                    input.tokenHash,
                ],
            },
            {
                sql: `INSERT INTO workspace_members (
                    id, workspace_id, user_id, role, created_at
                )
                SELECT ?, ?, ?, role, ?
                FROM auth_invites
                WHERE id = ?
                  AND status = 'accepted'
                  AND accepted_user_id = ?
                ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
                parameters: [
                    uid(),
                    input.workspaceId,
                    input.acceptedUserId,
                    now,
                    invite.id,
                    input.acceptedUserId,
                ],
            },
            {
                sql: `UPDATE users SET active_workspace_id = ?
                    WHERE id = ?
                      AND EXISTS (
                          SELECT 1 FROM workspace_members
                          WHERE workspace_id = ? AND user_id = ?
                      )`,
                parameters: [
                    input.workspaceId,
                    input.acceptedUserId,
                    input.workspaceId,
                    input.acceptedUserId,
                ],
            },
        ]);
        if ((results[0]?.meta?.changes ?? 0) !== 1) {
            const [latest] = await d1All<{
                status: 'pending' | 'accepted' | 'revoked' | 'expired';
            }>('SELECT status FROM auth_invites WHERE id = ?', invite.id);
            if (!latest) return { ok: false, reason: 'not_found' };
            if (latest.status === 'revoked') return { ok: false, reason: 'revoked' };
            if (latest.status === 'accepted') return { ok: false, reason: 'already_used' };
            return { ok: false, reason: 'expired' };
        }
        return { ok: true, role: invite.role };
    }

    private async inviteProvisionFailureInD1(
        workspaceId: string,
        email: string,
        tokenHash: string
    ): Promise<InviteProvisionResult> {
        const validation = await this.validateInviteInD1({
            workspaceId,
            email,
            tokenHash,
        });
        return validation.ok ? { ok: false, reason: 'already_used' } : validation;
    }
}

export function createSqliteAuthWorkspaceStore(): AuthWorkspaceStore {
    return new SqliteAuthWorkspaceStore();
}
