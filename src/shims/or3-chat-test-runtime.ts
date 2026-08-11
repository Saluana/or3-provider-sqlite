export * from './or3-chat-contract';

export class ConnectStoreError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'ConnectStoreError';
        this.code = code;
    }
}

export async function emitWebhookSystemHook(): Promise<void> {}

export function getJobConfig() {
    return {
        maxConcurrentJobs: 10,
        maxConcurrentJobsPerUser: 5,
        jobTimeoutMs: 30 * 60 * 1000,
        completedJobRetentionMs: 60 * 60 * 1000
    };
}
