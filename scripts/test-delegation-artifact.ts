import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const host = process.env.OR3_PROJECT_HOST_ROOT;
if (!host) throw new Error('OR3_PROJECT_HOST_ROOT must point to the host checkout being tested.');
const root = resolve(import.meta.dir, '..');

async function run(command: string[], env = process.env) {
    const process = Bun.spawn(command, { cwd: root, env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
    const code = await process.exited;
    if (code !== 0) throw new Error(`${command[0]} exited with status ${code}`);
}

await run(['bun', 'run', 'build']);
const directory = await mkdtemp(join(tmpdir(), 'or3-sqlite-artifact-'));
try {
    await run(['bun', 'pm', 'pack', '--destination', directory, '--ignore-scripts', '--quiet']);
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name: string; version: string };
    if (manifest.name !== 'or3-provider-sqlite') throw new Error('Unexpected provider package name');
    const archive = join(directory, `${manifest.name}-${manifest.version}.tgz`);
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    await run(['tar', '-xzf', archive, '-C', directory]);
    await symlink(await realpath(join(root, 'node_modules')), join(directory, 'node_modules'), 'dir');
    console.log(`Testing unpublished ${manifest.name}@${manifest.version} artifact; SHA-256 ${digest}`);
    await run(['bunx', 'vitest', 'run', '--config', 'vitest.delegation-integration.config.ts', '--reporter=dot', '--silent'], {
        ...process.env,
        OR3_PROJECT_HOST_ROOT: resolve(host),
        OR3_SQLITE_ARTIFACT_ROOT: join(directory, 'package'),
    });
} finally {
    await rm(directory, { recursive: true, force: true });
}
