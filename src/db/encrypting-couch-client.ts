/**
 * ICouchClient decorator that transparently encrypts/decrypts doc payloads.
 *
 * Level 1: ChunkDoc.data and ConfigDoc.data are AES-256-GCM encrypted.
 * Level 2: Additionally, FileDoc and ConfigDoc _id paths are replaced with
 *          HMAC-SHA256 hashes, and an `encryptedPath` field stores the
 *          AES-GCM-encrypted original path for pull-side recovery.
 *
 * The decorator sits between SyncEngine and the real CouchClient, so the
 * entire sync stack operates on plaintext — encryption is invisible.
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

function hasPathId(doc: AnyDoc): boolean {
    const id = doc._id as string | undefined;
    if (!id) return false;
    return id.startsWith("file:") || id.startsWith("config:");
}

function idPrefix(id: string): string {
    const colon = id.indexOf(":");
    return colon >= 0 ? id.slice(0, colon + 1) : "";
}

function idPayload(id: string): string {
    const colon = id.indexOf(":");
    return colon >= 0 ? id.slice(colon + 1) : id;
}

export class EncryptingCouchClient implements ICouchClient {
    constructor(
        private readonly inner: ICouchClient,
        private readonly crypto: CryptoProvider,
    ) {}

    private async encryptDoc(doc: AnyDoc): Promise<AnyDoc> {
        let out = doc;
        if (hasEncryptableData(doc)) {
            out = { ...out, data: await this.crypto.encrypt(doc.data as string) };
        }
        if (hasPathId(doc)) {
            const id = doc._id as string;
            const prefix = idPrefix(id);
            const path = idPayload(id);
            const hmac = await this.crypto.hmacHash(path);
            const encPath = await this.crypto.encryptPath(path);
            out = { ...out, _id: prefix + hmac, encryptedPath: encPath };
        }
        return out;
    }

    private async decryptDoc<T>(doc: T): Promise<T> {
        let d = doc as AnyDoc;
        if (hasEncryptableData(d)) {
            d = { ...d, data: await this.crypto.decrypt(d.data as string) };
        }
        if (typeof d.encryptedPath === "string") {
            const prefix = idPrefix(d._id as string);
            const path = await this.crypto.decryptPath(d.encryptedPath as string);
            const { encryptedPath: _, ...rest } = d;
            d = { ...rest, _id: prefix + path };
        }
        return d as T;
    }

    private async translateId(plainId: string): Promise<string> {
        const prefix = idPrefix(plainId);
        if (prefix === "file:" || prefix === "config:") {
            return prefix + await this.crypto.hmacHash(idPayload(plainId));
        }
        return plainId;
    }

    info(signal?: AbortSignal): Promise<DbInfo> {
        return this.inner.info(signal);
    }

    async getDoc<T>(
        id: string,
        opts?: { conflicts?: boolean },
        signal?: AbortSignal,
    ): Promise<T | null> {
        const remoteId = await this.translateId(id);
        const doc = await this.inner.getDoc<T>(remoteId, opts, signal);
        return doc ? this.decryptDoc(doc) : null;
    }

    async bulkGet<T>(ids: string[], signal?: AbortSignal): Promise<T[]> {
        const remoteIds = await Promise.all(ids.map((id) => this.translateId(id)));
        const docs = await this.inner.bulkGet<T>(remoteIds, signal);
        return Promise.all(docs.map((d) => this.decryptDoc(d)));
    }

    async bulkDocs(docs: any[], signal?: AbortSignal): Promise<BulkDocsResult[]> {
        const encrypted = await Promise.all(
            docs.map((d) => this.encryptDoc(d as AnyDoc)),
        );
        const results = await this.inner.bulkDocs(encrypted, signal);
        return results.map((r, i) => {
            const original = docs[i] as AnyDoc;
            if (r.ok && hasPathId(original)) {
                return { ...r, id: original._id as string };
            }
            return r;
        });
    }

    async allDocs<T>(
        opts: AllDocsOpts,
        signal?: AbortSignal,
    ): Promise<AllDocsResult<T>> {
        const translated: AllDocsOpts = { ...opts };
        const reverseIdMap = new Map<string, string>();
        if (opts.keys) {
            const translatedKeys = await Promise.all(
                opts.keys.map((k) => this.translateId(k)),
            );
            for (let i = 0; i < opts.keys.length; i++) {
                reverseIdMap.set(translatedKeys[i], opts.keys[i]);
            }
            translated.keys = translatedKeys;
        }
        const result = await this.inner.allDocs<T>(translated, signal);
        return {
            ...result,
            rows: await Promise.all(
                result.rows.map(async (row) => {
                    const restoredId = reverseIdMap.get(row.id) ?? row.id;
                    if (!row.doc) return { ...row, id: restoredId };
                    const dec = await this.decryptDoc(row.doc);
                    return { ...row, id: restoredId, doc: dec };
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
                    const dec = await this.decryptDoc(row.doc);
                    return { ...row, id: (dec as AnyDoc)._id as string, doc: dec };
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
                    const dec = await this.decryptDoc(row.doc);
                    return { ...row, id: (dec as AnyDoc)._id as string, doc: dec };
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
