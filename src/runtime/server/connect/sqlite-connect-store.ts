import type {
    ConnectAuthorizationRecord,
    ConnectEnvironmentRecord,
    StoredConnectHost,
} from '~~/server/connect/types';
import {
    ConnectStoreError,
    type ApproveConnectAuthorizationInput,
    type BeginConnectEnvironmentRevocationInput,
    type ConnectEnvironmentLifecycleClaim,
    type ConnectEnvironmentRelayProgress,
    type ConnectEnvironmentScope,
    type ConnectStore,
    type CreateConnectAuthorizationInput,
    type PurgeConnectRecordsInput,
    type PurgeConnectRecordsResult,
    type ReserveConnectAuthorizationInput,
} from '~~/server/connect/store/types';
import { getRawDb } from '../db/kysely';

type AuthorizationStatus =
    | 'pending'
    | 'provisioning'
    | 'approved'
    | 'delivering'
    | 'denied'
    | 'consumed'
    | 'expired';

interface AuthorizationRow {
    id: string;
    status: AuthorizationStatus;
    host_json: string;
    approved_user_id: string | null;
    approved_workspace_id: string | null;
    environment_id: string | null;
    credential_ciphertext: string | null;
    credential_delivery_started_at: number | null;
    credential_redeliver_until: number | null;
    expires_at: number;
}

interface EnvironmentRow {
    id: string;
    user_id: string;
    workspace_id: string;
    name: string;
    platform: string;
    architecture: string;
    driver: 'intern' | 'runs' | null;
    runtime: 'intern' | 'openclaw' | 'hermes' | null;
    base_path: '/' | '/or3/' | null;
    host_id: string | null;
    signing_public_key: string | null;
    noise_public_key: string | null;
    authorization_id: string | null;
    hostname: string;
    tunnel_id: string;
    dns_record_id: string;
    control_token_hash: string;
    access_credential_ciphertext: string;
    tunnel_secret_ciphertext: string | null;
    status: 'provisioning' | 'active' | 'revoking' | 'revoked' | 'error';
    lifecycle_attempts: number;
    lifecycle_next_attempt_at: number;
    lifecycle_claim_token: string | null;
    lifecycle_claimed_until: number | null;
    provisioning_deadline_at: number | null;
    activation_deadline_at: number | null;
    activation_claimed_at: number | null;
    relay_authenticator: string | null;
    lifecycle_error: string | null;
}

