declare module 'bun:sqlite' {
    export const Database: new (path: string) => unknown;
}
