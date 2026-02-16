import { randomUUID } from 'node:crypto';
import type {
    AdminUserInfo,
    AdminUserStore,
    WorkspaceAccessStore,
    WorkspaceSettingsStore,
    WorkspaceSummary,
} from '~~/server/admin/stores/types';
import { getSqliteDb } from '../../db/kysely';

function nowEpoch(): number {
    return Math.floor(Date.now() / 1000);
}

function normalizeEmail(value: string): string {
    return value.trim().toLowerCase();
}

function isEmail(value: string): boolean {
    return value.includes('@');
}

type Role = 'owner' | 'editor' | 'viewer';

class SqliteWorkspaceAccessStore implements WorkspaceAccessStore {
    private get db() {
        return getSqliteDb();
    }

    async listMembers(input: { workspaceId: string }) {
        const rows = await this.db
            .selectFrom('workspace_members')
            .innerJoin('users', 'users.id', 'workspace_members.user_id')
            .select([
                'workspace_members.user_id as user_id',
                'workspace_members.role as role',
                'users.email as email',
            ])
            .where('workspace_members.workspace_id', '=', input.workspaceId)
            .orderBy('workspace_members.created_at', 'asc')
            .execute();

        return rows.map((row) => ({
            userId: row.user_id,
            email: row.email ?? undefined,
            role: row.role as Role,
        }));
    }

    async upsertMember(input: {
        workspaceId: string;
        emailOrProviderId: string;
        role: Role;
        provider?: string;
    }) {
        const workspace = await this.db
            .selectFrom('workspaces')
            .select(['id', 'deleted'])
            .where('id', '=', input.workspaceId)
            .executeTakeFirst();

        if (!workspace || workspace.deleted === 1) {
            throw new Error('Workspace not found');
        }

        const lookup = input.emailOrProviderId.trim();
        const provider = input.provider?.trim();
        const now = nowEpoch();

        let userId: string | null = null;

        if (isEmail(lookup)) {
            const normalized = normalizeEmail(lookup);
            const existing = await this.db
                .selectFrom('users')
                .select('id')
                .where('email', '=', normalized)
                .executeTakeFirst();

            if (existing) {
                userId = existing.id;
            } else {
                userId = randomUUID();
                await this.db
                    .insertInto('users')
                    .values({
                        id: userId,
                        email: normalized,
                        display_name: null,
                        active_workspace_id: null,
                        created_at: now,
                    })
                    .execute();
            }
        } else {
            const account = provider
                ? await this.db
                      .selectFrom('auth_accounts')
                      .select('user_id')
                      .where('provider', '=', provider)
                      .where('provider_user_id', '=', lookup)
                      .executeTakeFirst()
                : await this.db
                      .selectFrom('auth_accounts')
                      .select('user_id')
                      .where('provider_user_id', '=', lookup)
                      .executeTakeFirst();

            if (account) {
                userId = account.user_id;
            } else {
                const byUserId = await this.db
                    .selectFrom('users')
                    .select('id')
                    .where('id', '=', lookup)
                    .executeTakeFirst();
                if (byUserId) {
                    userId = byUserId.id;
                }
            }

            if (!userId) {
                userId = randomUUID();
                await this.db
                    .insertInto('users')
                    .values({
                        id: userId,
                        email: null,
                        display_name: null,
                        active_workspace_id: null,
                        created_at: now,
                    })
                    .execute();

                await this.db
                    .insertInto('auth_accounts')
                    .values({
                        id: randomUUID(),
                        user_id: userId,
                        provider: provider || 'custom',
                        provider_user_id: lookup,
                        created_at: now,
                    })
                    .onConflict((oc) =>
                        oc.columns(['provider', 'provider_user_id']).doNothing()
                    )
                    .execute();
            }
        }

        await this.db
            .insertInto('workspace_members')
            .values({
                id: randomUUID(),
                workspace_id: input.workspaceId,
                user_id: userId,
                role: input.role,
                created_at: now,
            })
            .onConflict((oc) =>
                oc.columns(['workspace_id', 'user_id']).doUpdateSet({ role: input.role })
            )
            .execute();
    }

    async setMemberRole(input: {
        workspaceId: string;
        userId: string;
        role: Role;
    }) {
        const result = await this.db
            .updateTable('workspace_members')
            .set({ role: input.role })
            .where('workspace_id', '=', input.workspaceId)
            .where('user_id', '=', input.userId)
            .executeTakeFirst();

        const updated = Number(result.numUpdatedRows ?? 0);
        if (updated === 0) {
            throw new Error('Workspace member not found');
        }
    }

    async removeMember(input: { workspaceId: string; userId: string }) {
        await this.db
            .deleteFrom('workspace_members')
            .where('workspace_id', '=', input.workspaceId)
            .where('user_id', '=', input.userId)
            .execute();
    }

