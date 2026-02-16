/**
 * SQLite implementation of AuthWorkspaceStore.
 *
 * Maps provider identity -> internal user and manages workspace CRUD.
 * Uses Kysely for all queries. No Convex or Clerk SDK imports.
 */
import type { AuthWorkspaceStore } from '~~/server/auth/store/types';
import type { WorkspaceRole } from '~~/app/core/hooks/hook-types';
import { getRawDb, getSqliteDb } from '../db/kysely';
import { randomUUID } from 'node:crypto';

function uid(): string {
    return randomUUID();
}

function nowEpoch(): number {
    return Math.floor(Date.now() / 1000);
}

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

export class SqliteAuthWorkspaceStore implements AuthWorkspaceStore {
    private get db() {
        return getSqliteDb();
    }

    async getOrCreateUser(input: {
        provider: string;
        providerUserId: string;
        email?: string;
        displayName?: string;
    }): Promise<{ userId: string }> {
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
    ): Promise<{ workspaceId: string; workspaceName: string }> {
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

            return { workspaceId: membership.id, workspaceName: membership.name };
        }

        // Create default workspace
        const workspaceId = uid();
        const memberId = uid();
        const now = nowEpoch();
        const name = 'My Workspace';

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

        return { workspaceId, workspaceName: name };
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
}

export function createSqliteAuthWorkspaceStore(): AuthWorkspaceStore {
    return new SqliteAuthWorkspaceStore();
}