const ENVIRONMENT_COLUMNS = `
    id, user_id, workspace_id, name, platform, architecture, driver, runtime,
    base_path, host_id,
    signing_public_key, noise_public_key, authorization_id, hostname,
    tunnel_id, dns_record_id, control_token_hash, access_credential_ciphertext,
    tunnel_secret_ciphertext, status, lifecycle_attempts,
    lifecycle_next_attempt_at, lifecycle_claim_token,
    lifecycle_claimed_until, provisioning_deadline_at,
    activation_deadline_at, activation_claimed_at, lifecycle_error,
    relay_authenticator
`;

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
                    id, device_code_hash, user_code_hash,
                    status, host_json, expires_at, created_at, updated_at
                ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`
            )
            .run(
                globalThis.crypto.randomUUID(),
                input.deviceCodeHash,
                input.userCodeHash,
                JSON.stringify(input.host),
                input.expiresAt,
                input.now,
                input.now
            );
        })();
    }

    async getAuthorizationByDeviceHash(
        deviceCodeHash: string,
        now: number,
        redeliveryWindowMs: number
    ): Promise<ConnectAuthorizationRecord | null> {
        const boundedRedeliveryWindow = normalizeRedeliveryWindow(
            redeliveryWindowMs
        );
        const db = getRawDb();
        return db.transaction(() => {
            const row = db
                .prepare(
                    `SELECT id, status, host_json,
                            approved_user_id, approved_workspace_id,
                            environment_id,
                            credential_ciphertext,
                            credential_delivery_started_at,
                            credential_redeliver_until, expires_at
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
                const deliveryStarted = db
                    .prepare(
                        `UPDATE connect_device_authorizations
                         SET status = 'delivering',
                             credential_delivery_started_at = ?,
                             credential_redeliver_until = ?,
                             updated_at = ?
                         WHERE id = ? AND status = 'approved'`
                    )
                    .run(
                        now,
                        now + boundedRedeliveryWindow,
                        now,
                        row.id
                    );
                if (deliveryStarted.changes !== 1) {
                    return {
                        ...toAuthorizationRecord(row),
                        status: 'consumed' as const,
                        credential_ciphertext: undefined,
                    };
                }
                if (row.environment_id) {
                    db.prepare(
                        `UPDATE connect_environments
                         SET activation_claimed_at = ?,
                             activation_deadline_at = NULL,
                             updated_at = ?
                         WHERE id = ?
                           AND status = 'active'
                           AND activation_claimed_at IS NULL`
                    ).run(now, now, row.environment_id);
                }
                return toAuthorizationRecord(row);
            }

            if (row.status === 'delivering') {
                if (
                    row.credential_ciphertext &&
                    row.credential_redeliver_until !== null &&
                    row.credential_redeliver_until >= now
                ) {
                    return {
                        ...toAuthorizationRecord(row),
                        status: 'approved' as const,
                    };
                }
                db.prepare(
                    `UPDATE connect_device_authorizations
                     SET status = 'consumed',
                         credential_ciphertext = NULL,
                         updated_at = ?
                     WHERE id = ? AND status = 'delivering'`
                ).run(now, row.id);
                return {
                    ...toAuthorizationRecord(row),
                    status: 'consumed' as const,
                    credential_ciphertext: undefined,
                };
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
                `SELECT id, status, host_json,
                        approved_user_id, approved_workspace_id,
                        environment_id, credential_ciphertext, expires_at
                 FROM connect_device_authorizations
                 WHERE user_code_hash = ?
                 ORDER BY created_at DESC
                 LIMIT 1`
            )
            .get(userCodeHash) as AuthorizationRow | undefined;
        if (
            !row ||
            row.expires_at <= now ||
            row.status === 'denied' ||
            row.status === 'expired'
        ) {
            return null;
        }
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

            const active =
                input.limitPolicy.scope === 'workspace'
                    ? (db
                          .prepare(
                              `SELECT COUNT(*) AS count
                               FROM connect_environments
                               WHERE user_id = ?
                                 AND workspace_id = ?
                                 AND status = 'active'`
                          )
                          .get(input.userId, input.workspaceId) as {
                          count: number;
                      })
                    : (db
                          .prepare(
                              `SELECT COUNT(*) AS count
                               FROM connect_environments
                               WHERE user_id = ? AND status = 'active'`
                          )
                          .get(input.userId) as { count: number });
            if (active.count >= input.limitPolicy.maxActiveEnvironments) {
                throw new ConnectStoreError(
                    'environment_limit_reached',
                    `This ${input.limitPolicy.scope} already has ${input.limitPolicy.maxActiveEnvironments} connected computers.`
                );
            }

            const environment = input.environment;
            db.prepare(
                `INSERT INTO connect_environments (
                    id, user_id, workspace_id, name, platform, architecture,
                    driver, runtime, base_path,
                    host_id, signing_public_key, noise_public_key, hostname,
                    tunnel_id, dns_record_id, control_token_hash,
                    access_credential_ciphertext, status, created_at, updated_at
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    'active', ?, ?
                )`
            ).run(
                environment.id,
                input.userId,
                input.workspaceId,
                environment.name,
                environment.platform,
                environment.architecture,
                environment.driver ?? null,
                environment.runtime ?? null,
                environment.base_path ?? null,
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

    async reserveAuthorization(
        input: ReserveConnectAuthorizationInput
    ): Promise<ConnectEnvironmentRecord> {
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

            const reserved =
                input.limitPolicy.scope === 'workspace'
                    ? (db
                          .prepare(
                              `SELECT COUNT(*) AS count
                               FROM connect_environments
                               WHERE user_id = ?
                                 AND workspace_id = ?
                                 AND status IN (
                                     'provisioning', 'active', 'revoking'
                                 )`
                          )
                          .get(input.userId, input.workspaceId) as {
                          count: number;
                      })
                    : (db
                          .prepare(
                              `SELECT COUNT(*) AS count
                               FROM connect_environments
                               WHERE user_id = ?
                                 AND status IN (
                                     'provisioning', 'active', 'revoking'
                                 )`
                          )
                          .get(input.userId) as { count: number });
            if (reserved.count >= input.limitPolicy.maxActiveEnvironments) {
                throw new ConnectStoreError(
                    'environment_limit_reached',
                    `This ${input.limitPolicy.scope} already has ${input.limitPolicy.maxActiveEnvironments} connected computers.`
                );
            }

            const environment = input.environment;
            db.prepare(
                `INSERT INTO connect_environments (
                    id, user_id, workspace_id, name, platform, architecture,
                    driver, runtime, base_path,
                    host_id, signing_public_key, noise_public_key,
                    authorization_id, hostname, tunnel_id, dns_record_id,
                    control_token_hash, access_credential_ciphertext,
                    tunnel_secret_ciphertext, status, lifecycle_attempts,
                    lifecycle_next_attempt_at, lifecycle_claim_token,
                    lifecycle_claimed_until, provisioning_deadline_at,
                    activation_deadline_at, activation_claimed_at,
                    created_at, updated_at
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?, ?, ?,
                    'provisioning', 0, ?, ?, ?, ?, ?, NULL, ?, ?
                )`
            ).run(
                environment.id,
                input.userId,
                input.workspaceId,
                environment.name,
                environment.platform,
                environment.architecture,
                environment.driver ?? null,
                environment.runtime ?? null,
                environment.base_path ?? null,
                environment.host_id ?? null,
                environment.signing_public_key ?? null,
                environment.noise_public_key ?? null,
                input.authorizationId,
                environment.control_token_hash,
                environment.access_credential_ciphertext,
                environment.tunnel_secret_ciphertext,
                input.now,
                input.claimToken,
                input.claimUntil,
                input.provisioningDeadlineAt,
                input.activationDeadlineAt,
                input.now,
                input.now
            );
            const reservedAuthorization = db
                .prepare(
                    `UPDATE connect_device_authorizations
                     SET status = 'provisioning',
                         approved_user_id = ?,
                         approved_workspace_id = ?,
                         environment_id = ?,
                         expires_at = CASE
                             WHEN expires_at > ? THEN expires_at
                             ELSE ?
                         END,
                         updated_at = ?
                     WHERE id = ?
                       AND status = 'pending'
                       AND expires_at > ?`
                )
                .run(
                    input.userId,
                    input.workspaceId,
                    environment.id,
                    input.authorizationExpiresAt,
                    input.authorizationExpiresAt,
                    input.now,
                    input.authorizationId,
                    input.now
                );
            if (reservedAuthorization.changes !== 1) {
                throw new ConnectStoreError(
                    'conflict',
                    'This connection request was already handled.'
                );
            }
            return toEnvironmentRecord(
                requireEnvironmentById(db, environment.id)
            );
        })();
    }

    async claimNextEnvironmentLifecycle(
        claimToken: string,
        now: number,
        claimUntil: number
    ): Promise<ConnectEnvironmentRecord | null> {
        const db = getRawDb();
        return db.transaction(() => {
            const abandoned = db
                .prepare(
                    `SELECT id
                     FROM connect_environments
                     WHERE status = 'active'
                       AND activation_claimed_at IS NULL
                       AND activation_deadline_at IS NOT NULL
                       AND activation_deadline_at <= ?
                     ORDER BY activation_deadline_at ASC, id ASC
                     LIMIT 1`
                )
                .get(now) as { id: string } | undefined;
            if (abandoned) {
                db.prepare(
                    `UPDATE connect_device_authorizations
                     SET status = CASE
                             WHEN status IN (
                                 'pending', 'provisioning',
                                 'approved', 'delivering'
                             ) THEN 'expired'
                             ELSE status
                         END,
                         credential_ciphertext = NULL,
                         updated_at = ?
                     WHERE environment_id = ?`
                ).run(now, abandoned.id);
                const transitioned = db.prepare(
                    `UPDATE connect_environments
                     SET status = 'revoking',
                         access_credential_ciphertext = '',
                         tunnel_secret_ciphertext = NULL,
                         lifecycle_next_attempt_at = ?,
                         lifecycle_claim_token = ?,
                         lifecycle_claimed_until = ?,
                         lifecycle_error = 'Activation deadline expired.',
                         updated_at = ?
                     WHERE id = ?
                       AND status = 'active'
                       AND activation_claimed_at IS NULL
                       AND activation_deadline_at <= ?`
                ).run(
                    now,
                    claimToken,
                    claimUntil,
                    now,
                    abandoned.id,
                    now
                );
                if (transitioned.changes === 1) {
                    return toEnvironmentRecord(
                        requireEnvironmentById(db, abandoned.id)
                    );
                }
            }
            const candidate = db
                .prepare(
                    `SELECT id
                     FROM connect_environments
                     WHERE status IN ('provisioning', 'revoking')
                       AND lifecycle_next_attempt_at <= ?
                       AND (
                           lifecycle_claimed_until IS NULL
                           OR lifecycle_claimed_until <= ?
                       )
                     ORDER BY lifecycle_next_attempt_at ASC, created_at ASC
                     LIMIT 1`
                )
                .get(now, now) as { id: string } | undefined;
            if (!candidate) return null;
            const claimed = db
                .prepare(
                    `UPDATE connect_environments
                     SET lifecycle_claim_token = ?,
                         lifecycle_claimed_until = ?,
                         updated_at = ?
                     WHERE id = ?
                       AND status IN ('provisioning', 'revoking')
                       AND (
                           lifecycle_claimed_until IS NULL
                           OR lifecycle_claimed_until <= ?
                       )`
                )
                .run(claimToken, claimUntil, now, candidate.id, now);
            if (claimed.changes !== 1) return null;
            return toEnvironmentRecord(
                requireEnvironmentById(db, candidate.id)
            );
        })();
    }

    async saveEnvironmentRelayProgress(
        environmentId: string,
        expectedStatus: 'provisioning' | 'revoking',
        claimToken: string,
        progress: ConnectEnvironmentRelayProgress,
        now: number
    ): Promise<boolean> {
        const assignments = ['updated_at = ?'];
        const values: Array<string | number> = [now];
        if (progress.hostname !== undefined) {
            assignments.push('hostname = ?');
            values.push(progress.hostname);
        }
        if (progress.tunnelId !== undefined) {
            assignments.push('tunnel_id = ?');
            values.push(progress.tunnelId);
        }
        if (progress.dnsRecordId !== undefined) {
            assignments.push('dns_record_id = ?');
            values.push(progress.dnsRecordId);
        }
        if (progress.relayAuthenticator !== undefined) {
            assignments.push('relay_authenticator = ?');
            values.push(progress.relayAuthenticator);
        }
        values.push(environmentId, expectedStatus, claimToken);
        const result = getRawDb()
            .prepare(
                `UPDATE connect_environments
                 SET ${assignments.join(', ')}
                 WHERE id = ?
                   AND status = ?
                   AND lifecycle_claim_token = ?`
            )
            .run(...values);
        return result.changes === 1;
    }

    async completeEnvironmentProvisioning(
        environmentId: string,
        claimToken: string,
        credentialCiphertext: string,
        now: number
    ): Promise<boolean> {
        const db = getRawDb();
        return db.transaction(() => {
            const environment = requireEnvironmentById(db, environmentId);
            if (
                environment.status !== 'provisioning' ||
                environment.lifecycle_claim_token !== claimToken ||
                !environment.authorization_id ||
                !environment.hostname ||
                !environment.tunnel_id ||
                !environment.dns_record_id
            ) {
                return false;
            }
            const approved = db
                .prepare(
                    `UPDATE connect_device_authorizations
                     SET status = 'approved',
                         credential_ciphertext = ?,
                         updated_at = ?
                     WHERE id = ? AND status = 'provisioning'`
                )
                .run(
                    credentialCiphertext,
                    now,
                    environment.authorization_id
                );
            if (approved.changes !== 1) {
                throw new ConnectStoreError(
                    'conflict',
                    'The reserved connection request could not be finalized.'
                );
            }
            const activated = db
                .prepare(
                    `UPDATE connect_environments
                     SET status = 'active',
                         tunnel_secret_ciphertext = NULL,
                         lifecycle_claim_token = NULL,
                         lifecycle_claimed_until = NULL,
                         lifecycle_next_attempt_at = 0,
                         lifecycle_error = NULL,
                         updated_at = ?
                     WHERE id = ?
                       AND status = 'provisioning'
                       AND lifecycle_claim_token = ?`
                )
                .run(now, environmentId, claimToken);
            if (activated.changes !== 1) {
                throw new ConnectStoreError(
                    'conflict',
                    'The reserved environment could not be activated.'
                );
            }
            return true;
        })();
    }

    async beginEnvironmentRevocation(
        input: BeginConnectEnvironmentRevocationInput
    ): Promise<ConnectEnvironmentLifecycleClaim | null> {
        const db = getRawDb();
        return db.transaction(() => {
            const row = db
                .prepare(
                    `SELECT ${ENVIRONMENT_COLUMNS}
                     FROM connect_environments
                     WHERE id = ? AND user_id = ? AND workspace_id = ?`
                )
                .get(
                    input.environmentId,
                    input.scope.userId,
                    input.scope.workspaceId
                ) as EnvironmentRow | undefined;
            if (!row) return null;
            if (row.status === 'revoked') {
                return {
                    claimed: false,
                    environment: toEnvironmentRecord(row),
                };
            }
            if (row.status !== 'active' && row.status !== 'revoking') {
                return null;
            }
            const canClaim =
                row.status === 'active' ||
                row.lifecycle_claimed_until === null ||
                row.lifecycle_claimed_until <= input.now;
            if (!canClaim) {
                return {
                    claimed: false,
                    environment: toEnvironmentRecord(row),
                };
            }
            db.prepare(
                `UPDATE connect_device_authorizations
                 SET status = CASE
                         WHEN status IN (
                             'pending', 'provisioning',
                             'approved', 'delivering'
                         ) THEN 'expired'
                         ELSE status
                     END,
                     credential_ciphertext = NULL,
                     updated_at = ?
                 WHERE environment_id = ?`
            ).run(input.now, input.environmentId);
            const result = db
                .prepare(
                    `UPDATE connect_environments
                     SET status = 'revoking',
                         access_credential_ciphertext = '',
                         tunnel_secret_ciphertext = NULL,
                         lifecycle_claim_token = ?,
                         lifecycle_claimed_until = ?,
                         lifecycle_next_attempt_at = ?,
                         lifecycle_error = NULL,
                         updated_at = ?
                     WHERE id = ?
                       AND user_id = ?
                       AND workspace_id = ?
                       AND status IN ('active', 'revoking')
                       AND (
                           status = 'active'
                           OR lifecycle_claimed_until IS NULL
                           OR lifecycle_claimed_until <= ?
                       )`
                )
                .run(
                    input.claimToken,
                    input.claimUntil,
                    input.now,
                    input.now,
                    input.environmentId,
                    input.scope.userId,
                    input.scope.workspaceId,
                    input.now
                );
            if (result.changes !== 1) return null;
            return {
                claimed: true,
                environment: toEnvironmentRecord(
                    requireEnvironmentById(db, input.environmentId)
                ),
            };
        })();
    }

    async abandonEnvironmentProvisioning(
        environmentId: string,
        claimToken: string,
        now: number
    ): Promise<ConnectEnvironmentRecord | null> {
        const db = getRawDb();
        return db.transaction(() => {
            const environment = requireEnvironmentById(db, environmentId);
            if (
                environment.status !== 'provisioning' ||
                environment.lifecycle_claim_token !== claimToken
            ) {
                return null;
            }
            if (environment.authorization_id) {
                db.prepare(
                    `UPDATE connect_device_authorizations
                     SET status = 'expired',
                         credential_ciphertext = NULL,
                         updated_at = ?
                     WHERE id = ? AND status = 'provisioning'`
                ).run(now, environment.authorization_id);
            }
            const changed = db
                .prepare(
                    `UPDATE connect_environments
                     SET status = 'revoking',
                         access_credential_ciphertext = '',
                         tunnel_secret_ciphertext = NULL,
                         lifecycle_next_attempt_at = ?,
                         lifecycle_error = 'Provisioning deadline expired.',
                         updated_at = ?
                     WHERE id = ?
                       AND status = 'provisioning'
                       AND lifecycle_claim_token = ?`
                )
                .run(now, now, environmentId, claimToken);
            return changed.changes === 1
                ? toEnvironmentRecord(requireEnvironmentById(db, environmentId))
                : null;
        })();
    }

    async completeEnvironmentRevocation(
        environmentId: string,
        claimToken: string,
        now: number
    ): Promise<boolean> {
        const db = getRawDb();
        return db.transaction(() => {
            const environment = requireEnvironmentById(db, environmentId);
            if (
                environment.status !== 'revoking' ||
                environment.lifecycle_claim_token !== claimToken
            ) {
                return false;
            }
            if (environment.authorization_id) {
                db.prepare(
                    `UPDATE connect_device_authorizations
                         SET status = CASE
                             WHEN status IN (
                                 'provisioning', 'approved', 'delivering'
                             ) THEN 'expired'
                             ELSE status
                         END,
                         credential_ciphertext = NULL,
                         updated_at = ?
                     WHERE id = ?`
                ).run(now, environment.authorization_id);
            }
            const result = db
                .prepare(
                    `UPDATE connect_environments
                     SET status = 'revoked',
                         access_credential_ciphertext = '',
                         tunnel_secret_ciphertext = NULL,
                         hostname = '',
                         tunnel_id = '',
                         dns_record_id = '',
                         relay_authenticator = NULL,
                         lifecycle_claim_token = NULL,
                         lifecycle_claimed_until = NULL,
                         lifecycle_next_attempt_at = 0,
                         lifecycle_error = NULL,
                         revoked_at = ?,
                         updated_at = ?
                     WHERE id = ?
                       AND status = 'revoking'
                       AND lifecycle_claim_token = ?`
                )
                .run(now, now, environmentId, claimToken);
            return result.changes === 1;
        })();
    }

    async recordEnvironmentLifecycleFailure(
        environmentId: string,
        expectedStatus: 'provisioning' | 'revoking',
        claimToken: string,
        errorMessage: string,
        nextAttemptAt: number,
        now: number
    ): Promise<boolean> {
        const result = getRawDb()
            .prepare(
                `UPDATE connect_environments
                 SET lifecycle_attempts = lifecycle_attempts + 1,
                     lifecycle_next_attempt_at = ?,
                     lifecycle_claim_token = NULL,
                     lifecycle_claimed_until = NULL,
                     lifecycle_error = ?,
                     updated_at = ?
                 WHERE id = ?
                   AND status = ?
                   AND lifecycle_claim_token = ?`
            )
            .run(
                nextAttemptAt,
                errorMessage.slice(0, 500),
                now,
                environmentId,
                expectedStatus,
                claimToken
            );
        return result.changes === 1;
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
        controlTokenHash: string,
        scope: ConnectEnvironmentScope
    ): Promise<ConnectEnvironmentRecord | null> {
        const row = getRawDb()
            .prepare(
                `SELECT ${ENVIRONMENT_COLUMNS}
                 FROM connect_environments
                 WHERE user_id = ?
                   AND workspace_id = ?
                   AND control_token_hash = ?`
            )
            .get(
                scope.userId,
                scope.workspaceId,
                controlTokenHash
            ) as EnvironmentRow | undefined;
        return row ? toEnvironmentRecord(row) : null;
    }

    async listEnvironments(
        scope: ConnectEnvironmentScope
    ): Promise<ConnectEnvironmentRecord[]> {
        const rows = getRawDb()
            .prepare(
                `SELECT ${ENVIRONMENT_COLUMNS}
                 FROM connect_environments
                 WHERE user_id = ?
                   AND workspace_id = ?
                   AND status = 'active'
                 ORDER BY updated_at DESC, id ASC`
            )
            .all(scope.userId, scope.workspaceId) as EnvironmentRow[];
        return rows.map(toEnvironmentRecord);
    }

    async revokeEnvironment(
        environmentId: string,
        scope: ConnectEnvironmentScope,
        now: number
    ): Promise<boolean> {
        const db = getRawDb();
        return db.transaction(() => {
            db.prepare(
                `UPDATE connect_device_authorizations
                 SET status = CASE
                         WHEN status IN (
                             'pending', 'provisioning',
                             'approved', 'delivering'
                         ) THEN 'expired'
                         ELSE status
                     END,
                     credential_ciphertext = NULL,
                     updated_at = ?
                 WHERE environment_id = ?`
            ).run(now, environmentId);
            const result = db
                .prepare(
                    `UPDATE connect_environments
                     SET status = 'revoked',
                         access_credential_ciphertext = '',
                         tunnel_secret_ciphertext = NULL,
                         hostname = '',
                         tunnel_id = '',
                         dns_record_id = '',
                         relay_authenticator = NULL,
                         revoked_at = ?,
                         updated_at = ?
                     WHERE user_id = ?
                       AND workspace_id = ?
                       AND id = ?
                       AND status <> 'revoked'`
                )
                .run(
                    now,
                    now,
                    scope.userId,
                    scope.workspaceId,
                    environmentId
                );
            return result.changes === 1;
        })();
    }

    async purgeConnectRecords(
        input: PurgeConnectRecordsInput
    ): Promise<PurgeConnectRecordsResult> {
        const batchSize = normalizePurgeBatchSize(input.batchSize);
        const db = getRawDb();
        return db.transaction(() => {
            const authorizations = db
                .prepare(
                    `DELETE FROM connect_device_authorizations
                     WHERE id IN (
                         SELECT id
                         FROM connect_device_authorizations
                         WHERE status IN ('denied', 'consumed', 'expired')
                           AND updated_at <= ?
                         ORDER BY updated_at ASC, id ASC
                         LIMIT ?
                     )`
                )
                .run(input.authorizationUpdatedBefore, batchSize).changes;
            const environments = db
                .prepare(
                    `DELETE FROM connect_environments
                     WHERE id IN (
                         SELECT id
                         FROM connect_environments
                         WHERE status = 'revoked'
                           AND updated_at <= ?
                         ORDER BY updated_at ASC, id ASC
                         LIMIT ?
                     )`
                )
                .run(input.revokedEnvironmentUpdatedBefore, batchSize).changes;
            return { authorizations, environments };
        })();
    }

    async rotateAuthorizationCredential(
        authorizationId: string,
        expectedCiphertext: string,
        replacementCiphertext: string,
        now: number
    ): Promise<boolean> {
        const result = getRawDb()
            .prepare(
                `UPDATE connect_device_authorizations
                 SET credential_ciphertext = ?, updated_at = ?
                 WHERE id = ? AND credential_ciphertext = ?`
            )
            .run(
                replacementCiphertext,
                now,
                authorizationId,
                expectedCiphertext
            );
        return result.changes === 1;
    }

    async rotateEnvironmentCredential(
        environmentId: string,
        purpose: 'access' | 'tunnel',
        expectedCiphertext: string,
        replacementCiphertext: string,
        now: number
    ): Promise<boolean> {
        const column =
            purpose === 'access'
                ? 'access_credential_ciphertext'
                : 'tunnel_secret_ciphertext';
        const result = getRawDb()
            .prepare(
                `UPDATE connect_environments
                 SET ${column} = ?, updated_at = ?
                 WHERE id = ? AND ${column} = ?`
            )
            .run(
                replacementCiphertext,
                now,
                environmentId,
                expectedCiphertext
            );
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
        host: parsed,
        approved_user_id: row.approved_user_id ?? undefined,
        approved_workspace_id: row.approved_workspace_id ?? undefined,
        environment_id: row.environment_id ?? undefined,
        credential_ciphertext: row.credential_ciphertext ?? undefined,
        expires_at: row.expires_at,
    };
}

