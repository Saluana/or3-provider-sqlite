import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hostRoot = process.env.OR3_PROJECT_HOST_ROOT;
if (!hostRoot) throw new Error('OR3_PROJECT_HOST_ROOT must point to a prepared host checkout.');
const host = resolve(hostRoot);
const root = resolve(import.meta.dir, '..');
const serverConfig = join(host, '.nuxt/tsconfig.server.json');
const imports = join(host, '.nuxt/types/nitro-imports.d.ts');
const nitro = join(host, '.nuxt/types/nitro.d.ts');
const nitroNuxt = join(host, '.nuxt/types/nitro-nuxt.d.ts');
const catalog = join(host, '.nuxt/or3/bundled-plugin-catalog.ts');
await Promise.all([
    join(root, 'src/runtime/server/background-jobs/sqlite-provider.ts'),
    join(root, 'src/runtime/server/sync/sqlite-sync-gateway-adapter.ts'),
    join(root, 'src/runtime/server/db/migrations/029_delegation_wait.ts'),
].map(file => access(file)));
try {
    await Promise.all([serverConfig, imports, nitro, nitroNuxt, catalog].map(file => access(file)));
} catch {
    throw new Error('The host must have its Nuxt server declarations generated before checking provider contracts.');
}

const directory = await mkdtemp(join(tmpdir(), 'or3-provider-host-types-'));
try {
    const config = {
        extends: serverConfig,
        compilerOptions: {
            paths: {
                '~~/*': [join(host, '*')],
                '~/*': [join(host, 'app/*')],
                '~/types/*': [join(host, 'types/*')],
                '#imports': [imports],
                '#or3-bundled-plugin-catalog': [catalog],
            },
            lib: ['ESNext', 'DOM', 'DOM.Iterable'],
            types: ['node'],
            typeRoots: [join(root, 'node_modules/@types')],
        },
        include: [join(root, 'src/runtime/server/**/*.ts'), nitro, nitroNuxt],
        exclude: [join(root, 'src/runtime/**/__tests__/**')],
    };
    const configFile = join(directory, 'tsconfig.json');
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
    const check = Bun.spawn(['bunx', 'tsc', '-p', configFile, '--noEmit'], {
        cwd: root, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
    });
    const status = await check.exited;
    if (status !== 0) process.exitCode = status;
} finally {
    await rm(directory, { recursive: true, force: true });
}
