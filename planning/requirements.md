# requirements.md

artifact_id: 190de89e-5000-4fdf-9262-9b453fb889cf

## Overview

Build `or3-provider-sqlite` as a provider package that supplies:

- `AuthWorkspaceStore` implementation backed by SQLite
- `SyncGatewayAdapter` implementation backed by SQLite
- optional admin sync adapter hooks for maintenance/health

This provider is sync/store only. It does not provide authentication UI or password auth.

## Roles

- End User: expects cross-device sync and workspace operations to behave the same as current cloud behavior.
- Instance Operator: runs OR3 with SQLite backend in SSR mode.
- OR3 Maintainer: keeps sync invariants stable while evolving schema.

## Requirements

### 1. Package and Registration

1.1 As a Maintainer, I want this provider installable as `or3-provider-sqlite`, so that it can be selected via config without core changes.

- Package SHALL expose `or3-provider-sqlite/nuxt`.
- Module load SHALL register `AuthWorkspaceStore` and `SyncGatewayAdapter` with ID `sqlite`.
- Provider SHALL avoid Convex SDK imports.

1.2 As a Maintainer, I want provider startup to be deterministic, so that misconfiguration is obvious.

- Missing SQLite DB path/config in strict mode SHALL fail with actionable error.
- Non-strict mode SHALL log clear warnings.

### 2. AuthWorkspaceStore Behavior

2.1 As a Systems Engineer, I want user identity mapping from auth providers, so that session resolution works with any auth provider.

- Store SHALL map (`provider`, `provider_user_id`) to internal users.
- `getOrCreateUser` SHALL be idempotent.

2.2 As a User, I want default workspace provisioning, so that first login works automatically.

- `getOrCreateDefaultWorkspace` SHALL create first workspace + owner membership when none exists.
- Existing users SHALL receive consistent workspace resolution.

2.3 As a User, I want workspace CRUD and role checks, so that workspace features keep working.

- Store SHALL implement `listUserWorkspaces`, `createWorkspace`, `updateWorkspace`, `removeWorkspace`, `setActiveWorkspace`, and `getWorkspaceRole`.
- Workspace roles SHALL align with existing role semantics (`owner`, `editor`, `viewer`).

### 3. SyncGatewayAdapter Behavior

3.1 As a Multi-device User, I want push semantics to remain safe and deterministic, so that writes merge correctly.

- `push` SHALL enforce idempotency via `op_id`.
- `push` SHALL allocate contiguous monotonic `server_version` per workspace.
- LWW merge SHALL be based on `clock`, with `hlc` tie-break.
- Delete operations SHALL upsert tombstones.

3.2 As a Multi-device User, I want pull semantics to match existing clients, so that sync engine behavior remains unchanged.

- `pull` SHALL return ordered changes for `server_version > cursor`.
- `pull` SHALL support paging (`limit`, `hasMore`, `nextCursor`).
- `pull` SHALL support optional table filtering.

3.3 As an Operator, I want cursor and retention logic, so that sync storage remains bounded.

- `updateCursor` SHALL upsert per device cursor per workspace.
- `gcTombstones` and `gcChangeLog` SHALL delete only entries older than retention and behind min device cursor.
- Retention logic SHALL avoid data loss for lagging devices.

### 4. Data Model and Compatibility

4.1 As a Maintainer, I want wire-schema compatibility, so that no client payload mapping regressions occur.

- Table fields SHALL remain snake_case aligned with existing sync payloads.
- Synced table keys and payload handling SHALL match current table metadata.

4.2 As a User, I want stable message ordering, so that chats remain deterministic.

- Sync writes SHALL preserve `index` + `order_key` behavior.

4.3 As a Storage Maintainer, I want file metadata semantics unchanged, so that file sync stays correct.

- `ref_count` SHALL remain derived behavior and not authoritative LWW-synced state.

### 5. Performance and Reliability

5.1 As an Operator, I want efficient sync operations, so that SQLite stays responsive under normal load.

- Provider SHALL use indexes for `workspace + server_version`, `op_id`, and membership lookups.
- Provider SHALL avoid full-table scans in push/pull hot paths.

5.2 As a Maintainer, I want transactional safety, so that concurrent writes do not corrupt server version ordering.

- Push + version allocation SHALL run in explicit transactions.
- Concurrency strategy SHALL prevent duplicate or out-of-order server version assignment.

### 6. Testing

6.1 As a Maintainer, I want unit tests for sync invariants, so that correctness regressions are caught.

- Unit tests SHALL cover idempotency, LWW, cursor progression, GC eligibility.

6.2 As a Maintainer, I want integration tests for endpoints and store operations, so that provider wiring is validated.

- Integration tests SHALL cover `/api/sync/*` and `/api/workspaces/*` via this adapter/store.

6.3 As a Maintainer, I want build/type-check guarantees, so that provider package remains distributable.

- Package SHALL pass Bun build and type-check standalone.

### 7. Documentation

7.1 As an Operator, I want SQLite setup docs, so that deployment is predictable.

- Docs SHALL include install, DB path config, migration behavior, and backup guidance.

7.2 As an Intern, I want a schema and migration guide, so that implementation can proceed without guessing.

- Design doc SHALL include table schemas and starter queries.

