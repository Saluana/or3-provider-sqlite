/** Stable UUID for a SHA-256 operation digest (also used to repair legacy IDs). */
export function digestUuid(digest: string): string {
    const hex = digest.slice(0, 32).split('');
    hex[12] = '4';
    hex[16] = ((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16);
    const value = hex.join('');
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
