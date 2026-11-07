import { sql } from 'kysely';
import type {
    AdminUserInfo,
    AdminUserStore,
    WorkspaceAccessStore,
    WorkspaceSettingsStore,
    WorkspaceSummary,
} from '~~/server/admin/stores/types';
import { getSqliteDb } from '../../db/kysely';
import { SqliteExternalStorageGenerationCoordinator } from '../../storage/sqlite-generation-coordinator';

/** Rows store unix seconds; `createdAt` fields handed to the admin UI are milliseconds. */
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

// Structural copies of the host's optional customer-read contract, so this
// provider still type-checks against hosts that predate it.
interface CustomerSummary { userId: string; email?: string; displayName?: string; createdAt: number; lastContactAt: number | null }
interface CustomerPage { items: CustomerSummary[]; nextCursor: string | null }
interface CustomerWorkspace {
    id: string; name: string; role: Role; ownerUserId: string; createdAt: number;
    deleted: boolean; deletedAt?: number; memberCount: number; lastContactAt: number | null;
}

const CUSTOMER_PAGE_MAX = 50;

function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function encodeCursor(createdAt: number, id: string): string {
    return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url');
}

function decodeCursor(cursor: string): [number, string] | null {
    try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
        return Array.isArray(value) && value.length === 2 && Number.isSafeInteger(value[0]) && typeof value[1] === 'string'
            ? [value[0] as number, value[1] as string] : null;
    } catch {
        return null;
    }
}

class SqliteWorkspaceAccessStore implements WorkspaceAccessStore {
    async getStorageGenerationCandidates(input: { workspaceId: string; storageProviderId: 'fs' | 's3'; retentionSeconds: number; limit: number; cursor?: string }) {
        return new SqliteExternalStorageGenerationCoordinator({ storageProviderId: input.storageProviderId }).inspectCandidates(input);
    }

    private get db() {
        return getSqliteDb();
    }

