/**
 * Content-sniff whether a byte sequence is diffable UTF-8 text.
 * Returns true only if the first SNIFF_SIZE bytes contain no NUL and
 * decode cleanly as UTF-8.
 */
const SNIFF_SIZE = 8192;

export function isDiffableText(bytes: ArrayBuffer | Uint8Array): boolean {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const slice = view.subarray(0, Math.min(view.byteLength, SNIFF_SIZE));
    for (let i = 0; i < slice.byteLength; i++) {
        if (slice[i] === 0) return false;
    }
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(slice);
        return true;
    } catch {
        return false;
    }
}
