import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import provenance from '../fixtures/host-next.json';

/** Verify every runtime snapshot byte; never regenerate provenance while testing. */
export function verifyDelegationHostFixture(root: string, liveHostRoot?: string): void {
    if (liveHostRoot) {
        const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: liveHostRoot, encoding: 'utf8' }).trim();
        if (commit !== provenance.source_commit) throw new Error(`Host commit mismatch: ${commit}`);
        execFileSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: liveHostRoot });
    }
    const expected = new Map(provenance.files.map(file => [file.path, file]));
    if (expected.size !== provenance.files.length || expected.size === 0) throw new Error('Invalid delegation fixture manifest');
    const seen = new Set<string>();
    const visit = (directory: string, prefix = ''): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) { visit(absolute, relative); continue; }
            if (!entry.isFile()) throw new Error(`Invalid delegation fixture entry: ${relative}`);
            const file = expected.get(relative);
            if (!file) throw new Error(`Unrecorded delegation fixture file: ${relative}`);
            const bytes = readFileSync(absolute);
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
            if (sha256 !== file.sha256 || blob !== file.git_blob) throw new Error(`Delegation fixture drift: ${relative}`);
            if (liveHostRoot) {
                const committed = execFileSync('git', ['show', `${provenance.source_commit}:${relative}`], { cwd: liveHostRoot });
                if (!bytes.equals(committed) || !bytes.equals(readFileSync(path.join(liveHostRoot, relative)))) {
                    throw new Error(`Host integration source mismatch: ${relative}`);
                }
            }
            seen.add(relative);
        }
    };
    visit(root);
    if (seen.size !== expected.size) throw new Error('Delegation fixture is incomplete');
}
