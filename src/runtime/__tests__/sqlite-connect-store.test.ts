import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import type {
    ApproveConnectAuthorizationInput,
    ReserveConnectAuthorizationInput,
} from '~~/server/connect/store/types';
import {
    destroySqliteDb,
    getSqliteDb,
} from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { up as purgeLegacyUserCodes } from '../server/db/migrations/010_connect_user_code_hmac';
import {
    down as removeCredentialRedelivery,
    up as addCredentialRedelivery,
} from '../server/db/migrations/012_connect_credential_redelivery';
import {
    down as removeEnvironmentLifecycle,
    up as addEnvironmentLifecycle,
} from '../server/db/migrations/013_connect_environment_lifecycle';
import { up as addConnectRetention } from '../server/db/migrations/014_connect_retention_activation';
import { createSqliteConnectStore } from '../server/connect/sqlite-connect-store';

const now = 1_800_000_000_000;
const redeliveryWindowMs = 60_000;
const scope = {
    userId: 'user-one',
    workspaceId: 'workspace-one',
} as const;

describe('SQLite Connect store', () => {
    beforeEach(async () => {
        await runMigrations(getSqliteDb({ path: ':memory:' }));
    });

    afterEach(async () => {
        await destroySqliteDb();
    });

    it('redelivers an approved credential until its bounded lease expires', async () => {
        const store = createSqliteConnectStore();
        await store.createAuthorization({
            deviceCodeHash: 'device-hash',
            userCodeHash: 'user-hash',
            host: host(),
            expiresAt: now + 60_000,
            now,
        });

        const request = await store.getAuthorizationByUserHash(
            'user-hash',
            now
        );
        expect(request?.status).toBe('pending');

        await store.approveAuthorization(
            approval(request!._id, 'environment-one')
        );

        const firstPoll = await store.getAuthorizationByDeviceHash(
            'device-hash',
            now + 2,
            redeliveryWindowMs
        );
        expect(firstPoll).toMatchObject({
            status: 'approved',
            credential_ciphertext: 'encrypted-device-credential',
        });

        const replay = await store.getAuthorizationByDeviceHash(
            'device-hash',
            now + 3,
            redeliveryWindowMs
        );
        expect(replay).toMatchObject({
            status: 'approved',
            credential_ciphertext: 'encrypted-device-credential',
        });

        const afterLease = await store.getAuthorizationByDeviceHash(
            'device-hash',
            now + 60_003,
            redeliveryWindowMs
        );
        expect(afterLease).toMatchObject({ status: 'consumed' });
        expect(afterLease?.credential_ciphertext).toBeUndefined();
    });

    it('lists only active environments and persists revocation', async () => {
        const store = createSqliteConnectStore();
        await store.createAuthorization({
            deviceCodeHash: 'device-hash',
            userCodeHash: 'user-hash',
            host: host(),
            expiresAt: now + 60_000,
            now,
        });
        const request = await store.getAuthorizationByUserHash(
            'user-hash',
            now
        );
        await store.approveAuthorization(
            approval(request!._id, 'environment-one')
        );

        expect(await store.listEnvironments(scope)).toHaveLength(1);
        expect(
            await store.getEnvironmentByControlTokenHash(
                'control-token-hash',
                scope
            )
        ).toMatchObject({ id: 'environment-one', status: 'active' });

        expect(
            await store.revokeEnvironment(
                'environment-one',
                scope,
                now + 10
            )
        ).toBe(true);
        expect(await store.listEnvironments(scope)).toEqual([]);
    });

    it('enforces the active environment limit atomically', async () => {
        const store = createSqliteConnectStore();
        await store.createAuthorization({
            deviceCodeHash: 'device-one',
            userCodeHash: 'user-one-code',
            host: host(),
            expiresAt: now + 60_000,
            now,
        });
        const first = await store.getAuthorizationByUserHash(
            'user-one-code',
            now
        );
        await store.approveAuthorization(
            approval(first!._id, 'environment-one')
        );

        await store.createAuthorization({
            deviceCodeHash: 'device-two',
            userCodeHash: 'user-two-code',
            host: host(),
            expiresAt: now + 60_000,
            now,
        });
        const second = await store.getAuthorizationByUserHash(
            'user-two-code',
            now
        );

        await expect(
            store.approveAuthorization({
                ...approval(second!._id, 'environment-two'),
                workspaceId: 'workspace-two',
                limitPolicy: {
                    scope: 'account',
                    maxActiveEnvironments: 1,
                },
            })
        ).rejects.toMatchObject({
            code: 'environment_limit_reached',
        });
        expect(await store.listEnvironments(scope)).toHaveLength(1);
    });

    it('reserves quota and authorization before relay provisioning', async () => {
        const store = createSqliteConnectStore();
        await store.createAuthorization({
            deviceCodeHash: 'reserve-device-one',
            userCodeHash: 'reserve-code-one',
            host: host(),
            expiresAt: now + 60_000,
            now,
        });
        await store.createAuthorization({
            deviceCodeHash: 'reserve-device-two',
            userCodeHash: 'reserve-code-two',
            host: host(),
            expiresAt: now + 60_000,
            now,
        });
        const first = await store.getAuthorizationByUserHash(
            'reserve-code-one',
            now
        );
        const second = await store.getAuthorizationByUserHash(
            'reserve-code-two',
            now
        );
        const reserved = await store.reserveAuthorization({
            ...reservation(first!._id, 'reserved-environment', 'claim-one'),
            limitPolicy: {
                scope: 'account',
                maxActiveEnvironments: 1,
            },
        });

        expect(reserved).toMatchObject({
            id: 'reserved-environment',
            status: 'provisioning',
            tunnel_id: '',
            dns_record_id: '',
        });
        expect(await store.listEnvironments(scope)).toEqual([]);
        expect(
            await store.getAuthorizationByUserHash(
                'reserve-code-one',
                now + 1
            )
        ).toMatchObject({
            status: 'provisioning',
            approved_user_id: scope.userId,
            approved_workspace_id: scope.workspaceId,
            environment_id: 'reserved-environment',
        });
        await expect(
            store.reserveAuthorization({
                ...reservation(
                    second!._id,
                    'blocked-environment',
                    'claim-two'
                ),
                limitPolicy: {
                    scope: 'account',
                    maxActiveEnvironments: 1,
                },
            })
        ).rejects.toMatchObject({ code: 'environment_limit_reached' });
    });

    it('persists relay progress and atomically activates the reservation', async () => {
        const store = createSqliteConnectStore();
        await store.createAuthorization({
            deviceCodeHash: 'lifecycle-device',
            userCodeHash: 'lifecycle-code',
            host: host(),
            expiresAt: now + 60_000,
            now,
        });
        const authorization = await store.getAuthorizationByUserHash(
            'lifecycle-code',
            now
        );
        await store.reserveAuthorization(
            reservation(
                authorization!._id,
                'lifecycle-environment',
                'lifecycle-claim'
            )
        );

        await expect(
            store.saveEnvironmentRelayProgress(
                'lifecycle-environment',
                'provisioning',
                'lifecycle-claim',
                {
                    hostname:
                        'lifecycle-environment.connect.example.com',
                    tunnelId: 'lifecycle-tunnel',
                },
                now + 1
            )
        ).resolves.toBe(true);
        await expect(
            store.saveEnvironmentRelayProgress(
                'lifecycle-environment',
                'provisioning',
                'lifecycle-claim',
                { dnsRecordId: 'lifecycle-dns' },
                now + 2
            )
        ).resolves.toBe(true);
        await expect(
            store.completeEnvironmentProvisioning(
                'lifecycle-environment',
                'lifecycle-claim',
                'lifecycle-device-credential',
                now + 3
            )
        ).resolves.toBe(true);

        expect(await store.listEnvironments(scope)).toMatchObject([
            {
                id: 'lifecycle-environment',
                status: 'active',
                tunnel_id: 'lifecycle-tunnel',
                dns_record_id: 'lifecycle-dns',
            },
        ]);
        expect(
            await store.getAuthorizationByDeviceHash(
                'lifecycle-device',
                now + 2 * 60_000,
                redeliveryWindowMs
            )
        ).toMatchObject({
            status: 'approved',
            credential_ciphertext: 'lifecycle-device-credential',
        });
    });

    it('keeps partial revocation progress and resumes after a failed claim', async () => {
        const store = createSqliteConnectStore();
        await store.createAuthorization({
            deviceCodeHash: 'revoke-device',
            userCodeHash: 'revoke-code',
            host: host(),
            expiresAt: now + 60_000,
            now,
        });
        const authorization = await store.getAuthorizationByUserHash(
            'revoke-code',
            now
        );
        await store.approveAuthorization(
            approval(authorization!._id, 'revoke-environment')
        );
        const begun = await store.beginEnvironmentRevocation({
            environmentId: 'revoke-environment',
            scope,
            claimToken: 'revoke-claim-one',
            claimUntil: now + 30_000,
            now: now + 10,
        });
        expect(begun).toMatchObject({
            claimed: true,
            environment: {
                status: 'revoking',
                access_credential_ciphertext: '',
            },
        });
        expect(await store.listEnvironments(scope)).toEqual([]);
        expect(
            await store.getAuthorizationByDeviceHash(
                'revoke-device',
                now + 10,
                redeliveryWindowMs
            )
        ).toMatchObject({
            status: 'expired',
            credential_ciphertext: undefined,
        });
        await store.saveEnvironmentRelayProgress(
            'revoke-environment',
            'revoking',
            'revoke-claim-one',
            { dnsRecordId: '' },
            now + 11
        );
        await store.recordEnvironmentLifecycleFailure(
            'revoke-environment',
            'revoking',
            'revoke-claim-one',
            'tunnel unavailable',
            now + 20,
            now + 12
        );

        const resumed = await store.claimNextEnvironmentLifecycle(
            'revoke-claim-two',
            now + 20,
            now + 50_000
        );
        expect(resumed).toMatchObject({
            id: 'revoke-environment',
            status: 'revoking',
            dns_record_id: '',
            tunnel_id: 'tunnel-revoke-environment',
        });
        await store.saveEnvironmentRelayProgress(
            'revoke-environment',
            'revoking',
            'revoke-claim-two',
            { tunnelId: '' },
            now + 21
        );
        await expect(
            store.completeEnvironmentRevocation(
                'revoke-environment',
                'revoke-claim-two',
                now + 22
            )
        ).resolves.toBe(true);
        expect(
            await store.getEnvironmentByControlTokenHash(
                'control-token-hash',
                scope
            )
        ).toMatchObject({
            status: 'revoked',
            access_credential_ciphertext: '',
        });
    });

    it('moves an approved but unclaimed environment into cleanup after its activation deadline', async () => {
        const store = createSqliteConnectStore();
        await store.createAuthorization({
            deviceCodeHash: 'unclaimed-device',
            userCodeHash: 'unclaimed-code',
            host: host(),
            expiresAt: now + 60_000,
            now,
        });
        const authorization = await store.getAuthorizationByUserHash(
            'unclaimed-code',
            now
        );
        const request = reservation(
            authorization!._id,
            'unclaimed-environment',
            'provisioning-claim'
        );
        await store.reserveAuthorization(request);
        await store.saveEnvironmentRelayProgress(
            'unclaimed-environment',
            'provisioning',
            'provisioning-claim',
            {
                hostname: 'unclaimed.connect.example.test',
                tunnelId: 'unclaimed-tunnel',
                dnsRecordId: 'unclaimed-dns',
            },
            now + 2
        );
        await store.completeEnvironmentProvisioning(
            'unclaimed-environment',
            'provisioning-claim',
            'unclaimed-delivery-ciphertext',
            now + 3
        );

        const cleanup = await store.claimNextEnvironmentLifecycle(
            'cleanup-claim',
            request.activationDeadlineAt,
            request.activationDeadlineAt + 30_000
        );
        expect(cleanup).toMatchObject({
            id: 'unclaimed-environment',
            status: 'revoking',
            access_credential_ciphertext: '',
            lifecycle_error: 'Activation deadline expired.',
        });
        expect(
            await store.getAuthorizationByDeviceHash(
                'unclaimed-device',
                request.activationDeadlineAt,
                redeliveryWindowMs
            )
        ).toMatchObject({
            status: 'expired',
            credential_ciphertext: undefined,
        });
    });

    it('purges terminal records in bounded indexed batches', async () => {
        const store = createSqliteConnectStore();
        await store.createAuthorization({
            deviceCodeHash: 'retention-device',
            userCodeHash: 'retention-code',
            host: host(),
            expiresAt: now + 60_000,
            now,
        });
        const authorization = await store.getAuthorizationByUserHash(
            'retention-code',
            now
        );
        await store.denyAuthorization(authorization!._id, now + 1);
        const db = getSqliteDb({ path: ':memory:' });
        await store.createAuthorization({
            deviceCodeHash: 'retention-environment-device',
            userCodeHash: 'retention-environment-code',
            host: host(),
            expiresAt: now + 60_000,
            now,
        });
        const environmentAuthorization =
            await store.getAuthorizationByUserHash(
                'retention-environment-code',
                now
            );
        await store.approveAuthorization(
            approval(
                environmentAuthorization!._id,
                'retention-environment'
            )
        );
        await store.beginEnvironmentRevocation({
            environmentId: 'retention-environment',
            scope,
            claimToken: 'retention-revoke-claim',
            claimUntil: now + 30_000,
            now: now + 2,
        });
        await store.completeEnvironmentRevocation(
            'retention-environment',
            'retention-revoke-claim',
            now + 3
        );
        await sql`
            UPDATE connect_device_authorizations
            SET updated_at = ${now - 10_000}
            WHERE id = ${authorization!._id}
        `.execute(db);
        await sql`
            UPDATE connect_environments
            SET updated_at = ${now - 10_000}
            WHERE id = 'retention-environment'
        `.execute(db);

        expect(
            await store.purgeConnectRecords({
                authorizationUpdatedBefore: now - 5_000,
                revokedEnvironmentUpdatedBefore: now - 5_000,
                batchSize: 1,
            })
        ).toEqual({ authorizations: 1, environments: 1 });
        const rows = await db
            .selectFrom('connect_device_authorizations')
            .select('id')
            .where('id', '=', authorization!._id)
            .execute();
        expect(rows).toEqual([]);
        expect(
            await db
                .selectFrom('connect_environments')
                .select('id')
                .execute()
        ).toEqual([]);
    });

    it('never lists, resolves, or revokes an environment across workspaces', async () => {
        const store = createSqliteConnectStore();
        const workspaceA = {
            userId: 'user-one',
            workspaceId: 'workspace-a',
        };
        const workspaceB = {
            userId: 'user-one',
            workspaceId: 'workspace-b',
        };
        await store.createAuthorization({
            deviceCodeHash: 'device-a',
            userCodeHash: 'user-code-a',
            host: host(),
            expiresAt: now + 60_000,
            now,
        });
        const request = await store.getAuthorizationByUserHash(
            'user-code-a',
            now
        );
        await store.approveAuthorization({
            ...approval(request!._id, 'environment-a'),
            workspaceId: workspaceA.workspaceId,
        });

        await expect(store.listEnvironments(workspaceA)).resolves.toHaveLength(1);
        await expect(store.listEnvironments(workspaceB)).resolves.toEqual([]);
        await expect(
            store.getEnvironmentByControlTokenHash(
                'control-token-hash',
                workspaceB
            )
        ).resolves.toBeNull();
        await expect(
            store.revokeEnvironment('environment-a', workspaceB, now + 10)
        ).resolves.toBe(false);
        await expect(
            store.getEnvironmentByControlTokenHash(
                'control-token-hash',
                workspaceA
            )
        ).resolves.toMatchObject({
            id: 'environment-a',
            status: 'active',
        });

        await expect(
            store.revokeEnvironment('environment-a', workspaceA, now + 11)
        ).resolves.toBe(true);
        await expect(store.listEnvironments(workspaceA)).resolves.toEqual([]);

        const indexes = await sql<{ name: string }>`
            PRAGMA index_list(connect_environments)
        `.execute(getSqliteDb({ path: ':memory:' }));
        expect(indexes.rows.map((index) => index.name)).toEqual(
            expect.arrayContaining([
                'connect_environments_user_workspace_status_updated',
                'connect_environments_user_workspace_control_token',
                'connect_environments_user_workspace_id',
            ])
        );
    });

    it('expires stale requests without returning credentials', async () => {
        const store = createSqliteConnectStore();
        await store.createAuthorization({
            deviceCodeHash: 'expired-device',
            userCodeHash: 'expired-user',
            host: host(),
            expiresAt: now,
            now: now - 1_000,
        });

        expect(
            await store.getAuthorizationByUserHash('expired-user', now)
        ).toBeNull();
        expect(
            await store.getAuthorizationByDeviceHash(
                'expired-device',
                now,
                redeliveryWindowMs
            )
        ).toMatchObject({ status: 'expired' });
    });

    it('expires an approved credential that was never redeemed', async () => {
        const store = createSqliteConnectStore();
        await store.createAuthorization({
            deviceCodeHash: 'unredeemed-device',
            userCodeHash: 'unredeemed-user',
            host: host(),
            expiresAt: now + 5,
            now,
        });
        const request = await store.getAuthorizationByUserHash(
            'unredeemed-user',
            now
        );
        await store.approveAuthorization(
            approval(request!._id, 'unredeemed-environment')
        );

        const expired = await store.getAuthorizationByDeviceHash(
            'unredeemed-device',
            now + 6,
            redeliveryWindowMs
        );
        expect(expired).toMatchObject({ status: 'expired' });
        expect(expired?.credential_ciphertext).toBeUndefined();
    });

    it('rejects collisions only while the readable code is live', async () => {
        const store = createSqliteConnectStore();
        const first = {
            deviceCodeHash: 'collision-device-one',
            userCodeHash: 'same-readable-code',
            host: host(),
            expiresAt: now + 60_000,
            now,
        };
        await store.createAuthorization(first);

        await expect(
            store.createAuthorization({
                ...first,
                deviceCodeHash: 'collision-device-two',
            })
        ).rejects.toMatchObject({ code: 'conflict' });

        const request = await store.getAuthorizationByUserHash(
            first.userCodeHash,
            now
        );
        await store.denyAuthorization(request!._id, now + 1);
        await expect(
            store.createAuthorization({
                ...first,
                deviceCodeHash: 'collision-device-three',
                now: now + 2,
            })
        ).resolves.toBeUndefined();
    });

    it('never creates or persists a readable user-code column', async () => {
        const db = getSqliteDb({ path: ':memory:' });
        const columns = await db.introspection.getTables();
        const authorizationTable = columns.find(
            (table) => table.name === 'connect_device_authorizations'
        );

        expect(
            authorizationTable?.columns.some(
                (column) => column.name === 'user_code_display'
            )
        ).toBe(false);

        const store = createSqliteConnectStore();
        const legacyShapedInput = {
            deviceCodeHash: 'device-without-plaintext',
            userCodeHash: 'keyed-user-code-lookup',
            userCodeDisplay: 'BRIGHT-MOON-TREE-042',
            host: host(),
            expiresAt: now + 60_000,
            now,
        };
        await store.createAuthorization(legacyShapedInput);
        const serializedRows = JSON.stringify(
            await db.selectFrom('connect_device_authorizations').selectAll().execute()
        );
        expect(serializedRows).not.toContain(legacyShapedInput.userCodeDisplay);
    });

    it('purges in-flight records when upgrading a legacy plaintext schema', async () => {
        const db = getSqliteDb({ path: ':memory:' });
        const legacyPhrase = 'LEGACY-RIVER-TREE-123';
        await sql`
            ALTER TABLE connect_device_authorizations
            ADD COLUMN user_code_display TEXT
        `.execute(db);
        await sql`
            INSERT INTO connect_device_authorizations (
                id, device_code_hash, user_code_hash, user_code_display,
                status, host_json, expires_at, created_at, updated_at
            ) VALUES (
                'legacy-auth', 'legacy-device', 'legacy-fast-hash',
                ${legacyPhrase}, 'pending', '{}', ${now + 60_000}, ${now}, ${now}
            )
        `.execute(db);

        await purgeLegacyUserCodes(
            db as unknown as Kysely<unknown>
        );

        const tables = await db.introspection.getTables();
        const authorizationTable = tables.find(
            (table) => table.name === 'connect_device_authorizations'
        );
        expect(
            authorizationTable?.columns.some(
                (column) => column.name === 'user_code_display'
            )
        ).toBe(false);
        expect(
            await db
                .selectFrom('connect_device_authorizations')
                .selectAll()
                .execute()
        ).toEqual([]);
    });

    it('preserves approved credentials while adding redelivery columns', async () => {
        const db = getSqliteDb({ path: ':memory:' });
        const migrationDb = db as unknown as Kysely<unknown>;
        await removeCredentialRedelivery(migrationDb);
        await sql`
            INSERT INTO connect_device_authorizations (
                id, device_code_hash, user_code_hash, status, host_json,
                credential_ciphertext, expires_at, created_at, updated_at
            ) VALUES (
                'approved-before-upgrade', 'upgrade-device', 'upgrade-user',
                'approved', '{}', 'encrypted-before-upgrade',
                ${now + 60_000}, ${now}, ${now}
            )
        `.execute(db);

        await addCredentialRedelivery(migrationDb);

        const tables = await db.introspection.getTables();
        const authorizationTable = tables.find(
            (table) => table.name === 'connect_device_authorizations'
        );
        expect(
            authorizationTable?.columns.some(
                (column) => column.name === 'credential_redeliver_until'
            )
        ).toBe(true);
        const preserved = await sql<{
            status: string;
            credential_ciphertext: string | null;
        }>`
            SELECT status, credential_ciphertext
            FROM connect_device_authorizations
            WHERE id = 'approved-before-upgrade'
        `.execute(db);
        expect(preserved.rows[0]).toEqual({
            status: 'approved',
            credential_ciphertext: 'encrypted-before-upgrade',
        });
    });

    it('preserves active environments while adding lifecycle columns', async () => {
        const db = getSqliteDb({ path: ':memory:' });
        const store = createSqliteConnectStore();
        await store.createAuthorization({
            deviceCodeHash: 'lifecycle-upgrade-device',
            userCodeHash: 'lifecycle-upgrade-user',
            host: host(),
            expiresAt: now + 60_000,
            now,
        });
        const authorization = await store.getAuthorizationByUserHash(
            'lifecycle-upgrade-user',
            now
        );
        await store.approveAuthorization(
            approval(
                authorization!._id,
                'lifecycle-upgrade-environment'
            )
        );
        const migrationDb = db as unknown as Kysely<unknown>;

        await removeEnvironmentLifecycle(migrationDb);
        await addEnvironmentLifecycle(migrationDb);
        await addConnectRetention(migrationDb);

        const tables = await db.introspection.getTables();
        const environmentTable = tables.find(
            (table) => table.name === 'connect_environments'
        );
        expect(
            environmentTable?.columns.map((column) => column.name)
        ).toEqual(
            expect.arrayContaining([
                'authorization_id',
                'lifecycle_claim_token',
                'provisioning_deadline_at',
            ])
        );
        await expect(store.listEnvironments(scope)).resolves.toMatchObject([
            {
                id: 'lifecycle-upgrade-environment',
                status: 'active',
                access_credential_ciphertext:
                    'encrypted-access-token',
            },
        ]);
    });
});

