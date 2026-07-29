import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApproveConnectAuthorizationInput } from '~~/server/connect/store/types';
import {
    destroySqliteDb,
    getSqliteDb,
} from '../server/db/kysely';
import { runMigrations } from '../server/db/migrate';
import { createSqliteConnectStore } from '../server/connect/sqlite-connect-store';

const now = 1_800_000_000_000;

describe('SQLite Connect store', () => {
    beforeEach(async () => {
        await runMigrations(getSqliteDb({ path: ':memory:' }));
    });

    afterEach(async () => {
        await destroySqliteDb();
    });

    it('persists and consumes an approved device credential exactly once', async () => {
        const store = createSqliteConnectStore();
        await store.createAuthorization({
            deviceCodeHash: 'device-hash',
            userCodeHash: 'user-hash',
            userCodeDisplay: 'BRAVE-RIVER-123',
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
            now + 2
        );
        expect(firstPoll).toMatchObject({
            status: 'approved',
            credential_ciphertext: 'encrypted-device-credential',
        });

        const replay = await store.getAuthorizationByDeviceHash(
            'device-hash',
            now + 3
        );
        expect(replay).toMatchObject({ status: 'consumed' });
        expect(replay?.credential_ciphertext).toBeUndefined();
    });

    it('lists only active environments and persists revocation', async () => {
        const store = createSqliteConnectStore();
        await store.createAuthorization({
            deviceCodeHash: 'device-hash',
            userCodeHash: 'user-hash',
            userCodeDisplay: 'BRAVE-RIVER-123',
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

        expect(await store.listEnvironmentsForUser('user-one')).toHaveLength(1);
        expect(
            await store.getEnvironmentByControlTokenHash('control-token-hash')
        ).toMatchObject({ id: 'environment-one', status: 'active' });

        expect(
            await store.revokeEnvironment('environment-one', now + 10)
        ).toBe(true);
        expect(await store.listEnvironmentsForUser('user-one')).toEqual([]);
    });

    it('enforces the active environment limit atomically', async () => {
        const store = createSqliteConnectStore();
        await store.createAuthorization({
            deviceCodeHash: 'device-one',
            userCodeHash: 'user-one-code',
            userCodeDisplay: 'FIRST-CODE-111',
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
            userCodeDisplay: 'SECOND-CODE-222',
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
                maxActiveEnvironments: 1,
            })
        ).rejects.toMatchObject({
            code: 'environment_limit_reached',
        });
        expect(await store.listEnvironmentsForUser('user-one')).toHaveLength(1);
    });

    it('expires stale requests without returning credentials', async () => {
        const store = createSqliteConnectStore();
        await store.createAuthorization({
            deviceCodeHash: 'expired-device',
            userCodeHash: 'expired-user',
            userCodeDisplay: 'OLD-CODE-000',
            host: host(),
            expiresAt: now,
            now: now - 1_000,
        });

        expect(
            await store.getAuthorizationByUserHash('expired-user', now)
        ).toBeNull();
        expect(
            await store.getAuthorizationByDeviceHash('expired-device', now)
        ).toMatchObject({ status: 'expired' });
    });

    it('expires an approved credential that was never redeemed', async () => {
        const store = createSqliteConnectStore();
        await store.createAuthorization({
            deviceCodeHash: 'unredeemed-device',
            userCodeHash: 'unredeemed-user',
            userCodeDisplay: 'SHORT-LIVED-123',
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
            now + 6
        );
        expect(expired).toMatchObject({ status: 'expired' });
        expect(expired?.credential_ciphertext).toBeUndefined();
    });

    it('rejects collisions only while the readable code is live', async () => {
        const store = createSqliteConnectStore();
        const first = {
            deviceCodeHash: 'collision-device-one',
            userCodeHash: 'same-readable-code',
            userCodeDisplay: 'SAME-CODE-123',
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
        maxActiveEnvironments: 3,
        now: now + 1,
    };
}
