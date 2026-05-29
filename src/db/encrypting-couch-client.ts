/**
 * ICouchClient decorator that transparently encrypts/decrypts doc
 * payloads and attachment bodies.
 *
 *  - ConfigDoc.data (string) is encrypted via the unified envelope
 *    helper (`envelope.ts:encryptString`) and stored as a base64-wrapped
 *    envelope. The same helper handles decrypt on read.
 *  - FileDoc and ConfigDoc `_id` paths are replaced with HMAC-SHA256
 *    hashes; the original path lives in `encryptedPath` (also a
 *    base64-wrapped envelope produced by `encryptString`).
 *  - Attachment bodies (ChunkDoc `c`) are decoded as envelopes, the
 *    body is encrypted via the crypto-provider primitive, and the
 *    envelope is re-encoded with `bits.encrypted = true` plus the IV
 *    in the standard slot. The next layer (or the wire) never sees
 *    raw cipher bytes — they always ride inside the envelope.
 *
 * The decorator sits between SyncEngine and the inner couch client, so
 * the sync stack always operates on plaintext — encryption is invisible.
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
import type { CryptoProvider } from "./crypto-provider.ts";
import {
    decodeEnvelope,
    encodeEnvelope,
    encryptString,
    decryptString,
} from "./envelope.ts";
import { VAULT_META_DOC_ID, CONFIG_META_DOC_ID } from "./vault-meta.ts";

/** Reserved meta doc ids that must NEVER be path-encrypted. `config:meta`
 *  in particular starts with the `config:` prefix that `hasPathId` matches,
 *  so without this guard a meta doc accidentally routed through the
 *  encrypting client would be rewritten to `config:<hmac>` + encryptedPath
 *  and become undiscoverable by `fetchConfigMeta` (which reads the fixed
 *  id) — silently corrupting the crypto root. Production always reads/writes
 *  meta via a raw client; this makes that invariant defense-in-depth. */
const RESERVED_META_IDS = new Set<string>([VAULT_META_DOC_ID, CONFIG_META_DOC_ID]);

export class EncryptionError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = "EncryptionError";
    }
}

type AnyDoc = Record<string, unknown>;

function hasEncryptableData(doc: AnyDoc): boolean {
    return doc.type === "config" && typeof doc.data === "string";
}