    async listWorkspaces(input: {
        search?: string;
        includeDeleted?: boolean;
        page: number;
        perPage: number;
    }): Promise<{ items: WorkspaceSummary[]; total: number }> {
        const includeDeleted = input.includeDeleted === true;
        const search = input.search?.trim();

        let totalQuery = this.db
            .selectFrom('workspaces')
            .select((eb) => eb.fn.countAll<number>().as('count'));

        let itemsQuery = this.db
            .selectFrom('workspaces')
            .leftJoin('users as owners', 'owners.id', 'workspaces.owner_user_id')
            .select([
                'workspaces.id as id',
                'workspaces.name as name',
                'workspaces.description as description',
                'workspaces.created_at as created_at',
                'workspaces.deleted as deleted',
                'workspaces.deleted_at as deleted_at',
                'workspaces.owner_user_id as owner_user_id',
                'owners.email as owner_email',
            ]);

        if (!includeDeleted) {
            totalQuery = totalQuery.where('workspaces.deleted', '=', 0);
            itemsQuery = itemsQuery.where('workspaces.deleted', '=', 0);
        }

        if (search) {
            const pattern = `%${search}%`;
            totalQuery = totalQuery.where((eb) =>
                eb.or([
                    eb('workspaces.name', 'like', pattern),
                    eb('workspaces.description', 'like', pattern),
                ])
            );
            itemsQuery = itemsQuery.where((eb) =>
                eb.or([
                    eb('workspaces.name', 'like', pattern),
                    eb('workspaces.description', 'like', pattern),
                ])
            );
        }

        const totalRow = await totalQuery.executeTakeFirstOrThrow();
        const total = Number(totalRow.count ?? 0);

        const page = Math.max(1, input.page);
        const perPage = Math.max(1, Math.min(input.perPage, 100));
        const offset = (page - 1) * perPage;

        const rows = await itemsQuery
            .orderBy('workspaces.created_at', 'desc')
            .limit(perPage)
            .offset(offset)
            .execute();

        if (rows.length === 0) {
            return { items: [], total };
        }

        const workspaceIds = rows.map((row) => row.id);
        const counts = await this.db
            .selectFrom('workspace_members')
            .select([
                'workspace_id',
                (eb) => eb.fn.countAll<number>().as('member_count'),
            ])
            .where('workspace_id', 'in', workspaceIds)
            .groupBy('workspace_id')
            .execute();

        const countMap = new Map(
            counts.map((row) => [row.workspace_id, Number(row.member_count ?? 0)])
        );

        return {
            total,
            items: rows.map((row) => ({
                id: row.id,
                name: row.name,
                description: row.description ?? undefined,
                createdAt: row.created_at,
                deleted: row.deleted === 1,
                deletedAt: row.deleted_at ?? undefined,
                ownerUserId: row.owner_user_id ?? undefined,
                ownerEmail: row.owner_email ?? undefined,
                memberCount: countMap.get(row.id) ?? 0,
            })),
        };
    }

    async getWorkspace(input: { workspaceId: string }): Promise<WorkspaceSummary | null> {
        const row = await this.db
            .selectFrom('workspaces')
            .leftJoin('users as owners', 'owners.id', 'workspaces.owner_user_id')
            .select([
                'workspaces.id as id',
                'workspaces.name as name',
                'workspaces.description as description',
                'workspaces.created_at as created_at',
                'workspaces.deleted as deleted',
                'workspaces.deleted_at as deleted_at',
                'workspaces.owner_user_id as owner_user_id',
                'owners.email as owner_email',
            ])
            .where('workspaces.id', '=', input.workspaceId)
            .executeTakeFirst();

        if (!row) return null;

        const memberCountRow = await this.db
            .selectFrom('workspace_members')
            .select((eb) => eb.fn.countAll<number>().as('count'))
            .where('workspace_id', '=', input.workspaceId)
            .executeTakeFirstOrThrow();

        return {
            id: row.id,
            name: row.name,
            description: row.description ?? undefined,
            createdAt: row.created_at,
            deleted: row.deleted === 1,
            deletedAt: row.deleted_at ?? undefined,
            ownerUserId: row.owner_user_id ?? undefined,
            ownerEmail: row.owner_email ?? undefined,
            memberCount: Number(memberCountRow.count ?? 0),
        };
    }

    async createWorkspace(input: {
        name: string;
        description?: string;
        ownerUserId: string;
    }): Promise<{ workspaceId: string }> {
        const owner = await this.db
            .selectFrom('users')
            .select('id')
            .where('id', '=', input.ownerUserId)
            .executeTakeFirst();

        if (!owner) {
            throw new Error('Owner user not found');
        }

        const workspaceId = randomUUID();
        const now = nowEpoch();

        await this.db.transaction().execute(async (tx) => {
            await tx
                .insertInto('workspaces')
                .values({
                    id: workspaceId,
                    name: input.name,
                    description: input.description ?? null,
                    owner_user_id: input.ownerUserId,
                    created_at: now,
                    deleted: 0,
                    deleted_at: null,
                })
                .execute();

            await tx
                .insertInto('workspace_members')
                .values({
                    id: randomUUID(),
                    workspace_id: workspaceId,
                    user_id: input.ownerUserId,
                    role: 'owner',
                    created_at: now,
                })
                .execute();
        });

        return { workspaceId };
    }

