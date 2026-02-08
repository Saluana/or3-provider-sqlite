/**
 * @module or3-provider-sqlite
 *
 * Nuxt module entry point for the SQLite sync/store provider.
 * Registers a server plugin that wires AuthWorkspaceStore + SyncGatewayAdapter.
 */
import { defineNuxtModule, addServerPlugin, createResolver } from '@nuxt/kit';

export default defineNuxtModule({
    meta: { name: 'or3-provider-sqlite' },
    setup(_options: Record<string, unknown>, _nuxt: unknown) {
        const { resolve } = createResolver(import.meta.url);
        addServerPlugin(resolve('runtime/server/plugins/register'));
    },
});
