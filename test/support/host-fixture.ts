import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import provenance from '../fixtures/host/provenance.json';

export const hostFixtureRoot = fileURLToPath(new URL('../fixtures/host/', import.meta.url));

/** Fail closed on fixture drift. This verifier never updates the manifest. */
export function verifyHostFixture(liveHostRoot?: string): void {
    for (const file of provenance.files) {
        const bytes = readFileSync(path.join(hostFixtureRoot, file.path));
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (sha256 !== file.sha256 || blob !== file.git_blob) {
            throw new Error(`Pinned host fixture drift: ${file.path}. Restore the reviewed bytes; do not regenerate the manifest automatically.`);
        }
        if (liveHostRoot) {
            const liveBytes = readFileSync(path.join(liveHostRoot, file.path));
            if (!bytes.equals(liveBytes)) {
                throw new Error(`Host integration source mismatch: ${file.path}. The sibling must match the reviewed fixture provenance.`);
            }
        }
    }
    if (liveHostRoot) {
        const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: liveHostRoot, encoding: 'utf8' }).trim();
        if (tree !== provenance.reviewed_candidate_tree) {
            throw new Error(`Host integration tree mismatch: expected ${provenance.reviewed_candidate_tree}, received ${tree}`);
        }
        execFileSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: liveHostRoot });
    }
}

/** Only runtime contract imports needed by these production-backed suites. */
export function hostContractAliases(root: string) {
    return [
        'shared/chat/background-history', 'shared/chat/compaction', 'shared/sync/sanitize',
        'server/utils/background-jobs/history', 'server/sync/gateway/registry',
    ].map((entry) => ({
        find: `~~/${entry}`,
        replacement: path.join(root, `${entry}.ts`),
    }));
}
