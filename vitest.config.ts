import { defineConfig } from 'vitest/config';
import path from 'path';
import { hostContractAliases, hostFixtureRoot, verifyHostFixture } from './test/support/host-fixture';

verifyHostFixture();

export default defineConfig({
    resolve: {
        alias: [
            // Exact pinned host source, verified above, also works in a
            // provider-only checkout. The explicit integration lane uses the host.
            ...hostContractAliases(hostFixtureRoot),
            {
                find: '~~/shared/testing/contracts/sync',
                replacement: path.resolve(__dirname, 'src/shims/sync-test-contract.ts'),
            },
            {
                find: '~~/shared/sync/revision',
                replacement: path.resolve(__dirname, 'src/shims/sync-revision.ts'),
            },
            {
                find: /^~~\/.*$/,
                replacement: path.resolve(__dirname, 'src/shims/or3-chat-test-runtime.ts'),
            },
            {
                find: '#imports',
                replacement: path.resolve(__dirname, 'src/shims/imports.ts'),
            },
        ],
    },
    test: {
        globals: true,
        include: ['src/**/__tests__/**/*.test.ts'],
        exclude: ['node_modules', 'dist'],
        testTimeout: 10000,
    },
});
