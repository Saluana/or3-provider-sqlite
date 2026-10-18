/**
 * Unit tests for SqliteAuthWorkspaceStore.
 *
 * Uses in-memory SQLite for fast isolated tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
    getSqliteDb,
    initializeSqliteDb,
    destroySqliteDb,
    _resetForTest,
} from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { SqliteAuthWorkspaceStore } from '../server/auth/sqlite-auth-workspace-store';

type InviteProvisionStep =
    | 'invite_validated'
    | 'user_created'
    | 'membership_created'
    | 'invite_consumed';

class FailureInjectingSqliteAuthWorkspaceStore extends SqliteAuthWorkspaceStore {
    constructor(private readonly failureStep: InviteProvisionStep) {
        super();
    }

    protected override onInviteProvisionStep(step: InviteProvisionStep): void {
        if (step === this.failureStep) {
            throw new Error(`injected failure after ${step}`);
        }
    }
}

let store: SqliteAuthWorkspaceStore;

beforeEach(async () => {
    _resetForTest();
    const db = await initializeSqliteDb({ path: ':memory:' });
    await runMigrations(db);
    store = new SqliteAuthWorkspaceStore();
});

afterEach(async () => {
    await destroySqliteDb();
});

describe('SqliteAuthWorkspaceStore', () => {
    describe('getOrCreateUser', () => {
        it('creates a new user on first call', async () => {
            const result = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
                email: 'test@example.com',
                displayName: 'Test User',
            });

            expect(result.userId).toBeDefined();
            expect(typeof result.userId).toBe('string');
        });

        it('returns same userId for same provider identity (idempotent)', async () => {
            const first = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const second = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            expect(second.userId).toBe(first.userId);
        });

        it('creates different users for different provider IDs', async () => {
            const a = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const b = await store.getOrCreateUser({
                provider: 'clerk',
                providerUserId: 'user-1',
            });

            expect(a.userId).not.toBe(b.userId);
        });

        it('creates different users for different provider user IDs', async () => {
            const a = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const b = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-2',
            });

            expect(a.userId).not.toBe(b.userId);
        });

        it('is idempotent under concurrent calls for the same provider identity', async () => {
            const calls = await Promise.all(
                Array.from({ length: 10 }, () =>
                    store.getOrCreateUser({
                        provider: 'basic-auth',
                        providerUserId: 'concurrent-user',
                    })
                )
            );

            const ids = new Set(calls.map((c) => c.userId));
            expect(ids.size).toBe(1);

            const db = getSqliteDb();
            const authCount = await db
                .selectFrom('auth_accounts')
                .select((eb) => eb.fn.countAll<number>().as('count'))
                .where('provider', '=', 'basic-auth')
                .where('provider_user_id', '=', 'concurrent-user')
                .executeTakeFirstOrThrow();

            const userCount = await db
                .selectFrom('users')
                .select((eb) => eb.fn.countAll<number>().as('count'))
                .executeTakeFirstOrThrow();

            expect(authCount.count).toBe(1);
            expect(userCount.count).toBe(1);
        });
    });

    describe('getOrCreateDefaultWorkspace', () => {
        it('creates a default workspace on first call', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const result = await store.getOrCreateDefaultWorkspace(userId);

            expect(result.workspaceId).toBeDefined();
            expect(result.workspaceName).toBe('My Workspace');
        });

        it('returns same workspace on subsequent calls', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const first = await store.getOrCreateDefaultWorkspace(userId);
            const second = await store.getOrCreateDefaultWorkspace(userId);

            expect(second.workspaceId).toBe(first.workspaceId);
        });

        it('sets active workspace for user', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const { workspaceId } = await store.getOrCreateDefaultWorkspace(userId);

            const workspaces = await store.listUserWorkspaces(userId);
            const active = workspaces.find((w) => w.isActive);
            expect(active?.id).toBe(workspaceId);
        });

        it('returns the currently active workspace when multiple memberships exist', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const { workspaceId: ws1 } = await store.createWorkspace({
                userId,
                name: 'WS 1',
            });
            const { workspaceId: ws2 } = await store.createWorkspace({
                userId,
                name: 'WS 2',
            });

            await store.setActiveWorkspace({ userId, workspaceId: ws2 });

            const resolved = await store.getOrCreateDefaultWorkspace(userId);
            expect(resolved.workspaceId).toBe(ws2);
            expect(resolved.workspaceName).toBe('WS 2');

            const workspaces = await store.listUserWorkspaces(userId);
            const active = workspaces.find((workspace) => workspace.isActive);
            expect(active?.id).toBe(ws2);
            expect(workspaces.some((workspace) => workspace.id === ws1)).toBe(true);
        });
    });

    describe('getWorkspaceRole', () => {
        it('returns owner for workspace creator', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const { workspaceId } = await store.getOrCreateDefaultWorkspace(userId);
            const role = await store.getWorkspaceRole({ userId, workspaceId });

            expect(role).toBe('owner');
        });

        it('returns null for non-member', async () => {
            const { userId: userA } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-a',
            });
            const { userId: userB } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-b',
            });

            const { workspaceId } = await store.getOrCreateDefaultWorkspace(userA);
            const role = await store.getWorkspaceRole({ userId: userB, workspaceId });

            expect(role).toBeNull();
        });
    });

    describe('workspace CRUD', () => {
        it('creates and lists workspaces', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            await store.createWorkspace({ userId, name: 'WS 1', description: 'First' });
            await store.createWorkspace({ userId, name: 'WS 2' });

            const workspaces = await store.listUserWorkspaces(userId);
            expect(workspaces.length).toBe(2);
            expect(workspaces.map((w) => w.name).sort()).toEqual(['WS 1', 'WS 2']);
        });

        it('updates workspace metadata', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const { workspaceId } = await store.createWorkspace({
                userId,
                name: 'Old Name',
            });

            await store.updateWorkspace({
                userId,
                workspaceId,
                name: 'New Name',
                description: 'Updated',
            });

            const workspaces = await store.listUserWorkspaces(userId);
            const ws = workspaces.find((w) => w.id === workspaceId);
            expect(ws?.name).toBe('New Name');
            expect(ws?.description).toBe('Updated');
        });

        it('rejects update from viewer', async () => {
            const { userId: owner } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'owner',
            });

            const { workspaceId } = await store.createWorkspace({
                userId: owner,
                name: 'Test',
            });

            // Add viewer directly via DB
            const db = getSqliteDb();
            const { userId: viewer } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'viewer',
            });

            await db
                .insertInto('workspace_members')
                .values({
                    id: randomUUID(),
                    workspace_id: workspaceId,
                    user_id: viewer,
                    role: 'viewer',
                    created_at: Math.floor(Date.now() / 1000),
                })
                .execute();

            await expect(
                store.updateWorkspace({
                    userId: viewer,
                    workspaceId,
                    name: 'Hacked',
                })
            ).rejects.toThrow('insufficient workspace role');
        });

        it('soft deletes and re-homes active workspace', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            const { workspaceId: ws1 } = await store.createWorkspace({
                userId,
                name: 'WS 1',
            });
            const { workspaceId: ws2 } = await store.createWorkspace({
                userId,
                name: 'WS 2',
            });

            await store.setActiveWorkspace({ userId, workspaceId: ws1 });
            await store.removeWorkspace({ userId, workspaceId: ws1 });

            const workspaces = await store.listUserWorkspaces(userId);
            expect(workspaces.length).toBe(1);
            expect(workspaces[0]!.id).toBe(ws2);
        });

        it('re-homes active workspace for all affected members', async () => {
            const { userId: owner } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'owner',
            });
            const { userId: member } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'member',
            });

            const { workspaceId: sharedWs } = await store.createWorkspace({
                userId: owner,
                name: 'Shared',
            });

            const db = getSqliteDb();
            await db
                .insertInto('workspace_members')
                .values({
                    id: randomUUID(),
                    workspace_id: sharedWs,
                    user_id: member,
                    role: 'editor',
                    created_at: Math.floor(Date.now() / 1000),
                })
                .execute();

            const { workspaceId: ownerFallback } = await store.createWorkspace({
                userId: owner,
                name: 'Owner Fallback',
            });
            const { workspaceId: memberFallback } = await store.createWorkspace({
                userId: member,
                name: 'Member Fallback',
            });

            await store.setActiveWorkspace({ userId: owner, workspaceId: sharedWs });
            await store.setActiveWorkspace({ userId: member, workspaceId: sharedWs });

            await store.removeWorkspace({ userId: owner, workspaceId: sharedWs });

            const ownerWorkspaces = await store.listUserWorkspaces(owner);
            const memberWorkspaces = await store.listUserWorkspaces(member);

            expect(ownerWorkspaces.find((w) => w.isActive)?.id).toBe(ownerFallback);
            expect(memberWorkspaces.find((w) => w.isActive)?.id).toBe(memberFallback);
        });

        it('rejects remove from non-owner', async () => {
            const { userId: owner } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'owner',
            });
            const { userId: editor } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'editor',
            });

            const { workspaceId } = await store.createWorkspace({
                userId: owner,
                name: 'Test',
            });

            const db = getSqliteDb();
            await db
                .insertInto('workspace_members')
                .values({
                    id: randomUUID(),
                    workspace_id: workspaceId,
                    user_id: editor,
                    role: 'editor',
                    created_at: Math.floor(Date.now() / 1000),
                })
                .execute();

            await expect(
                store.removeWorkspace({ userId: editor, workspaceId })
            ).rejects.toThrow('only owner');
        });
    });

    describe('setActiveWorkspace', () => {
        it('sets active workspace for member', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-1',
            });

            await store.createWorkspace({
                userId,
                name: 'WS 1',
            });
            const { workspaceId: ws2 } = await store.createWorkspace({
                userId,
                name: 'WS 2',
            });

            await store.setActiveWorkspace({ userId, workspaceId: ws2 });

            const workspaces = await store.listUserWorkspaces(userId);
            const active = workspaces.find((w) => w.isActive);
            expect(active?.id).toBe(ws2);
        });

        it('rejects for non-member', async () => {
            const { userId: userA } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-a',
            });
            const { userId: userB } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-b',
            });

            const { workspaceId } = await store.createWorkspace({
                userId: userA,
                name: 'Private',
            });

            await expect(
                store.setActiveWorkspace({ userId: userB, workspaceId })
            ).rejects.toThrow('not a member');
        });

        it('rejects setting a deleted workspace as active', async () => {
            const { userId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: 'user-active-delete',
            });

            const { workspaceId } = await store.createWorkspace({
                userId,
                name: 'To Delete',
            });

            await store.removeWorkspace({ userId, workspaceId });

            await expect(
                store.setActiveWorkspace({ userId, workspaceId })
            ).rejects.toThrow('not a member');
        });
    });

    describe('atomic invite acceptance', () => {
        async function createPendingInvite(input?: {
            email?: string;
            tokenHash?: string;
            expiresAt?: number;
        }) {
            const { userId: ownerUserId } = await store.getOrCreateUser({
                provider: 'basic-auth',
                providerUserId: `owner-${randomUUID()}`,
                email: 'owner@example.com',
            });
            const { workspaceId } = await store.createWorkspace({
                userId: ownerUserId,
                name: 'Invited Workspace',
            });
            const email = input?.email ?? 'invitee@example.com';
            const tokenHash = input?.tokenHash ?? `token-${randomUUID()}`;
            const { inviteId } = await store.createInvite({
                workspaceId,
                email,
                role: 'editor',
                invitedByUserId: ownerUserId,
                expiresAt: input?.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
                tokenHash,
            });
            return { workspaceId, inviteId, email, tokenHash };
        }

        it('creates user and membership and consumes the invite in one transaction', async () => {
            const invite = await createPendingInvite();

            const result = await store.acceptInviteAndProvisionUser({
                provider: 'basic-auth',
                providerUserId: 'new-provider-user',
                email: ' Invitee@Example.com ',
                displayName: 'Invitee',
                workspaceId: invite.workspaceId,
                tokenHash: invite.tokenHash,
            });

            expect(result).toMatchObject({
                ok: true,
                role: 'editor',
                createdUser: true,
            });
            if (!result.ok) throw new Error('Expected successful invite acceptance');
            await expect(store.getWorkspaceRole({
                userId: result.userId,
                workspaceId: invite.workspaceId,
            })).resolves.toBe('editor');
            const [persisted] = await store.listInvites({
                workspaceId: invite.workspaceId,
                status: 'accepted',
            });
            expect(persisted).toMatchObject({
                id: invite.inviteId,
                acceptedUserId: result.userId,
            });
        });

        for (const step of [
            'invite_validated',
            'user_created',
            'membership_created',
            'invite_consumed',
        ] as const) {
            it(`rolls back all provisioning when failure is injected after ${step}`, async () => {
                const invite = await createPendingInvite();
                const failingStore = new FailureInjectingSqliteAuthWorkspaceStore(step);

                await expect(failingStore.acceptInviteAndProvisionUser({
                    provider: 'basic-auth',
                    providerUserId: `failed-${step}`,
                    email: invite.email,
                    displayName: 'Must Roll Back',
                    workspaceId: invite.workspaceId,
                    tokenHash: invite.tokenHash,
                })).rejects.toThrow(`injected failure after ${step}`);

                await expect(store.getUser({
                    provider: 'basic-auth',
                    providerUserId: `failed-${step}`,
                })).resolves.toBeNull();
                const [pending] = await store.listInvites({
                    workspaceId: invite.workspaceId,
                    status: 'pending',
                });
                expect(pending).toMatchObject({
                    id: invite.inviteId,
                    acceptedUserId: null,
                });
            });
        }
    });
});


describe('private signup invitations', () => {
    const identity = { provider: 'basic-auth', provider_user_id: 'signup-subject', email: 'signup@example.com' };
    const invite = { id: 'signup-invite', email: identity.email, token_hash: 'signup-hash', expires_at: Date.now() + 3600_000, created_by_admin: 'admin' };
    const accept = () => store.acceptSignupInviteAndProvisionUser!({ ...identity, invite_id: invite.id, token_hash: invite.token_hash });

    it('looks up signup proof by hash without exposing stored hashes or history receipts', async () => {
        await store.createSignupInvite!(invite);
        expect(await store.findSignupInviteByTokenHash!({ token_hash: 'wrong' })).toBeNull();
        expect(await store.findSignupInviteByTokenHash!({ token_hash: invite.token_hash }))
            .toEqual({ id: invite.id, email: invite.email, expires_at: invite.expires_at });
        const history = await store.listSignupInvites!({ limit: 10 });
        expect(JSON.stringify(history)).not.toContain(invite.token_hash);
        expect(await accept()).toMatchObject({ ok: true, created: true });
        expect(await store.findSignupInviteByTokenHash!({ token_hash: invite.token_hash })).toBeNull();
    });

    it('creates one private owner workspace and replays without resetting a later selection', async () => {
        await store.createSignupInvite!(invite);
        const results = await Promise.all([accept(), accept()]);
        expect(results.filter(r => r.ok && r.created)).toHaveLength(1);
        const first = results[0];
        expect(first.ok).toBe(true);
        if (!first.ok) throw new Error('signup failed');
        expect(await store.listUserWorkspaces(first.user_id)).toEqual([expect.objectContaining({ id: first.workspace_id, role: 'owner', isActive: true })]);
        const members = await getSqliteDb().selectFrom('workspace_members').selectAll().execute();
        expect(members).toHaveLength(1);
        expect(members[0]?.user_id).toBe(first.user_id);
        const other = await store.createWorkspace({ userId: first.user_id, name: 'Other' });
        await store.setActiveWorkspace({ userId: first.user_id, workspaceId: other.workspaceId });
        expect(await accept()).toMatchObject({ ok: true, created: false, workspace_id: first.workspace_id });
        expect((await store.getOrCreateDefaultWorkspace(first.user_id)).workspaceId).toBe(other.workspaceId);
        expect(await store.acceptSignupInviteAndProvisionUser!({ ...identity, provider_user_id: 'impostor', invite_id: invite.id, token_hash: invite.token_hash })).toEqual({ ok: false, reason: 'already_used' });
        expect(await store.revokeSignupInvite!({ id: invite.id })).toEqual({ ok: false, reason: 'already_used' });
    });

    it('rolls back canonical writes when the workspace insert fails, and retries the same provider identity', async () => {
        await store.createSignupInvite!(invite);
        const { sql } = await import('kysely');
        await sql.raw("CREATE TRIGGER refuse_signup BEFORE INSERT ON workspaces BEGIN SELECT RAISE(ABORT, 'workspace failure'); END").execute(getSqliteDb());
        await expect(accept()).rejects.toThrow('workspace failure');
        expect(await store.getUser({ provider: identity.provider, providerUserId: identity.provider_user_id })).toBeNull();
        expect(await getSqliteDb().selectFrom('users').selectAll().execute()).toEqual([]);
        expect(await store.validateSignupInvite!({ id: invite.id, email: identity.email, token_hash: invite.token_hash })).toEqual({ ok: true });
        await sql.raw('DROP TRIGGER refuse_signup').execute(getSqliteDb());
        expect(await accept()).toMatchObject({ ok: true, created: true });
    });

    it.each(['revoked', 'expired', 'token_mismatch', 'email_mismatch', 'account_exists'])(
        'rejects %s without creating a workspace', async reason => {
            await store.createSignupInvite!({ ...invite, expires_at: reason === 'expired' ? Date.now() - 1000 : invite.expires_at });
            if (reason === 'revoked') await store.revokeSignupInvite!({ id: invite.id });
            if (reason === 'account_exists') await store.getOrCreateUser({ provider: 'clerk', providerUserId: 'existing', email: identity.email });
            const result = await store.acceptSignupInviteAndProvisionUser!({ ...identity, invite_id: invite.id,
                email: reason === 'email_mismatch' ? 'wrong@example.com' : identity.email,
                token_hash: reason === 'token_mismatch' ? 'wrong' : invite.token_hash });
            expect(result).toEqual({ ok: false, reason });
            expect(await getSqliteDb().selectFrom('workspaces').selectAll().execute()).toEqual([]);
        }
    );

    it('paginates without token material and removes only a bounded set of old terminal rows', async () => {
        for (let n = 0; n < 105; n++) {
            await store.createSignupInvite!({ ...invite, id: 'old-' + n, token_hash: 'hash-' + n, expires_at: Date.now() - 1000 });
        }
        // Create cleanup is bounded; inject the old timestamps as a persisted retention fixture.
        const { sql } = await import('kysely');
        await sql.raw('UPDATE signup_invites SET expires_at = 1, retain_until = 1').execute(getSqliteDb());
        const result = await store.listSignupInvites!({ limit: 2 });
        expect(result.invites).toHaveLength(2);
        expect(result.next_cursor).toBeTruthy();
        expect(result.invites[0]).not.toHaveProperty('token_hash');
        const remaining = await getSqliteDb().selectFrom('signup_invites').selectAll().execute();
        expect(remaining).toHaveLength(5);
        const second = await store.listSignupInvites!({ limit: 2, cursor: result.next_cursor! });
        expect(second.invites).toEqual([]); // next bounded cleanup finishes retention
    });
});
