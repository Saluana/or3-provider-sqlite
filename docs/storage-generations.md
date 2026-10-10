# Dormant immutable storage generations

## Status and scope

This is a trusted-server foundation, not an activated cleanup feature or a
qualification claim. `SqliteExternalStorageGenerationCoordinator` is deliberately
not registered on `SqliteSyncGatewayAdapter`. Neither adapter advertises the
external-generation capability. No existing upload, restore, or GC route calls
the coordinator, and the SQLite code never selects or removes filesystem bytes.

Migration 024 is a normal ordered migration containing empty lifecycle tables
and triggers. With no managed rows, existing canonical writers remain on their
legacy path. Development executes the migration only on disposable test
databases; this change does not perform a live migration or deploy a provider.
After activation, generation records cannot be deleted and migration rollback
must refuse a nonempty lifecycle table.

## Identity and publication

The current-head key is `(workspaceId, SHA-256 hash)`. Every generation has a
globally unique, permanent `generationId` and `storageId`, including after
deletion. The storage provider owns the immutable target and must bind its
namespace, workspace, hash, and generation in a verified publication receipt.
An API caller cannot choose an arbitrary existing path as a target.

The SQLite API accepts a bare 64-character hexadecimal SHA-256 digest or its
`sha256:`-prefixed form, case-insensitively. Returned hashes are lowercase bare
digests. Whitespace, NUL, unknown prefixes, and other encodings are rejected.
Well-formed MD5 source references remain unmanaged legacy references; MD5 cannot
be registered as a managed generation. Proofs and SQL barriers share exactly
the same hash grammar rather than reusing the broader legacy normalization.

`registerVerifiedGeneration` is trusted input: it must receive an independently
verified, durable filesystem publication receipt, never an authenticated user's
unverified assertion. For a new head it refuses adoption if the hash or target
already has live or tombstoned metadata/references. Ambiguous or over-budget
legacy state also prevents registration. A verified head cannot be replaced.
After the previous head is irreversibly claimed, a distinct verified generation
can become current without changing the previous generation's identity/state.

The test-only publication sequence is immutable FS allocation, verified durable
publication, then transactional registration. An unpublished/unregistered slot
has no authoritative SQLite claim and cannot be removed by this protocol.
While a replacement is being published, the old claimed head continues to reject
restoration/reference creation; registration atomically installs the new head.
This intentionally does not reuse the legacy hash-only upload-intent route.

## Claim and canonical admission

`claimGeneration` starts its own `BEGIN IMMEDIATE` transaction, checks the exact
SQL of every required guard, and proves that the current generation has no live
metadata, message/post reference, or active legacy upload intent. It checks a
nonnegative safe-integer retention interval against SQLite server epoch seconds.
Client `updated_at` values never determine eligibility. Expired active-intent
expiry is an additional retention floor. Any clock regression fails closed.

Proof work is conservative and bounded: at most 1,000 metadata rows, 1,000 total
message/post rows, 1,000 active intents, 10,000 total reference edges, 1,000 edges
per row, and 256 KiB of JSON per inspected source. Row budgets count rows even
without attachments and tombstones, before filtering for relevance. Crossing a
aggregate row/edge bound returns `proof_incomplete`; malformed or unsupported per-row state returns
`unknown_references`. Large workspaces require a separately reviewed indexed
proof projection or revised budget before useful cleanup is possible.

Claims never expire or reopen. Replaying the same claim is idempotent; a different
claim cannot take its place. `completeDeletion` acknowledges an independently
verified exact-generation removal, preserves the claim, and never updates a
newer head. Permanent claims and identities survive retries and process restarts.

DB triggers cover raw and server-authored INSERT/UPDATE/DELETE/REPLACE operations
on `s_file_meta`, `s_messages`, `s_posts`, and active `upload_intents`. Source-first
references may pin a verified current head without requiring metadata first.
Claimed/deleted heads reject references/restores; metadata must match the verified
head's exact storage target and size. Ambiguous identities, duplicate/NUL-bearing
JSON keys, malformed reference lists, and hash aliases fail closed. Missing or
JSON-null `file_hashes` means no attachments, matching canonical message format.

OLD and NEW reference changes restart retention under the writer's lock, including
removal, tombstoning, workspace moves, and replacement by an attachment-free row.
BEFORE INSERT observes overwritten rows even with `recursive_triggers=OFF`.
This is necessary because SQLite's REPLACE conflict handler can suppress DELETE
triggers on old connections. Permanent generation/target reuse has its own BEFORE
INSERT guard. See [SQLite conflict behavior](https://www.sqlite.org/lang_conflict.html).

## Durable authority, including reads

All coordinator operations, including `getGeneration` used as destruction
authority by a test-only filesystem helper, require a native local connection,
file-backed WAL, `synchronous=FULL` or `EXTRA`, and `foreign_keys=ON`. The connection
must positively report that no enclosing transaction exists. A nested savepoint
could expose a claim that an outer rollback later removes, so it is rejected.
Missing or modified guard SQL also fails closed even with a current migration
ledger. These checks do not alter operator pragmas or change provider defaults.

The ordinary provider default is WAL with NORMAL synchronous mode. It remains
unchanged and does **not** qualify for generation-authorized deletion. SQLite
documents that FULL syncs each WAL commit, whereas NORMAL may lose a committed
transaction after power loss. See [SQLite synchronous guarantees](https://www.sqlite.org/pragma.html#pragma_synchronous)
and [write serialization](https://www.sqlite.org/isolation.html).

Better-sqlite3 and Bun native connections are implemented; D1 and Turso/libSQL
explicitly refuse this coordinator. Native API support and tests are not a
deployment/storage-stack durability qualification. FS receipts must also prove
file and directory fsync ordering for publication/removal.

## Test evidence and remaining activation blockers

The provider suite uses real file-backed SQLite with FULL, including independent
worker connections. It covers writer-wins and claim-wins lock interleavings,
metadata restoration, old raw writers, source-first references, unsafe durability,
outer transactions, guard tampering, JSON alias attacks, permanence, retention,
interrupted uncommitted claims, committed retry after reopening, and stale claim
completion after a replacement. Production sync push and server-authored
background-history admission tests verify full rollback of rows, version/log
allocations, receipts, and webhook emission on guard failure.

Before any capability advertisement or runtime deletion, separately qualify:

- Authorized workspace dispatch, trusted receipt verification and strict paired
  provider identity. Direct class imports are not a public API security boundary.
- Generation-aware authenticated upload admission/quota reservations and safe
  abandoned-publication recovery; legacy hash-only reservations stay blocked
  after a claim and cannot silently create a replacement generation.
- Integrated immutable filesystem namespace, multi-process publication/removal,
  crash/retry handling, directory/file durability, and bounded inventory.
- Backup/restore of DB barriers together with their corresponding filesystem
  namespace. Restoring an older DB must not revive authority over removed bytes.
- Rollout and mixed-version DB writers, schema/guard integrity, large-workspace
  proof costs, and explicit future migration of legacy storage. Administrative
  DDL/trigger removal or unmanaged modification of lifecycle tables is outside
  the supported writer protocol and cannot be treated as safe maintenance.
- The deployed local filesystem/SQLite VFS and hardware power-loss guarantees.
  Process-crash tests alone do not prove power-loss durability.

Until these are qualified together, physical cleanup remains disabled.
