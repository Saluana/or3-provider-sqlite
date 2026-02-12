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
    };
    sync?: {
        provider?: string;
        enabled?: boolean;
    };
    public: {
        auth: {
            enabled?: boolean;
        };
        sync: {
            provider?: string;
        };
        storage: {
            provider?: string;
        };
        limits: {
            enabled?: boolean;
            maxConversations: number;
        };
    };
}

export const useRuntimeConfig: () => RuntimeConfigLike = () => {
    throw new Error('#imports shim — should never run at runtime');
};
