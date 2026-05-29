/**
 * chunk-attachment.ts — the single home for the chunk ⇄ attachment
 * round-trip.
 *
 * A chunk's canonical payload (`ChunkDoc.content`, plain bytes) rides the
 * wire as a CouchDB attachment named `c`, wrapped in the self-describing
 * codec envelope (`envelope.ts`). The *forward* step (push) and its
 * *inverse* (pull) are defined here together so the contract — envelope
 * framing, attachment name, content type, schema version, and the
 * content-addressed `id = hash(content)` integrity property — lives in
 * exactly one place. Previously this logic was copy-pasted across three
 * push pipelines and three pull sites, which let the pull side drift
 * (a missing attachment was silently turned into an empty chunk).
 *
 * `buildChunkAttachment` strips the binary body off the doc (it travels
 * as the attachment) and leaves the rest of the chunk metadata as the
 * doc body. `chunkFromAttachment` decodes the envelope back to plain
 * bytes and, when handed the matching `ChunkHasher`, verifies the bytes
 * still hash to the id — the inverse of how the id was minted in
 * `chunker.splitIntoChunks`. A null/absent attachment is NOT this
 * module's concern: callers own their "missing chunk" semantics (collect
 * into a notFound list and let assembly fail loud), so this module never
 * fabricates a stand-in body.
 */

import type { DocWithAttachments } from "./interfaces.ts";
import type { ChunkDoc } from "../types.ts";
import { CHUNK_SCHEMA_VERSION } from "../types.ts";
import type { ChunkHasher } from "./chunker.ts";
import { plainEnvelope, encodeEnvelope, decodeEnvelope } from "./envelope.ts";
import { parseChunkId } from "../types/doc-id.ts";

/** Attachment name carrying the chunk body. Single source of truth. */
export const CHUNK_ATTACHMENT_NAME = "c";
/** Content type stored on the chunk attachment. The body is opaque
 *  binary (gzip, if enabled, is applied by `CompressingCouchClient`
 *  downstream — not here). */
export const CHUNK_CONTENT_TYPE = "application/octet-stream";

/** Thrown when a pulled chunk body does not hash to its content-addressed
 *  id. Callers should treat the chunk as missing/corrupt (route to repair)
 *  rather than persisting it. */
export class ChunkIntegrityError extends Error {
    constructor(
        public readonly chunkId: string,
        public readonly expectedHash: string,
        public readonly actualHash: string,
    ) {
        super(
            `chunk ${chunkId} failed integrity check: ` +
            `expected hash ${expectedHash}, got ${actualHash}`,
        );
        this.name = "ChunkIntegrityError";
    }
}

/** Thrown when a ChunkDoc reaches reassembly without a usable `content`
 *  buffer (undefined/null/non-Uint8Array). A chunk is *available* only when
 *  its doc exists AND carries content; a content-less doc is treated exactly
 *  like a missing chunk. This converts the previous opaque
 *  `TypeError: cannot read 'length' of undefined` (joinChunks) into a typed,
 *  routable signal. Sibling of ChunkIntegrityError — both mean "this chunk is
 *  not usable, route to repair/quarantine". */
export class ChunkContentMissingError extends Error {
    constructor(public readonly chunkId: string) {
        super(`chunk ${chunkId} has no usable content (content-less doc)`);
        this.name = "ChunkContentMissingError";
    }
}

/**
 * Forward step: turn a ChunkDoc into the `{ doc, attachments: { c } }`
 * item consumed by `bulkDocsWithAttachments`. The `content` field is
 * removed from the doc body (it becomes the attachment).
 *
 * `_rev` policy differs by destination, so it is explicit:
 *  - vault push / setup push: `keepRev: true` (default) — the caller has
 *    back-filled the remote rev and it is load-bearing for the update.
 *  - config push: `keepRev: false` — Dexie tracks its own revs and the
 *    config DB would reject a rev it never issued.
 */
export function buildChunkAttachment(
    chunk: ChunkDoc & { _rev?: string },
    opts?: { keepRev?: boolean },
): DocWithAttachments {
    const keepRev = opts?.keepRev ?? true;
    const { content: _content, _rev, ...rest } = chunk;
    void _content;
    const doc = keepRev ? { ...rest, ...(_rev !== undefined ? { _rev } : {}) } : rest;
    return {
        doc,
        attachments: {
            [CHUNK_ATTACHMENT_NAME]: {
                contentType: CHUNK_CONTENT_TYPE,
                data: encodeEnvelope(plainEnvelope(chunk.content)),
            },
        },
    };
}

/**
 * Inverse step: decode an attachment blob back into a ChunkDoc. The
 * decorator stack below has already decrypted + decompressed, so `blob`
 * is the `[codec-byte][body]` envelope; `decodeEnvelope` recovers the
 * canonical plain bytes (and throws `EnvelopeError` on a malformed blob).
 *
 * When `hasher` is supplied and its algorithm matches the id's tag, the
 * decoded body is re-hashed and compared to the id — the inverse of the
 * mint in `splitIntoChunks`. A mismatch throws `ChunkIntegrityError`. The
 * check is skipped when no hasher is given or its alg differs from the
 * id's (e.g. an `hmac` chunk with only an `x64` hasher available).
 *
 * NULL/absent attachments are not handled here — callers keep their own
 * notFound semantics.
 */
export async function chunkFromAttachment(
    id: string,
    blob: Uint8Array,
    hasher?: ChunkHasher,
): Promise<ChunkDoc> {
    const content = decodeEnvelope(blob).body;
    if (hasher) {
        const { alg, hash: expected } = parseChunkId(id);
        if (hasher.alg === alg) {
            const actual = await hasher.hash(content);
            if (actual !== expected) {
                throw new ChunkIntegrityError(id, expected, actual);
            }
        }
    }
    return {
        _id: id,
        type: "chunk",
        schemaVersion: CHUNK_SCHEMA_VERSION,
        content,
    };
}
