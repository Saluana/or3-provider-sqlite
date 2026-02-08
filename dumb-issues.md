## Workspace isolation is broken by schema design
**Reference:** `src/runtime/server/db/migrations/002_sync_tables.ts:117-130`, `src/runtime/server/sync/sqlite-sync-gateway-adapter.ts:189-201`

The materialized sync tables use `id` as a global primary key. You still query by `(workspace_id, id)`, but inserts only enforce uniqueness on `id`. Two workspaces using the same entity ID will collide.

**Why this is bad:** multi-tenant data is no longer isolated at the storage layer.

**Real-world consequence:** a push in workspace B can fail (`UNIQUE constraint failed`) because workspace A already has the same `id`; sync reliability falls apart as tenant count grows.

**Concrete fix:** make the key workspace-scoped.

```sql
-- migration fix idea
CREATE TABLE s_threads (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  ...,
  PRIMARY KEY (workspace_id, id)
);
```

Also add matching composite indexes for all `s_*` tables and update queries to always bind both columns.

## Your tombstone "upsert" never actually upserts
**Reference:** `src/runtime/server/sync/sqlite-sync-gateway-adapter.ts:280-296`, `src/runtime/server/db/migrations/002_sync_tables.ts:91-110`

You insert tombstones with a random `id` and use `ON CONFLICT(id)`. That conflict target is useless because every insert has a fresh UUID, so conflict never triggers.

**Why this is bad:** repeated deletes for the same `(workspace, table, pk)` create duplicate tombstones instead of updating one canonical record.

**Real-world consequence:** unbounded tombstone growth, stale clocks/server versions, and garbage collection doing extra work forever.

**Concrete fix:** enforce uniqueness on logical identity and upsert on that key.

```sql
CREATE UNIQUE INDEX idx_tombstones_ws_table_pk
ON tombstones(workspace_id, table_name, pk);
```

```sql
ON CONFLICT(workspace_id, table_name, pk) DO UPDATE SET
  deleted_at = excluded.deleted_at,
  clock = MAX(tombstones.clock, excluded.clock),
  server_version = excluded.server_version
```

## `getOrCreateUser` is not idempotent under concurrency
**Reference:** `src/runtime/server/auth/sqlite-auth-workspace-store.ts:32-73`

You do a read-then-insert pattern. Two concurrent requests for the same provider identity can both miss the initial read; one then blows up on the unique index.

**Why this is bad:** "idempotent" behavior only works in single-threaded happy path.

**Real-world consequence:** intermittent login/provisioning failures during auth bursts, retries, or multi-instance deployment.

**Concrete fix:** do conflict-safe insert semantics and re-read on conflict.

```ts
// sketch
await tx.insertInto('auth_accounts')
  .values(...)
  .onConflict((oc) => oc.columns(['provider', 'provider_user_id']).doNothing())
  .execute();

const row = await tx.selectFrom('auth_accounts')...
```

## Deleting a workspace only re-homes one user and leaves everyone else broken
**Reference:** `src/runtime/server/auth/sqlite-auth-workspace-store.ts:304-325`

`removeWorkspace` only re-homes `active_workspace_id` for `input.userId` (the actor). Other members keep an active workspace pointer to a deleted workspace.

**Why this is bad:** workspace state becomes inconsistent across members after deletion.

**Real-world consequence:** users end up with invalid active workspace state, weird workspace switching behavior, and stale authorization/session context until manual recovery.

**Concrete fix:** fetch all members for the deleted workspace and re-home each user atomically inside the same transaction.

## `setActiveWorkspace` allows activating deleted workspaces
**Reference:** `src/runtime/server/auth/sqlite-auth-workspace-store.ts:336-352`

Membership is checked, but workspace deletion state is ignored. Since deleted workspaces keep membership rows, this lets users set `active_workspace_id` to a soft-deleted workspace.

**Why this is bad:** you persist an invalid active pointer by design.

**Real-world consequence:** active workspace UI and server session behavior diverge; users can pin themselves to dead workspaces.

**Concrete fix:** join `workspaces` in the membership check and require `workspaces.deleted = 0` before updating `users.active_workspace_id`.

## Duplicate `op_id` values inside one push batch can nuke the whole transaction
**Reference:** `src/runtime/server/sync/sqlite-sync-gateway-adapter.ts:84-105`, `src/runtime/server/sync/sqlite-sync-gateway-adapter.ts:137-182`

You only check idempotency against existing DB rows. If the same `op_id` appears twice in the incoming batch, the second insert hits the unique index on `change_log(op_id)` and aborts the entire transaction.

**Why this is bad:** one malformed batch becomes an all-or-nothing server error instead of deterministic idempotent handling.

**Real-world consequence:** transient client bugs or retry edge cases can drop a whole sync push and force expensive recovery loops.

**Concrete fix:** dedupe `op_id` inside the batch before allocation, or track seen `op_id` during iteration and treat duplicates as idempotent to the first in-batch result.

## Defaulting to `:memory:` is a production footgun with silent data loss
**Reference:** `src/runtime/server/db/kysely.ts:27-29`

If `OR3_SQLITE_DB_PATH` is missing, you silently use in-memory storage. That means everything disappears on process restart.

**Why this is bad:** a misconfigured deployment looks healthy while permanently losing sync/workspace data.

**Real-world consequence:** operator restarts and suddenly all server-side state is gone.

**Concrete fix:** require explicit DB path in non-test mode, or at minimum emit a loud startup warning and gate `:memory:` behind an explicit env like `OR3_SQLITE_ALLOW_IN_MEMORY=true`.

## You explicitly skipped required integration coverage
**Reference:** `planning/tasks.md:117-122`

The task list still marks all 6.2 integration tests as undone (`/api/sync/push -> pull`, `/api/sync/update-cursor`, `/api/workspaces/*`).

**Why this is bad:** the exact end-to-end seams where your current bugs live are untested.

**Real-world consequence:** regressions ship even while unit tests stay green.

**Concrete fix:** add endpoint-level integration tests that run against the registered SQLite provider and assert multi-workspace isolation, delete semantics, and cursor/GC safety.
