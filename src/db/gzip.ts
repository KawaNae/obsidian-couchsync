/**
 * gzip.ts — the single home for gzip framing, shared by the two layers that
 * compress-then-encrypt:
 *   - `CompressingCouchClient` — gzips attachment bodies (chunk content).
 *   - `EncryptingCouchClient`  — gzips the encrypted doc body (`encBody`).
 *
 * Both must apply compression BEFORE encryption (invariant 10: ciphertext is
 * high-entropy and does not compress), so the primitive lives in one place
 * rather than being copy-pasted with a subtly different stream dance.
 *
 * Implementation note: we *do not* `await writer.write` / `writer.close`
 * before reading the output, because in Chromium-based runtimes (Electron /
 * Obsidian) the writer's promise only resolves once the consumer drains the
 * stream — awaiting first would deadlock. We consume the readable side via
 * `new Response(stream).arrayBuffer()` and let the writer promises settle in
 * the background. `CompressionStream`/`DecompressionStream` are available in
 * Node 18+, all modern browsers, and Electron.
 */

const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

export async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    void writer.write(bs(data)).catch((): void => undefined);
    void writer.close().catch((): void => undefined);
    const buf = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(buf);
}

export async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    void writer.write(bs(data)).catch((): void => undefined);
    void writer.close().catch((): void => undefined);
    const buf = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(buf);
}

/**
 * Compress `data`, but keep the result only if it actually got smaller.
 * Returns `{ compressed: true, body: gzipped }` when gzip helped, or
 * `{ compressed: false, body: data }` when the gzip header/footer overhead
 * would have made a tiny payload larger. Lets callers (the `encBody` codec)
 * avoid bloating small docs while still crushing large, repetitive ones (long
 * chunk-id arrays compress ~2x). The returned `compressed` flag is exactly the
 * envelope's `compressed` bit, so decode is unambiguous.
 */
export async function gzipIfSmaller(
    data: Uint8Array,
): Promise<{ compressed: boolean; body: Uint8Array }> {
    const gzipped = await gzipCompress(data);
    if (gzipped.length < data.length) return { compressed: true, body: gzipped };
    return { compressed: false, body: data };
}
