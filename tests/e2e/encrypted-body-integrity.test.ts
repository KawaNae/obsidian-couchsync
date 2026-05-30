/**
 * encrypted-body-integrity.test.ts — review finding #2, end to end.
 *
 * Under the v3 (encBody) scheme a file/config doc's whole sensitive body is
 * compressed-then-encrypted into a single `encBody` field, GCM-bound to the
 * doc `_id` (AAD). This test drives a REAL encrypted Init against docker
 * CouchDB and asserts two properties:
 *
 *   1. Confidentiality: nothing but `_id` (an HMAC) and `encBody` leaks to the
 *      server — `chunks` / `vclock` / `encryptedPath` are gone at rest.
 *   2. Integrity: a tampering server that swaps two docs' `encBody` blobs is
 *      detected — a Clone that pulls the swapped docs fails to decrypt instead
 *      of silently restoring the wrong content.
 *
 * Requires docker CouchDB on :5984 (scripts/integ-start.sh).
 */
import { describe, it, expect } from "vitest";
import { createE2EHarness, e2eConfig } from "./couch-harness.ts";

const enc = new TextEncoder();
const PASS = "e2e-encbody-passphrase";

function authHeader(): string {
    const cfg = e2eConfig();
    return "Basic " + Buffer.from(`${cfg.user}:${cfg.password}`).toString("base64");
}

describe("Encrypted body integrity (review finding #2: encBody is authenticated + confidential)", () => {
    it("seals the body at rest and rejects a server that swaps encBody between docs", async () => {
        const h = await createE2EHarness({ uniqueDb: true, codec: { passphrase: PASS, compression: true } });
        const base = h.config.couchUrl.replace(/\/+$/, "");
        const db = h.config.dbName;
        try {
            // ── Device A: two distinct files, encrypted Init ──
            const A = h.addDevice("A");
            await A.vault.createBinary("alpha.md", enc.encode("ALPHA-content-one").buffer as ArrayBuffer);
            await A.vault.createBinary("beta.md", enc.encode("BETA-content-two-different").buffer as ArrayBuffer);
            await A.runInit({ encryption: true, passphrase: PASS, compression: true });

            // ── Confidentiality at rest ──
            const fileRows = await fetch(
                `${base}/${db}/_all_docs?include_docs=true&startkey=%22file%3A%22&endkey=%22file%3B%22`,
                { headers: { Authorization: authHeader() } },
            ).then((r) => r.json());
            const fileDocs = (fileRows.rows ?? []).map((r: any) => r.doc).filter(Boolean);
            expect(fileDocs.length).toBe(2);
            for (const doc of fileDocs) {
                expect(String(doc._id)).toMatch(/^file:[0-9a-f]{64}$/); // HMAC'd path
                expect(doc.encBody).toBeTypeOf("string");
                // No structure leaks to the server.
                expect(doc.chunks).toBeUndefined();
                expect(doc.vclock).toBeUndefined();
                expect(doc.encryptedPath).toBeUndefined();
                expect(doc.size).toBeUndefined();
            }

            // ── Tamper: swap the two docs' encBody blobs server-side ──
            const [da, dbDoc] = fileDocs;
            const putSwap = async (target: any, donor: any) => {
                const res = await fetch(`${base}/${db}/${encodeURIComponent(target._id)}`, {
                    method: "PUT",
                    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
                    body: JSON.stringify({ ...target, encBody: donor.encBody, _rev: target._rev }),
                });
                expect(res.ok).toBe(true);
            };
            await putSwap(da, dbDoc);
            await putSwap(dbDoc, da);

            // ── Device B: Clone pulls the swapped docs → must fail to decrypt ──
            // The encBody for alpha was sealed with AAD = hmac(alpha); presented
            // under hmac(beta)'s id it can no longer authenticate.
            const B = h.addDevice("B");
            let cloneError: any = null;
            await B.runClone({ passphrase: PASS }).catch((e) => (cloneError = e));
            expect(cloneError).not.toBeNull();
            expect(String(cloneError?.message ?? cloneError)).toMatch(/decrypt|encrypt|integrity/i);
        } finally {
            await h.destroyAll();
        }
    });
});
