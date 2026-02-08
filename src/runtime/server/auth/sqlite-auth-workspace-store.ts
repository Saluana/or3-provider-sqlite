/**
 * SQLite implementation of AuthWorkspaceStore.
 *
 * Maps provider identity -> internal user and manages workspace CRUD.
 * Uses Kysely for all queries. No Convex or Clerk SDK imports.
 */
import type { AuthWorkspaceStore } from '~~/server/auth/store/types';
import type { WorkspaceRole } from '~~/app/core/hooks/hook-types';
import { getSqliteDb } from '../db/kysely';

function uid(): string {
    return crypto.randomUUID();
}

function nowEpoch(): number {
    return Math.floor(Date.now() / 1000);
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
        const db = this.db;

        // Check if auth account already exists
        const existing = await db
            .selectFrom('auth_accounts')
            .select('user_id')
            .where('provider', '=', input.provider)
            .where('provider_user_id', '=', input.providerUserId)
            .executeTakeFirst();

        if (existing) {
            return { userId: existing.user_id };
        }

        // Create user + auth account in transaction
        const userId = uid();
        const accountId = uid();
        const now = nowEpoch();

        await db.transaction().execute(async (tx) => {
            await tx
                .insertInto('users')
                .values({
                    id: userId,
                    email: input.email ?? null,
                    display_name: input.displayName ?? null,
                    active_workspace_id: null,
                    created_at: now,
                })
                .execute();

            await tx
                .insertInto('auth_accounts')
                .values({
                    id: accountId,
                    user_id: userId,
                    provider: input.provider,
                    provider_user_id: input.providerUserId,
                    created_at: now,
                })
                .execute();
        });

        return { userId };
    }

    async getOrCreateDefaultWorkspace(
        userId: string
    ): Promise<{ workspaceId: string; workspaceName: string }> {
        const db = this.db;

        // Check if user has any workspace memberships
        const membership = await db
            .selectFrom('workspace_members')
            .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
            .select([
                'workspaces.id',
                'workspaces.name',
            ])
            .where('workspace_members.user_id', '=', userId)
            .where('workspaces.deleted', '=', 0)
            .executeTakeFirst();

        if (membership) {
            // Ensure active_workspace_id is set
            await db
                .updateTable('users')
                .set({ active_workspace_id: membership.id })
                .where('id', '=', userId)
                .where('active_workspace_id', 'is', null)
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

            // If this was the user's active workspace, re-home to another
            const user = await tx
                .selectFrom('users')
                .select('active_workspace_id')
                .where('id', '=', input.userId)
                .executeTakeFirst();

            if (user?.active_workspace_id === input.workspaceId) {
                const next = await tx
                    .selectFrom('workspace_members')
                    .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
                    .select('workspaces.id')
                    .where('workspace_members.user_id', '=', input.userId)
                    .where('workspaces.deleted', '=', 0)
                    .where('workspaces.id', '!=', input.workspaceId)
                    .executeTakeFirst();

                await tx
                    .updateTable('users')
                    .set({ active_workspace_id: next?.id ?? null })
                    .where('id', '=', input.userId)
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
            .select('id')
            .where('workspace_id', '=', input.workspaceId)
            .where('user_id', '=', input.userId)
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
}

export function createSqliteAuthWorkspaceStore(): AuthWorkspaceStore {
    return new SqliteAuthWorkspaceStore();
}
