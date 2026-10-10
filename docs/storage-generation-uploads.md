# Dormant generation upload and restore reservations

## Scope

Migration 025 and `SqliteExternalStorageGenerationUploadCoordinator` extend the
test-only trusted-server generation foundation. There is no production registry
entry, capability advertisement, route registration, deployment, live migration,
or enabled garbage collector. The original v1 generation states remain exactly
`verified`, `claimed`, and `deleted`. An unpublished allocation is never exposed
as a verified generation or as v1 deletion authority.

The host contract is `server/storage/gateway/generation-upload.ts`. Owner-bound
methods require trusted callers to authenticate the current user and authorize
workspace access; a caller-supplied `userId` alone is not authorization. Filesystem
namespace, target, readiness and byte-verification receipts must come from the
paired storage provider, never from an untrusted upload request.

## Reservation and quota handoff

An upload-origin binding permanently owns its intent, generation and immutable
target identities. Registration does not adopt existing legacy metadata or
references. New generations are permitted only when the current head is absent
or already irreversibly claimed/deleted; a verified head cannot be overwritten.
The whole workspace/hash is enrolled as soon as the binding is committed, before
filesystem allocation. Old raw metadata/reference writers cannot fill this gap
with a legacy binding. Historical enrollment persists after abandonment, and
unbound calls to the older `registerVerifiedGeneration` cannot bypass it.

The lifecycle is:

1. `reserved`: durable identity and quota charge; no deletion authority.
2. `ready`: independently verified durable ready-slot receipt. Upload credentials
   may be issued only while their original server-derived deadline is valid.
3. `published_pending_metadata`: verified filesystem publication and real
   generation/head registration commit atomically. The quota charge remains.
4. `materialized`: an exact live `s_file_meta` row transfers the charge in the
   canonical writer's transaction, together with its normal sync log/version work.

A separate server-time expiry in the binding limits credentials. The accounting
projection is an ordinary `upload_intents` row with an active charge and a
non-expiring accounting deadline (`Number.MAX_SAFE_INTEGER`). This deliberately
keeps charges visible to existing canonical quota readers and the older
`reserveUploadIntent` implementation. No deduplication creates a zero-charge
surviving intent: only one unresolved binding per workspace/hash is admitted.

Old consume, cancel, expiry, DELETE, identity-changing UPDATE, and REPLACE paths
cannot release or overwrite a bound charge. BEFORE INSERT guards protect against
REPLACE even when an older connection has recursive triggers disabled. Identity,
size, MIME, target and timestamps must exactly match the binding's current
projection. Exact intent/claim reads also verify the projection before returning.

Publication and quota transfer are not composed as two independently committed
coordinator calls. A deferred foreign key prevents a committed published binding
without its genuine generation record. Database guards require an enrolled
generation/head to have its exact bound publication authorization. Matching live
metadata triggers atomically change the binding to `materialized` and the shared
ledger to `consumed`. The existing exact immutable size/hash/storage-target guard
also rejects missing, duplicate, conflicting or malformed aliases.

Source-first sync remains supported while a persistent published charge is held.
Credential expiry and legacy cancellation cannot free that charge while messages
or posts still reference the generation before metadata arrives. Abandonment
must prove raw reference absence under the same SQLite writer lock.

## Restore tickets

`reserveGenerationRestore` creates a distinct owner-bound intent with
`purpose: 'restore'`. It derives the exact size, storage target, namespace, MIME,
and ready receipt from a materialized upload-origin binding and its current
verified generation. It allocates no generation, promotes no head, and authorizes
no byte upload. Mark-ready and byte-publication methods refuse restore intents.

A restore ticket starts with a persistent `published_pending_metadata` charge.
The existing canonical metadata insertion/resurrection consumes only this ticket
in the same transaction. Historical upload/restore bindings remain permanent and
idempotent; replaying them cannot reactivate a consumed charge. A new restoration
cycle needs a new ticket. Existing live metadata, claimed/deleted generations,
foreign identity, concurrent tickets, and insufficient quota are refused.

