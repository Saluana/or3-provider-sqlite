import { defineConfig } from 'vitest/config';
import path from 'path';
import { verifyDelegationHostFixture } from './test/support/delegation-host-fixture';
import { hostContractAliases, hostFixtureRoot, verifyHostFixture } from './test/support/host-fixture';

verifyHostFixture();
// Explicit host lanes use live host bytes; standalone tests use the committed snapshot.
export function createProviderTestConfig(hostRoot?: string) {
const host = hostRoot ? path.resolve(hostRoot) : path.resolve('test/fixtures/host-next');
if (!hostRoot) verifyDelegationHostFixture(host);

return defineConfig({
    resolve: {
        alias: [
            {
                find: /^#sqlite-runtime\/(.*)$/,
                replacement: path.resolve(process.env.OR3_SQLITE_ARTIFACT_ROOT || '.',
                    process.env.OR3_SQLITE_ARTIFACT_ROOT ? 'dist/runtime/$1' : 'src/runtime/$1'),
            },
            ...[{
                find: '~~/shared/openrouter/delegation-model-catalog',
                replacement: path.resolve(host, 'shared/openrouter/delegation-model-catalog.ts'),
            }, {
                find: '~~/shared/errors',
                replacement: path.resolve(host, 'shared/errors/index.ts'),
            }, {
                find: '~~/shared/sync/revision',
                replacement: path.resolve(host, 'shared/sync/revision.ts'),
            }, {
                find: '~~/shared/sync/sanitize',
                replacement: path.resolve(host, 'shared/sync/sanitize.ts'),
            }, {
                find: '~~/shared/sync/field-mappings',
                replacement: path.resolve(host, 'shared/sync/field-mappings.ts'),
            }, {
                find: '~~/shared/chat/history-reader',
                replacement: path.resolve(host, 'shared/chat/history-reader.ts'),
            }, {
                find: '~~/shared/chat/delegation-checkpoint',
                replacement: path.resolve(host, 'shared/chat/delegation-checkpoint.ts'),
            }, {
                find: '~~/shared/chat/delegation-identities',
                replacement: path.resolve(host, 'shared/chat/delegation-identities.ts'),
            }, {
                find: '~~/server/utils/background-jobs/admission-cancels',
                replacement: path.resolve(host, 'server/utils/background-jobs/admission-cancels.ts'),
            }, {
                find: '~~/server/utils/background-jobs/history',
                replacement: path.resolve(host, 'server/utils/background-jobs/history.ts'),
            }, {
                find: '~~/server/utils/background-jobs/delegation-resume',
                replacement: path.resolve(host, 'server/utils/background-jobs/delegation-resume.ts'),
            }, {
                find: '~~/server/utils/background-jobs/delegation-child',
                replacement: path.resolve(host, 'server/utils/background-jobs/delegation-child.ts'),
            }, {
                find: '~~/server/utils/chat/tool-registry',
                replacement: path.resolve(host, 'server/utils/chat/tool-registry.ts'),
            }, {
                find: '~~/server/utils/background-jobs/delegation-coordinator',
                replacement: path.resolve(host, 'server/utils/background-jobs/delegation-coordinator.ts'),
            }, {
                find: '~~/server/utils/shutdown/runtime',
                replacement: path.resolve(host, 'server/utils/shutdown/runtime.ts'),
            }, {
                find: '~~/server/auth/hooks',
                replacement: path.resolve(host, 'server/auth/hooks.ts'),
            }, {
                find: '~~/server/hooks/hook-engine',
                replacement: path.resolve(host, 'server/hooks/hook-engine.ts'),
            }, {
                find: /^~~\/shared\/hooks\/(.*)$/,
                replacement: path.resolve(host, 'shared/hooks/$1'),
            }, {
                find: '~~/server/auth/store/registry',
                replacement: path.resolve(host, 'server/auth/store/registry.ts'),
            }, {
                find: '~~/server/sync/gateway/registry',
                replacement: path.resolve(host, 'server/sync/gateway/registry.ts'),
            }, {
                find: '~~/server/utils/background-jobs/admission-history',
                replacement: path.resolve(host, 'server/utils/background-jobs/admission-history.ts'),
            }, {
                find: '~~/shared/chat/normalized-stream-reducer',
                replacement: path.resolve(host, 'shared/chat/normalized-stream-reducer.ts'),
            }, {
                find: '~~/shared/chat/tool-ledger',
                replacement: path.resolve(host, 'shared/chat/tool-ledger.ts'),
            }, {
                find: /^~~\/shared\/plugins\/(.*)$/,
                replacement: path.resolve(host, 'shared/plugins/$1'),
            }, {
                find: /^~~\/shared\/chat\/(.*)$/,
                replacement: path.resolve(host, 'shared/chat/$1'),
            }],
            // Exact pinned host source, verified above, also works in a
            // provider-only checkout. The explicit integration lane uses the host.
            ...hostContractAliases(hostFixtureRoot),
            {
                find: '~~/shared/testing/contracts/sync',
                replacement: path.resolve(__dirname, 'src/shims/sync-test-contract.ts'),
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
}

export default createProviderTestConfig(process.env.OR3_PROJECT_HOST_ROOT);
