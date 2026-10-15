import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { VaultSync } from "../../src/sync/vault-sync.ts";
import { FilesystemVaultWriter } from "../../src/sync/vault-writer.ts";
import { LocalDB } from "../../src/db/local-db.ts";
import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { makeSettings } from "../helpers/settings-factory.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";
import { FILE_SCHEMA_VERSION } from "../../src/types.ts";
import { splitIntoChunks } from "../../src/db/chunker.ts";
import { RACY_MTIME_WINDOW_MS } from "../../src/sync/last-synced.ts";

let counter = 0;
function uniqueDbName() { return `vault-sync-test-${Date.now()}-${counter++}`; }

describe("VaultSync", () => {
    let vault: FakeVaultIO;
    let db: LocalDB;
    let vs: VaultSync;
    let settings: ReturnType<typeof makeSettings>;

    beforeEach(() => {
        vault = new FakeVaultIO();
        db = new LocalDB(uniqueDbName());
        db.open();
        settings = makeSettings({ deviceId: "dev-A" });
        const writer = new FilesystemVaultWriter(vault);
        vs = new VaultSync(vault, db, () => settings, writer);
    });

    afterEach(async () => {
        await db.destroy();
    });

    // ── fileToDb ────────────────────────────────────────

    describe("fileToDb", () => {
        it("stores file content as chunks in DB", async () => {
            vault.addFile("hello.md", "Hello, world!");

            await vs.fileToDb("hello.md");

            const fileDoc = await db.get(makeFileId("hello.md")) as FileDoc;
            expect(fileDoc).not.toBeNull();
            expect(fileDoc.type).toBe("file");
            expect(fileDoc.chunks.length).toBeGreaterThan(0);

            // Verify chunks exist
            const chunks = await db.getChunks(fileDoc.chunks);
            expect(chunks.length).toBe(fileDoc.chunks.length);
        });

        it("increments vclock with device ID", async () => {
            vault.addFile("a.md", "content");

            await vs.fileToDb("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            expect(doc.vclock).toEqual({ "dev-A": 1 });
        });

        it("increments existing vclock on second write", async () => {
            vault.addFile("a.md", "v1");
            await vs.fileToDb("a.md");

            // Modify content
            vault.addFile("a.md", "v2");
            await vs.fileToDb("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            expect(doc.vclock["dev-A"]).toBe(2);
        });

        it("skips files exceeding maxFileSizeMB", async () => {
            settings.maxFileSizeMB = 0.001; // ~1 KB
            const bigContent = "x".repeat(2000);
            vault.addFile("big.md", bigContent);

            await vs.fileToDb("big.md");

            const doc = await db.get(makeFileId("big.md"));
            expect(doc).toBeNull();
        });

        it("skips files matching syncIgnore pattern", async () => {
            settings.syncIgnore = "\\.private\\.md$";
            vault.addFile("secret.private.md", "secret");

            await vs.fileToDb("secret.private.md");

            const doc = await db.get(makeFileId("secret.private.md"));
            expect(doc).toBeNull();
        });

        it("skips files not matching syncFilter pattern", async () => {
            settings.syncFilter = "^notes/";
            vault.addFile("outside.md", "content");

            await vs.fileToDb("outside.md");

            const doc = await db.get(makeFileId("outside.md"));
            expect(doc).toBeNull();
        });

        it("does not write when content is unchanged", async () => {
            vault.addFile("a.md", "same");
            await vs.fileToDb("a.md");
            const doc1 = await db.get(makeFileId("a.md")) as FileDoc;

            // Re-push same content
            await vs.fileToDb("a.md");
            const doc2 = await db.get(makeFileId("a.md")) as FileDoc;

            // vclock should NOT have been incremented
            expect(doc2.vclock).toEqual(doc1.vclock);
        });

        it("records stat from vault", async () => {
            vault.addFile("a.md", "content", { mtime: 5000, ctime: 3000 });

            await vs.fileToDb("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            expect(doc.mtime).toBe(5000);
            expect(doc.ctime).toBe(3000);
        });

        it("does nothing when file disappears before read", async () => {
            // Don't add file to vault — stat returns null
            await vs.fileToDb("gone.md");

            const doc = await db.get(makeFileId("gone.md"));
            expect(doc).toBeNull();
        });
    });

    // ── dbToFile ────────────────────────────────────────

    describe("dbToFile", () => {
        /** `text` at `path` as another device sent it, with its chunks
         *  stored locally as the pull fetches them before writing. */
        async function remoteDoc(
            path: string, text: string, vclock: Record<string, number>,
        ): Promise<FileDoc> {
            const buf = new TextEncoder().encode(text).buffer;
            const chunks = await splitIntoChunks(buf);
            await db.runWriteTx({ chunks: chunks as unknown as CouchSyncDoc[] });
            return {
                _id: makeFileId(path), schemaVersion: FILE_SCHEMA_VERSION, type: "file",
                chunks: chunks.map((c) => c._id), mtime: 1, ctime: 1,
                size: buf.byteLength, vclock,
            };
        }

        /** A tombstone another device made after `doc`. */
        function remoteTombstone(doc: FileDoc): FileDoc {
            return { ...doc, deleted: true, vclock: { ...doc.vclock, "dev-B": 9 } };
        }

        it("writes file content to vault", async () => {
            const doc = await remoteDoc("a.md", "Hello from DB", { "dev-B": 1 });

            await vs.dbToFile(doc);

            expect(vault.files.has("a.md")).toBe(true);
            expect(vault.readText("a.md")).toBe("Hello from DB");
        });

        it("overwrites existing file", async () => {
            vault.addFile("a.md", "v1");
            await vs.fileToDb("a.md");
            const doc = await remoteDoc("a.md", "v2", { "dev-A": 1, "dev-B": 1 });

            const res = await vs.dbToFile(doc);

            expect(res).toEqual({ applied: true });
            expect(vault.readText("a.md")).toBe("v2");
        });

        it("deletes file for tombstone", async () => {
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            await vs.dbToFile(remoteTombstone(doc));

            expect(vault.files.has("a.md")).toBe(false);
        });

        it("applies a deletion whose vclock equals the baseline (hard delete on pull)", async () => {
            // The pull turns a CouchDB deletion into a tombstone carrying the
            // local doc's vclock; with the vault unchanged it is applied.
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");
            const doc = await db.get(makeFileId("a.md")) as FileDoc;

            const res = await vs.dbToFile({ ...doc, deleted: true });

            expect(res).toEqual({ applied: true });
            expect(vault.files.has("a.md")).toBe(false);
        });

        describe("a vault changed since the last sync", () => {
            const DECLINED = { applied: false, reason: "unsynced-vault-change" };

            it("keeps an edited file and leaves the baseline", async () => {
                vault.addFile("a.md", "v1");
                await vs.fileToDb("a.md");
                const before = vs.getLastSynced("a.md");
                vault.addFile("a.md", "my edit", { mtime: Date.now() + 1000 });
                const doc = await remoteDoc("a.md", "v2", { "dev-A": 1, "dev-B": 1 });

                const res = await vs.dbToFile(doc);

                expect(res).toEqual(DECLINED);
                expect(vault.readText("a.md")).toBe("my edit");
                expect(vs.getLastSynced("a.md")).toEqual(before);
                // The reconcile finds the path diverged.
                const stat = (await vault.stat("a.md"))!;
                expect(await vs.classifyFileVsDoc(doc, "a.md", stat)).toBe("true-divergent");
            });

            it("keeps an edit of the same size with a fresh mtime", async () => {
                vault.addFile("a.md", "aaaa", { mtime: 1000 });
                await vs.fileToDb("a.md");
                vault.addFile("a.md", "bbbb", { mtime: 2000 });
                const doc = await remoteDoc("a.md", "cccc", { "dev-A": 1, "dev-B": 1 });

                expect(await vs.dbToFile(doc)).toEqual(DECLINED);
                expect(vault.readText("a.md")).toBe("bbbb");
            });

            it("does not recreate a file the user deleted", async () => {
                vault.addFile("a.md", "v1");
                await vs.fileToDb("a.md");
                vault.files.delete("a.md");
                const doc = await remoteDoc("a.md", "v2", { "dev-A": 1, "dev-B": 1 });

                expect(await vs.dbToFile(doc)).toEqual(DECLINED);
                expect(vault.files.has("a.md")).toBe(false);
            });

            it("does not delete an edited file", async () => {
                vault.addFile("a.md", "v1");
                await vs.fileToDb("a.md");
                const doc = await db.get(makeFileId("a.md")) as FileDoc;
                vault.addFile("a.md", "my edit", { mtime: Date.now() + 1000 });

                expect(await vs.dbToFile(remoteTombstone(doc))).toEqual(DECLINED);
                expect(vault.readText("a.md")).toBe("my edit");
                expect(vs.getLastSynced("a.md")?.deleted).toBeUndefined();
            });

            it("does not delete a file made after a synced deletion", async () => {
                vault.addFile("a.md", "v1");
                await vs.fileToDb("a.md");
                const doc = await db.get(makeFileId("a.md")) as FileDoc;
                const tomb = remoteTombstone(doc);
                await vs.dbToFile(tomb);
                vault.addFile("a.md", "made again");

                const again = { ...tomb, vclock: { ...tomb.vclock, "dev-B": 10 } };
                expect(await vs.dbToFile(again)).toEqual(DECLINED);
                expect(vault.readText("a.md")).toBe("made again");
            });

            it("does not delete a file never synced here", async () => {
                vault.addFile("a.md", "never synced");
                const doc = await remoteDoc("a.md", "theirs", { "dev-B": 1 });

                expect(await vs.dbToFile(remoteTombstone(doc))).toEqual(DECLINED);
                expect(vault.readText("a.md")).toBe("never synced");
            });

            it("replaces it when the caller holds the user's decision", async () => {
                vault.addFile("a.md", "v1");
                await vs.fileToDb("a.md");
                vault.addFile("a.md", "my edit", { mtime: Date.now() + 1000 });
                const doc = await remoteDoc("a.md", "v2", { "dev-A": 1, "dev-B": 1 });

                const res = await vs.dbToFile(doc, { overwriteVaultChange: true });

                expect(res).toEqual({ applied: true });
                expect(vault.readText("a.md")).toBe("v2");
                expect(vs.getLastSynced("a.md")?.chunks).toEqual(doc.chunks);
            });

            it("applies a deletion to a file the user already deleted", async () => {
                vault.addFile("a.md", "v1");
                await vs.fileToDb("a.md");
                const doc = await db.get(makeFileId("a.md")) as FileDoc;
                vault.files.delete("a.md");

                expect(await vs.dbToFile(remoteTombstone(doc))).toEqual({ applied: true });
                expect(vs.getLastSynced("a.md")?.deleted).toBe(true);
            });

            it("writes content where the file has no baseline, as the reconcile does", async () => {
                // No baseline: the classifier calls this remote-edit and the
                // reconcile writes it, so a declined write would never be offered.
                vault.addFile("a.md", "never synced");
                const doc = await remoteDoc("a.md", "theirs", { "dev-B": 1 });

                expect(await vs.dbToFile(doc)).toEqual({ applied: true });
                expect(vault.readText("a.md")).toBe("theirs");
            });
        });

        it("rejects a remote path that escapes the vault (traversal)", async () => {
            vault.addFile("seed.md", "payload");
            await vs.fileToDb("seed.md");
            const seed = await db.get(makeFileId("seed.md")) as FileDoc;

            // Server-controlled _id with a parent-traversal path (the
            // plaintext-vault attack vector). Reuse the valid chunks so only
            // the path is hostile.
            const evil = { ...seed, _id: makeFileId("../evil.md") } as FileDoc;
            const res = await vs.dbToFile(evil);

            expect(res).toEqual({ applied: false, reason: "unsafe-path" });
            expect(vault.files.has("../evil.md")).toBe(false);
        });

        it("rejects a tombstone whose path escapes the vault (delete-via-traversal)", async () => {
            vault.addFile("seed.md", "payload");
            await vs.fileToDb("seed.md");
            const seed = await db.get(makeFileId("seed.md")) as FileDoc;

            // The tombstone branch bypasses shouldSync, so the path gate must
            // precede it — a hostile tombstone must not delete outside the vault.
            const evilDel = { ...seed, _id: makeFileId("../victim.md"), deleted: true } as FileDoc;
            const res = await vs.dbToFile(evilDel);

            expect(res).toEqual({ applied: false, reason: "unsafe-path" });
        });

        it("skips pull when total chunk size exceeds maxFileSizeMB (symmetric to push)", async () => {
            vault.addFile("big.md", "y".repeat(4000));
            await vs.fileToDb("big.md");
            vault.files.delete("big.md");
            const doc = await db.get(makeFileId("big.md")) as FileDoc;

            settings.maxFileSizeMB = 0.001; // ~1 KB, below the ~4 KB content
            const res = await vs.dbToFile(doc);

            expect(res).toEqual({ applied: false, reason: "exceeds-max-size" });
            expect(vault.files.has("big.md")).toBe(false);
        });

        it("skips write when vault content already matches", async () => {
            vault.addFile("a.md", "same");
            await vs.fileToDb("a.md");

            // Capture vault state, run dbToFile with the doc that
            // matches what's already on disk, expect no mutation.
            const beforeMtime = (await vault.stat("a.md"))?.mtime;
            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            await vs.dbToFile(doc);
            const afterMtime = (await vault.stat("a.md"))?.mtime;

            expect(afterMtime).toBe(beforeMtime);
        });
    });

    // ── classifyFileVsDoc (replaces legacy compareFileToDoc) ─

    describe("classifyFileVsDoc", () => {
        it("returns identical when content matches", async () => {
            vault.addFile("a.md", "same");
            await vs.fileToDb("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            const stat = (await vault.stat("a.md"))!;
            const result = await vs.classifyFileVsDoc(doc, "a.md", stat);
            expect(result).toBe("identical");
        });

        it("returns local-edit when vault has changed", async () => {
            vault.addFile("a.md", "v1");
            await vs.fileToDb("a.md");
            await vs.loadLastSyncedVclocks();

            // Change vault content without pushing
            vault.addFile("a.md", "v2-local-edit", { size: 999 });

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            const result = await vs.classifyFileVsDoc(doc, "a.md", (await vault.stat("a.md"))!);
            expect(result).toBe("local-edit");
        });

        it("returns true-divergent when db has newer vclock and vault drifted", async () => {
            vault.addFile("a.md", "v1");
            await vs.fileToDb("a.md");
            await vs.loadLastSyncedVclocks();

            // Simulate remote update by directly modifying DB
            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            const updated = { ...doc, vclock: { "dev-A": 1, "dev-B": 1 }, size: 888 };
            await db.runWriteTx({ docs: [{ doc: updated as any }] });

            // Vault has different content from both lastSynced and remote.
            vault.addFile("a.md", "v1-but-different", { size: 777 });
            const result = await vs.classifyFileVsDoc(updated as FileDoc, "a.md", (await vault.stat("a.md"))!);
            // The classifier detects "right dominates AND left drifted from
            // baseline" → true-divergent (instead of legacy remote-pending
            // which had a separate divergent-edit guard).
            expect(result).toBe("true-divergent");
        });
    });

    // ── diskChunkIds stat cache (lastSynced.mtime) ──────

    describe("diskChunkIds stat cache", () => {
        function countReads(): () => number {
            let reads = 0;
            const orig = vault.readBinary.bind(vault);
            vault.readBinary = async (p: string) => { reads++; return orig(p); };
            return () => reads;
        }

        it("classifyFileVsDoc serves the fingerprint from cache when (mtime,size) matches", async () => {
            vault.addFile("c.md", "cached", { mtime: 7000 });
            await vs.fileToDb("c.md"); // stamps lastSynced.mtime = 7000

            const doc = await db.get(makeFileId("c.md")) as FileDoc;
            const reads = countReads();
            const result = await vs.classifyFileVsDoc(doc, "c.md", { mtime: 7000, size: 6 });
            expect(result).toBe("identical");
            expect(reads()).toBe(0);
        });

        it("re-hashes when the stat mtime differs from the stamp", async () => {
            vault.addFile("c.md", "cached", { mtime: 7000 });
            await vs.fileToDb("c.md");

            const doc = await db.get(makeFileId("c.md")) as FileDoc;
            const reads = countReads();
            const result = await vs.classifyFileVsDoc(doc, "c.md", { mtime: 8000, size: 6 });
            expect(result).toBe("identical"); // content really is unchanged
            expect(reads()).toBe(1);
        });

        it("re-hashes when the baseline has no mtime stamp (legacy entry)", async () => {
            vault.addFile("c.md", "cached", { mtime: 7000 });
            await vs.fileToDb("c.md");
            // Rewrite the baseline WITHOUT mtime — the pre-stamp shape.
            const doc = await db.get(makeFileId("c.md")) as FileDoc;
            await db.runWriteTx({
                vclocks: [{
                    path: "c.md", op: "set", clock: doc.vclock,
                    chunks: doc.chunks, size: doc.size,
                }],
            });
            await vs.loadLastSyncedVclocks();

            const reads = countReads();
            const result = await vs.classifyFileVsDoc(doc, "c.md", { mtime: 7000, size: 6 });
            expect(result).toBe("identical");
            expect(reads()).toBe(1);
        });

        it("alignLastSyncedToDoc warms up a missing stamp (stamped-mtime), then settles", async () => {
            vault.addFile("c.md", "cached", { mtime: 7000 });
            await vs.fileToDb("c.md");
            const doc = await db.get(makeFileId("c.md")) as FileDoc;
            // Strip the stamp to simulate a pre-mtime vault.
            await db.runWriteTx({
                vclocks: [{
                    path: "c.md", op: "set", clock: doc.vclock,
                    chunks: doc.chunks, size: doc.size,
                }],
            });
            await vs.loadLastSyncedVclocks();

            const first = await vs.alignLastSyncedToDoc("c.md", doc, { mtime: 7000, size: 6 });
            expect(first).toBe("stamped-mtime");
            const second = await vs.alignLastSyncedToDoc("c.md", doc, { mtime: 7000, size: 6 });
            expect(second).toBe("already-aligned");
            // The stamp survives a reload (persisted, not memory-only).
            await vs.loadLastSyncedVclocks();
            expect(vs.getLastSynced("c.md")?.mtime).toBe(7000);
        });

        it("alignLastSyncedToDoc skips the stamp when the stat size mismatches the doc", async () => {
            vault.addFile("c.md", "cached", { mtime: 7000 });
            await vs.fileToDb("c.md");
            const doc = await db.get(makeFileId("c.md")) as FileDoc;
            await db.runWriteTx({
                vclocks: [{
                    path: "c.md", op: "set", clock: doc.vclock,
                    chunks: doc.chunks, size: doc.size,
                }],
            });
            await vs.loadLastSyncedVclocks();

            // A stat whose size disagrees with the doc does not describe the
            // integrated content (unflushed editor buffer) — no stamp.
            const r = await vs.alignLastSyncedToDoc("c.md", doc, { mtime: 9000, size: 999 });
            expect(r).toBe("already-aligned");
            expect(vs.getLastSynced("c.md")?.mtime).toBeUndefined();
        });

        it("a stamp too recent to trust is not kept: a same-size rewrite with the same mtime is seen", async () => {
            const t = Date.now();
            vault.addFile("r.md", "aa", { mtime: t });
            await vs.fileToDb("r.md");
            expect(vs.getLastSynced("r.md")?.mtime).toBeUndefined();
            await vs.loadLastSyncedVclocks();
            expect(vs.getLastSynced("r.md")?.mtime).toBeUndefined();

            // Rewritten within the mtime resolution: same mtime, same size.
            vault.addFile("r.md", "bb", { mtime: t });
            const doc = await db.get(makeFileId("r.md")) as FileDoc;
            const reads = countReads();
            const result = await vs.classifyFileVsDoc(doc, "r.md", { mtime: t, size: 2 });
            expect(reads()).toBe(1);
            expect(result).not.toBe("identical");

            // The startup drift scan hashes it too and records the rewrite.
            expect(await vs.stampVaultDrift()).toBe(1);
            const after = await db.get(makeFileId("r.md")) as FileDoc;
            expect(after.chunks).not.toEqual(doc.chunks);
        });

        it("a stamp old enough is kept, and a later check is served from it", async () => {
            const old = Date.now() - RACY_MTIME_WINDOW_MS - 1;
            vault.addFile("o.md", "aa", { mtime: old });
            await vs.fileToDb("o.md");
            expect(vs.getLastSynced("o.md")?.mtime).toBe(old);
            await vs.loadLastSyncedVclocks();
            expect(vs.getLastSynced("o.md")?.mtime).toBe(old);

            const doc = await db.get(makeFileId("o.md")) as FileDoc;
            const reads = countReads();
            expect(await vs.classifyFileVsDoc(doc, "o.md", { mtime: old, size: 2 })).toBe("identical");
            expect(reads()).toBe(0);
            expect(await vs.stampVaultDrift()).toBe(0);
        });

        it("dbToFile stamps the post-write disk mtime once it is old enough", async () => {
            const remote: FileDoc = {
                _id: makeFileId("pulled.md"),
                type: "file",
                chunks: [],
                mtime: 123, // sender's mtime — must NOT end up in the stamp
                ctime: 123,
                size: 0,
                vclock: { "dev-B": 1 },
            };
            // Build the real chunks for some content.
            vault.addFile("seed.md", "from remote");
            await vs.fileToDb("seed.md");
            const seed = await db.get(makeFileId("seed.md")) as FileDoc;
            const pulled = { ...remote, chunks: seed.chunks, size: seed.size };
            await db.runWriteTx({ docs: [{ doc: pulled as any }] });

            const res = await vs.dbToFile(pulled);
            expect(res.applied).toBe(true);

            // Just written: too recent to stamp.
            const stat = (await vault.stat("pulled.md"))!;
            expect(vs.getLastSynced("pulled.md")!.mtime).toBeUndefined();

            // A later reconcile align stamps the disk mtime (never the sender's).
            const now = vi.spyOn(Date, "now").mockReturnValue(stat.mtime + RACY_MTIME_WINDOW_MS);
            try {
                expect(await vs.alignLastSyncedToDoc("pulled.md", pulled, stat)).toBe("stamped-mtime");
            } finally {
                now.mockRestore();
            }
            const ls = vs.getLastSynced("pulled.md")!;
            expect(ls.mtime).toBe(stat.mtime);
            expect(ls.mtime).not.toBe(123);
        });
    });

    // ── markDeleted ─────────────────────────────────────

    describe("markDeleted", () => {
        it("marks existing doc as deleted", async () => {
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");

            await vs.markDeleted("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            expect(doc.deleted).toBe(true);
        });

        it("increments vclock on deletion", async () => {
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");

            await vs.markDeleted("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            expect(doc.vclock["dev-A"]).toBe(2);
        });
    });

    // ── handleRename ────────────────────────────────────

    describe("handleRename", () => {
        it("creates new doc and deletes old", async () => {
            vault.addFile("old.md", "content");
            await vs.fileToDb("old.md");

            // Simulate rename
            const data = vault.files.get("old.md")!.data;
            vault.files.delete("old.md");
            vault.addBinaryFile("new.md", data);

            await vs.handleRename("new.md", "old.md");

            const newDoc = await db.get(makeFileId("new.md")) as FileDoc;
            const oldDoc = await db.get(makeFileId("old.md")) as FileDoc;
            expect(newDoc).not.toBeNull();
            expect(newDoc.type).toBe("file");
            expect(oldDoc.deleted).toBe(true);
        });
    });

    // ── applyRemoteDeletion ─────────────────────────────

    describe("applyRemoteDeletion", () => {
        it("deletes file from vault and marks in DB", async () => {
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");

            await vs.applyRemoteDeletion("a.md");

            expect(vault.files.has("a.md")).toBe(false);
            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            expect(doc.deleted).toBe(true);
        });

        it("handles already-missing file gracefully", async () => {
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");
            vault.files.delete("a.md"); // already gone

            await vs.applyRemoteDeletion("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            expect(doc.deleted).toBe(true);
        });
    });

    // ── hasUnpushedChanges (chunks-aware pending-edit oracle) ─

    describe("hasUnpushedChanges", () => {
        it("returns false when no integration baseline exists", async () => {
            expect(await vs.hasUnpushedChanges("a.md")).toBe(false);
        });

        it("returns false when vault matches the integration baseline", async () => {
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");

            expect(await vs.hasUnpushedChanges("a.md")).toBe(false);
        });

        it("returns true when vault disk drifts from baseline (size differs)", async () => {
            vault.addFile("a.md", "v1");
            await vs.fileToDb("a.md");

            // Simulate a user edit landing on disk before fileToDb fires.
            vault.addFile("a.md", "v2-local-edit-much-longer", { size: 999 });
            expect(await vs.hasUnpushedChanges("a.md")).toBe(true);
        });

        it("returns true when vault drifts but size is unchanged (chunks differ)", async () => {
            vault.addFile("a.md", "abcde");
            await vs.fileToDb("a.md");
            const ls1 = vs.getLastSynced("a.md")!;

            // Same byte length, different content → different chunks.
            vault.addFile("a.md", "vwxyz", { size: ls1.size });
            expect(await vs.hasUnpushedChanges("a.md")).toBe(true);
        });

        it("returns true when ChangeTracker has a debounced sync pending", async () => {
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");
            // Vault disk equals baseline — chunks check would say false.
            expect(await vs.hasUnpushedChanges("a.md")).toBe(false);

            // Wire a fake probe to simulate ChangeTracker reporting pending.
            vs.setPendingProbe({
                hasPending: (p: string) => p === "a.md",
            });
            expect(await vs.hasUnpushedChanges("a.md")).toBe(true);
            expect(await vs.hasUnpushedChanges("other.md")).toBe(false);
        });

        it("returns false when vault file is missing (deletion path handles it)", async () => {
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");
            await vault.delete("a.md");

            expect(await vs.hasUnpushedChanges("a.md")).toBe(false);
        });
    });
});
