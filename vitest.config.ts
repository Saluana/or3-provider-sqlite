import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    resolve: {
        alias: [
            {
                find: '~~/shared/testing/contracts/admin',
                replacement: path.resolve(__dirname, 'src/shims/admin-test-contract.ts'),
            },
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
