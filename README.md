# or3-provider-sqlite

SQLite sync and workspace store provider for OR3 Chat. Provides a lightweight, self-hosted alternative to Convex for SSR cloud mode.

## What it provides

- **AuthWorkspaceStore** (`sqlite`) — user identity mapping, workspace CRUD, role resolution
- **SyncGatewayAdapter** (`sqlite`) — push/pull sync, consistent materialized snapshot pages, LWW conflict resolution, and cursor tracking
- **ConnectStore** (`sqlite`) — durable, atomic device enrollment and connected-computer records for OR3 Connect
- **WebhookStore** (`sqlite`) — durable webhook registrations and delivery logs (local, Bun, and Turso runtimes)
- **Admin stores** (`sqlite`) — workspace access/lifecycle, workspace settings, user search, and deployment-admin grants (local, Bun, and Turso runtimes)
- **RateLimitProvider** (`sqlite`) — durable rate-limit counters

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
| Bun | `bun` | `OR3_SQLITE_DB_PATH` | None; uses built-in `bun:sqlite` |
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

1. Initializes the SQLite database (creates file if needed)
2. Runs schema migrations automatically
3. Registers `AuthWorkspaceStore` with ID `sqlite`
4. Registers `SyncGatewayAdapter` when SQLite sync is selected
5. Registers `ConnectStore` when SQLite Connect persistence is selected
6. Registers `WebhookStore` and the admin stores (workspace access, workspace
   settings, user search) — all runtimes except D1
7. Registers `RateLimitProvider` with ID `sqlite` and the sync admin adapter
8. Registers a durable `BackgroundJobProvider` with ID `sqlite`, so active chat
   and workflow jobs remain addressable across Nitro HMR/module reloads

Registration is skipped when `auth.enabled` is `false`, or when neither SQLite
sync, SQLite Connect, nor SQLite background jobs are selected (local-only mode).

### Schema

Ordered migrations create and evolve all tables:

- **001_init**: `users`, `auth_accounts`, `workspaces`, `workspace_members`
- **002_sync_tables**: `server_version_counter`, `change_log`, `device_cursors`, `tombstones`, plus materialized entity tables (`s_threads`, `s_messages`, etc.)
- **003–005**: workspace-scoped sync keys, invitations, and admin stores
- **006_sync_snapshots**: winning operation IDs plus immutable snapshot headers/items
- **009_or3_connect**: single-use device authorizations and connected computers
- **017_background_jobs**: durable job status, workflow snapshots, cancellation,
  inactivity timestamps, and worker leases

Additional migrations (007–008, 010–016) evolve device-cursor ownership,
upload intents, and Connect credential/lifecycle hardening and rate limits.

All tables use snake_case aligned with the sync wire format.

### Sync semantics

- **Push**: validates ops (including a 256 KB serialized payload ceiling per operation) → checks `op_id` idempotency → allocates contiguous `server_version` block → writes change_log → applies LWW to materialized tables → upserts tombstones for deletes
- **Pull**: returns ordered changes for `server_version > cursor` with limit/pagination, optional table filtering, `oldestRetainedVersion`, and `requiresSnapshot` when the cursor is behind retained history
- **Snapshot**: captures canonical live rows and current tombstones at one `highWatermark`, then serves immutable, keyset-paginated pages ordered by `(tableName, pk, kind)`. Notification live rows are filtered to the session user.
- **Cursor**: forward-only per-device cursor tracking
- **Retention safety**: tombstone and `change_log` GC is enabled only under the explicit `snapshot-v1` capability and deletes old revisions acknowledged by every registered device
- **Notifications**: push forces `payload.user_id` to the session user; foreign notification writes are rejected; pull/snapshot omit other users' rows

LWW conflict resolution: incoming wins when `clock` is higher, then when clocks are equal and `hlc` is lexicographically greater, then when `op_id` is greater. Tombstones use the same `(clock, hlc, op_id)` tuple. LWW losers return `applied: false` with the winning payload.

Local, Bun, and Turso runtimes use `BEGIN IMMEDIATE` transactions. D1 uses its
native atomic batch API for grouped writes.

### Workspace store

- `getOrCreateUser` — maps `(provider, provider_user_id)` to internal user (idempotent)
- `getOrCreateDefaultWorkspace` — creates first workspace + owner membership on initial login
- Full workspace CRUD with role-based access checks

## Backup

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

## Compatibility

- Works with multiple auth providers (`basic-auth`, `clerk`, or custom)
- Replaces `or3-provider-convex` for sync + workspace store functionality
- Provides OR3 Connect persistence without Convex for local, Bun, and Turso runtimes
- Does NOT provide storage — pair with `or3-provider-fs` for file storage

### Known differences vs Convex

- Single-process SQLite vs distributed Convex backend
- No real-time subscriptions (gateway polling only)
- Migrations run on boot, or on the first Worker request for D1; schema changes require restart

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
