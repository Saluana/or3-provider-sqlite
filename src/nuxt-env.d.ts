/**
 * Ambient type declarations for Nuxt/Nitro auto-imports.
 *
 * These globals are provided by Nuxt's build pipeline when the module
 * is installed in a host app. This file makes standalone `tsc` work
 * without needing the full Nuxt type-generation chain.
 */

declare global {
    /** Define a Nitro server plugin. */
    const defineNitroPlugin: (handler: (nitro: unknown) => void | Promise<void>) => void;
    /** Define a Nitro event handler. */
    const defineEventHandler: typeof import('h3')['defineEventHandler'];
    /** Nuxt runtime config composable (auto-imported). */
    const useRuntimeConfig: typeof import('nuxt/app')['useRuntimeConfig'];
}

export {};
