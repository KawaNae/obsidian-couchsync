/** Test helpers for envelope-aware decorator tests.
 *
 *  The decorator stack (`CompressingCouchClient`, `EncryptingCouchClient`)
 *  contracts on envelope-formatted bytes at every layer (invariant 12).
 *  Production callers wrap their raw bytes via
 *  `encodeEnvelope(plainEnvelope(...))` before pushing into the stack
 *  and decode the envelope after pulling. These helpers do the same
 *  for tests so each assertion can keep talking about raw payload
 *  bytes without spelling out the envelope round-trip every time.
 */
import {
    encodeEnvelope,
    decodeEnvelope,
    plainEnvelope,
} from "../../src/db/envelope.ts";

/** Wrap raw bytes into a `[0x00][raw]` envelope ready for
 *  `bulkDocsWithAttachments`. */
export function asEnvelope(raw: Uint8Array): Uint8Array {
    return encodeEnvelope(plainEnvelope(raw));
}

/** Decode an envelope returned by `getAttachment` back into the raw
 *  body bytes. Throws if the envelope's codec bits are still set
 *  (decorator didn't fully unwrap). */
export function fromEnvelope(blob: Uint8Array): Uint8Array {
    const env = decodeEnvelope(blob);
    if (env.bits.encrypted || env.bits.compressed) {
        throw new Error(
            `fromEnvelope: expected plain envelope, got bits=${JSON.stringify(env.bits)}`,
        );
    }
    return env.body;
}
