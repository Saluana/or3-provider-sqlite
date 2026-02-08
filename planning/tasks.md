# tasks.md

artifact_id: 4497f9a5-bc30-46b1-8a42-f96a9dcfae16

## 0. Preflight

- [ ] Initialize package metadata and Bun scripts
  - Requirements: 1.1
- [ ] Define required env vars (`OR3_SQLITE_DB_PATH`, optional pragmas)
  - Requirements: 1.2
- [ ] Add README skeleton with setup section
  - Requirements: 7.1

## 1. Package Scaffolding

- [ ] Create `src/module.ts` and module export path
  - Requirements: 1.1
- [ ] Create runtime folders (`server/db`, `server/auth`, `server/sync`, `server/plugins`)
  - Requirements: 1.1
- [ ] Configure TypeScript build and test setup
  - Requirements: 6.3

## 2. Database Core

### 2.1 Kysely client and config

- [ ] Implement singleton DB bootstrap with `SqliteDialect`
  - Requirements: 5.1
- [ ] Configure SQLite pragmas for WAL and synchronous mode
  - Requirements: 5.1
- [ ] Add lifecycle/cleanup handling for tests
  - Requirements: 6.1

### 2.2 Schema and migrations

- [ ] Create `001_init` migration for auth/workspace tables
  - Requirements: 2.1, 2.2, 2.3
- [ ] Create `002_sync_tables` migration for sync infra tables
  - Requirements: 3.1, 3.2, 3.3
- [ ] Add indexes and uniqueness constraints (`op_id`, provider identity)
  - Requirements: 3.1, 5.1
- [ ] Implement migration runner on module boot
  - Requirements: 1.2

## 3. AuthWorkspaceStore

- [ ] Implement `getOrCreateUser`
  - Requirements: 2.1
- [ ] Implement `getOrCreateDefaultWorkspace`
  - Requirements: 2.2
- [ ] Implement `getWorkspaceRole`
  - Requirements: 2.3
- [ ] Implement workspace CRUD methods and active workspace switching
  - Requirements: 2.3
- [ ] Add role/ownership checks in mutating store methods
  - Requirements: 2.3

## 4. SyncGatewayAdapter

### 4.1 Push

- [ ] Implement op validation and allowlisted table handling
  - Requirements: 3.1, 4.1
- [ ] Implement idempotency lookup using `op_id`
  - Requirements: 3.1
- [ ] Implement contiguous server-version allocation transaction
  - Requirements: 3.1, 5.2
- [ ] Implement LWW apply logic with `clock` + `hlc`
  - Requirements: 3.1, 4.2
- [ ] Implement tombstone upsert on delete
  - Requirements: 3.1

### 4.2 Pull and cursor

- [ ] Implement paginated `pull` with optional table filters
  - Requirements: 3.2
- [ ] Implement `updateCursor` upsert
  - Requirements: 3.3
- [ ] Ensure cursor only moves forward
  - Requirements: 3.3

### 4.3 GC

- [ ] Implement `gcTombstones` with retention + min cursor safety
  - Requirements: 3.3
- [ ] Implement `gcChangeLog` with retention + min cursor safety
  - Requirements: 3.3
- [ ] Add batched GC cursor support
  - Requirements: 3.3, 5.1

## 5. Registration and Module Wiring

- [ ] Implement Nitro `register.ts` for store and sync adapter
  - Requirements: 1.1
- [ ] Validate provider ID `sqlite` registration end-to-end
  - Requirements: 1.2
- [ ] Optionally add admin sync adapter registration
  - Requirements: 1.1

## 6. Testing

### 6.1 Unit

- [ ] Test getOrCreate idempotency and workspace provisioning
  - Requirements: 6.1
- [ ] Test push idempotency (`op_id`) and replay behavior
  - Requirements: 6.1
- [ ] Test LWW merge edge cases and HLC tie-breaks
  - Requirements: 6.1
- [ ] Test pull pagination and next cursor computation
  - Requirements: 6.1
- [ ] Test GC eligibility rules
  - Requirements: 6.1

### 6.2 Integration

- [ ] Test `/api/sync/push` through `/api/sync/pull` cycle
  - Requirements: 6.2
- [ ] Test `/api/sync/update-cursor` behavior
  - Requirements: 6.2
- [ ] Test `/api/workspaces/*` CRUD through sqlite store
  - Requirements: 6.2

### 6.3 Package validation

- [ ] Run `bun run type-check`
  - Requirements: 6.3
- [ ] Run `bun run test`
  - Requirements: 6.3
- [ ] Run `bun run build`
  - Requirements: 6.3

## 7. Docs and Handoff

- [ ] Finalize README with config, migration, backup, and troubleshooting
  - Requirements: 7.1
- [ ] Add intern quickstart order and known gotchas
  - Requirements: 7.2
- [ ] Add compatibility note vs Convex behavior
  - Requirements: 4.1, 4.2

