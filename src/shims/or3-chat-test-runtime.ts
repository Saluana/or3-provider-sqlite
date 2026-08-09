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
