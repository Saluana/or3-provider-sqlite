# design.md

artifact_id: c7e9ead8-2f1f-4471-bc40-4b503ec12bf4

## Overview

`or3-provider-sqlite` provides the server-side data backend for OR3 SSR cloud mode when `sync.provider=sqlite`.

It implements two core interfaces:

- `AuthWorkspaceStore`
- `SyncGatewayAdapter`

It is intentionally gateway-mode server infrastructure. Client sync engine and Dexie hooks remain unchanged.

## Architecture

```mermaid
flowchart LR
  SyncApi[/api/sync/*] --> Adapter[SQLiteSyncGatewayAdapter]
  WorkspaceApi[/api/workspaces/*] --> Store[SQLiteAuthWorkspaceStore]

  Session[/api/auth/session] --> Store

  Adapter --> DB[(SQLite via Kysely)]
  Store --> DB

  Register[Nitro plugin register.ts] --> SyncRegistry[registerSyncGatewayAdapter('sqlite')]
  Register --> StoreRegistry[registerAuthWorkspaceStore('sqlite')]
```

## Package Layout

```text
or3-provider-sqlite/
  package.json
  tsconfig.json
  README.md
  src/
    module.ts
    runtime/
      server/
        plugins/
          register.ts
        db/
          kysely.ts
          schema.ts
          migrations/
            001_init.ts
            002_sync_tables.ts
        auth/
          sqlite-auth-workspace-store.ts
        sync/
          sqlite-sync-gateway-adapter.ts
        admin/
          adapters/
            sync-sqlite.ts (optional)
```

## Kysely Setup

```ts
// src/runtime/server/db/kysely.ts
import { Kysely, SqliteDialect } from 'kysely';
import Database from 'better-sqlite3';
import type { Or3SqliteDb } from './schema';

let db: Kysely<Or3SqliteDb> | null = null;

export function getSqliteDb(path: string): Kysely<Or3SqliteDb> {
  if (db) return db;

  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');

  db = new Kysely<Or3SqliteDb>({
    dialect: new SqliteDialect({ database: sqlite }),
  });

  return db;
}
```

## Database Schema

## Auth/workspace tables

```ts
// src/runtime/server/db/schema.ts (excerpt)
export interface UsersTable {
  id: string;
  email: string | null;
  display_name: string | null;
  active_workspace_id: string | null;
  created_at: number;
}

export interface AuthAccountsTable {
  id: string;
  user_id: string;
  provider: string;
  provider_user_id: string;
  created_at: number;
}

export interface WorkspacesTable {
  id: string;
  name: string;
  description: string | null;
  owner_user_id: string;
  created_at: number;
  deleted: number;
  deleted_at: number | null;
}

export interface WorkspaceMembersTable {
  id: string;
  workspace_id: string;
  user_id: string;
  role: 'owner' | 'editor' | 'viewer';
  created_at: number;
}
```

## Sync infrastructure tables

```ts
export interface ChangeLogTable {
  id: string;
  workspace_id: string;
  server_version: number;
  table_name: string;
  pk: string;
  op: 'put' | 'delete';
  payload_json: string | null;
  clock: number;
  hlc: string;
  device_id: string;
  op_id: string;
  created_at: number;
}

export interface ServerVersionCounterTable {
  workspace_id: string;
  value: number;
}

export interface DeviceCursorsTable {
  id: string;
  workspace_id: string;
  device_id: string;
  last_seen_version: number;
  updated_at: number;
}

export interface TombstonesTable {
  id: string;
  workspace_id: string;
  table_name: string;
  pk: string;
  deleted_at: number;
  clock: number;
  server_version: number;
  created_at: number;
}
```

Required indexes:

- `change_log(workspace_id, server_version)`
- `change_log(op_id)` unique
- `device_cursors(workspace_id, last_seen_version)`
- `workspace_members(workspace_id, user_id)`
- `auth_accounts(provider, provider_user_id)` unique