    async softDeleteWorkspace(input: { workspaceId: string; deletedAt: number }): Promise<void> {
        await this.db
            .updateTable('workspaces')
            .set({
                deleted: 1,
                deleted_at: input.deletedAt,
            })
            .where('id', '=', input.workspaceId)
            .execute();
    }

    async restoreWorkspace(input: { workspaceId: string }): Promise<void> {
        await this.db
            .updateTable('workspaces')
            .set({
                deleted: 0,
                deleted_at: null,
            })
            .where('id', '=', input.workspaceId)
            .execute();
    }

    async searchUsers(input: { query: string; limit?: number }) {
        const query = input.query.trim();
        const limit = Math.max(1, Math.min(input.limit ?? 20, 100));

        if (!query) return [];

        const pattern = `%${query}%`;
        const rows = await this.db
            .selectFrom('users')
            .select(['id', 'email', 'display_name'])
            .where((eb) =>
                eb.or([
                    eb('email', 'like', pattern),
                    eb('display_name', 'like', pattern),
                    eb('id', 'like', pattern),
                ])
            )
            .limit(limit)
            .execute();

        return rows.map((row) => ({
            userId: row.id,
            email: row.email ?? undefined,
            displayName: row.display_name ?? undefined,
        }));
    }
}

class SqliteWorkspaceSettingsStore implements WorkspaceSettingsStore {
    private get db() {
        return getSqliteDb();
    }

    async get(workspaceId: string, key: string): Promise<string | null> {
        const row = await this.db
            .selectFrom('admin_workspace_settings')
            .select('value')
            .where('workspace_id', '=', workspaceId)
            .where('key', '=', key)
            .executeTakeFirst();

        return row?.value ?? null;
    }

    async set(workspaceId: string, key: string, value: string): Promise<void> {
        await this.db
            .insertInto('admin_workspace_settings')
            .values({
                id: randomUUID(),
                workspace_id: workspaceId,
                key,
                value,
                updated_at: nowEpoch(),
            })
            .onConflict((oc) =>
                oc.columns(['workspace_id', 'key']).doUpdateSet({
                    value,
                    updated_at: nowEpoch(),
                })
            )
            .execute();
    }
}

class SqliteAdminUserStore implements AdminUserStore {
    private get db() {
        return getSqliteDb();
    }

    async listAdmins(): Promise<AdminUserInfo[]> {
        const rows = await this.db
            .selectFrom('admin_users')
            .innerJoin('users', 'users.id', 'admin_users.user_id')
            .select([
                'admin_users.user_id as user_id',
                'users.email as email',
                'users.display_name as display_name',
                'admin_users.created_at as created_at',
            ])
            .orderBy('admin_users.created_at', 'desc')
            .execute();

        return rows.map((row) => ({
            userId: row.user_id,
            email: row.email ?? undefined,
            displayName: row.display_name ?? undefined,
            createdAt: row.created_at,
        }));
    }

    async grantAdmin(input: { userId: string; createdByUserId?: string }): Promise<void> {
        const user = await this.db
            .selectFrom('users')
            .select('id')
            .where('id', '=', input.userId)
            .executeTakeFirst();

        if (!user) {
            throw new Error('User not found');
        }

        await this.db
            .insertInto('admin_users')
            .values({
                user_id: input.userId,
                created_at: nowEpoch(),
                created_by_user_id: input.createdByUserId ?? null,
            })
            .onConflict((oc) => oc.column('user_id').doNothing())
            .execute();
    }

    async revokeAdmin(input: { userId: string }): Promise<void> {
        await this.db
            .deleteFrom('admin_users')
            .where('user_id', '=', input.userId)
            .execute();
    }

    async isAdmin(input: { userId: string }): Promise<boolean> {
        const row = await this.db
            .selectFrom('admin_users')
            .select('user_id')
            .where('user_id', '=', input.userId)
            .executeTakeFirst();

        return Boolean(row);
    }

    async searchUsers(input: { query: string; limit?: number }) {
        const query = input.query.trim();
        const limit = Math.max(1, Math.min(input.limit ?? 20, 100));

        if (!query) return [];

        const pattern = `%${query}%`;
        const rows = await this.db
            .selectFrom('users')
            .select(['id', 'email', 'display_name'])
            .where((eb) =>
                eb.or([
                    eb('email', 'like', pattern),
                    eb('display_name', 'like', pattern),
                    eb('id', 'like', pattern),
                ])
            )
            .limit(limit)
            .execute();

        return rows.map((row) => ({
            userId: row.id,
            email: row.email ?? undefined,
            displayName: row.display_name ?? undefined,
        }));
    }
}

export function createSqliteWorkspaceAccessStore(): WorkspaceAccessStore {
    return new SqliteWorkspaceAccessStore();
}

export function createSqliteWorkspaceSettingsStore(): WorkspaceSettingsStore {
    return new SqliteWorkspaceSettingsStore();
}

export function createSqliteAdminUserStore(): AdminUserStore {
    return new SqliteAdminUserStore();
}
