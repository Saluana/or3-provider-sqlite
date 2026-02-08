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
    deleted: Generated<number>;
    created_at: Generated<number>;
    updated_at: Generated<number>;
}

// ─── Database Interface ───

export interface Or3SqliteDb {
    users: UsersTable;
    auth_accounts: AuthAccountsTable;
    workspaces: WorkspacesTable;
    workspace_members: WorkspaceMembersTable;
    server_version_counter: ServerVersionCounterTable;
    change_log: ChangeLogTable;
    device_cursors: DeviceCursorsTable;
    tombstones: TombstonesTable;
    // Synced entity tables
    s_threads: SyncedEntityTable;
    s_messages: SyncedEntityTable;
    s_projects: SyncedEntityTable;
    s_posts: SyncedEntityTable;
    s_kv: SyncedEntityTable;
    s_file_meta: SyncedEntityTable;
    s_notifications: SyncedEntityTable;
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
