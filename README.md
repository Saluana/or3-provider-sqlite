# or3-provider-sqlite

SQLite sync and workspace store provider for OR3 Chat. Provides a lightweight, self-hosted alternative to Convex for SSR cloud mode.

Requires **Node.js 24.22.1 or newer on the 24.x line**, matching OR3 Chat. Development and CI pin **24.22.1** in `.node-version`.

## What it provides

- **AuthWorkspaceStore** (`sqlite`) — user identity mapping, workspace CRUD, role resolution
- **SyncGatewayAdapter** (`sqlite`) — push/pull sync, consistent materialized snapshot pages, LWW conflict resolution, cursor tracking, and canonical background-generation history on synchronous SQLite runtimes
- **ConnectStore** (`sqlite`) — durable, atomic device enrollment and connected-computer records for OR3 Connect
- **WebhookStore** (`sqlite`) — durable webhook registrations and delivery logs (local, Bun, and Turso runtimes)
- **Admin stores** (`sqlite`) — workspace access/lifecycle, workspace settings, user search, and deployment-admin grants (local, Bun, and Turso runtimes)
- **RateLimitProvider** (`sqlite`) — durable rate-limit counters

SSR-authenticated deployments also activate SQLite when it is selected only by
`OR3_LIMITS_ENABLED=true` and `OR3_LIMITS_STORAGE_PROVIDER=sqlite`, independently
of the account workspace backend.

Canonical storage queries include bounded retained deleted metadata pages and
advertise `retainedStorageMetadata: 'v1'` on native SQLite and D1. Missing sizes in
delete-before-put rows remain unknown; these reads never replay sync history.

Upload quota admission groups unexpired pending authorizations by hash and
reserves atomically on native SQLite and D1. Migration 027 replaces the
metadata-derived charges from migration 026 with persisted, verified consumed
upload receipts. Client-authored file sizes cannot create retained charges.
Trash, logical deletion and receipt replay expiry do not release verified
charges; restoring the same hash does not double-charge it. A larger upload
reserves the difference above its verified retained size.

Pre-receipt files and raw incomplete uploads are outside this verified ledger;
metadata alone cannot prove their physical size. Existing consumed receipts are
retained and reconciled during upgrade. Physical filesystem/S3 GC remains
disabled. The provider advertises `atomicUploadQuota: 'retained-v1'`; configure
`OR3_STORAGE_WORKSPACE_QUOTA_BYTES` to enforce a quota (the default is unlimited).

Migrations 027–028 are forward-only. Keep a pre-upgrade database backup;
rolling back the provider requires restoring that snapshot because the old
adapter expects the previous device-cursor unique key.

`watchVersion` shares one indexed workspace version-counter read every two
seconds per workspace per process across notification listeners. The host can
wake its ordinary sync pull immediately when the counter changes and use a
one-minute safety pull while connected. Last-listener teardown stops the timer;
unsupported notification routes retain normal gateway polling.

Background chat admissions emit the existing thread and user-message create hooks after commit when those rows are newly created. Replayed admissions do not emit them again; hook delivery failures do not fail admission.

## Atomic webhook registration quotas

The webhook store advertises `registrationLimit: 'atomic-v1'`. `createWebhook(input, limit)` checks the user/workspace quota (or instance-wide admin quota) in the same immediate transaction as insertion. Independent connections share the limit; exhaustion throws `WEBHOOK_LIMIT_EXCEEDED`. The optional argument leaves non-quota internal calls unchanged. OR3 Chat requires this capability for registration; ship this provider change before integrating the coordinated host change.

## Install

```bash
bun add or3-provider-sqlite
```

Add to your provider module list (e.g. `or3.providers.generated.ts`):

```ts
export default ['or3-provider-sqlite/nuxt'];
```

## Native runtimes and configuration

`better-sqlite3` remains the default, so existing local-file installations do
not need to change. Set `OR3_SQLITE_DRIVER` only when selecting another native
runtime.

