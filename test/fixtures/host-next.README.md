# Delegation host fixture

`host-next` contains runtime files from the committed host revision recorded in
`host-next.json`, with SHA-256 and Git blob hashes for every file. Standalone
tests verify the complete snapshot and reject changed, missing, extra, or
non-regular files. The verifier never updates the manifest.

`bun run test:host-integration` also verifies the exact host commit, checks that
the checkout is clean, and compares the fixture with both committed and live
host bytes before testing the host sources. The release workflow checks out that
same commit and runs this lane along with delegation and canonical-history tests.
These checks do not imply a deployment or qualify an unrelated host revision.