function host() {
    return {
        name: 'Brendon’s Mac',
        platform: 'darwin',
        architecture: 'arm64',
        intern_version: '0.1.0',
    };
}

function approval(
    authorizationId: string,
    environmentId: string
): ApproveConnectAuthorizationInput {
    return {
        authorizationId,
        userId: 'user-one',
        workspaceId: 'workspace-one',
        environment: {
            id: environmentId,
            name: 'Brendon’s Mac',
            platform: 'darwin',
            architecture: 'arm64',
            hostname: `${environmentId}.connect.example.com`,
            tunnel_id: `tunnel-${environmentId}`,
            dns_record_id: `dns-${environmentId}`,
            control_token_hash: 'control-token-hash',
            access_credential_ciphertext: 'encrypted-access-token',
        },
        credentialCiphertext: 'encrypted-device-credential',
        limitPolicy: {
            scope: 'account',
            maxActiveEnvironments: 3,
        },
        now: now + 1,
    };
}

function reservation(
    authorizationId: string,
    environmentId: string,
    claimToken: string
): ReserveConnectAuthorizationInput {
    return {
        authorizationId,
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        environment: {
            id: environmentId,
            name: 'Brendon’s Mac',
            platform: 'darwin',
            architecture: 'arm64',
            control_token_hash: `${environmentId}-control-hash`,
            access_credential_ciphertext: 'encrypted-access-token',
            tunnel_secret_ciphertext: 'encrypted-tunnel-secret',
        },
        limitPolicy: {
            scope: 'account',
            maxActiveEnvironments: 3,
        },
        claimToken,
        claimUntil: now + 30_000,
        provisioningDeadlineAt: now + 15 * 60_000,
        activationDeadlineAt: now + 45 * 60_000,
        authorizationExpiresAt: now + 16 * 60_000,
        now: now + 1,
    };
}
