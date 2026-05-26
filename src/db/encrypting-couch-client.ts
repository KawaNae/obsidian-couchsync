/**
 * ICouchClient decorator that transparently encrypts/decrypts doc payloads.
 *
 * Push path: ChunkDoc.data and ConfigDoc.data are encrypted before bulkDocs.
 * Pull path: The same fields are decrypted after changes/bulkGet/allDocs.
 * FileDoc fields (chunks[], vclock, mtime, etc.) pass through unmodified.
 *
 * The decorator sits between SyncEngine and the real CouchClient, so the
 * entire sync stack (push-pipeline, pull-writer, reconciler) operates on
 * plaintext — encryption is invisible to them.
 */

import type {
    ICouchClient,
    DbInfo,
    AllDocsOpts,
    AllDocsResult,
    BulkDocsResult,
    ChangesOpts,
    ChangesResult,
} from "./interfaces.ts";
import type { CryptoProvider } from "./crypto-provider.ts";

type AnyDoc = Record<string, unknown>;

function hasEncryptableData(doc: AnyDoc): boolean {
    return (doc.type === "chunk" || doc.type === "config")
        && typeof doc.data === "string";
}

async function encryptDoc(doc: AnyDoc, crypto: CryptoProvider): Promise<AnyDoc> {
    if (!hasEncryptableData(doc)) return doc;
    return { ...doc, data: await crypto.encrypt(doc.data as string) };
}

async function decryptDoc<T>(doc: T, crypto: CryptoProvider): Promise<T> {
    const d = doc as AnyDoc;
    if (!hasEncryptableData(d)) return doc;
    return { ...d, data: await crypto.decrypt(d.data as string) } as T;
}

export class EncryptingCouchClient implements ICouchClient {
    constructor(
        private readonly inner: ICouchClient,
        private readonly crypto: CryptoProvider,
    ) {}

    info(signal?: AbortSignal): Promise<DbInfo> {
        return this.inner.info(signal);
    }

    async getDoc<T>(
        id: string,
        opts?: { conflicts?: boolean },
        signal?: AbortSignal,
    ): Promise<T | null> {
        const doc = await this.inner.getDoc<T>(id, opts, signal);
        return doc ? decryptDoc(doc, this.crypto) : null;
    }

    async bulkGet<T>(ids: string[], signal?: AbortSignal): Promise<T[]> {
        const docs = await this.inner.bulkGet<T>(ids, signal);
        return Promise.all(docs.map((d) => decryptDoc(d, this.crypto)));
    }

    async bulkDocs(docs: any[], signal?: AbortSignal): Promise<BulkDocsResult[]> {
        const encrypted = await Promise.all(
            docs.map((d) => encryptDoc(d as AnyDoc, this.crypto)),
        );
        return this.inner.bulkDocs(encrypted, signal);
    }

    async allDocs<T>(
        opts: AllDocsOpts,
        signal?: AbortSignal,
    ): Promise<AllDocsResult<T>> {
        const result = await this.inner.allDocs<T>(opts, signal);
        if (!opts.include_docs) return result;
        return {
            ...result,
            rows: await Promise.all(
                result.rows.map(async (row) => {
                    if (!row.doc) return row;
                    return { ...row, doc: await decryptDoc(row.doc, this.crypto) };
                }),
            ),
        };
    }

    async changes<T>(
        opts: ChangesOpts,
        signal?: AbortSignal,
    ): Promise<ChangesResult<T>> {
        const result = await this.inner.changes<T>(opts, signal);
        if (!opts.include_docs) return result;
        return {
            ...result,
            results: await Promise.all(
                result.results.map(async (row) => {
                    if (!row.doc) return row;
                    return { ...row, doc: await decryptDoc(row.doc, this.crypto) };
                }),
            ),
        };
    }

    async changesLongpoll<T>(
        opts: ChangesOpts,
        signal?: AbortSignal,
    ): Promise<ChangesResult<T>> {
        const result = await this.inner.changesLongpoll<T>(opts, signal);
        if (!opts.include_docs) return result;
        return {
            ...result,
            results: await Promise.all(
                result.results.map(async (row) => {
                    if (!row.doc) return row;
                    return { ...row, doc: await decryptDoc(row.doc, this.crypto) };
                }),
            ),
        };
    }

    ensureDb(signal?: AbortSignal): Promise<void> {
        return this.inner.ensureDb(signal);
    }

    destroy(signal?: AbortSignal): Promise<void> {
        return this.inner.destroy(signal);
    }

    withTimeout(ms: number): ICouchClient {
        return new EncryptingCouchClient(this.inner.withTimeout(ms), this.crypto);
    }

    getLastPullBodyChunkAt(): number | null {
        return this.inner.getLastPullBodyChunkAt();
    }
}
