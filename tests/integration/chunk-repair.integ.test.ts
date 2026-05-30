/**
 * Integration: chunk-repair against a real LocalDB + FakeCouchClient.
 *
 * Seeds drift via the same channels the production code uses, runs the
 * repair end-to-end via `analyzeChunkConsistency` → `planFromReport` →
 * `repairChunkDrift`, and verifies the post-repair report is clean.
 *
 * Complements `chunk-repair.test.ts` (unit-level) by exercising the
 * full pipeline: report → plan → execute → re-analyze.
 */

import "fake-indexeddb/auto";
import { describe, it, expect, afterEach } from "vitest";
import { LocalDB } from "../../src/db/local-db.ts";
import { FakeCouchClient } from "../helpers/fake-couch-client.ts";
import {
    analyzeChunkConsistency,
    type ChunkConsistencyReport,
    type ChunkConsistencyDeps,
} from "../../src/sync/chunk-consistency.ts";
import {
    planFromReport,
    repairChunkDrift,
} from "../../src/sync/chunk-repair.ts";
import { makeFileId, makeChunkId, isChunkDocId } from "../../src/types/doc-id.ts";
import type { FileDoc, ChunkDoc, CouchSyncDoc } from "../../src/types.ts";
import type { ICouchClient } from "../../src/db/interfaces.ts";
import { buildChunkAttachment } from "../../src/db/chunk-attachment.ts";
import { EncryptingCouchClient } from "../../src/db/encrypting-couch-client.ts";
import { deriveKeys, generateSalt, createCryptoProvider } from "../../src/db/crypto-provider.ts";
import { decodeEnvelope } from "../../src/db/envelope.ts";
import { computeHash, type ChunkHasher } from "../../src/db/chunker.ts";

// x64 hasher for the verified pull boundary. Fixtures are content-addressed
// (id = x64(content)); the encrypted test only encrypts attachment bytes, not
// the chunk id, so x64 still matches there.
const h: ChunkHasher = { alg: "x64", hash: (d) => computeHash(d) };

/** Seed docs on the remote the way production writes them: chunk bodies
 *  ride in the `c` attachment (bulkDocsWithAttachments), everything else
 *  via plain bulkDocs. Mirrors the push-pipeline split so repair-pull can
 *  reconstruct chunk content from attachments (v2). Accepts any
 *  ICouchClient so an EncryptingCouchClient wrapper can be seeded through
 *  (encrypts on the way to the underlying store). */
async function seedRemote(remote: ICouchClient, docs: CouchSyncDoc[]): Promise<void> {
    const chunks = docs.filter((d) => isChunkDocId(d._id)) as ChunkDoc[];
    const rest = docs.filter((d) => !isChunkDocId(d._id));
    if (rest.length > 0) await remote.bulkDocs(rest);
    if (chunks.length > 0) {
        await remote.bulkDocsWithAttachments(chunks.map((c) => buildChunkAttachment(c)));
    }
}

async function analyzeConverged(
    deps: ChunkConsistencyDeps,
): Promise<ChunkConsistencyReport> {
    const result = await analyzeChunkConsistency(deps);
    if (result.state !== "converged") {
        throw new Error(
            `expected converged, got needs-convergence: ${JSON.stringify(result.divergence)}`,
        );
    }
    return result.report;
}

let counter = 0;

function file(path: string, chunkIds: string[]): FileDoc {
    return {
        _id: makeFileId(path),
        type: "file",
        schemaVersion: 2,
        chunks: chunkIds,
        mtime: 1000,
        ctime: 1000,
        size: 100,
        vclock: { A: 1 },
    };
}

async function chunk(label: string): Promise<ChunkDoc> {
    const content = new TextEncoder().encode(`data-${label}`);
    return {
        _id: makeChunkId(await computeHash(content)),
        type: "chunk",
        schemaVersion: 2,
        content,
    };
}

async function putLocal(db: LocalDB, docs: CouchSyncDoc[]): Promise<void> {
    await db.runWriteTx({
        docs: docs.filter((d) => d.type !== "chunk").map((d) => ({ doc: d })),
        chunks: docs.filter((d) => d.type === "chunk") as ChunkDoc[],
    });
}