| Runtime | `OR3_SQLITE_DRIVER` | Required configuration | Extra install |
|---|---|---|---|
| Local Node (default) | `better-sqlite3` | `OR3_SQLITE_DB_PATH` | `better-sqlite3` |
| Bun | `bun` | `OR3_SQLITE_DB_PATH` | None for sync; uses built-in `bun:sqlite` |
| Turso/libSQL | `turso` | `OR3_SQLITE_TURSO_URL`, `OR3_SQLITE_TURSO_AUTH_TOKEN` | `libsql` |
| Cloudflare D1 | `d1` | `OR3_SQLITE_D1_BINDING` (defaults to `DB`) | None; uses the Worker binding |

### Local Node (existing default)

```bash
OR3_SQLITE_DB_PATH=/data/or3-sync.db
OR3_SQLITE_PRAGMA_JOURNAL_MODE=WAL
OR3_SQLITE_PRAGMA_SYNCHRONOUS=NORMAL
```

### Bun

```bash
OR3_SQLITE_DRIVER=bun
OR3_SQLITE_DB_PATH=/data/or3-sync.db
```

OR3 Chat's source launcher (`bun run dev:ssr`) selects Bun when this provider
uses the Bun driver, including when only the auth workspace store is active.
Use the Bun version pinned in the host's `package.json`. The launcher checks
the built-in driver and required native bindings before Nuxt starts. Run a
built Bun-configured server with `bun .output/server/index.mjs`.

Basic Auth still uses a separate `better-sqlite3` database; its native binding
must also be compatible with Bun. The managed Cloud image uses Node and the
default `better-sqlite3` sync driver.

### Turso/libSQL

```bash
bun add libsql
```

```bash
OR3_SQLITE_DRIVER=turso
OR3_SQLITE_TURSO_URL=libsql://your-database.turso.io
OR3_SQLITE_TURSO_AUTH_TOKEN=your-server-only-token
```

### Cloudflare D1

Run the application in a Cloudflare Worker that already has a D1 binding, then
set its binding name:

```toml
[[d1_databases]]
binding = "DB"
database_name = "or3"
database_id = "your-database-id"
```

```bash
OR3_SQLITE_DRIVER=d1
OR3_SQLITE_D1_BINDING=DB
```

The provider initializes D1 and applies pending migrations on the first Worker
request, which keeps D1 I/O inside Cloudflare's request context.

For D1, use Workers-compatible auth and storage providers. The local Basic
Auth and filesystem providers depend on Node-native local storage and are not
Workers-compatible. OR3 Connect with D1 throws at startup, persistent webhooks
are not registered (a warning is logged), and server-side admin stores are
registered with all capabilities disabled; the install wizard reports these
boundaries explicitly.

`OR3_SQLITE_PRAGMA_*`, `OR3_SQLITE_ALLOW_IN_MEMORY`, and
`OR3_SQLITE_STRICT` apply only to local-file runtimes. The Turso auth token is
server-only and must not be exposed through public runtime configuration.

| Variable | Default | Notes |
|---|---|---|
| `OR3_SQLITE_PRAGMA_JOURNAL_MODE` | `WAL` | better-sqlite3 and Bun only |
| `OR3_SQLITE_PRAGMA_SYNCHRONOUS` | `NORMAL` | better-sqlite3 and Bun only |
| `OR3_SQLITE_ALLOW_IN_MEMORY` | unset | required to run on `:memory:` outside tests; data is lost on restart |
| `OR3_SQLITE_STRICT` | unset | forbids `:memory:`; requires `OR3_SQLITE_DB_PATH` |

`OR3_SQLITE_DB_PATH` is required in non-test environments unless
`OR3_SQLITE_ALLOW_IN_MEMORY=true`; otherwise startup fails with a clear error.

OR3 Connect uses the same database with local, Bun, or Turso runtimes:

```bash
OR3_CONNECT_ENABLED=true
OR3_CONNECT_PROVIDER=sqlite
```

## How it works

### Registration

On server startup, the Nitro plugin:

1. Registers `AuthWorkspaceStore` with ID `sqlite`
2. Registers `SyncGatewayAdapter` when SQLite conversation transfer is enabled
3. Registers `ConnectStore` when SQLite Connect persistence is selected
4. Registers `WebhookStore` on runtimes other than D1, and the admin store
   provider (D1 declares server-side admin capabilities unavailable)
