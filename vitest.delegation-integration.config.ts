import { defineConfig } from 'vitest/config';
import path from 'node:path';

const host = process.env.OR3_PROJECT_HOST_ROOT;
if (!host) throw new Error('OR3_PROJECT_HOST_ROOT is required for the draft delegation integration lane.');
const artifact = process.env.OR3_SQLITE_ARTIFACT_ROOT;

export default defineConfig({
    resolve: { alias: [
        { find: /^#sqlite-runtime\/(.*)$/,
            replacement: path.resolve(artifact || '.', artifact ? 'dist/runtime/$1' : 'src/runtime/$1') },
        { find: /^~~\/(.*)$/, replacement: path.resolve(host, '$1') },
        { find: /^~\/(.*)$/, replacement: path.resolve(host, 'app/$1') },
        { find: '#imports', replacement: path.resolve('src/shims/imports.ts') },
    ] },
    test: { include: ['test/integration/delegation.test.ts'], testTimeout: 30_000 },
});
