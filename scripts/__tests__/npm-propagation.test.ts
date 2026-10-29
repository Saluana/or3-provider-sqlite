import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run the actual workflow command with offline HTTP and timer fixtures. The
// verifier still hashes both the qualified archive and the downloaded bytes.
const workflow = readFileSync(new URL('../../.github/workflows/publish.yml', import.meta.url), 'utf8');
const node = Bun.which('node');
if (!node) throw new Error('Node is required for the workflow subprocess fixture');
const step = workflow.split('      - name: Verify exact npm propagation\n')[1];
const script = step?.split('        run: |\n')[1]?.split('\n')
    .filter((line) => line.startsWith('          ')).map((line) => line.slice(10)).join('\n');
if (!script) throw new Error('Exact npm propagation command is missing');

describe('post-publication npm verification', () => {
    for (const scenario of [
        { name: 'immediate publication', visibleAfter: 1, failure: '', status: 0, attempts: 1, downloads: 1 },
        { name: 'publication beyond the old 40-second window', visibleAfter: 9, failure: '', status: 0, attempts: 9, downloads: 1 },
        { name: 'publication never appears', visibleAfter: 999, failure: '', status: 1, attempts: 24, downloads: 0 },
        { name: 'metadata has the wrong version', visibleAfter: 1, failure: 'version', status: 1, attempts: 1, downloads: 0 },
        { name: 'metadata has the wrong archive integrity', visibleAfter: 1, failure: 'integrity', status: 1, attempts: 1, downloads: 0 },
        { name: 'downloaded archive has different bytes', visibleAfter: 1, failure: 'archive', status: 1, attempts: 1, downloads: 1 },
        { name: 'archive propagation lags metadata', visibleAfter: 1, failure: 'lag', status: 0, attempts: 2, downloads: 2 },
    ]) {
        test(scenario.name, () => {
            const root = mkdtempSync(join(tmpdir(), 'or3-npm-propagation-test-'));
            try {
                const archive = join(root, 'or3-npm-package');
                const receipt = join(root, 'calls.jsonl');
                const fixture = join(root, 'fixture.mjs');
                mkdirSync(archive);
                writeFileSync(join(archive, 'package.json'), JSON.stringify({ name: 'fixture-provider', version: '1.2.3' }));
                writeFileSync(join(archive, 'fixture.tgz'), 'qualified archive bytes');
                writeFileSync(fixture, `
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import timers from 'node:timers/promises';
const scenario = JSON.parse(process.env.SCENARIO);
const record = value => appendFileSync(process.env.RECEIPT, JSON.stringify(value) + '\\n');
timers.setTimeout = async delay => { if (delay !== 5000) throw Error('Unexpected retry delay'); record({ delay }); };
syncBuiltinESMExports();
let attempts = 0, downloads = 0;
const bytes = Buffer.from('qualified archive bytes');
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.origin !== 'https://registry.npmjs.org' || !url.searchParams.has('or3_verify')) throw Error('Expected a fresh registry request');
    record({ url: url.toString() });
    if (url.pathname === '/fixture-provider/1.2.3') {
        attempts++;
        if (attempts < scenario.visibleAfter) return new Response('', { status: 404 });
        return Response.json({ version: scenario.failure === 'version' ? '9.9.9' : '1.2.3', dist: {
            integrity: scenario.failure === 'integrity' ? 'sha512-wrong' : integrity,
            tarball: 'https://registry.npmjs.org/fixture-provider/-/fixture.tgz',
        }});
    }
    if (url.pathname !== '/fixture-provider/-/fixture.tgz') throw Error('Unexpected archive URL');
    downloads++;
    if (scenario.failure === 'lag' && downloads === 1) return new Response('', { status: 404 });
    return new Response(scenario.failure === 'archive' ? Buffer.from('different bytes') : bytes);
};
`);
                const result = spawnSync('/bin/bash', ['-c', script], {
                    cwd: root, encoding: 'utf8', timeout: 10_000,
                    env: { PATH: `${join(node, '..')}:/usr/bin:/bin`, RUNNER_TEMP: root,
                        NODE_OPTIONS: `--import=${fixture}`, RECEIPT: receipt, SCENARIO: JSON.stringify(scenario) },
                });
                expect(result.status, result.stderr).toBe(scenario.status);
                const calls = readFileSync(receipt, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
                const requests = calls.filter((call) => call.url);
                expect(requests.filter((call) => new URL(call.url).pathname.endsWith('/1.2.3'))).toHaveLength(scenario.attempts);
                expect(requests.filter((call) => new URL(call.url).pathname.endsWith('.tgz'))).toHaveLength(scenario.downloads);
                expect(calls.filter((call) => call.delay)).toHaveLength(
                    scenario.visibleAfter === 999 ? scenario.attempts : scenario.attempts - 1);
                if (scenario.visibleAfter === 999) expect(result.stderr).toContain('Timed out');
                if (['version', 'integrity'].includes(scenario.failure)) expect(result.stderr).toContain('identity differs');
                if (scenario.failure === 'archive') expect(result.stderr).toContain('integrity mismatch');
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    }
});
