/**
 * ICouchClient decorator that transparently encrypts/decrypts doc
 * payloads and attachment bodies.
 *
 *  - FileDoc and ConfigDoc `_id` paths are replaced with HMAC-SHA256
 *    hashes; the original path lives in `encryptedPath` (a
 *    base64-wrapped envelope produced by `envelope.ts:encryptString`).
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
    uint8ToBase64,
    base64ToUint8,
} from "./envelope.ts";
import { gzipIfSmaller, gzipDecompress } from "./gzip.ts";
import { VAULT_META_DOC_ID, CONFIG_META_DOC_ID } from "./vault-meta.ts";
import { EncryptionError } from "./codec-errors.ts";

// Re-exported from its canonical home (`codec-errors.ts`) for back-compat:
// callers that `import { EncryptionError } from "./encrypting-couch-client.ts"`
// keep working. New sync-stack consumers should import from `codec-errors.ts`
// directly so they do not compile-depend on this decorator.
export { EncryptionError };

/** Reserved meta doc ids that must NEVER be path-encrypted. `config:meta`
 *  in particular starts with the `config:` prefix that `hasPathId` matches,
 *  so without this guard a meta doc accidentally routed through the
 *  encrypting client would be rewritten to `config:<hmac>` + encryptedPath
 *  and become undiscoverable by `fetchConfigMeta` (which reads the fixed
 *  id) — silently corrupting the crypto root. Production always reads/writes
 *  meta via a raw client; this makes that invariant defense-in-depth. */
const RESERVED_META_IDS = new Set<string>([VAULT_META_DOC_ID, CONFIG_META_DOC_ID]);

type AnyDoc = Record<string, unknown>;

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

const UTF8 = new TextEncoder();
const UTF8_DEC = new TextDecoder();

/** The field that carries the encrypted+authenticated doc body on the wire.
 *  A doc with `encBody` uses the v2 (encBody) scheme; a doc with the legacy
 *  `encryptedPath` uses the v1 scheme (path-only encryption). */
const ENC_BODY_FIELD = "encBody";

export class EncryptingCouchClient implements ICouchClient {
    constructor(
        private readonly inner: ICouchClient,
        private readonly crypto: CryptoProvider,
        /** The vault's locally-anchored cipherVersion policy floor (TOFU).
         *  When >= 3, `decryptDoc` refuses any file/config doc that is not a
         *  sealed `encBody` — rejecting both the legacy `encryptedPath` branch
         *  and the plaintext passthrough, which are unauthenticated and let a
         *  curious server downgrade a v3 vault (#1/#3). When `undefined` or 2,
         *  the legacy dual-read is preserved for vaults not yet re-init'd to
         *  v3. The floor MUST come from client-local state (see
         *  `settings.vaultCipherVersion`), never from the server-writable
         *  `vault:meta`; the non-downgrade gate in `encryption-agreement`
         *  refuses a remote meta below the recorded floor. */
        private readonly cipherVersion?: number,
    ) {}

    /**
     * v2 (encBody) scheme: the WHOLE sensitive body of a file/config doc is
     * compressed-then-encrypted into a single `encBody` field, bound to the
     * doc's identity via AES-GCM additional-authenticated-data (the remote
     * `_id`). Only `_id` (the HMAC'd path) and `_rev` ride in the clear.
     *
     * This closes the integrity gap where `chunks` / `vclock` / `size` /
     * `deleted` were plaintext and unbound: a tampering server could reorder
     * or substitute chunk references, swap a body onto another doc, or roll
     * back the vclock undetected. Now any mutation of the body OR a move to a
     * different `_id` fails the GCM tag. It also hides the doc structure
     * (chunk count, causal history) from the server. Compression precedes
     * encryption so the long, repetitive chunk-id arrays still pack down.
     */
    private async encryptDoc(doc: AnyDoc): Promise<AnyDoc> {
        if (!hasPathId(doc)) return doc;
        const id = doc._id as string;
        const prefix = idPrefix(id);
        const path = idPayload(id);
        const hmac = await this.crypto.hmacHash(encodePathForHmac(path));
        const remoteId = prefix + hmac;

        // Payload = everything except the CouchDB-managed _id/_rev, plus the
        // plaintext path so decrypt can restore the id. _rev stays in the clear
        // (MVCC is managed by the server and is not sensitive).
        const { _id: _omitId, _rev, ...body } = doc;
        void _omitId;
        const payload = UTF8.encode(JSON.stringify({ path, ...body }));
        // NB (#17): doc-BODY compression here is ALWAYS-ON and independent of
        // the user's compression toggle (which gates only attachment bodies via
        // CompressingCouchClient). It is safe because `gzipIfSmaller` keeps the
        // result only when strictly smaller and the envelope's self-describing
        // `compressed` bit makes decode unambiguous regardless of any flag —
        // chunk-id arrays must pack down before encryption renders them opaque.
        const { compressed, body: maybeGz } = await gzipIfSmaller(payload);
        const { iv, cipher } = await this.crypto.encryptBytesIv(
            maybeGz, UTF8.encode(remoteId),
        );
        const encBody = uint8ToBase64(encodeEnvelope({
            bits: { encrypted: true, compressed }, iv, body: cipher,
        }));

        const out: AnyDoc = { _id: remoteId, [ENC_BODY_FIELD]: encBody };
        if (_rev !== undefined) out._rev = _rev;
        return out;
    }

