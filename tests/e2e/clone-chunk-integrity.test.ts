/**
 * clone-chunk-integrity.test.ts — regression for review finding #1/#10:
 *
 *   The Clone / full-resync path (`pullAll` in remote-couch.ts) now fetches
 *   chunk attachments WITH the vault's ChunkHasher, so a chunk body that no
 *   longer hashes to its content-addressed id is rejected (ChunkIntegrityError)
 *   and skipped — never written to the local DB nor reconstructed into a vault
 *   file. This closes the asymmetry where live-sync verified pulled chunks but
 *   Clone did not, which let an untrusted / MITM CouchDB substitute or roll back
 *   chunk bodies during a Clone and have the corruption land silently.
 *
 * This drives the REAL Init/Clone pipeline against the docker CouchDB, tampers
 * a chunk attachment server-side via raw HTTP, then Clones a second device and
 * asserts the tamper is rejected (not written) — and that Clone does not crash.
 *
 * Requires docker CouchDB on :5984 (scripts/integ-start.sh).
 */
import { describe, it, expect } from "vitest";
import { createE2EHarness, e2eConfig } from "./couch-harness.ts";
import { encodeEnvelope, plainEnvelope } from "../../src/db/envelope.ts";
import { chunkFromAttachment, ChunkIntegrityError } from "../../src/db/chunk-attachment.ts";
import { computeHash } from "../../src/db/chunker.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function authHeader(): string {
    const cfg = e2eConfig();
    return "Basic " + Buffer.from(`${cfg.user}:${cfg.password}`).toString("base64");
}

describe("Clone chunk integrity (review finding #1/#10: pullAll now verifies chunks)", () => {
    it("rejects a server-tampered chunk during Clone instead of landing it", async () => {
        const h = await createE2EHarness({ uniqueDb: true }); // plaintext vault (x64 ids)
        const base = h.config.couchUrl.replace(/\/+$/, "");
        const db = h.config.dbName;
        try {
            // ── Device A: write a known file and Init it onto the remote ──
            const A = h.addDevice("A");
            const ORIGINAL = "HELLO-ORIGINAL-CONTENT-from-device-A";
            await A.vault.createBinary("note.md", enc.encode(ORIGINAL).buffer as ArrayBuffer);
            await A.runInit({ encryption: false, compression: false });

            // ── Locate the chunk doc on the remote ──
            const allRes = await fetch(
                `${base}/${db}/_all_docs?include_docs=false&startkey=%22chunk%3A%22&endkey=%22chunk%3B%22`,
                { headers: { Authorization: authHeader() } },
            );
            const allJson = await allRes.json();
            const chunkRows = (allJson.rows ?? []).filter((r: any) => String(r.id).startsWith("chunk:"));
            expect(chunkRows.length).toBeGreaterThan(0);
            const chunkId: string = chunkRows[0].id;
            const chunkRev: string = chunkRows[0].value.rev;

            // Sanity: the id is content-addressed to the ORIGINAL bytes.
            const expectedHash = await computeHash(enc.encode(ORIGINAL));
            expect(chunkId).toBe(`chunk:x64:${expectedHash}`);

            // ── Tamper: replace the attachment body server-side, KEEPING the id ──
            const EVIL = "EVIL-TAMPERED-CONTENT-injected-by-server!!";
            const tamperedEnvelope = encodeEnvelope(plainEnvelope(enc.encode(EVIL)));
            const putRes = await fetch(
                `${base}/${db}/${encodeURIComponent(chunkId)}/c?rev=${chunkRev}`,
                {
                    method: "PUT",
                    headers: {
                        Authorization: authHeader(),
                        "Content-Type": "application/octet-stream",
                    },
                    body: tamperedEnvelope as any,
                },
            );
            expect(putRes.ok).toBe(true);

            // The verification primitive rejects the tamper (now wired into Clone).
            const tamperedBlob = await h.adminClient.getAttachment(chunkId, "c");
            expect(tamperedBlob).not.toBeNull();
            await expect(
                chunkFromAttachment(chunkId, tamperedBlob!, {
                    alg: "x64",
                    hash: (d) => computeHash(d),
                }),
            ).rejects.toBeInstanceOf(ChunkIntegrityError);

            // ── Device B: Clone (drives the verified pullAll) ──
            const B = h.addDevice("B");
            let cloneError: unknown = null;
            await B.runClone().catch((e) => (cloneError = e));

            // Clone does NOT crash on a corrupt chunk — it skips + routes to repair.
            expect(cloneError).toBeNull();

            // The tampered chunk was REJECTED at the fetch boundary: it is not
            // persisted in B's local DB (neither tampered nor empty).
            const landedChunks = await B.db.getChunks([chunkId]);
            expect(landedChunks).toHaveLength(0);

            // And B's vault never received the attacker's bytes. The file either
            // is absent (its only chunk was rejected) or, if present, is NOT the
            // tampered content. Crucially it is never equal to EVIL.
            if (await B.vault.exists("note.md")) {
                const got = dec.decode(new Uint8Array(await B.vault.readBinary("note.md")));
                expect(got).not.toBe(EVIL);
            }
        } finally {
            await h.destroyAll();
        }
    });
});
