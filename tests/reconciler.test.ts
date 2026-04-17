import { describe, it, expect, beforeEach } from "vitest";
import { Reconciler, totalDiscrepancies } from "../src/sync/reconciler.ts";
import type { ScanCursor, VaultManifest } from "../src/db/local-db.ts";
import type { FileDoc } from "../src/types.ts";
import { makeFileId, filePathFromId } from "../src/types/doc-id.ts";

const SELF = "device-self";
const OTHER = "device-other";

interface FakeFile {
    path: string;
    stat: { mtime: number; ctime: number; size: number };
}

function makeFile(path: string, mtime: number, size = 100): FakeFile {
    return { path, stat: { mtime, ctime: mtime, size } };
}

/**
 * Build a FileDoc for tests in the PRODUCTION shape: `_id` is always
 * `"file:" + path`. Test fixtures that assert or key on vault paths
 * continue to use the bare path — it's only the stored document
 * that carries the prefix, mirroring what `LocalDB.allFileDocs()`
 * returns in production.
 *
 * `lastWriter` becomes the only key in the vclock (counter 1), so
 * reconciler.classifyMissingFromVault sees it as the latest-writing
 * device — functionally equivalent to the old `editedBy` field but
 * using the VC as the source of truth.
 */
function makeDoc(
    path: string,
    overrides: Partial<FileDoc> & { lastWriter?: string; deleted?: boolean } = {},
): FileDoc {
    const lastWriter = overrides.lastWriter ?? SELF;
    return {
        _id: makeFileId(path),
        type: "file",
        chunks: overrides.chunks ?? ["chunk:abc"],
        mtime: overrides.mtime ?? 1000,
        ctime: 1000,
        size: overrides.size ?? 100,
        vclock: overrides.vclock ?? { [lastWriter]: 1 },
        deleted: overrides.deleted,
    };
}

class FakeLocalDb {
    cursor: ScanCursor | null = null;
    manifest: VaultManifest | null = null;
    fileDocs = new Map<string, FileDoc>();
    private updateSeq = 0;

    async getScanCursor() { return this.cursor; }
    async putScanCursor(c: ScanCursor) { this.cursor = { ...c }; }
    async getVaultManifest() { return this.manifest; }
    async putVaultManifest(m: VaultManifest) { this.manifest = { paths: [...m.paths], updatedAt: m.updatedAt }; }
    async allFileDocs(): Promise<FileDoc[]> { return [...this.fileDocs.values()]; }
    async getFileDoc(path: string) { return this.fileDocs.get(path) ?? null; }
    /** Bump the simulated update_seq. Tests can call this to mimic
     *  external writes that the Reconciler short-circuit must notice. */
    bumpSeq() { this.updateSeq++; }
    async info() { return { updateSeq: this.updateSeq }; }
}

type CompareResult = "identical" | "local-unpushed" | "remote-pending";

interface FakeVaultSync {
    fileToDbCalls: string[];
    dbToFileCalls: string[];
    markDeletedCalls: string[];
    /** Per-path comparison override. Tests must set this explicitly. */
    compareResults: Map<string, CompareResult>;
    fileToDb(path: string): Promise<void>;
    dbToFile(doc: FileDoc): Promise<void>;
    markDeleted(path: string): Promise<void>;
    compareFileToDoc(doc: FileDoc, path: string, size: number): Promise<CompareResult>;
}

function makeVaultSync(): FakeVaultSync {
    return {
        fileToDbCalls: [],
        dbToFileCalls: [],
        markDeletedCalls: [],
        compareResults: new Map(),
        async fileToDb(path) { this.fileToDbCalls.push(path); },
        // Record the bare vault path (not the prefixed _id) so tests can
        // keep asserting `expect(dbToFileCalls).toEqual(["a.md"])`.
        async dbToFile(doc) { this.dbToFileCalls.push(filePathFromId(doc._id)); },
        async markDeleted(path) { this.markDeletedCalls.push(path); },
        async compareFileToDoc(doc, _path, _size) {
            // Fake honours compareResults keyed by vault path — extract
            // from the prefixed _id to match how tests register overrides.
            const key = filePathFromId(doc._id);
            const override = this.compareResults.get(key);
            if (override === undefined) {
                throw new Error(`test missing compareResults for ${key}`);
            }
            return override;
        },
    };
}

function setup(files: FakeFile[]) {
    const db = new FakeLocalDb();
    const vaultSync = makeVaultSync();
    const notifyCalls: string[] = [];
    const vault = { getFiles: () => files };
    const reconciler = new Reconciler(
        vault as any,
        db as any,
        vaultSync as any,
        () => ({ deviceId: SELF } as any),
        (msg) => notifyCalls.push(msg),
    );
    return { reconciler, db, vaultSync, files, notifyCalls };
}

