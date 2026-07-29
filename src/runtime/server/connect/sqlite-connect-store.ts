import { randomUUID } from 'node:crypto';
import type {
    ConnectAuthorizationRecord,
    ConnectEnvironmentRecord,
    StoredConnectHost,
} from '~~/server/connect/types';
import {
    ConnectStoreError,
    type ApproveConnectAuthorizationInput,
    type ConnectStore,
    type CreateConnectAuthorizationInput,
} from '~~/server/connect/store/types';
import { getRawDb } from '../db/kysely';

type AuthorizationStatus =
    | 'pending'
    | 'approved'
    | 'denied'
    | 'consumed'
    | 'expired';

interface AuthorizationRow {
    id: string;
    status: AuthorizationStatus;
    user_code_display: string;
    host_json: string;
    credential_ciphertext: string | null;
    expires_at: number;
}

interface EnvironmentRow {
    id: string;
    name: string;
    hostname: string;
    tunnel_id: string;
    dns_record_id: string;
    access_credential_ciphertext: string;
    status: 'active' | 'revoked' | 'error';
}

export function createSqliteConnectStore(): ConnectStore {
    return new SqliteConnectStore();
}

class SqliteConnectStore implements ConnectStore {
    async createAuthorization(
        input: CreateConnectAuthorizationInput
    ): Promise<void> {
        const db = getRawDb();
        db.transaction(() => {
            const collision = db
                .prepare(
                    `SELECT 1
                     FROM connect_device_authorizations
                     WHERE user_code_hash = ?
                       AND status = 'pending'
                       AND expires_at > ?
                     LIMIT 1`
                )
                .get(input.userCodeHash, input.now);
            if (collision) {
                throw new ConnectStoreError(
                    'conflict',
                    'Pairing code collision. Generate another code.'
                );
            }
            db.prepare(
                `INSERT INTO connect_device_authorizations (
                    id, device_code_hash, user_code_hash, user_code_display,
                    status, host_json, expires_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
            )
            .run(
                randomUUID(),
                input.deviceCodeHash,
                input.userCodeHash,
                input.userCodeDisplay,
                JSON.stringify(input.host),
                input.expiresAt,
                input.now,
                input.now
            );
        })();
    }

    async getAuthorizationByDeviceHash(
        deviceCodeHash: string,
        now: number
    ): Promise<ConnectAuthorizationRecord | null> {
        const db = getRawDb();
        return db.transaction(() => {
            const row = db
                .prepare(
                    `SELECT id, status, user_code_display, host_json,
                            credential_ciphertext, expires_at
                     FROM connect_device_authorizations
                     WHERE device_code_hash = ?`
                )
                .get(deviceCodeHash) as AuthorizationRow | undefined;
            if (!row) return null;

            if (
                (row.status === 'pending' || row.status === 'approved') &&
                row.expires_at <= now
            ) {
                db.prepare(
                    `UPDATE connect_device_authorizations
                     SET status = 'expired',
                         credential_ciphertext = NULL,
                         updated_at = ?
                     WHERE id = ? AND status IN ('pending', 'approved')`
                ).run(now, row.id);
                return toAuthorizationRecord({
                    ...row,
                    status: 'expired',
                    credential_ciphertext: null,
                });
            }

            if (row.status === 'approved') {
                const consumed = db
                    .prepare(
                        `UPDATE connect_device_authorizations
                         SET status = 'consumed',
                             credential_ciphertext = NULL,
                             updated_at = ?
                         WHERE id = ? AND status = 'approved'`
                    )
                    .run(now, row.id);
                if (consumed.changes !== 1) {
                    return {
                        ...toAuthorizationRecord(row),
                        status: 'consumed' as const,
                        credential_ciphertext: undefined,
                    };
                }
            }

            return toAuthorizationRecord(row);
        })();
    }

    async getAuthorizationByUserHash(
        userCodeHash: string,
        now: number
    ): Promise<ConnectAuthorizationRecord | null> {
        const row = getRawDb()
            .prepare(
                `SELECT id, status, user_code_display, host_json,
                        credential_ciphertext, expires_at
                 FROM connect_device_authorizations
                 WHERE user_code_hash = ?
                 ORDER BY created_at DESC
                 LIMIT 1`
            )
            .get(userCodeHash) as AuthorizationRow | undefined;
        if (!row || row.expires_at <= now) return null;
        return toAuthorizationRecord(row);
    }

    async approveAuthorization(
        input: ApproveConnectAuthorizationInput
    ): Promise<{ environment_id: string }> {
        const db = getRawDb();
        return db.transaction(() => {
            const authorization = db
                .prepare(
                    `SELECT id, status, expires_at
                     FROM connect_device_authorizations
                     WHERE id = ?`
                )
                .get(input.authorizationId) as
                | Pick<AuthorizationRow, 'id' | 'status' | 'expires_at'>
                | undefined;
            if (
                !authorization ||
                authorization.status !== 'pending' ||
                authorization.expires_at <= input.now
            ) {
                throw new ConnectStoreError(
                    'authorization_unavailable',
                    'This connection request is no longer available.'
                );
            }

            const active = db
                .prepare(
                    `SELECT COUNT(*) AS count
                     FROM connect_environments
                     WHERE user_id = ? AND status = 'active'`
                )
                .get(input.userId) as { count: number };
            if (active.count >= input.maxActiveEnvironments) {
                throw new ConnectStoreError(
                    'environment_limit_reached',
                    `This account already has ${input.maxActiveEnvironments} connected computers.`
                );
            }

            const environment = input.environment;
            db.prepare(
                `INSERT INTO connect_environments (
                    id, user_id, workspace_id, name, platform, architecture,
                    host_id, signing_public_key, noise_public_key, hostname,
                    tunnel_id, dns_record_id, control_token_hash,
                    access_credential_ciphertext, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
            ).run(
                environment.id,
                input.userId,
                input.workspaceId,
                environment.name,
                environment.platform,
                environment.architecture,
                environment.host_id ?? null,
                environment.signing_public_key ?? null,
                environment.noise_public_key ?? null,
                environment.hostname,
                environment.tunnel_id,
                environment.dns_record_id,
                environment.control_token_hash,
                environment.access_credential_ciphertext,
                input.now,
                input.now
            );

            const approved = db
                .prepare(
                    `UPDATE connect_device_authorizations
                     SET status = 'approved',
                         approved_user_id = ?,
                         approved_workspace_id = ?,
                         environment_id = ?,
                         credential_ciphertext = ?,
                         updated_at = ?
                     WHERE id = ? AND status = 'pending' AND expires_at > ?`
                )
                .run(
                    input.userId,
                    input.workspaceId,
                    environment.id,
                    input.credentialCiphertext,
                    input.now,
                    input.authorizationId,
                    input.now
                );
            if (approved.changes !== 1) {
                throw new ConnectStoreError(
                    'conflict',
                    'This connection request was already handled.'
                );
            }
            return { environment_id: environment.id };
        })();
    }

    async denyAuthorization(
        authorizationId: string,
        now: number
    ): Promise<boolean> {
        const result = getRawDb()
            .prepare(
                `UPDATE connect_device_authorizations
                 SET status = 'denied', updated_at = ?
                 WHERE id = ? AND status = 'pending' AND expires_at > ?`
            )
            .run(now, authorizationId, now);
        return result.changes === 1;
    }

    async getEnvironmentByControlTokenHash(
        controlTokenHash: string
    ): Promise<ConnectEnvironmentRecord | null> {
        const row = getRawDb()
            .prepare(
                `SELECT id, name, hostname, tunnel_id, dns_record_id,
                        access_credential_ciphertext, status
                 FROM connect_environments
                 WHERE control_token_hash = ?`
            )
            .get(controlTokenHash) as EnvironmentRow | undefined;
        return row ?? null;
    }

    async listEnvironmentsForUser(
        userId: string
    ): Promise<ConnectEnvironmentRecord[]> {
        return getRawDb()
            .prepare(
                `SELECT id, name, hostname, tunnel_id, dns_record_id,
                        access_credential_ciphertext, status
                 FROM connect_environments
                 WHERE user_id = ? AND status = 'active'
                 ORDER BY updated_at DESC, id ASC`
            )
            .all(userId) as EnvironmentRow[];
    }

    async revokeEnvironment(
        environmentId: string,
        now: number
    ): Promise<boolean> {
        const result = getRawDb()
            .prepare(
                `UPDATE connect_environments
                 SET status = 'revoked', revoked_at = ?, updated_at = ?
                 WHERE id = ? AND status <> 'revoked'`
            )
            .run(now, now, environmentId);
        return result.changes === 1;
    }
}

function toAuthorizationRecord(
    row: AuthorizationRow
): ConnectAuthorizationRecord {
    const parsed = JSON.parse(row.host_json) as StoredConnectHost;
    return {
        _id: row.id,
        status: row.status,
        user_code_display: row.user_code_display,
        host: parsed,
        credential_ciphertext: row.credential_ciphertext ?? undefined,
        expires_at: row.expires_at,
    };
}