For enrolled targets, raw metadata restoration requires the pending ticket.
New source-first references after a metadata tombstone require either matching
live metadata or a persistent bound hold. Ticket expiry does not erase a charge
while such references remain. This is deliberately scoped to enrolled hashes;
unrelated unmanaged legacy writes retain their existing behavior.

The current client restore flow does **not** request this ticket before syncing
metadata. The dormant factory/API and tests establish the primitive; authenticated
client admission wiring and rollout remain activation blockers. No new client
roundtrip, sync wire field, or change-log/server-version semantics are silently
introduced here.

## Distinct abandonment and recovery authority

Only ready allocations or pending publications/restores can become
`abandon_claimed`, and only after credential expiry, server-time retention, and
bounded no-live-metadata/no-raw-reference/no-other-active-intent proofs. The
retention floor includes expiry, readiness, publication, and the real generation's
last canonical activity. Removing a source reference after credential expiry
therefore restarts retention. A lease/deadline never reopens a terminal claim.

If genuine publication already exists, the exact verified generation is claimed
under the **same transaction and claim identity** before the binding's charge
closes. A ready-only allocation instead receives distinct upload-abandonment
authority and never gets a fabricated verified generation. The filesystem helper
must use `getGenerationUploadClaim` and compare the complete immutable identity
and ready receipt before acting. Completion acknowledges independently proved
exact ready-payload removal and permanently records `abandoned`; a published
generation is marked deleted in the same transaction. A newer head is untouched.

Pre-ready or incomplete slots remain retained and reported. A paused allocator
can still resume initialization, so absence is not removal proof. A late trusted
ready receipt may make an expired slot recoverable, but cannot extend its
credential deadline. Until then the conservative pending count/charge remains.

Recovery listing uses opaque workspace/provider-scoped keyset cursors and bounded
scanned pages. A page can have no eligible observations and still have a next
cursor. Listings are observations, not deletion authorization; each destructive
step needs the exact qualified claim read.

## Bounds, compatibility and durability

- Credentials last at most 900 seconds; exact replay preserves the original
  deadline and immutable request, including TTL and quota decision.
- At most 128 unresolved bindings per workspace, including zero-byte and expired
  pre-ready allocations. Pending byte quota alone does not bound permanent slots.
- Quota/proof scans use the existing 1,000-row budgets and safe-integer aggregate
  checks. Oversized/ambiguous state fails closed rather than estimating capacity.
- Every method, including intent and claim reads, inherits file-backed WAL,
  FULL/EXTRA synchronous mode, foreign-keys, own-transaction and exact guard checks.
  D1 and Turso are refused. Operator defaults are not changed.
- Migration 024 remains reproducible. Migration 025 narrowly replaces its legacy
  active-intent guards with exact bound-projection exceptions and installs the
  additional barriers. Current integrity checks require both sets. Older compiled
  coordinators expecting the original SQL fail closed after this upgrade.

The quota guarantee is atomic upload/managed-restore admission and accounting
handoff, not an absolute workspace limit over arbitrary unmanaged raw metadata
writes. Legacy sync restores have never all gone through quota admission; this
tranche does not silently impose a workspace-wide policy cutover. Logical quota
also remains distinct from physical disk usage: retained payloads, incomplete
slots, and open unlinked files can still occupy disk after a logical charge ends.

Tests use disposable native SQLite and real independent connections to cover old
quota writers, both restore/claim race orders, interrupted metadata handoff,
source-first expiry, immutable identities, raw ledger attacks, exact zero/alias
sizes, and unsafe authority reads. Paired filesystem tests additionally exercise
the real factory/receipt boundary. These tests do not qualify production rollout,
hardware power-loss behavior, backups restoring older barriers, or hostile
administrative modification of the managed namespace/schema. Physical cleanup
remains disabled until all activation requirements are reviewed together.