describe("Reconciler", () => {
    describe("Case A: vault & DB match", () => {
        it("does nothing when content is identical", async () => {
            const h = setup([makeFile("a.md", 1000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { lastWriter: SELF }));
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };
            h.vaultSync.compareResults.set("a.md", "identical");

            const r = await h.reconciler.reconcile("manual");
            expect(r.inSync).toBe(1);
            expect(totalDiscrepancies(r)).toBe(0);
            expect(h.vaultSync.fileToDbCalls).toEqual([]);
            expect(h.vaultSync.dbToFileCalls).toEqual([]);
        });
    });

    describe("Case B: content differs", () => {
        it("local-win when vault is newer", async () => {
            const h = setup([makeFile("a.md", 5000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { mtime: 3000 }));
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };
            h.vaultSync.compareResults.set("a.md", "local-unpushed");

            const r = await h.reconciler.reconcile("manual");
            expect(r.localWins).toEqual(["a.md"]);
            expect(h.vaultSync.fileToDbCalls).toEqual(["a.md"]);
        });

        it("remote-win when remote is newer", async () => {
            const h = setup([makeFile("a.md", 1000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { mtime: 5000 }));
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };
            h.vaultSync.compareResults.set("a.md", "remote-pending");

            const r = await h.reconciler.reconcile("manual");
            expect(r.remoteWins).toEqual(["a.md"]);
            expect(h.vaultSync.dbToFileCalls).toEqual(["a.md"]);
        });

        it("local-newer regression: edits during a long pull are pushed by reconcile", async () => {
            // Reproduces the v0.9.0 bug: vault is newer (user edited during a
            // long pull) but the old reconcile classified it as in-sync because
            // the underlying skip predicate returned true for both "identical"
            // and "vault newer" reasons. The 3-value compareFileToDoc fixes it.
            const h = setup([makeFile("note.md", 9999)]);
            h.db.fileDocs.set("note.md", makeDoc("note.md", { mtime: 1000, lastWriter: SELF }));
            h.db.manifest = { paths: ["note.md"], updatedAt: 0 };
            h.vaultSync.compareResults.set("note.md", "local-unpushed");

            const r = await h.reconciler.reconcile("reconnect");
            expect(r.localWins).toEqual(["note.md"]);
            expect(r.inSync).toBe(0);
            expect(h.vaultSync.fileToDbCalls).toEqual(["note.md"]);
        });
    });

    describe("Case C: vault has, DB doesn't", () => {
        it("pushes new file when DB is empty", async () => {
            const h = setup([makeFile("new.md", 1000)]);
            const r = await h.reconciler.reconcile("manual");
            expect(r.pushed).toEqual(["new.md"]);
            expect(h.vaultSync.fileToDbCalls).toEqual(["new.md"]);
        });

        it("resurrects when DB has tombstone", async () => {
            const h = setup([makeFile("a.md", 1000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { deleted: true }));
            const r = await h.reconciler.reconcile("manual");
            expect(r.pushed).toEqual(["a.md"]);
            expect(h.vaultSync.fileToDbCalls).toEqual(["a.md"]);
        });
    });

    describe("Case D: vault missing, DB alive (the main bug fix)", () => {
        it("deletes when editedBy === self", async () => {
            const h = setup([]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { lastWriter: SELF }));
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };
            const r = await h.reconciler.reconcile("manual");
            expect(r.deleted).toEqual(["a.md"]);
            expect(h.vaultSync.markDeletedCalls).toEqual(["a.md"]);
        });

        it("deletes when editedBy === other but manifest had the path", async () => {
            const h = setup([]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { lastWriter: OTHER }));
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };
            const r = await h.reconciler.reconcile("manual");
            expect(r.deleted).toEqual(["a.md"]);
        });

        it("restores when editedBy === other AND manifest didn't have the path", async () => {
            const h = setup([]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { lastWriter: OTHER }));
            h.db.manifest = { paths: [], updatedAt: 0 };
            const r = await h.reconciler.reconcile("manual");
            expect(r.restored).toEqual(["a.md"]);
            expect(h.vaultSync.dbToFileCalls).toEqual(["a.md"]);
            expect(h.vaultSync.markDeletedCalls).toEqual([]);
        });

        it("manifest null falls back to restore (safe side, R1)", async () => {
            const h = setup([]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { lastWriter: SELF }));
            // No manifest set
            const r = await h.reconciler.reconcile("manual");
            expect(r.restored).toEqual(["a.md"]);
            expect(h.vaultSync.markDeletedCalls).toEqual([]);
        });
    });

    describe("Case E: vault missing, DB tombstone", () => {
        it("does nothing", async () => {
            const h = setup([]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { deleted: true }));
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };
            const r = await h.reconciler.reconcile("manual");
            expect(totalDiscrepancies(r)).toBe(0);
            expect(h.vaultSync.markDeletedCalls).toEqual([]);
        });
    });

    describe("short-circuit", () => {
        it("returns immediately when nothing has changed since last cursor", async () => {
            const h = setup([makeFile("a.md", 1000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md"));
            h.db.cursor = {
                lastScanStartedAt: Date.now(),
                lastScanCompletedAt: Date.now(),
                lastSeenUpdateSeq: 0,
            };
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };

            const r = await h.reconciler.reconcile("paused");
            expect(r.shortCircuited).toBe(true);
            expect(totalDiscrepancies(r)).toBe(0);
            // No vaultSync calls because we never entered the loop
            expect(h.vaultSync.fileToDbCalls).toEqual([]);
        });

        it("does not short-circuit when DB update_seq has advanced", async () => {
            const h = setup([makeFile("a.md", 1000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md"));
            h.db.cursor = {
                lastScanStartedAt: Date.now(),
                lastScanCompletedAt: Date.now(),
                lastSeenUpdateSeq: 0,
            };
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };
            h.vaultSync.compareResults.set("a.md", "identical");
            h.db.bumpSeq();

            const r = await h.reconciler.reconcile("paused");
            expect(r.shortCircuited).toBe(false);
            expect(r.inSync).toBe(1);
        });

        it("does not short-circuit when manifest doesn't match vault (delete pending)", async () => {
            const h = setup([]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { lastWriter: SELF }));
            h.db.cursor = {
                lastScanStartedAt: Date.now() + 60_000,
                lastScanCompletedAt: Date.now() + 60_000,
                lastSeenUpdateSeq: 0,
            };
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };

            const r = await h.reconciler.reconcile("onload");
            expect(r.shortCircuited).toBe(false);
            expect(r.deleted).toEqual(["a.md"]);
        });
    });

    describe("modes", () => {
        it("report mode does not apply changes", async () => {
            const h = setup([makeFile("new.md", 1000)]);
            h.db.fileDocs.set("old.md", makeDoc("old.md", { lastWriter: SELF }));
            h.db.manifest = { paths: ["old.md"], updatedAt: 0 };

            const r = await h.reconciler.reconcile("manual", { mode: "report" });
            expect(r.pushed).toEqual(["new.md"]);
            expect(r.deleted).toEqual(["old.md"]);
            // No side effects
            expect(h.vaultSync.fileToDbCalls).toEqual([]);
            expect(h.vaultSync.markDeletedCalls).toEqual([]);
        });

        it("report mode does not update manifest or cursor", async () => {
            const h = setup([makeFile("a.md", 1000)]);
            h.db.cursor = null;
            h.db.manifest = null;
            await h.reconciler.reconcile("manual", { mode: "report" });
            expect(h.db.cursor).toBeNull();
            expect(h.db.manifest).toBeNull();
        });
    });

    describe("guards & safety", () => {
        it("concurrent calls return immediately for the second one", async () => {
            const h = setup([makeFile("a.md", 1000)]);
            const p1 = h.reconciler.reconcile("manual");
            const p2 = h.reconciler.reconcile("manual");
            const [r1, r2] = await Promise.all([p1, p2]);
            const oneDidWork = r1.pushed.length === 1 || r2.pushed.length === 1;
            expect(oneDidWork).toBe(true);
        });

        it("warns when deletion exceeds 10% of vault (15 of 100)", async () => {
            const files: FakeFile[] = [];
            for (let i = 0; i < 100; i++) files.push(makeFile(`keep-${i}.md`, 1000));
            const h = setup(files);

            const manifestPaths = files.map((f) => f.path);
            for (let i = 0; i < 15; i++) {
                const p = `gone-${i}.md`;
                h.db.fileDocs.set(p, makeDoc(p, { lastWriter: SELF }));
                manifestPaths.push(p);
            }
            for (const f of files) h.db.fileDocs.set(f.path, makeDoc(f.path));
            h.db.manifest = { paths: manifestPaths, updatedAt: 0 };
            for (const f of files) h.vaultSync.compareResults.set(f.path, "identical");

            const r = await h.reconciler.reconcile("manual");
            expect(r.deleted.length).toBe(15);
            expect(h.notifyCalls.some((m) => m.includes("Large deletion"))).toBe(true);
        });

        it("yields the event loop on large vaults", async () => {
            const files: FakeFile[] = [];
            for (let i = 0; i < 200; i++) files.push(makeFile(`f-${i}.md`, 1000));
            const h = setup(files);
            // All new (case C), no DB docs
            const r = await h.reconciler.reconcile("manual");
            expect(r.pushed.length).toBe(200);
        });
    });

    describe("manifest persistence", () => {
        it("updates manifest with current vault paths after apply", async () => {
            const h = setup([makeFile("a.md", 1000), makeFile("b.md", 2000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md"));
            h.db.fileDocs.set("b.md", makeDoc("b.md"));
            h.vaultSync.compareResults.set("a.md", "identical");
            h.vaultSync.compareResults.set("b.md", "identical");

            await h.reconciler.reconcile("manual");
            expect(h.db.manifest).not.toBeNull();
            expect(new Set(h.db.manifest!.paths)).toEqual(new Set(["a.md", "b.md"]));
        });
    });

    /**
     * Regression test for the 227-file "push AND delete" bug.
     *
     * Background: after the ID redesign, `LocalDB.allFileDocs()` returns
     * FileDocs whose `_id` is `"file:" + vaultPath`. The reconciler used
     * to key its `dbByPath` map directly by `d._id`, which no longer
     * matches `vaultByPath` keys (bare vault paths). The result was that
     * every file got counted twice — once as Case C (push, missing from
     * DB) and once as Case D (delete, missing from vault).
     *
     * This test drives the reconciler with docs in the PRODUCTION shape
     * (`_id: makeFileId(path)`) and asserts that a fully-synced vault
     * requires zero changes.
     */
    describe("regression: prefixed FileDoc._id (production shape)", () => {
        it("zero changes when vault, DB (prefixed _ids) and manifest all align", async () => {
            // Simulate production: same N files in vault, DB, and manifest.
            const N = 227;
            const files: FakeFile[] = [];
            for (let i = 0; i < N; i++) files.push(makeFile(`notes/f-${i}.md`, 1000));
            const h = setup(files);

            // Production writes FileDocs with prefixed _ids. The fake
            // LocalDB is keyed by bare path internally (mirroring
            // LocalDB.getFileDoc(path)) but the STORED FileDoc carries
            // the prefixed _id — which is what `allFileDocs()` yields.
            for (const f of files) {
                const doc: FileDoc = {
                    _id: makeFileId(f.path),
                    type: "file",
                    chunks: ["chunk:abc"],
                    mtime: 1000,
                    ctime: 1000,
                    size: 100,
                    vclock: { [SELF]: 1 },
                };
                h.db.fileDocs.set(f.path, doc);
                h.vaultSync.compareResults.set(f.path, "identical");
            }
            h.db.manifest = { paths: files.map((f) => f.path), updatedAt: 0 };

            const r = await h.reconciler.reconcile("manual");

            // No churn: every file is already in sync.
            expect(r.pushed).toEqual([]);
            expect(r.deleted).toEqual([]);
            expect(r.localWins).toEqual([]);
            expect(r.remoteWins).toEqual([]);
            expect(r.restored).toEqual([]);
            expect(r.inSync).toBe(N);
            expect(totalDiscrepancies(r)).toBe(0);

            // And — the safety net assertion: no "Large deletion detected"
            // notification, which is what alerted us to the original bug.
            expect(h.notifyCalls.some((m) => m.includes("Large deletion"))).toBe(false);
        });
    });

    describe("case-insensitive path collapse", () => {
        it("treats vault 'AGENTS.md' and DB 'agents.md' as the same path (no spurious push/delete)", async () => {
            // Reproduces the case-insensitive FS bug: vault preserves
            // 'AGENTS.md' but DB doc was stored as 'agents.md'. Pre-fix
            // the reconciler classified them as two distinct paths and
            // emitted both a "push AGENTS.md" and a "delete agents.md".
            const h = setup([makeFile("AGENTS.md", 1000)]);
            h.db.fileDocs.set("agents.md", makeDoc("agents.md", { lastWriter: SELF }));
            h.db.manifest = { paths: ["AGENTS.md"], updatedAt: 0 };
            // Fake compareFileToDoc keys by the DB doc's stored path.
            h.vaultSync.compareResults.set("agents.md", "identical");

            const r = await h.reconciler.reconcile("manual");

            expect(r.inSync).toBe(1);
            expect(r.pushed).toEqual([]);
            expect(r.deleted).toEqual([]);
            expect(h.vaultSync.fileToDbCalls).toEqual([]);
            expect(h.vaultSync.markDeletedCalls).toEqual([]);
        });

        it("uses the vault's case for display when reporting reconciled paths", async () => {
            // When vault has 'README.md' and DB has 'readme.md' with a
            // local-unpushed compare result, the reconcile report should
            // surface the current vault casing — not the stale DB casing.
            const h = setup([makeFile("README.md", 5000)]);
            h.db.fileDocs.set("readme.md", makeDoc("readme.md", { mtime: 1000 }));
            h.db.manifest = { paths: ["README.md"], updatedAt: 0 };
            // Fake compareFileToDoc keys by the DB doc's stored path.
            h.vaultSync.compareResults.set("readme.md", "local-unpushed");

            const r = await h.reconciler.reconcile("manual");

            expect(r.localWins).toEqual(["README.md"]);
            expect(h.vaultSync.fileToDbCalls).toEqual(["README.md"]);
        });
    });
});