    private async decryptDoc<T>(doc: T): Promise<T> {
        const d = doc as AnyDoc;
        // cipherVersion-3 policy floor (checked before the shape dispatch).
        // In a re-init'd v3 vault every file/config doc MUST be a sealed
        // `encBody`. A path doc that arrives WITHOUT `encBody` is either a
        // legacy `encryptedPath` body or a plaintext injection — both
        // unauthenticated, both let a curious server roll back a vclock,
        // resurrect a deleted file, or swap chunk references undetected
        // (#1/#3). Refuse them. The floor is local-anchored (TOFU), so a
        // server cannot re-open the hole by rewriting `vault:meta`. Docs that
        // are not path docs (chunks, `_local`, the raw meta docs) carry no
        // `encBody` legitimately and pass through untouched. Floor < 3 (or
        // undefined) keeps the dual-read below for not-yet-re-init'd v2 vaults.
        if (this.cipherVersion !== undefined && this.cipherVersion >= 3
            && hasPathId(d) && typeof d[ENC_BODY_FIELD] !== "string") {
            throw new EncryptionError(
                `cipherVersion-${this.cipherVersion} floor: refusing unsealed ` +
                    `file/config doc ${d._id} (missing encBody — possible ` +
                    `server downgrade attack)`,
                undefined,
                false, // policy violation — terminal, never retry (#enc-1)
            );
        }
        try {
            if (typeof d[ENC_BODY_FIELD] === "string") {
                return await this.decryptEncBody(d) as T;
            }
            // v1 legacy scheme (path-only encryption). Kept for the migration
            // window: a v2 build reading a not-yet-re-init'd v1 vault. New
            // writes are always v2. Remove once all vaults are re-init'd.
            if (typeof d.encryptedPath === "string") {
                const prefix = idPrefix(d._id as string);
                const path = await decryptString(d.encryptedPath as string, this.crypto);
                const { encryptedPath: _omit, ...rest } = d;
                return { ...rest, _id: prefix + path } as T;
            }
        } catch (e) {
            throw new EncryptionError(
                `Failed to decrypt doc ${d._id}: ${e instanceof Error ? e.message : e}`,
                e,
            );
        }
        return d as T;
    }

    /** Inverse of `encryptDoc`'s v2 path. Verifies the GCM tag (with the
     *  remote `_id` as AAD), decompresses, and rebuilds the plaintext doc. A
     *  defence-in-depth identity check confirms the decrypted path actually
     *  HMACs to the id payload — so a server cannot pair a valid ciphertext
     *  with a mismatched id even within the same vault. */
    private async decryptEncBody(d: AnyDoc): Promise<AnyDoc> {
        const remoteId = d._id as string;
        const prefix = idPrefix(remoteId);
        const env = decodeEnvelope(base64ToUint8(d[ENC_BODY_FIELD] as string));
        if (!env.iv) throw new EncryptionError(`encBody missing IV: ${remoteId}`);
        const plain = await this.crypto.decryptBytesIv(
            env.iv, env.body, UTF8.encode(remoteId),
        );
        const json = env.bits.compressed ? await gzipDecompress(plain) : plain;
        const payload = JSON.parse(UTF8_DEC.decode(json)) as AnyDoc & { path?: string };
        const path = payload.path;
        if (typeof path !== "string") {
            throw new EncryptionError(`encBody payload missing path: ${remoteId}`);
        }
        const expectedHmac = await this.crypto.hmacHash(encodePathForHmac(path));
        if (idPayload(remoteId) !== expectedHmac) {
            throw new EncryptionError(
                `encBody id/path mismatch: ${remoteId} does not HMAC to its path`,
                undefined,
                false, // identity/security violation — terminal (#enc-1)
            );
        }
        const { path: _omitPath, ...rest } = payload;
        void _omitPath;
        const out: AnyDoc = { ...rest, _id: prefix + path };
        if (d._rev !== undefined) out._rev = d._rev;
        return out;
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
        // Forward the policy floor — a timed-out client that dropped it would
        // silently revert to the permissive (floor-undefined) dual-read.
        return new EncryptingCouchClient(
            this.inner.withTimeout(ms), this.crypto, this.cipherVersion,
        );
    }

    getLastPullBodyChunkAt(): number | null {
        return this.inner.getLastPullBodyChunkAt();
    }
}