function toEnvironmentRecord(row: EnvironmentRow): ConnectEnvironmentRecord {
    return {
        id: row.id,
        user_id: row.user_id,
        workspace_id: row.workspace_id,
        name: row.name,
        platform: row.platform,
        architecture: row.architecture,
        driver: row.driver ?? undefined,
        runtime: row.runtime ?? undefined,
        base_path: row.base_path ?? undefined,
        host_id: row.host_id ?? undefined,
        signing_public_key: row.signing_public_key ?? undefined,
        noise_public_key: row.noise_public_key ?? undefined,
        authorization_id: row.authorization_id ?? undefined,
        hostname: row.hostname,
        tunnel_id: row.tunnel_id,
        dns_record_id: row.dns_record_id,
        access_credential_ciphertext: row.access_credential_ciphertext,
        tunnel_secret_ciphertext:
            row.tunnel_secret_ciphertext ?? undefined,
        status: row.status,
        lifecycle_attempts: row.lifecycle_attempts,
        lifecycle_next_attempt_at: row.lifecycle_next_attempt_at,
        lifecycle_claim_token: row.lifecycle_claim_token ?? undefined,
        lifecycle_claimed_until: row.lifecycle_claimed_until ?? undefined,
        provisioning_deadline_at:
            row.provisioning_deadline_at ?? undefined,
        activation_deadline_at:
            row.activation_deadline_at ?? undefined,
        activation_claimed_at:
            row.activation_claimed_at ?? undefined,
        relay_authenticator: row.relay_authenticator ?? undefined,
        control_token_hash: row.control_token_hash,
        lifecycle_error: row.lifecycle_error ?? undefined,
    };
}

function requireEnvironmentById(
    db: ReturnType<typeof getRawDb>,
    environmentId: string
): EnvironmentRow {
    const row = db
        .prepare(
            `SELECT ${ENVIRONMENT_COLUMNS}
             FROM connect_environments
             WHERE id = ?`
        )
        .get(environmentId) as EnvironmentRow | undefined;
    if (!row) {
        throw new ConnectStoreError(
            'authorization_unavailable',
            'The Connect environment is no longer available.'
        );
    }
    return row;
}

function normalizeRedeliveryWindow(value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('Invalid Connect credential redelivery window');
    }
    return Math.min(value, 5 * 60_000);
}

function normalizePurgeBatchSize(value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('Invalid Connect retention purge batch size');
    }
    return Math.min(500, value);
}