describe("Integration: chunk-repair", () => {
    const cleanups: Array<() => Promise<void>> = [];

    function mkDevice(label: string): { db: LocalDB; remote: FakeCouchClient } {
        const db = new LocalDB(`integ-chunk-repair-${label}-${Date.now()}-${counter++}`);
        db.open();
        const remote = new FakeCouchClient();
        cleanups.push(async () => { await db.destroy(); });
        cleanups.push(async () => { await remote.destroy(); });
        return { db, remote };
    }

    afterEach(async () => {
        for (const fn of cleanups.splice(0)) await fn();
    });

    it("heals a localOnly chunk: push to remote closes the gap", async () => {
        const { db, remote } = mkDevice("push");

        const c = await chunk("drift-push");
        const f = file("a.md", [c._id]);
        // Local has FileDoc + chunk, remote only has the FileDoc.
        await putLocal(db, [c, f]);
        await seedRemote(remote, [f]);

        const before = await analyzeConverged({ localDb: db, remote });
        expect(before.localOnly).toEqual([c._id]);

        const result = await repairChunkDrift(
            planFromReport(before),
            { localDb: db, remote, chunkHasher: h },
        );
        expect(result.pushed).toBe(1);
        expect(result.failed).toEqual([]);

        const after = await analyzeConverged({ localDb: db, remote });
        expect(after.counts.localOnly).toBe(0);
        expect(after.counts.remoteOnly).toBe(0);
        expect(after.counts.missingReferenced).toBe(0);
    });

    it("heals a remoteOnly chunk: pull from remote closes the gap", async () => {
        const { db, remote } = mkDevice("pull");

        const c = await chunk("drift-pull");
        const f = file("b.md", [c._id]);
        // Remote has FileDoc + chunk, local only has the FileDoc.
        await putLocal(db, [f]);
        await seedRemote(remote, [c, f]);

        const before = await analyzeConverged({ localDb: db, remote });
        expect(before.remoteOnly).toEqual([c._id]);

        const result = await repairChunkDrift(
            planFromReport(before),
            { localDb: db, remote, chunkHasher: h },
        );
        expect(result.pulled).toBe(1);

        const after = await analyzeConverged({ localDb: db, remote });
        expect(after.counts.localOnly).toBe(0);
        expect(after.counts.remoteOnly).toBe(0);
    });

    it("heals bidirectional drift in a single run", async () => {
        const { db, remote } = mkDevice("both");

        const lc = await chunk("local-drift");
        const rc = await chunk("remote-drift");
        const fLocal = file("l.md", [lc._id]);
        const fRemote = file("r.md", [rc._id]);
        // Both sides have both FileDocs (so references are known everywhere),
        // but each side is missing exactly one of the chunks.
        await putLocal(db, [lc, fLocal, fRemote]);
        await seedRemote(remote, [rc, fLocal, fRemote]);

        const before = await analyzeConverged({ localDb: db, remote });
        expect(before.localOnly).toEqual([lc._id]);
        expect(before.remoteOnly).toEqual([rc._id]);

        const result = await repairChunkDrift(
            planFromReport(before),
            { localDb: db, remote, chunkHasher: h },
        );
        expect(result.pushed).toBe(1);
        expect(result.pulled).toBe(1);
        expect(result.failed).toEqual([]);

        const after = await analyzeConverged({ localDb: db, remote });
        expect(after.counts.localOnly).toBe(0);
        expect(after.counts.remoteOnly).toBe(0);
    });

    it("deletes one-sided orphans from the side they live on", async () => {
        const { db, remote } = mkDevice("one-sided-orphans");

        const kept = await chunk("kept");
        const localOrphan = await chunk("loc-only-orphan");
        const remoteOrphan = await chunk("rem-only-orphan");
        const ghost = makeChunkId("ghost");
        const healthy = file("h.md", [kept._id]);
        const broken = file("b.md", [ghost]);

        await putLocal(db, [kept, localOrphan, healthy, broken]);
        await seedRemote(remote, [kept, remoteOrphan, healthy, broken]);

        const before = await analyzeConverged({ localDb: db, remote });
        expect(before.orphanLocal).toEqual([localOrphan._id]);
        expect(before.orphanRemote).toEqual([remoteOrphan._id]);

        const result = await repairChunkDrift(
            planFromReport(before),
            { localDb: db, remote, chunkHasher: h },
        );
        // One-sided orphans are deleted from their side (neither copy
        // nor a no-op). This is where the repair complements GC.
        expect(result.deletedLocal).toBe(1);
        expect(result.deletedRemote).toBe(1);
        expect(result.pushed).toBe(0);
        expect(result.pulled).toBe(0);

        const after = await analyzeConverged({ localDb: db, remote });
        // Both one-sided orphans are gone. missingReferenced (ghost)
        // remains — it's unrecoverable and out of scope.
        expect(after.counts.orphanLocal).toBe(0);
        expect(after.counts.orphanRemote).toBe(0);
        expect(after.counts.localOnly).toBe(0);
        expect(after.counts.remoteOnly).toBe(0);
        expect(after.counts.missingReferenced).toBe(1);
        expect(after.missingReferenced[0].id).toBe(ghost);
    });

    it("only cleans one-sided orphans; two-sided orphans are GC's job", async () => {
        const { db, remote } = mkDevice("two-sided");

        const bothSidesOrphan = await chunk("both-orphan");
        // Seed the same unreferenced chunk on both sides, with no file
        // referencing it. The report will list it in orphanLocal AND
        // orphanRemote, but NOT in localOnly / remoteOnly.
        await putLocal(db, [bothSidesOrphan]);
        await seedRemote(remote, [bothSidesOrphan]);

        const before = await analyzeConverged({ localDb: db, remote });
        expect(before.localOnly).toEqual([]);
        expect(before.remoteOnly).toEqual([]);
        expect(before.orphanLocal).toEqual([bothSidesOrphan._id]);
        expect(before.orphanRemote).toEqual([bothSidesOrphan._id]);

        const result = await repairChunkDrift(
            planFromReport(before),
            { localDb: db, remote, chunkHasher: h },
        );
        expect(result.deletedLocal).toBe(0);
        expect(result.deletedRemote).toBe(0);

        const after = await analyzeConverged({ localDb: db, remote });
        // Untouched — GC will eventually handle it.
        expect(after.orphanLocal).toEqual([bothSidesOrphan._id]);
        expect(after.orphanRemote).toEqual([bothSidesOrphan._id]);
    });

    it("empty drift → repair is a no-op and report stays clean", async () => {
        const { db, remote } = mkDevice("noop");

        const c = await chunk("kept");
        const f = file("a.md", [c._id]);
        await putLocal(db, [c, f]);
        await seedRemote(remote, [c, f]);

        const before = await analyzeConverged({ localDb: db, remote });
        const result = await repairChunkDrift(
            planFromReport(before),
            { localDb: db, remote, chunkHasher: h },
        );
        expect(result.pushed).toBe(0);
        expect(result.pulled).toBe(0);

        const after = await analyzeConverged({ localDb: db, remote });
        expect(after.counts.localOnly).toBe(0);
        expect(after.counts.remoteOnly).toBe(0);
    });

    // ── Encrypted vault (codec client) ───────────────────
    //
    // The maintenance tooling must run through the codec (Encrypting)
    // client. Under encryption the remote stores `file:<hmac>` ids +
    // encrypted attachments; the analyzer/repair only ever see the
    // plaintext view the decorator restores. Regresses the v0.25.1→.2 bug
    // where the raw client made analyze permanently `needs-convergence`
    // and repair-pull either 404'd or wrote empty chunks.
    it("encrypted: analyze converges and repair-pull restores chunk content", async () => {
        const inner = new FakeCouchClient();
        const crypto = createCryptoProvider(await deriveKeys("pw", generateSalt()));
        const enc = new EncryptingCouchClient(inner, crypto);
        const db = new LocalDB(`integ-chunk-repair-enc-${Date.now()}-${counter++}`);
        db.open();
        cleanups.push(async () => { await db.destroy(); });
        cleanups.push(async () => { await inner.destroy(); });

        const c = await chunk("enc-drift-pull");
        const f = file("secret.md", [c._id]);
        // Local has only the FileDoc; remote (encrypted) has both.
        await putLocal(db, [f]);
        await seedRemote(enc, [c, f]);

        // The underlying store holds an ENCRYPTED attachment + hmac id.
        const rawRows = (await inner.allDocs<unknown>({
            startkey: "file:", endkey: "file;", include_docs: false,
        })).rows;
        expect(rawRows[0]?.id.startsWith("file:")).toBe(true);
        expect(rawRows[0]?.id).not.toBe(f._id); // hmac, not plaintext path
        const rawBlob = await inner.getAttachment(c._id, "c");
        expect(rawBlob).not.toBeNull();
        expect(decodeEnvelope(rawBlob!).bits.encrypted).toBe(true);

        // Analyze through the codec client converges and sees the gap.
        const before = await analyzeConverged({ localDb: db, remote: enc });
        expect(before.remoteOnly).toEqual([c._id]);

        const result = await repairChunkDrift(
            planFromReport(before),
            { localDb: db, remote: enc, chunkHasher: h },
        );
        expect(result.pulled).toBe(1);
        expect(result.failed).toEqual([]);

        // Pulled chunk landed with its DECRYPTED content, not an empty shell.
        const local = await db.getChunks([c._id]);
        expect(local).toHaveLength(1);
        expect(new TextDecoder().decode(local[0].content)).toBe("data-enc-drift-pull");

        const after = await analyzeConverged({ localDb: db, remote: enc });
        expect(after.counts.remoteOnly).toBe(0);
    });
});
