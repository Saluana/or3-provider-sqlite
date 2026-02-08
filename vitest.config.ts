import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            '~~/': path.resolve(__dirname, '../or3-chat') + '/',
            '~~': path.resolve(__dirname, '../or3-chat'),
            '#imports': path.resolve(__dirname, 'src/shims/imports.ts'),
        },
    },
    test: {
        globals: true,
        include: ['src/**/__tests__/**/*.test.ts'],
        exclude: ['node_modules', 'dist'],
        testTimeout: 10000,
    },
});
