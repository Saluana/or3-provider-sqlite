import { defineConfig, mergeConfig } from 'vitest/config';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import config from './vitest.config';

// Additive qualification lane. The older reviewed/pinned fixture is unchanged.
const host = path.resolve(import.meta.dirname,
    process.env.OR3_CANONICAL_HOST_ROOT || '../or3-chat');
const files = ['shared/chat/history-reader', 'shared/chat/background-history', 'shared/chat/compaction',
    'shared/sync/sanitize', 'server/utils/background-jobs/history', 'server/sync/gateway/registry'];
for (const file of files) {
    const committed = execFileSync('git', ['show', `HEAD:${file}.ts`], { cwd: host });
    if (!committed.equals(readFileSync(path.join(host, `${file}.ts`)))) throw new Error(`Uncommitted canonical contract: ${file}`);
}
const hostRequire = createRequire(path.join(host, 'package.json'));
const lane = mergeConfig(config, defineConfig({ resolve: { alias: [
    ...files.map((file) => ({ find: `~~/${file}`, replacement: path.join(host, `${file}.ts`) })),
    { find: 'fake-indexeddb/auto', replacement: hostRequire.resolve('fake-indexeddb/auto') },
    { find: '#imports', replacement: path.join(host, 'tests/stubs/nuxt-imports.ts') },
    { find: '#app', replacement: path.join(host, 'tests/stubs/nuxt-app.ts') },
    { find: 'nuxt/app', replacement: path.join(host, 'tests/stubs/nuxt-app.ts') },
    { find: /^~~\/(app|shared)\/(.*)$/, replacement: `${host}/$1/$2` },
    { find: /^~\/(.*)$/, replacement: `${host}/app/$1` },
] } }));
lane.test = { ...lane.test, include: ['src/runtime/__tests__/sqlite-sync-gateway-adapter.test.ts',
    'src/runtime/__tests__/sqlite-background-jobs.test.ts', 'src/runtime/__tests__/sqlite-registration.test.ts'],
    env: { ...lane.test?.env, OR3_CANONICAL_ARTIFACTS: 'true' } };
export default lane;
