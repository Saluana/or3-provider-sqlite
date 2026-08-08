/**
 * Shim for Nuxt's #imports virtual module.
 *
 * In a real Nuxt app, #imports re-exports all auto-imported composables.
 * At standalone type-check time, we just re-export from the global declaration
 * in nuxt-env.d.ts. At runtime, Nuxt replaces #imports with real auto-imports.
 */
export interface RuntimeConfigLike {
    auth?: {
        enabled?: boolean;
        [key: string]: unknown;
    };
    sync: {
        provider?: string;
        enabled?: boolean;
        [key: string]: unknown;
    };
    public: {
        auth?: {
            enabled?: boolean;
            [key: string]: unknown;
        };
        sync: {
            provider?: string;
            [key: string]: unknown;
        };
        storage: {
            provider?: string;
            [key: string]: unknown;
        };
        limits?: {
            enabled?: boolean;
            maxConversations?: number;
            [key: string]: unknown;
        };
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export const useRuntimeConfig: () => RuntimeConfigLike = () => {
    const runtimeConfig = (
        globalThis as typeof globalThis & {
            useRuntimeConfig?: () => RuntimeConfigLike;
        }
    ).useRuntimeConfig;
    if (runtimeConfig) {
        return runtimeConfig();
    }
    throw new Error('#imports shim — should never run at runtime');
};