    async recordSyncObservation(input: { userId: string; workspaceId: string; operation: 'push' | 'pull' | 'snapshot' | 'cursor'; observedAt: number; outcome: 'success' | 'failure'; code?: string }): Promise<void> {
        if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0) throw new Error('Invalid observation time');
        const success = input.outcome === 'success';
        const code = ['provider_failed', 'request_rejected', 'operation_rejected', 'rate_limited', 'access_denied'].includes(input.code ?? '') ? input.code! : 'provider_failed';
        await sql`INSERT INTO sync_observations (user_id, workspace_id, last_success_at, last_success_operation, last_failure_at, last_failure_code)
            VALUES (${input.userId}, ${input.workspaceId}, ${success ? input.observedAt : null}, ${success ? input.operation : null}, ${success ? null : input.observedAt}, ${success ? null : code})
            ON CONFLICT (user_id, workspace_id) DO UPDATE SET
            last_success_at = CASE WHEN excluded.last_success_at >= COALESCE(last_success_at, 0) THEN excluded.last_success_at ELSE last_success_at END,
            last_success_operation = CASE WHEN excluded.last_success_at >= COALESCE(last_success_at, 0) THEN excluded.last_success_operation ELSE last_success_operation END,
            last_failure_at = CASE WHEN excluded.last_failure_at >= COALESCE(last_failure_at, 0) THEN excluded.last_failure_at ELSE last_failure_at END,
            last_failure_code = CASE WHEN excluded.last_failure_at >= COALESCE(last_failure_at, 0) THEN excluded.last_failure_code ELSE last_failure_code END`.execute(this.db);
    }

    async getCustomerSyncObservations(input: { userId: string }) {
        const result = await sql<{ workspace_id: string; last_success_at: number | null; last_success_operation: string | null; last_failure_at: number | null; last_failure_code: string | null }>`
            SELECT workspace_id, last_success_at, last_success_operation, last_failure_at, last_failure_code
            FROM sync_observations WHERE user_id = ${input.userId} ORDER BY workspace_id LIMIT 500`.execute(this.db);
        return result.rows.map(row => ({ workspaceId: row.workspace_id, lastSuccessAt: row.last_success_at, lastSuccessOperation: row.last_success_operation, lastFailureAt: row.last_failure_at, lastFailureCode: row.last_failure_code }));
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
                userId = globalThis.crypto.randomUUID();
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
                userId = globalThis.crypto.randomUUID();
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
                        id: globalThis.crypto.randomUUID(),
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

        const existingMembership = await this.db
            .selectFrom('workspace_members')
            .select('role')
            .where('workspace_id', '=', input.workspaceId)
            .where('user_id', '=', userId)
            .executeTakeFirst();

        if (existingMembership) {
            await this.setMemberRole({
                workspaceId: input.workspaceId,
                userId,
                role: input.role,
            });
            return;
        }

        await this.db
            .insertInto('workspace_members')
            .values({
                id: globalThis.crypto.randomUUID(),
                workspace_id: input.workspaceId,
                user_id: userId,
                role: input.role,
                created_at: now,
            })
            .execute();
    }

    async setMemberRole(input: {
        workspaceId: string;
        userId: string;
        role: Role;
    }) {
        await this.db.transaction().execute(async (tx) => {
            const member = await tx
                .selectFrom('workspace_members')
                .select('role')
                .where('workspace_id', '=', input.workspaceId)
                .where('user_id', '=', input.userId)
                .executeTakeFirst();
            if (!member) {
                throw new Error('Workspace member not found');
            }

            if (member.role === 'owner' && input.role !== 'owner') {
                const owners = await tx
                    .selectFrom('workspace_members')
                    .select('user_id')
                    .where('workspace_id', '=', input.workspaceId)
                    .where('role', '=', 'owner')
                    .execute();
                if (owners.length <= 1) {
                    throw new Error(
                        'Cannot demote the last workspace owner. Transfer ownership first.'
                    );
                }

                const workspace = await tx
                    .selectFrom('workspaces')
                    .select('owner_user_id')
                    .where('id', '=', input.workspaceId)
                    .executeTakeFirst();
                if (workspace?.owner_user_id === input.userId) {
                    const replacement = owners.find(
                        (owner) => owner.user_id !== input.userId
                    );
                    if (!replacement) {
                        throw new Error(
                            'Cannot demote the last workspace owner. Transfer ownership first.'
                        );
                    }
                    await tx
                        .updateTable('workspaces')
                        .set({ owner_user_id: replacement.user_id })
                        .where('id', '=', input.workspaceId)
                        .execute();
                }
            }

            await tx
                .updateTable('workspace_members')
                .set({ role: input.role })
                .where('workspace_id', '=', input.workspaceId)
                .where('user_id', '=', input.userId)
                .execute();
        });
    }

    async removeMember(input: { workspaceId: string; userId: string }) {
        await this.db.transaction().execute(async (tx) => {
            const member = await tx
                .selectFrom('workspace_members')
                .select('role')
                .where('workspace_id', '=', input.workspaceId)
                .where('user_id', '=', input.userId)
                .executeTakeFirst();
            if (!member) {
                throw new Error('Workspace member not found');
            }

            if (member.role === 'owner') {
                const owners = await tx
                    .selectFrom('workspace_members')
                    .select('user_id')
                    .where('workspace_id', '=', input.workspaceId)
                    .where('role', '=', 'owner')
                    .execute();
                if (owners.length <= 1) {
                    throw new Error(
                        'Cannot remove the last workspace owner. Transfer ownership first.'
                    );
                }

                const workspace = await tx
                    .selectFrom('workspaces')
                    .select('owner_user_id')
                    .where('id', '=', input.workspaceId)
                    .executeTakeFirst();
                if (workspace?.owner_user_id === input.userId) {
                    const replacement = owners.find(
                        (owner) => owner.user_id !== input.userId
                    );
                    if (!replacement) {
                        throw new Error(
                            'Cannot remove the last workspace owner. Transfer ownership first.'
                        );
                    }
                    await tx
                        .updateTable('workspaces')
                        .set({ owner_user_id: replacement.user_id })
                        .where('id', '=', input.workspaceId)
                        .execute();
                }
            }

            await tx
                .deleteFrom('workspace_members')
                .where('workspace_id', '=', input.workspaceId)
                .where('user_id', '=', input.userId)
                .execute();
        });
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
                createdAt: row.created_at * 1000,
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
            createdAt: row.created_at * 1000,
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

        const workspaceId = globalThis.crypto.randomUUID();
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
                    id: globalThis.crypto.randomUUID(),
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

    /** Bounded, read-only canonical directory. Keyset-paginated by creation time; never provisions. */
    async listCustomers(input: { query?: string; cursor?: string | null; limit: number }): Promise<CustomerPage> {
        const limit = Math.max(1, Math.min(input.limit, CUSTOMER_PAGE_MAX));
        const query = input.query?.trim();
        const cursor = input.cursor ? decodeCursor(input.cursor) : null;
        if (input.cursor && !cursor) throw new Error('Invalid customer cursor');
        let rows = this.db.selectFrom('users').select(['id', 'email', 'display_name', 'created_at']);
        if (query) {
            const pattern = `%${escapeLike(query)}%`;
            rows = rows.where(sql<boolean>`(email LIKE ${pattern} ESCAPE '\\' OR display_name LIKE ${pattern} ESCAPE '\\' OR id LIKE ${pattern} ESCAPE '\\')`);
        }
        if (cursor) rows = rows.where(sql<boolean>`(created_at < ${cursor[0]} OR (created_at = ${cursor[0]} AND id < ${cursor[1]}))`);
        const page = await rows.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute();
        const items = page.slice(0, limit);
        const last = items.at(-1);
        return {
            items: await this.withLastContact(items),
            nextCursor: page.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
        };
    }

    /** Batch lookup by internal IDs. Unknown IDs are omitted, never invented. */
    async getCustomersByIds(input: { userIds: string[] }): Promise<CustomerSummary[]> {
        const ids = [...new Set(input.userIds)].slice(0, CUSTOMER_PAGE_MAX);
        if (!ids.length) return [];
        const rows = await this.db.selectFrom('users').select(['id', 'email', 'display_name', 'created_at']).where('id', 'in', ids).execute();
        return this.withLastContact(rows);
    }

    /** Owned workspaces (including retained deleted ones) and memberships for one canonical user. */
    async getCustomerWorkspaces(input: { userId: string }): Promise<CustomerWorkspace[]> {
        const rows = await this.db
            .selectFrom('workspaces')
            .leftJoin('workspace_members as membership', (join) => join
                .onRef('membership.workspace_id', '=', 'workspaces.id')
                .on('membership.user_id', '=', input.userId))
            .select([
                'workspaces.id as id', 'workspaces.name as name', 'workspaces.owner_user_id as owner_user_id',
                'workspaces.created_at as created_at', 'workspaces.deleted as deleted', 'workspaces.deleted_at as deleted_at',
                'membership.role as role',
                (eb) => eb.selectFrom('workspace_members').select((inner) => inner.fn.countAll<number>().as('n'))
                    .whereRef('workspace_members.workspace_id', '=', 'workspaces.id').as('member_count'),
                (eb) => eb.selectFrom('device_cursors').select((inner) => inner.fn.max('device_cursors.updated_at').as('t'))
                    .whereRef('device_cursors.workspace_id', '=', 'workspaces.id')
                    .where('device_cursors.owner_user_id', '=', input.userId).as('last_contact'),
            ])
            .where((eb) => eb.or([
                eb('workspaces.owner_user_id', '=', input.userId),
                eb('membership.user_id', '=', input.userId),
            ]))
            .orderBy('workspaces.created_at', 'asc')
            .limit(500)
            .execute();
        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            role: (row.owner_user_id === input.userId ? 'owner' : (row.role ?? 'viewer')) as Role,
            ownerUserId: row.owner_user_id,
            createdAt: row.created_at * 1000,
            deleted: row.deleted === 1,
            deletedAt: row.deleted_at ?? undefined,
            memberCount: Number(row.member_count ?? 0),
            lastContactAt: row.last_contact == null ? null : Number(row.last_contact) * 1000,
        }));
    }

    /** Last sync cursor write by this user (server contact, not proof of a completed sync). */
    private async withLastContact(rows: Array<{ id: string; email: string | null; display_name: string | null; created_at: number }>): Promise<CustomerSummary[]> {
        if (!rows.length) return [];
        const contacts = await this.db
            .selectFrom('device_cursors')
            .select(['owner_user_id', (eb) => eb.fn.max('updated_at').as('t')])
            .where('owner_user_id', 'in', rows.map((row) => row.id))
            .groupBy('owner_user_id')
            .execute();
        const byUser = new Map(contacts.map((row) => [row.owner_user_id, Number(row.t) * 1000]));
        return rows.map((row) => ({
            userId: row.id,
            email: row.email ?? undefined,
            displayName: row.display_name ?? undefined,
            createdAt: row.created_at * 1000,
            lastContactAt: byUser.get(row.id) ?? null,
        }));
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
                id: globalThis.crypto.randomUUID(),
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

    /** Atomically write only when the stored value still equals the expected value. */
    async compareAndSet(
        workspaceId: string,
        key: string,
        expectedValue: string | null,
        nextValue: string
    ): Promise<boolean> {
        const now = nowEpoch();
        if (expectedValue === null) {
            const result = await this.db
                .insertInto('admin_workspace_settings')
                .values({
                    id: globalThis.crypto.randomUUID(),
                    workspace_id: workspaceId,
                    key,
                    value: nextValue,
                    updated_at: now,
                })
                .onConflict((oc) => oc.columns(['workspace_id', 'key']).doNothing())
                .executeTakeFirst();
            return Number(result.numInsertedOrUpdatedRows ?? 0) === 1;
        }

        const result = await this.db
            .updateTable('admin_workspace_settings')
            .set({ value: nextValue, updated_at: now })
            .where('workspace_id', '=', workspaceId)
            .where('key', '=', key)
            .where('value', '=', expectedValue)
            .executeTakeFirst();
        return Number(result.numUpdatedRows ?? 0) === 1;
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
            createdAt: row.created_at * 1000,
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