5. Registers `RateLimitProvider` with ID `sqlite` and the sync admin adapter
6. Registers a durable `BackgroundJobProvider` with ID `sqlite`, so active chat
   and workflow jobs remain addressable across Nitro HMR/module reloads
7. Initializes the database and runs schema migrations eagerly on local
   runtimes, or on the first Worker request for D1

Registration is skipped when `auth.enabled` is `false`, or when SQLite is not
selected for account workspaces, Connect or background jobs. Account workspaces
use `sync.provider` even with `sync.enabled=false`; disabling conversation
transfer does not disable the workspace store. The sync gateway remains
unregistered while transfer is disabled.

Workspace-only account storage requires `or3-provider-sqlite@0.0.12` or later.
Version `0.0.11` skips workspace-store registration when sync, Connect and
background jobs are all disabled, causing Chat to exit before listening.
Upgrade the provider; conversation transfer can remain disabled.

SQLite background jobs also persist mixed-runtime tool handoffs. Browser-only
calls are atomically claimed and settled in `execution_json`; parked calls are
excluded from worker claims until their browser result makes the job runnable.
Parked handoffs have a separate global and per-user admission cap, so they do
not consume active worker slots or grow without bound.

### Schema

Ordered migrations create and evolve all tables:

- **001_init**: `users`, `auth_accounts`, `workspaces`, `workspace_members`
- **002_sync_tables**: `server_version_counter`, `change_log`, `device_cursors`, `tombstones`, plus materialized entity tables (`s_threads`, `s_messages`, etc.)
- **003–005**: workspace-scoped sync keys, invitations, and admin stores
- **006_sync_snapshots**: winning operation IDs plus immutable snapshot headers/items
- **009_or3_connect**: single-use device authorizations and connected computers
- **017_background_jobs**: durable job status, workflow snapshots, cancellation,
  inactivity timestamps, and worker leases
- **018–020**: durable pre-admission cancellation, reasoning/generation history
  phases, and idempotent canonical generation-write receipts

Background-job claims reset text and iteration progress back to the durable
checkpoint when reclaiming an expired lease, matching the memory/Convex recovery
contract. The provider implements `findJobByIdempotencyKey`, which lets the
server cancel an admission before the client has received its job ID.

Additional migrations (007–008, 010–016) evolve device-cursor ownership,
upload intents, and Connect credential/lifecycle hardening and rate limits.

All tables use snake_case aligned with the sync wire format.

### Sync semantics

- **Push**: validates ops (including a 256 KB serialized payload ceiling per operation) → checks `op_id` idempotency → allocates contiguous `server_version` values for admitted change-log entries → applies LWW to materialized tables → upserts tombstones for deletes. D1 admission and version allocation share one atomic batch; rejected notification races consume no versions.
- **Pull**: returns ordered changes for `server_version > cursor` with limit/pagination, optional table filtering, `oldestRetainedVersion`, and `requiresSnapshot` when the cursor is behind retained history
- **Snapshot**: captures canonical live rows and current tombstones at one `highWatermark`, then serves immutable, keyset-paginated pages ordered by `(tableName, pk, kind)`. Notification live rows are filtered to the session user.
- **Cursor**: forward-only tracking per authenticated user and device within a workspace. Migration 028 changes the unique key so accounts sharing a browser device ID cannot claim each other’s acknowledgements. Legacy unowned rows are never adopted and expire through normal cursor GC.
- **Retention safety**: tombstone and `change_log` GC is enabled only under the explicit `snapshot-v1` capability and deletes old revisions acknowledged by every registered device
- **Notifications**: push forces `payload.user_id` to the session user on puts and deletes; foreign notification writes are rejected. Successful deletes remain visible to the owner's other devices while pull/snapshot omit other users' rows.
- **Workspace Files/Trash admission**: a client without `workspaceItemCapability: 'v1'` cannot replace or delete a canonical post/project carrying workspace Files/Trash semantics, even if the submitted payload omits those fields. Native write transactions and the D1 atomic batch check canonical state before any operation or version allocation; a rejected batch returns HTTP 426 and leaves sibling writes unchanged.

