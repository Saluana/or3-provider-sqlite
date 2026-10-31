import path from 'node:path';
import { createProviderTestConfig } from './vitest.config';
import { verifyDelegationHostFixture } from './test/support/delegation-host-fixture';

const hostRoot = path.resolve(process.env.OR3_PROJECT_HOST_ROOT || path.resolve(import.meta.dirname, '../or3-chat'));
verifyDelegationHostFixture(path.resolve('test/fixtures/host-next'), hostRoot);

// Select live sources before constructing aliases; the fixture cannot shadow them.
const hostConfig = createProviderTestConfig(hostRoot);
hostConfig.test = {
    ...hostConfig.test,
    include: [
        'src/runtime/__tests__/sqlite-background-jobs.test.ts',
        'src/runtime/__tests__/sqlite-sync-gateway-adapter.test.ts',
        'src/runtime/__tests__/sqlite-registration.test.ts',
    ],
};
export default hostConfig;
