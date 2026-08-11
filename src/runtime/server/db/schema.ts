/**
 * Database schema types for the SQLite provider.
 * All tables use snake_case aligned with sync wire format.
 */
import type { Generated, Insertable, Selectable } from 'kysely';

// ─── Auth / Workspace Tables ───

export interface UsersTable {
    id: string;
    email: string | null;
    display_name: string | null;
    active_workspace_id: string | null;
    created_at: Generated<number>;
}

export interface AuthAccountsTable {
    id: string;
    user_id: string;
    provider: string;
    provider_user_id: string;
    created_at: Generated<number>;
}

export interface WorkspacesTable {
    id: string;
    name: string;
    description: string | null;
    owner_user_id: string;
    created_at: Generated<number>;
    deleted: Generated<number>;
    deleted_at: number | null;
}

export interface WorkspaceMembersTable {
    id: string;
    workspace_id: string;
    user_id: string;
    role: string; // 'owner' | 'editor' | 'viewer'
    created_at: Generated<number>;
}

export interface AuthInvitesTable {
    id: string;
    workspace_id: string;
    email: string;
    role: string; // 'owner' | 'editor' | 'viewer'
    status: string; // 'pending' | 'accepted' | 'revoked' | 'expired'
    invited_by_user_id: string;
    token_hash: string;
    expires_at: number;
    accepted_at: number | null;
    accepted_user_id: string | null;
    revoked_at: number | null;
    created_at: Generated<number>;
    updated_at: Generated<number>;
}

// ─── Sync Infrastructure Tables ───

export interface ServerVersionCounterTable {
    workspace_id: string;
    value: Generated<number>;
}

export interface ChangeLogTable {
    id: string;
    workspace_id: string;
    server_version: number;
    table_name: string;
    pk: string;
    op: string; // 'put' | 'delete'
    payload_json: string | null;
    clock: number;
    hlc: string;
    device_id: string;
    op_id: string;
    created_at: Generated<number>;
}

export interface DeviceCursorsTable {
    id: string;
    workspace_id: string;
    device_id: string;
    owner_user_id: string | null;
    last_seen_version: number;
    updated_at: Generated<number>;
}

export interface TombstonesTable {
    id: string;
    workspace_id: string;
    table_name: string;
    pk: string;
    deleted_at: number;
    clock: number;
    hlc: string;
    op_id: string;
    server_version: number;
    created_at: Generated<number>;
}

// ─── Synced Data Tables ───
// Generic row type for all synced entity tables.
// The actual payload is stored in change_log.payload_json.
// Materialized tables store the latest version for reads.

export interface SyncedEntityTable {
    id: string;
    workspace_id: string;
    data_json: string;
    clock: number;
    hlc: string;
    device_id: string;
    op_id: string;
    deleted: Generated<number>;
    created_at: Generated<number>;
    updated_at: Generated<number>;
}

export interface SyncSnapshotsTable {
    id: string;
    workspace_id: string;
    high_watermark: number;
    tables_json: string;
    created_at: number;
    expires_at: number;
}

export interface SyncSnapshotItemsTable {
    snapshot_id: string;
    table_name: string;
    pk: string;
    kind: string; // 'row' | 'tombstone'
    payload_json: string | null;
    clock: number;
    hlc: string;
    op_id: string;
    server_deleted_at: number | null;
}

export interface UploadIntentsTable {
    id: string;
    workspace_id: string;
    hash: string;
    mime_type: string;
    size_bytes: number;
    reserved_bytes: number;
    expires_at: number;
    status: 'active' | 'consumed' | 'cancelled' | 'expired';
    storage_id: string | null;
    created_at: number;
    consumed_at: number | null;
    cancelled_at: number | null;
}

// ─── Database Interface ───