Snapshot continuations are bound to the capturing user and workspace, including
backup snapshots. Each user retains at most four copies per workspace across
both modes. A newer capture can supersede the oldest chain; expired,
superseded, and pre-upgrade tokens return HTTP 410 and require a fresh capture.
Copies expire after one hour. Native runtimes prune expired copies at startup
and every minute; D1 prunes on requests at most once per minute. Deleting a
snapshot also removes its copied items.
If a D1 snapshot is evicted while a page is being read, that request also returns
HTTP 410 instead of acknowledging a truncated final page.

LWW conflict resolution: incoming wins when `clock` is higher, then when clocks are equal and `hlc` is lexicographically greater, then when `op_id` is greater. Tombstones use the same `(clock, hlc, op_id)` tuple. LWW losers return `applied: false` with the current winner as either `{ kind: 'put', payload, revision }` or `{ kind: 'delete', revision, serverDeletedAt? }`. Idempotent `op_id` retries return `replayed: true` and, if superseded, the current winner. A replay does not allocate another server version.

Local, Bun, and Turso runtimes use `BEGIN IMMEDIATE` transactions. D1 uses its
native atomic batch API for grouped writes.

Canonical background generation history is advertised by the local, Bun, and
Turso adapters. It writes admission rows, contiguous change-log versions,
materialized state, and the receipt in one transaction, then commits a terminal
snapshot only if its generation still owns the assistant row. D1 does not
advertise this versioned capability, so background chat admission fails before
model execution there; ordinary sync and other D1 features are unchanged.

### Workspace store

- `getOrCreateUser` — maps `(provider, provider_user_id)` to internal user (idempotent)
- `getOrCreateDefaultWorkspace` — creates first workspace + owner membership on initial login
- Full workspace CRUD with role-based access checks

## Backup

Workspace archives use `backupSnapshot` to include retained Trash file metadata
and originals. Normal sync snapshots continue to emit tombstones. Archive pages
share a frozen SQLite/D1 transaction snapshot and reject tokens from another
snapshot mode. Backup reads do not remove originals or unfinished uploads.

For local-file and Bun runtimes, everything lives in a single SQLite file:

```bash
# While the app is running (WAL mode supports this)
sqlite3 /data/or3-sync.db ".backup /backup/or3-sync-$(date +%s).db"
```

Use Turso or Cloudflare's own backup/export facilities for their managed
databases.

## Development

```bash
bun install
bun run test        # run unit tests
bun run type-check  # TypeScript validation
bun run build       # build for distribution
```

The normal test suite runs in a provider-only checkout using hash-verified,
byte-for-byte host runtime fixtures. `bun run test:host-integration` reruns the
same background-job, canonical-history and registration cases against a prepared
sibling `../or3-chat` at the exact reviewed source tree. It fails on missing or
mismatched source rather than falling back to fixtures. See the
[fixture provenance and prerequisites](test/fixtures/host/README.md).

## Compatibility

- Works with multiple auth providers (`basic-auth`, `clerk`, or custom)
- Replaces `or3-provider-convex` for sync + workspace store functionality
- Provides OR3 Connect persistence without Convex for local, Bun, and Turso runtimes
- Does NOT provide storage — pair with `or3-provider-fs` for file storage

### Known differences vs Convex

- Single-process SQLite vs distributed Convex backend
- Gateway version notifications use a shared counter poll; no native reactive SQLite subscription
- Migrations run on boot, or on the first Worker request for D1; schema changes require restart

## Admin maintenance

**Operations → Maintenance** labels the history tools **Clear old sync history**
(`sync.gc-change-log`) and **Clear old deletion history** (`sync.gc-tombstones`).
Descriptions explain the retention period and active-device requirements without
internal terminology. They wrap fully on narrow screens. These tools preserve
current chats and files; they do not empty Trash or remove stored files.

## Troubleshooting

- **`OR3_SQLITE_DB_PATH is required in non-test environments`** — set a file
  path, or pass `OR3_SQLITE_ALLOW_IN_MEMORY=true` only for ephemeral storage.
