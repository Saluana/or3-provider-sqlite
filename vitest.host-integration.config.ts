import { defineConfig, mergeConfig } from 'vitest/config';
import path from 'node:path';
import config from './vitest.config';
import { hostContractAliases, verifyHostFixture } from './test/support/host-fixture';

const hostRoot = path.resolve(import.meta.dirname, '../or3-chat');
verifyHostFixture(hostRoot);

// The same owners and assertions execute the reviewed host source. Put these
// exact aliases before the ordinary fixture and broad declaration-shim aliases.
const hostConfig = mergeConfig(config, defineConfig({
    resolve: { alias: hostContractAliases(hostRoot) },
}));
hostConfig.test = {
    ...hostConfig.test,
    include: [
        'src/runtime/__tests__/sqlite-background-jobs.test.ts',
        'src/runtime/__tests__/sqlite-sync-gateway-adapter.test.ts',
        'src/runtime/__tests__/sqlite-registration.test.ts',
    ],
};
export default hostConfig;