export interface ConnectDeviceAuthorizationsTable {
    id: string;
    device_code_hash: string;
    user_code_hash: string;
    status:
        | 'pending'
        | 'provisioning'
        | 'approved'
        | 'delivering'
        | 'denied'
        | 'consumed'
        | 'expired';
    host_json: string;
    approved_user_id: string | null;
    approved_workspace_id: string | null;
    environment_id: string | null;
    credential_ciphertext: string | null;
    credential_delivery_started_at: number | null;
    credential_redeliver_until: number | null;
    expires_at: number;
    created_at: number;
    updated_at: number;
}

export interface ConnectEnvironmentsTable {
    id: string;
    user_id: string;
    workspace_id: string;
    name: string;
    platform: string;
    architecture: string;
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
    driver: 'intern' | 'runs' | null;
    runtime: 'intern' | 'openclaw' | 'hermes' | null;
    base_path: '/' | '/or3/' | null;
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
    last_seen_at: number | null;
    created_at: number;
    updated_at: number;
    revoked_at: number | null;
}

export interface RateLimitsTable {
    key: string;
    count: number;
    window_started_at: number;
    expires_at: number;
}

export interface BackgroundJobsTable {
    id: string;
    user_id: string;
    thread_id: string;
    message_id: string;
    model: string;
    kind: string | null;
    status: 'streaming' | 'complete' | 'error' | 'aborted';
    content: string;
    chunks_received: number;
    started_at: number;
    last_activity_at: number;
    completed_at: number | null;
    error: string | null;
    tool_calls_json: string | null;
    workflow_state_json: string | null;
    execution_json: string | null;
    idempotency_key: string | null;
    lease_owner: string | null;
    lease_expires_at: number | null;
    attempts: number;
}

export interface AdminUsersTable {
    user_id: string;
    created_at: number;
    created_by_user_id: string | null;
}

export interface AdminWorkspaceSettingsTable {
    id: string;
    workspace_id: string;
    key: string;
    value: string;
    updated_at: number;
}

export interface Or3SqliteDb {
    users: UsersTable;
    auth_accounts: AuthAccountsTable;
    workspaces: WorkspacesTable;
    workspace_members: WorkspaceMembersTable;
    auth_invites: AuthInvitesTable;
    server_version_counter: ServerVersionCounterTable;
    change_log: ChangeLogTable;
    device_cursors: DeviceCursorsTable;
    tombstones: TombstonesTable;
    sync_snapshots: SyncSnapshotsTable;
    sync_snapshot_items: SyncSnapshotItemsTable;
    upload_intents: UploadIntentsTable;
    connect_device_authorizations: ConnectDeviceAuthorizationsTable;
    connect_environments: ConnectEnvironmentsTable;
    rate_limits: RateLimitsTable;
    background_jobs: BackgroundJobsTable;
    // Synced entity tables
    s_threads: SyncedEntityTable;
    s_messages: SyncedEntityTable;
    s_projects: SyncedEntityTable;
    s_posts: SyncedEntityTable;
    s_kv: SyncedEntityTable;
    s_file_meta: SyncedEntityTable;
    s_notifications: SyncedEntityTable;
    admin_users: AdminUsersTable;
    admin_workspace_settings: AdminWorkspaceSettingsTable;
}

// ─── Convenience types ───

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type AuthAccount = Selectable<AuthAccountsTable>;
export type Workspace = Selectable<WorkspacesTable>;
export type WorkspaceMember = Selectable<WorkspaceMembersTable>;
export type ChangeLogRow = Selectable<ChangeLogTable>;

/** Map sync table name -> materialized table name */
export const SYNCED_TABLE_MAP: Record<string, keyof Or3SqliteDb> = {
    threads: 's_threads',
    messages: 's_messages',
    projects: 's_projects',
    posts: 's_posts',
    kv: 's_kv',
    file_meta: 's_file_meta',
    notifications: 's_notifications',
};

/** List of allowed sync table names */
export const ALLOWED_SYNC_TABLES = Object.keys(SYNCED_TABLE_MAP);
