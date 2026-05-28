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
 * The compression is self-managed: we gzip the attachment body before
 * forwarding to the inner client, and we ungzip on read. The wire-level
 * `Content-Encoding: gzip` header (CouchDB's native attachment encoding
 * support) is intentionally NOT used — keeping the encoding inside our
 * binary blob makes the contract identical against real CouchDB and
 * `FakeCouchClient` in tests.
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
                out[name] = {
                    contentType: blob.contentType,
                    data: await gzipCompress(blob.data),
                    // Do NOT propagate `contentEncoding: "gzip"` to the
                    // inner client. The encoding is implicit in our wire
                    // contract (decorator round-trips it); surfacing it
                    // to CouchDB would cause double-decompression on
                    // real HTTP clients (Electron / browser fetch
                    // auto-decompresses on Content-Encoding: gzip).
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
        const compressed = await this.inner.getAttachment(docId, name, signal);
        if (compressed === null) return null;
        return gzipDecompress(compressed);
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
 *  Available in Node 18+, all modern browsers, and Electron — the
 *  runtimes Obsidian / vitest deploy on. Empty input round-trips
 *  through the standard gzip empty-stream encoding. */
async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    // Web Streams writers expect BufferSource. Uint8Array satisfies that
    // but TypeScript's lib.dom signature is narrower than the runtime.
    await writer.write(data);
    await writer.close();
    return readStreamToUint8Array(cs.readable);
}

async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    await writer.write(data);
    await writer.close();
    return readStreamToUint8Array(ds.readable);
}

async function readStreamToUint8Array(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let totalLen = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        totalLen += value.length;
    }
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (const p of parts) {
        merged.set(p, off);
        off += p.length;
    }
    return merged;
}
