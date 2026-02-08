# or3-provider-sqlite

SQLite sync and workspace store provider for OR3 Chat. Provides a lightweight, self-hosted alternative to Convex for SSR cloud mode.

## What it provides

- **AuthWorkspaceStore** (`sqlite`) — user identity mapping, workspace CRUD, role resolution
- **SyncGatewayAdapter** (`sqlite`) — push/pull sync with LWW conflict resolution, cursor tracking, GC

## Install

```bash
bun add or3-provider-sqlite
```

Add to your provider module list (e.g. `or3.providers.generated.ts`):

```ts
export default ['or3-provider-sqlite/nuxt'];
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OR3_SQLITE_DB_PATH` | Yes (non-test) | None | Path to SQLite database file |
| `OR3_SQLITE_PRAGMA_JOURNAL_MODE` | No | `WAL` | SQLite journal mode |
| `OR3_SQLITE_PRAGMA_SYNCHRONOUS` | No | `NORMAL` | SQLite synchronous pragma |
| `OR3_SQLITE_ALLOW_IN_MEMORY` | No | `false` | Allow `:memory:` in non-test environments (ephemeral data) |
| `OR3_SQLITE_STRICT` | No | `false` | Fail startup if `:memory:` is used |

### Production example

```bash
OR3_SQLITE_DB_PATH=/data/or3-sync.db
OR3_SQLITE_PRAGMA_JOURNAL_MODE=WAL
OR3_SQLITE_PRAGMA_SYNCHRONOUS=NORMAL
```

## How it works

### Registration

On server startup, the Nitro plugin:

1. Initializes the SQLite database (creates file if needed)
2. Runs schema migrations automatically
3. Registers `AuthWorkspaceStore` with ID `sqlite`
4. Registers `SyncGatewayAdapter` with ID `sqlite`

Registration is skipped when `auth.enabled` is `false` (local-only mode).

### Schema

Two migrations create all tables:

- **001_init**: `users`, `auth_accounts`, `workspaces`, `workspace_members`
- **002_sync_tables**: `server_version_counter`, `change_log`, `device_cursors`, `tombstones`, plus materialized entity tables (`s_threads`, `s_messages`, etc.)

All tables use snake_case aligned with the sync wire format.

### Sync semantics

- **Push**: validates ops → checks `op_id` idempotency → allocates contiguous `server_version` block → applies LWW to materialized tables → writes change_log → upserts tombstones for deletes
- **Pull**: returns ordered changes for `server_version > cursor` with limit/pagination and optional table filtering
- **Cursor**: forward-only per-device cursor tracking
- **GC**: tombstone and change_log cleanup respects min device cursor + retention window

LWW conflict resolution: incoming wins when `clock` is higher, or when clocks are equal and `hlc` is lexicographically greater.

Push uses `BEGIN IMMEDIATE` transactions to prevent concurrent server_version races.

### Workspace store

- `getOrCreateUser` — maps `(provider, provider_user_id)` to internal user (idempotent)
- `getOrCreateDefaultWorkspace` — creates first workspace + owner membership on initial login
- Full workspace CRUD with role-based access checks

## Backup

Since everything lives in a single SQLite file:

```bash
# While the app is running (WAL mode supports this)
sqlite3 /data/or3-sync.db ".backup /backup/or3-sync-$(date +%s).db"
```

## Development

```bash
bun install
bun run test        # run unit tests
bun run type-check  # TypeScript validation
bun run build       # build for distribution
```

## Compatibility

- Works with any auth provider (`basic-auth`, `clerk`, or custom)
- Replaces `or3-provider-convex` for sync + workspace store functionality
- Does NOT provide storage — pair with `or3-provider-fs` for file storage

### Known differences vs Convex

- Single-process SQLite vs distributed Convex backend
- No real-time subscriptions (gateway polling only)
- Migrations run on boot; schema changes require restart