- **`OR3_SQLITE_STRICT=true forbids in-memory SQLite`** — the two settings
  cannot be combined; set `OR3_SQLITE_DB_PATH`.
- **`Unsupported OR3_SQLITE_DRIVER value`** — use `better-sqlite3`, `bun`,
  `turso`, or `d1`.
- **`Unable to load better-sqlite3`** — install `better-sqlite3`, or select
  another driver via `OR3_SQLITE_DRIVER`.
- **`OR3_SQLITE_TURSO_URL` / `OR3_SQLITE_TURSO_AUTH_TOKEN` required** — both
  must be set when `OR3_SQLITE_DRIVER=turso`, and `libsql` must be installed.
- **`Cloudflare D1 binding "…" was not found`** — set `OR3_SQLITE_D1_BINDING`
  to the binding name declared in your Worker's `wrangler.jsonc`.
- **`Cloudflare D1 supports Auth and Sync, but OR3 Connect still requires a
  synchronous SQLite runtime`** — Connect is unavailable with D1; set
  `OR3_CONNECT_ENABLED=false` or switch to better-sqlite3, Bun, or Turso.
- **`OR3_SQLITE_DRIVER=bun requires Bun`** — the Bun driver only runs under
  the Bun runtime with its built-in `bun:sqlite`.

### Atomic workspace settings

The workspace settings store implements `compareAndSet(workspaceId, key, expectedValue, nextValue)` atomically. A `null` expected value means the key must be absent; a conflict returns `false` without overwriting it. The host uses this for concurrent plugin setup saves, bulk plugin enablement and permission review, and persistent AI spend reservations. A provider without this operation cannot safely run a bulk plugin rollout. A slow plugin write may outlive the HTTP response: the host reports pending after eight seconds and keeps the plugin lock until the atomic operation settles.


### Testing local changes in OR3 Chat

With this repository beside `or3-chat`, run `bun install` here once, then
`bun run dev:ssr` from Chat. Chat's dev wrapper rebuilds the local provider and
prints its selected path; restart it after provider edits. Missing repositories
or failed builds fall back to installed packages with a warning.
`OR3_LOCAL_PROVIDERS=false` disables local selection. Production builds use the
installed package, so local development does not publish these changes.

### Canonical compaction history reader (unreleased)

`canonicalChatHistory: 'v1'` and `readChatHistory` read current `s_threads`/`s_messages`, with explicit workspace membership (owner/editor/viewer), bounded by-ID queries and canonical `(index, order_key, id)` keyset pages. Migration 022 adds transactional per-thread revision triggers. Migration 023 matches the index to legacy missing-order-key normalization and preserves the existing orphan-row cleanup lifecycle; revision bookkeeping does not add a foreign key to otherwise independent sync rows. Current-chat tool result writes do not invalidate ancestor search cursors. The reader never consults retained sync logs. D1 omits the capability.

The additive local qualification command is `bun run build` followed by `bunx vitest run --config vitest.canonical-history.config.ts`. It checks committed current host contract bytes without replacing the older pinned fixture. The current-host lane passes 119 cases across three files, including the real gateway owner and source-built artifact reads after change-log deletion, legacy tie paging in both directions, bounded queries, revision changes, cancellation, revoked membership and an index plan without a temporary sort. These checks do not qualify a deployed rollout, second-client/background reconciliation or released pins. This compaction capability is not yet included in a published package.

The canonical-history qualification lane defaults to a sibling `../or3-chat` checkout. For an isolated host worktree, set `OR3_CANONICAL_HOST_ROOT=/absolute/path/to/or3-chat` before the command. Install the host dependencies too; the two-client fixture resolves its IndexedDB test dependency from that checkout. Its contract-byte checks fail closed on uncommitted changes; this does not replace the pinned host fixture or certify deployed/released provider behavior.

## Workspace Files and Trash admission