## Registration

```ts
// src/runtime/server/plugins/register.ts
import { registerAuthWorkspaceStore } from '~~/server/auth/store/registry';
import { registerSyncGatewayAdapter } from '~~/server/sync/gateway/registry';
import { createSqliteAuthWorkspaceStore } from '../auth/sqlite-auth-workspace-store';
import { createSqliteSyncGatewayAdapter } from '../sync/sqlite-sync-gateway-adapter';

export default defineNitroPlugin(() => {
  registerAuthWorkspaceStore({
    id: 'sqlite',
    order: 100,
    create: createSqliteAuthWorkspaceStore,
  });

  registerSyncGatewayAdapter({
    id: 'sqlite',
    order: 100,
    create: createSqliteSyncGatewayAdapter,
  });
});
```

## AuthWorkspaceStore implementation details

### `getOrCreateUser`

```ts
// flow sketch
// 1) find auth account by provider/provider_user_id
// 2) if exists -> return user_id
// 3) else create users row + auth_accounts row transactionally
```

### `getOrCreateDefaultWorkspace`

- query user memberships
- if membership exists, return selected workspace
- else create workspace + owner membership, set active workspace

### Workspace CRUD

- `createWorkspace`: insert workspace + owner membership
- `updateWorkspace`: update metadata with role checks
- `removeWorkspace`: soft delete and re-home active workspace
- `setActiveWorkspace`: ensure membership then set `users.active_workspace_id`

## SyncGatewayAdapter implementation details

### `push`

```ts
// pseudo-flow
// tx begin immediate
// validate ops
// resolve existing op_ids in bulk
// allocate contiguous server_version block for new ops
// apply LWW per op to materialized table
// insert change_log row
// upsert tombstone for delete
// commit
```

Key invariants:

- `op_id` unique -> idempotency
- server versions monotonic and contiguous per workspace
- LWW: `(incoming.clock > existing.clock) || (== and incoming.hlc > existing.hlc)`

### `pull`

```ts
const rows = await db
  .selectFrom('change_log')
  .selectAll()
  .where('workspace_id', '=', workspaceId)
  .where('server_version', '>', cursor)
  .orderBy('server_version asc')
  .limit(limit + 1)
  .execute();
```

- map to OR3 `PullResponse`
- derive `hasMore` and `nextCursor`

### `updateCursor`

- upsert `(workspace_id, device_id)`
- only move `last_seen_version` forward

### `gcTombstones` / `gcChangeLog`

- find `min(last_seen_version)` across workspace device cursors
- delete rows older than retention **and** `< min_cursor`
- support batch cursors to avoid long locks

## Migration Plan

1. `001_init.ts`: auth/workspace tables + indexes
2. `002_sync_tables.ts`: change_log/cursors/tombstones/counter + indexes
3. future migrations append only; no destructive changes without migration path

Migration runner called from module init before registration.

## Error Handling

- adapter unavailable -> core endpoints already return 500
- invalid payload -> 400
- membership/auth issues -> 401/403 from core `requireCan` + endpoint checks
- DB constraint collisions on `op_id` -> return previous server version as idempotent success

## Testing Strategy

### Unit

- `sqlite-sync-gateway-adapter.test.ts`
  - idempotent replay behavior
  - LWW conflict scenarios
  - pull pagination correctness
  - gc retention safety

- `sqlite-auth-workspace-store.test.ts`
  - getOrCreate idempotency
  - default workspace provisioning
  - workspace role resolution and CRUD

### Integration

- wire through `server/api/sync/*.post.ts`
- wire through `server/api/workspaces/*`
- verify session resolver with non-Convex workspace store

## Intern Implementation Order

1. Create schema and migrations first.
2. Implement `AuthWorkspaceStore` next (easier to validate).
3. Implement sync adapter push/pull/updateCursor.
4. Add GC methods.
5. Register plugin and run integration tests.
6. Add optional admin adapter last.

