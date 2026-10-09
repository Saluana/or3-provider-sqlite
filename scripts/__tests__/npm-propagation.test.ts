import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Execute the actual workflow shell against an offline npm CLI fixture. This
// protects the propagation window, fresh reads and exact-version rejection,
// rather than a second implementation of the verifier.
const workflow = readFileSync(new URL('../../.github/workflows/publish.yml', import.meta.url), 'utf8');
const node = Bun.which('node');
if (!node) throw new Error('Node is required for the workflow subprocess fixture');
const step = workflow.split('      - name: Verify exact npm propagation\n')[1];
if (!step) throw new Error('Exact npm propagation step is missing');
const script = step.split('        run: |\n')[1]?.split('\n').filter((line) => line.startsWith('          ')).map((line) => line.slice(10)).join('\n');
if (!script) throw new Error('Exact npm propagation command is missing');

describe('post-publication npm verification', () => {
    for (const scenario of [
        { name: 'immediate publication', visibleAfter: 1, version: '1.2.3', status: 0, calls: 1 },
        { name: 'publication beyond the old 40-second window', visibleAfter: 9, version: '1.2.3', status: 0, calls: 9 },
        { name: 'publication never appears', visibleAfter: 999, version: '1.2.3', status: 1, calls: 36 },
        { name: 'successful metadata returns the wrong version', visibleAfter: 1, version: '9.9.9', status: 1, calls: 1 },
    ]) {
        test(scenario.name, () => {
            const root = mkdtempSync(join(tmpdir(), 'or3-npm-propagation-test-'));
            try {
                const bin = join(root, 'bin');
                const archive = join(root, 'or3-npm-package');
                const receipt = join(root, 'calls.jsonl');
                mkdirSync(bin);
                mkdirSync(archive);
                writeFileSync(join(archive, 'package.json'), JSON.stringify({ name: 'fixture-provider', version: '1.2.3' }));
                symlinkSync(node, join(bin, 'node'));
                writeFileSync(join(bin, 'npm'), `#!${node}
const fs = require('node:fs');
const file = process.env.RECEIPT;
const calls = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\\n').length : 0;
fs.appendFileSync(file, JSON.stringify(process.argv.slice(2)) + '\\n');
if (calls + 1 < ${scenario.visibleAfter}) { console.error('E404 Not Found'); process.exit(1); }
console.log('${scenario.version}');
`, { mode: 0o755 });
                writeFileSync(join(bin, 'sleep'), '#!/bin/sh\n[ "$1" = 5 ] || exit 99\n', { mode: 0o755 });
                const result = spawnSync('/bin/bash', ['-c', script], {
                    cwd: root, encoding: 'utf8', timeout: 10_000,
                    env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: root, RECEIPT: receipt },
                });
                expect(result.status, result.stderr).toBe(scenario.status);
                const calls = readFileSync(receipt, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
                expect(calls.length).toBe(scenario.calls);
                for (const args of calls) {
                    expect(args).toEqual(['view', 'fixture-provider@1.2.3', 'version', '--prefer-online']);
                }
                if (scenario.visibleAfter === 999) expect(result.stderr).toContain('Timed out');
                if (scenario.version !== '1.2.3') expect(result.stderr).toContain('version mismatch');
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    }
});