function hasPathId(doc: AnyDoc): boolean {
    const id = doc._id as string | undefined;
    if (!id) return false;
    if (RESERVED_META_IDS.has(id)) return false;
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

const PATH_ENCODER = new TextEncoder();
function encodePathForHmac(path: string): Uint8Array {
    return PATH_ENCODER.encode(path);
}

export class EncryptingCouchClient implements ICouchClient {
    constructor(
        private readonly inner: ICouchClient,
        private readonly crypto: CryptoProvider,
    ) {}

    private async encryptDoc(doc: AnyDoc): Promise<AnyDoc> {
        let out = doc;
        if (hasEncryptableData(doc)) {
            out = { ...out, data: await encryptString(doc.data as string, this.crypto) };
        }
        if (hasPathId(doc)) {
            const id = doc._id as string;
            const prefix = idPrefix(id);
            const path = idPayload(id);
            const hmac = await this.crypto.hmacHash(encodePathForHmac(path));
            const encPath = await encryptString(path, this.crypto);
            out = { ...out, _id: prefix + hmac, encryptedPath: encPath };
        }
        return out;
    }

    private async decryptDoc<T>(doc: T): Promise<T> {
        let d = doc as AnyDoc;
        try {
            if (hasEncryptableData(d)) {
                d = { ...d, data: await decryptString(d.data as string, this.crypto) };
            }
            if (typeof d.encryptedPath === "string") {
                const prefix = idPrefix(d._id as string);
                const path = await decryptString(d.encryptedPath as string, this.crypto);
                const { encryptedPath: _, ...rest } = d;
                d = { ...rest, _id: prefix + path };
            }
        } catch (e) {
            throw new EncryptionError(
                `Failed to decrypt doc ${d._id}: ${e instanceof Error ? e.message : e}`,
                e,
            );
        }
        return d as T;
    }

    private async translateId(plainId: string): Promise<string> {
        const prefix = idPrefix(plainId);
        if (prefix === "file:" || prefix === "config:") {
            return prefix + await this.crypto.hmacHash(encodePathForHmac(idPayload(plainId)));
        }
        return plainId;
    }

    private async encryptAttachment(blob: AttachmentBlob): Promise<AttachmentBlob> {
        const env = decodeEnvelope(blob.data);
        if (env.bits.encrypted) {
            // Double-encryption would corrupt the round-trip. Pass through
            // when the body is already encrypted (idempotent semantics).
            return blob;
        }
        const { iv, cipher } = await this.crypto.encryptBytesIv(env.body);
        return {
            contentType: blob.contentType,
            data: encodeEnvelope({
                bits: { encrypted: true, compressed: env.bits.compressed },
                iv,
                body: cipher,
            }),
        };
    }

    private async decryptAttachment(blob: Uint8Array): Promise<Uint8Array> {
        const env = decodeEnvelope(blob);
        if (!env.bits.encrypted) return blob;
        if (!env.iv) {
            throw new EncryptionError(
                "decryptAttachment: encrypted envelope missing IV",
            );
        }
        const plain = await this.crypto.decryptBytesIv(env.iv, env.body);
        return encodeEnvelope({
            bits: { encrypted: false, compressed: env.bits.compressed },
            body: plain,
        });
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
        const needPathRestore = !opts.keys
            && (opts.startkey?.startsWith("file:") || opts.startkey?.startsWith("config:"));
        if (needPathRestore && !opts.include_docs) {
            translated.include_docs = true;
        }
        const result = await this.inner.allDocs<T>(translated, signal);
        return {
            ...result,
            rows: await Promise.all(
                result.rows.map(async (row) => {
                    const restoredId = reverseIdMap.get(row.id) ?? row.id;
                    if (!row.doc) return { ...row, id: restoredId };
                    const dec = await this.decryptDoc(row.doc);
                    const docId = (dec as AnyDoc)._id as string ?? restoredId;
                    const out = { ...row, id: docId, doc: dec };
                    if (needPathRestore && !opts.include_docs) {
                        delete (out as any).doc;
                    }
                    return out;
                }),
            ),
        };
    }

    async changes<T>(
        opts: ChangesOpts,
        signal?: AbortSignal,
    ): Promise<ChangesResult<T>> {
        if (!opts.include_docs) {
            throw new Error(
                "EncryptingCouchClient requires include_docs: true to decrypt path-encrypted IDs.",
            );
        }
        const result = await this.inner.changes<T>(opts, signal);
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
        if (!opts.include_docs) {
            throw new Error(
                "EncryptingCouchClient requires include_docs: true to decrypt path-encrypted IDs.",
            );
        }
        const result = await this.inner.changesLongpoll<T>(opts, signal);
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

    async bulkDocsWithAttachments(
        items: DocWithAttachments[],
        signal?: AbortSignal,
    ): Promise<BulkDocsResult[]> {
        const translated = await Promise.all(items.map(async ({ doc, attachments }) => {
            const encDoc = await this.encryptDoc(doc as AnyDoc);
            const encAttachments: Record<string, AttachmentBlob> = {};
            for (const [name, blob] of Object.entries(attachments)) {
                encAttachments[name] = await this.encryptAttachment(blob);
            }
            return { doc: encDoc, attachments: encAttachments };
        }));
        const results = await this.inner.bulkDocsWithAttachments(translated, signal);
        return results.map((r, i) => {
            const original = items[i].doc as AnyDoc;
            if (r.ok && hasPathId(original)) {
                return { ...r, id: original._id as string };
            }
            return r;
        });
    }

    async getAttachment(
        docId: string,
        name: string,
        signal?: AbortSignal,
    ): Promise<Uint8Array | null> {
        const remoteId = await this.translateId(docId);
        const blob = await this.inner.getAttachment(remoteId, name, signal);
        if (blob === null) return null;
        try {
            return await this.decryptAttachment(blob);
        } catch (e) {
            throw new EncryptionError(
                `Failed to decrypt attachment ${docId}/${name}: ${
                    e instanceof Error ? e.message : e
                }`,
                e,
            );
        }
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