Persistent Projects uses this same capability for opaque `or3:project-settings`, `or3:project-memory`, and `or3:project-source` posts. Preserve their JSON, metadata, and every original/extraction `file_hashes` reference. The project-aware canonical reader resolves `threads.project_id` or a single legacy membership in its authorized SQLite snapshot, returning `project_ownership: resolved | conflict`. String entries and JSON-encoded membership arrays remain supported; chat IDs are trimmed and entry kinds ignore case and surrounding whitespace, matching the host's legacy normalization. Malformed or ambiguous memberships do not grant server execution. Hosts without this result must refuse project-sensitive server admission rather than infer ownership from the visible UI.

Explicit ownership requires a live project in the same workspace. A missing or deleted project releases the chat even if a concurrent thread write retained its former pointer; legacy folders do not override that explicit release. Canonical reads leave the persisted pointer untouched.

Current hosts refuse server tools and workflows when the reader cannot return
resolved canonical ownership. Older providers require an upgrade even for chats
with no explicit project pointer, because legacy folder membership may own them.

Version 0.0.15 declares `projectOwnership: 'v1'` on the native canonical-history adapter. D1 does not advertise this contract. Projects qualification: `OR3_PROJECT_HOST_ROOT=/absolute/path/to/or3-chat bun x vitest run src/runtime/__tests__/sqlite-sync-gateway-adapter.test.ts`. This explicit lane uses the host's canonical-reader query contract while retaining the pinned standalone fixture for existing contracts. Qualify the published exact version with the disposable host cloud journey.

Native synchronous adapters advertise workspace-item capability v1. Canonical
posts/projects with catalog, logical Trash, or file-membership semantics require
a current writer even when the incoming update omits those fields. Admission is
checked inside the same write transaction, before versions or changes are
allocated. Canonical retained post references include logically trashed catalog
entries/documents and checkpoints. D1 does not advertise this transactional
capability.

This source change is a provider publication dependency for the host feature.
Rebuild the provider before testing a file-linked host; follow the existing OR3
release/update workflow separately. Local qualification does not authorize
publication or a production migration. Files cloud exposure remains gated until
the supported profile is qualified.

## Instance signup invitations

The updated host distinguishes signup invites from existing team invites. Signup invites create a private workspace with only the recipient as owner; team invites retain their selected workspace and role. This requires the updated host and rebuilt provider artifacts, rather than the existing published release alone.

Native SQLite implements five optional AuthWorkspaceStore methods with one additive signup_invites migration and one immediate acceptance transaction. User, identity mapping, recipient-only workspace membership, active pointer, and acceptance receipt commit together. Replay performs no provisioning writes. D1 deliberately does not advertise these methods. Dates are milliseconds; history pages contain at most 100 rows without hashes, with 90-day terminal retention and cleanup capped at 100 records per create/list call.

### Short signup codes

New signup invitations use eight random characters (shown as `K7MP-4X9Q`) and retain clickable invite links. Lowercase, spaces, and an optional dash are accepted. The host hashes codes with HMAC using `OR3_AUTH_INVITE_TOKEN_SECRET`, shares a 20/minute/IP lookup limit across invitation entry points, and preserves email binding, expiry, revocation, and atomic single use. Previously issued signed links remain supported. Codes and hashes are omitted from invitation history.

`findSignupInviteByTokenHash` resolves pending proofs through the existing unique `token_hash` index and returns only ID, email, and expiry to the host. No new migration is required. D1 continues to omit signup invitation capabilities.

## Dashboard restart drain accounting

The background provider implements `getShutdownBlockerCount`: streaming jobs
(including browser-tool handoffs and workflows), pending admission and terminal
history delivery prevent replacement. Database failures propagate so the host
cancels preparation and restores admission rather than treating failure as idle.
An additive covering index migration keeps counts off stored response bodies.

Admin workspace summaries, workspace details, and deployment-admin lists expose `createdAt` in Unix milliseconds for the host UI. SQLite continues to store the underlying creation timestamps in Unix seconds; no data migration is needed.

## Dormant immutable-generation foundation (unreleased)

Migration 029 adds inert generation records, current-hash heads, and canonical write barriers after the released migrations. No runtime route creates these records, no adapter advertises `externalStorageGenerations`, and physical cleanup remains disabled. See [protocol invariants and activation blockers](docs/storage-generations.md).
