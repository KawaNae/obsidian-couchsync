/**
 * ICouchClient decorator that transparently gzip-compresses attachment
 * bodies. Sits between EncryptingCouchClient (or the base CouchClient)
 * and the rest of the stack so the sync layer never sees compressed bytes.
 *
 * v2 composition order, when both decorators are active:
 *
 *   CompressingCouchClient ← outermost, app facing
 *     └─ EncryptingCouchClient
 *          └─ CouchClient ← network
 *
 * Push direction: app plain bytes → gzip → encrypt → wire
 * Pull direction: wire → decrypt → gunzip → app plain bytes
 *
 * ## Envelope contract
 *
 * Every attachment body passing through this decorator is envelope-
 * formatted bytes (see `envelope.ts`). On push, this layer:
 *   1. decodes the incoming envelope (typically `0x00` plain from the
 *      caller, but may already carry no bits set yet)
 *   2. gzips the body
 *   3. sets `bits.compressed = true`
 *   4. re-encodes the envelope and forwards
 *
 * On pull it does the inverse: decode, if compressed bit set then
 * gunzip and clear the bit, re-encode. This keeps invariant 12
 * (universality of attachment envelope) intact at every decorator
 * boundary.
 *
 * Only attachment bodies are touched. Doc bodies (JSON) and other
 * methods (info, getDoc, bulkGet, bulkDocs, allDocs, changes,
 * changesLongpoll, ensureDb, destroy) pass through to the inner client
 * verbatim.
 */

import type {
    ICouchClient,
    DbInfo,
    AllDocsOpts,
    AllDocsResult,
    BulkDocsResult,
    ChangesOpts,
    ChangesResult,
    DocWithAttachments,
    AttachmentBlob,
} from "./interfaces.ts";
import { decodeEnvelope, encodeEnvelope } from "./envelope.ts";

export class CompressingCouchClient implements ICouchClient {
    constructor(private readonly inner: ICouchClient) {}

    info(signal?: AbortSignal): Promise<DbInfo> {
        return this.inner.info(signal);
    }

    getDoc<T>(
        id: string,
        opts?: { conflicts?: boolean },
        signal?: AbortSignal,
    ): Promise<T | null> {
        return this.inner.getDoc<T>(id, opts, signal);
    }

    bulkGet<T>(ids: string[], signal?: AbortSignal): Promise<T[]> {
        return this.inner.bulkGet<T>(ids, signal);
    }

    bulkDocs(docs: any[], signal?: AbortSignal): Promise<BulkDocsResult[]> {
        return this.inner.bulkDocs(docs, signal);
    }

    async bulkDocsWithAttachments(
        items: DocWithAttachments[],
        signal?: AbortSignal,
    ): Promise<BulkDocsResult[]> {
        const compressed = await Promise.all(items.map(async ({ doc, attachments }) => {
            const out: Record<string, AttachmentBlob> = {};
            for (const [name, blob] of Object.entries(attachments)) {
                const env = decodeEnvelope(blob.data);
                if (env.bits.compressed) {
                    // Already compressed by a peer (or the same decorator
                    // applied twice). Pass through unchanged — double-
                    // compressing would corrupt the round-trip.
                    out[name] = blob;
                    continue;
                }
                if (env.bits.encrypted) {
                    // Compress must happen before encrypt (invariant 10).
                    // If we ever see encrypt-without-compress here it means
                    // the stack is wired in the wrong order.
                    throw new Error(
                        "CompressingCouchClient: cannot compress already-encrypted body",
                    );
                }
                const gzipped = await gzipCompress(env.body);
                out[name] = {
                    contentType: blob.contentType,
                    data: encodeEnvelope({
                        bits: { encrypted: false, compressed: true },
                        body: gzipped,
                    }),
                };
            }
            return { doc, attachments: out };
        }));
        return this.inner.bulkDocsWithAttachments(compressed, signal);
    }

    async getAttachment(
        docId: string,
        name: string,
        signal?: AbortSignal,
    ): Promise<Uint8Array | null> {
        const blob = await this.inner.getAttachment(docId, name, signal);
        if (blob === null) return null;
        const env = decodeEnvelope(blob);
        if (!env.bits.compressed) return blob;
        if (env.bits.encrypted) {
            // Symmetric to push: decrypt must precede decompress.
            throw new Error(
                "CompressingCouchClient: cannot decompress still-encrypted body",
            );
        }
        const inflated = await gzipDecompress(env.body);
        return encodeEnvelope({
            bits: { encrypted: false, compressed: false },
            body: inflated,
        });
    }

    allDocs<T>(opts: AllDocsOpts, signal?: AbortSignal): Promise<AllDocsResult<T>> {
        return this.inner.allDocs<T>(opts, signal);
    }

    changes<T>(opts: ChangesOpts, signal?: AbortSignal): Promise<ChangesResult<T>> {
        return this.inner.changes<T>(opts, signal);
    }

    changesLongpoll<T>(opts: ChangesOpts, signal?: AbortSignal): Promise<ChangesResult<T>> {
        return this.inner.changesLongpoll<T>(opts, signal);
    }

    ensureDb(signal?: AbortSignal): Promise<void> {
        return this.inner.ensureDb(signal);
    }

    destroy(signal?: AbortSignal): Promise<void> {
        return this.inner.destroy(signal);
    }

    withTimeout(ms: number): ICouchClient {
        return new CompressingCouchClient(this.inner.withTimeout(ms));
    }

    getLastPullBodyChunkAt(): number | null {
        return this.inner.getLastPullBodyChunkAt();
    }
}

/** Gzip a binary buffer using the Web Streams `CompressionStream` API.
 *
 *  Available in Node 18+, all modern browsers, and Electron — the
 *  runtimes Obsidian / vitest deploy on.
 *
 *  Implementation note: we *do not* `await writer.write` / `writer.close`
 *  before starting to read the output, because in Chromium-based runtimes
 *  (including Electron / Obsidian) the writer's promise only resolves
 *  once the consumer drains the stream. Awaiting first would deadlock —
 *  the writer waits for the (not-yet-started) reader, and the reader is
 *  never started. We use `new Response(stream).arrayBuffer()` which
 *  consumes the readable side, and let the writer's promises settle
 *  asynchronously in the background. */
async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    // TS 5.7+ types a bare Uint8Array as Uint8Array<ArrayBufferLike>, which the
    // stream writer's BufferSource chunk type rejects; the buffer is always
    // ArrayBuffer-backed at runtime, so the assertion is sound.
    void writer.write(data as unknown as BufferSource).catch((): void => undefined);
    void writer.close().catch((): void => undefined);
    const buf = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(buf);
}

async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    // TS 5.7+ types a bare Uint8Array as Uint8Array<ArrayBufferLike>, which the
    // stream writer's BufferSource chunk type rejects; the buffer is always
    // ArrayBuffer-backed at runtime, so the assertion is sound.
    void writer.write(data as unknown as BufferSource).catch((): void => undefined);
    void writer.close().catch((): void => undefined);
    const buf = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(buf);
}
