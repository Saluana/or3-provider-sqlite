# Pinned host runtime contracts

These eight TypeScript files are byte-for-byte runtime dependency snapshots from
the reviewed OR3 Chat candidate identified in `provenance.json`. They are test
fixtures, never provider production imports. They preserve the real host usage
validator, admission parser, sanitizer, registry and history reconciler so a
provider-only checkout does not replace persistence with a fake finalizer.

The candidate is unpublished. Its real upstream base, reviewed tree and candidate
patch hash are recorded; `source_commit` is deliberately null. A synthetic local
commit is not upstream ancestry. The manifest includes Git blob and SHA-256 hashes
for each source file. Type-only imports are erased by Vitest; this is the minimal
runtime closure, not an independently typechecked copy of the full host.

`bun run test` verifies the snapshot bytes before running the normal provider
suites. It needs only this package's locked dependencies, including dev-only
Zod 4.6.5. It does not need a sibling OR3 Chat checkout or generated Nuxt files.

`bun run test:host-integration` reruns the same job, canonical gateway and startup
registration owners against an actual sibling `../or3-chat` checkout. Prepare
that checkout's locked dependencies and generated Nuxt configuration through its
documented development setup first. Its Git tree must equal the reviewed candidate
tree and tracked source must be clean. Every fixture source file must match the
live host bytes. A missing checkout, different tree, dirty source or hash mismatch
fails this explicit lane rather than silently falling back to the snapshots.

The config verifier never regenerates or updates hashes. Changing these fixtures
requires separately reviewing the new host contract, copying exact source bytes,
updating provenance honestly, and qualifying both standalone and real-host lanes.
Do not use a hash update to suppress an unexplained mismatch.
