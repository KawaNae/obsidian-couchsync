import { describe, it, expect } from "vitest";
import { Reconciler, totalDiscrepancies } from "../../src/sync/reconciler.ts";
import type { ScanCursor, VaultManifest } from "../../src/db/local-db.ts";
import type { DocsChangeSignature } from "../../src/db/dexie-store.ts";
import type { FileDoc } from "../../src/types.ts";
import { makeFileId, filePathFromId } from "../../src/types/doc-id.ts";
import type { LastSynced } from "../../src/sync/last-synced.ts";

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
    private docsSig: DocsChangeSignature = { maxDocSeq: 0, docCount: 0 };

    async getScanCursor() { return this.cursor; }
    async putScanCursor(c: ScanCursor) { this.cursor = { ...c }; }
    async getVaultManifest() { return this.manifest; }
    async putVaultManifest(m: VaultManifest) { this.manifest = { paths: [...m.paths], updatedAt: m.updatedAt }; }
    async allFileDocs(): Promise<FileDoc[]> { return [...this.fileDocs.values()]; }
    async getFileDoc(path: string) { return this.fileDocs.get(path) ?? null; }
    /** Mimic a docs-row write (a pull/push landing a FileDoc or chunk) —
     *  the only kind of write the Reconciler short-circuit must notice.
     *  Meta-only bookkeeping (checkpoints, vclocks) leaves the signature
     *  untouched by construction; that property is covered by the
     *  dexie-store signature tests against the real store. */
    bumpDocsSig() {
        this.docsSig = {
            maxDocSeq: this.docsSig.maxDocSeq + 1,
            docCount: this.docsSig.docCount,
        };
    }
    async docsChangeSignature(): Promise<DocsChangeSignature> {
        return { ...this.docsSig };
    }
}

// PR3: classifier returns 6 states; the legacy 3-state alias is kept
// as a typedef so tests reading old fixture names stay obvious.
type ClassifyResult =
    | "identical"
    | "vclock-only-drift"
    | "remote-edit"
    | "local-edit"
    | "true-divergent"
    | "legacy-skip";

interface FakeVaultSync {
    fileToDbCalls: string[];
    dbToFileCalls: string[];
    markDeletedCalls: string[];
    adoptVclockCalls: string[];
    alignCalls: string[];
    /** Per-path classifier override. Tests must set this explicitly. */
    compareResults: Map<string, ClassifyResult>;
    applyRemoteDeletionCalls: string[];
    /** Paths the test marks as having unpushed local edits (Case F gate). */
    unpushed: Set<string>;
    fileToDb(path: string): Promise<void>;
    dbToFile(doc: FileDoc): Promise<void>;
    markDeleted(path: string): Promise<void>;
    applyRemoteDeletion(path: string): Promise<void>;
    hasUnpushedChanges(path: string): Promise<boolean>;
    classifyFileVsDoc(doc: FileDoc, path: string, stat: { mtime: number; size: number }): Promise<ClassifyResult>;
    adoptDocVclock(path: string, doc: FileDoc, stat?: { mtime: number; size: number }): Promise<void>;
    alignLastSyncedToDoc(path: string, doc: FileDoc, stat?: { mtime: number; size: number }): Promise<"already-aligned" | "upgraded-legacy" | "recovered-stale" | "stamped-mtime">;
    /** Per-path integration baseline. Empty by default (legacy paths);
     *  tests populate it to exercise the lastSynced-primary Case D logic. */
    lastSyncedMap: Map<string, LastSynced>;
    getLastSynced(path: string): LastSynced | undefined;
    computeVaultChunks(path: string): Promise<string[]>;
    // Quarantine (Invariant II). Defaults to "nothing quarantined" so existing
    // restore/pull tests are unaffected.
    quarantinedCalls: string[];
    clearedCalls: string[];
    quarantined: Set<string>;
    wasQuarantined(path: string): Promise<boolean>;
    recordQuarantined(path: string, missingChunks: string[]): Promise<boolean>;
    clearQuarantined(path: string): Promise<void>;
}

function makeVaultSync(): FakeVaultSync {
    return {
        fileToDbCalls: [],
        dbToFileCalls: [],
        markDeletedCalls: [],
        adoptVclockCalls: [],
        alignCalls: [],
        applyRemoteDeletionCalls: [],
        unpushed: new Set<string>(),
        compareResults: new Map(),
        async fileToDb(path) { this.fileToDbCalls.push(path); },
        // Record the bare vault path (not the prefixed _id) so tests can
        // keep asserting `expect(dbToFileCalls).toEqual(["a.md"])`.
        async dbToFile(doc) { this.dbToFileCalls.push(filePathFromId(doc._id)); },
        async markDeleted(path) { this.markDeletedCalls.push(path); },
        async applyRemoteDeletion(path) {
            this.applyRemoteDeletionCalls.push(path);
            this.markDeletedCalls.push(path);
        },
        async hasUnpushedChanges(path) { return this.unpushed.has(path); },
        async classifyFileVsDoc(doc, _path, _stat) {
            // Fake honours compareResults keyed by vault path — extract
            // from the prefixed _id to match how tests register overrides.
            const key = filePathFromId(doc._id);
            const override = this.compareResults.get(key);
            if (override === undefined) {
                throw new Error(`test missing compareResults for ${key}`);
            }
            return override;
        },
        async adoptDocVclock(path, _doc, _stat) {
            this.adoptVclockCalls.push(path);
        },
        async alignLastSyncedToDoc(path, _doc, _stat) {
            this.alignCalls.push(path);
            return "already-aligned" as const;
        },
        // Per-path integration baseline. Defaults to empty, so paths with no
        // explicit entry fall to the manifest fallback (legacy behaviour).
        // Tests set entries to drive the lastSynced-primary Case D branch.
        lastSyncedMap: new Map<string, LastSynced>(),
        getLastSynced(path) { return this.lastSyncedMap.get(path); },
        async computeVaultChunks(_path) { return []; },
        quarantinedCalls: [],
        clearedCalls: [],
        quarantined: new Set<string>(),
        async wasQuarantined(path) { return this.quarantined.has(path); },
        async recordQuarantined(path, _missingChunks) {
            // Mirror the real isNew contract: record (and would-notify) only on
            // a newly-quarantined path; repeat calls are silent.
            const had = this.quarantined.has(path);
            this.quarantined.add(path);
            if (!had) this.quarantinedCalls.push(path);
            return !had;
        },
        async clearQuarantined(path) {
            this.clearedCalls.push(path);
            this.quarantined.delete(path);
        },
    };
}

function setup(
    files: FakeFile[],
    ensureChunks?: (doc: FileDoc) => Promise<{ stillMissing: string[]; remoteConsulted: boolean }>,
) {
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
        ensureChunks as any,
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

    describe("disposal barrier (#err-7)", () => {
        it("skips the trailing manifest/cursor persist when disposed mid-run", async () => {
            const h = setup([makeFile("a.md", 1000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { lastWriter: SELF }));
            // Slow path: null manifest + cursor so runOnce reaches the
            // trailing persist instead of short-circuiting on the fast path.
            h.db.manifest = null;
            h.db.cursor = null;
            // Latch disposed mid-run (during classify), before the persist.
            h.vaultSync.classifyFileVsDoc = (async () => {
                h.reconciler.destroy();
                return "identical";
            }) as any;

            await h.reconciler.reconcile("manual");

            // The unguarded persist used to race teardown (DatabaseClosedError);
            // now it is skipped, leaving manifest/cursor untouched.
            expect(h.db.manifest).toBeNull();
            expect(h.db.cursor).toBeNull();
        });
    });

    describe("Case B: content differs", () => {
        it("local-win when vault is newer", async () => {
            const h = setup([makeFile("a.md", 5000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { mtime: 3000 }));
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };
            h.vaultSync.compareResults.set("a.md", "local-edit");

            const r = await h.reconciler.reconcile("manual");
            expect(r.localWins).toEqual(["a.md"]);
            expect(h.vaultSync.fileToDbCalls).toEqual(["a.md"]);
        });

        it("remote-win when remote is newer", async () => {
            const h = setup([makeFile("a.md", 1000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { mtime: 5000 }));
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };
            h.vaultSync.compareResults.set("a.md", "remote-edit");

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
            h.vaultSync.compareResults.set("note.md", "local-edit");

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

        // Invariant 7: a vault file over a DB tombstone routes through the
        // classifier instead of a blind fileToDb (whose divergent guard
        // skipped every relation except local-edit — the W24 wedged path).
        it("recreate-pushes over a tombstone when classifier says local-edit", async () => {
            const h = setup([makeFile("a.md", 1000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { deleted: true }));
            h.vaultSync.compareResults.set("a.md", "local-edit");
            const r = await h.reconciler.reconcile("manual");
            expect(r.pushed).toEqual(["a.md"]);
            expect(h.vaultSync.fileToDbCalls).toEqual(["a.md"]);
        });

        it("applies the pending deletion when classifier says remote-edit", async () => {
            const h = setup([makeFile("a.md", 1000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { deleted: true }));
            h.vaultSync.compareResults.set("a.md", "remote-edit");
            const r = await h.reconciler.reconcile("manual");
            expect(r.deleted).toEqual(["a.md"]);
            expect(h.vaultSync.dbToFileCalls).toEqual(["a.md"]);
            expect(h.vaultSync.fileToDbCalls).toEqual([]);
        });

        it("routes true-divergent (the W24 wedged state) to handleDivergentRecreate", async () => {
            const h = setup([makeFile("a.md", 1000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { deleted: true }));
            h.vaultSync.compareResults.set("a.md", "true-divergent");
            const recreateCalls: string[] = [];
            h.reconciler.setConflictOrchestrator({
                handleDivergentRecreate: async (path: string) => { recreateCalls.push(path); },
            } as any);
            const r = await h.reconciler.reconcile("manual");
            expect(recreateCalls).toEqual(["a.md"]);
            expect(r.pushed).toEqual(["a.md"]);
            expect(h.vaultSync.fileToDbCalls).toEqual([]);
        });

        it("leaves true-divergent untouched without an orchestrator (no silent restore/delete)", async () => {
            const h = setup([makeFile("a.md", 1000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { deleted: true }));
            h.vaultSync.compareResults.set("a.md", "true-divergent");
            const r = await h.reconciler.reconcile("manual");
            expect(r.pushed).toEqual([]);
            expect(r.deleted).toEqual([]);
            expect(h.vaultSync.fileToDbCalls).toEqual([]);
            expect(h.vaultSync.dbToFileCalls).toEqual([]);
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

        // Invariant II (G2): a broken FileDoc (chunks missing on this device
        // AND the server) must be quarantined, not restore-looped. Reproduces
        // the field ping-pong (couchsync_log_* with GC'd chunks).
        it("quarantines (not restores) when chunks are missing everywhere", async () => {
            const broken = async () => ({ stillMissing: ["chunk:x64:gone"], remoteConsulted: true });
            const h = setup([], broken);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { lastWriter: OTHER }));
            h.db.manifest = { paths: [], updatedAt: 0 };

            const r1 = await h.reconciler.reconcile("manual");
            expect(r1.quarantined).toEqual(["a.md"]);
            expect(r1.restored).toEqual([]);
            expect(h.vaultSync.dbToFileCalls).toEqual([]); // no opaque restore attempt
            expect(h.vaultSync.quarantinedCalls).toEqual(["a.md"]);

            // Second cycle: re-probes (still broken) → stays quarantined, but
            // recordQuarantined's isNew guard means no repeat notice, and it
            // never reaches dbToFile so there is no restore ping-pong.
            const r2 = await h.reconciler.reconcile("manual");
            expect(r2.restored).toEqual([]);
            expect(h.vaultSync.dbToFileCalls).toEqual([]);
            expect(h.vaultSync.quarantinedCalls).toEqual(["a.md"]); // not re-recorded (isNew=false)
        });

        it("recovers a quarantined file once its chunks become available", async () => {
            // ensureChunks now reports the chunks available (e.g. re-pushed) →
            // reconcile clears the quarantine and restores.
            const available = async () => ({ stillMissing: [], remoteConsulted: true });
            const h = setup([], available);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { lastWriter: OTHER }));
            h.db.manifest = { paths: [], updatedAt: 0 };
            h.vaultSync.quarantined.add("a.md"); // previously quarantined

            const r = await h.reconciler.reconcile("manual");
            expect(h.vaultSync.clearedCalls).toEqual(["a.md"]);
            expect(r.restored).toEqual(["a.md"]);
            expect(h.vaultSync.dbToFileCalls).toEqual(["a.md"]);
        });
    });

    // H-1: lastSynced (per-path integration baseline) is the PRIMARY oracle
    // for Case D; the manifest is only a fallback. A path this device pulled
    // (lastSynced set) but had not yet reconciled into the manifest must NOT be
    // resurrected when its delete event is dropped — the missing file is a real
    // local delete and must propagate as a tombstone.
    describe("Case D: lastSynced-primary classification (H-1)", () => {
        it("tombstones a pulled-then-deleted path even when absent from the manifest", async () => {
            const h = setup([]); // vault missing the file (deleted, event dropped)
            h.db.fileDocs.set("a.md", makeDoc("a.md", { lastWriter: OTHER }));
            h.db.manifest = { paths: [], updatedAt: 0 }; // manifest lags the pull
            // Integration baseline equal to the doc (pull set it; no later pull
            // advanced it) — the divergent guard must NOT fire here.
            h.vaultSync.lastSyncedMap.set("a.md", { vclock: { [OTHER]: 1 } });

            const r = await h.reconciler.reconcile("manual");

            expect(r.deleted).toEqual(["a.md"]);
            expect(h.vaultSync.markDeletedCalls).toEqual(["a.md"]);
            expect(r.restored).toEqual([]); // the old manifest-blind bug
            expect(h.vaultSync.dbToFileCalls).toEqual([]);
        });

        it("without an integration baseline, still restores (manifest fallback unchanged)", async () => {
            const h = setup([]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { lastWriter: OTHER }));
            h.db.manifest = { paths: [], updatedAt: 0 };
            // No lastSynced entry → never integrated here → remote-created.

            const r = await h.reconciler.reconcile("manual");

            expect(r.restored).toEqual(["a.md"]);
            expect(h.vaultSync.markDeletedCalls).toEqual([]);
        });
    });

    describe("Disposal barrier (Invariant III / G5)", () => {
        it("destroy() stops new reconcile work (no DB writes after unload)", async () => {
            const h = setup([]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { lastWriter: OTHER }));
            h.db.manifest = { paths: [], updatedAt: 0 };
            h.reconciler.destroy();
            const r = await h.reconciler.reconcile("manual");
            expect(r.restored).toEqual([]);
            expect(h.vaultSync.dbToFileCalls).toEqual([]);
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
                lastSeenDocsSig: { maxDocSeq: 0, docCount: 0 },
            };
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };

            const r = await h.reconciler.reconcile("paused");
            expect(r.shortCircuited).toBe(true);
            expect(totalDiscrepancies(r)).toBe(0);
            // No vaultSync calls because we never entered the loop
            expect(h.vaultSync.fileToDbCalls).toEqual([]);
        });

        it("does not short-circuit when a docs row changed", async () => {
            const h = setup([makeFile("a.md", 1000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md"));
            h.db.cursor = {
                lastScanStartedAt: Date.now(),
                lastScanCompletedAt: Date.now(),
                lastSeenDocsSig: { maxDocSeq: 0, docCount: 0 },
            };
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };
            h.vaultSync.compareResults.set("a.md", "identical");
            h.db.bumpDocsSig();

            const r = await h.reconciler.reconcile("paused");
            expect(r.shortCircuited).toBe(false);
            expect(r.inSync).toBe(1);
        });

        it("does not short-circuit when the cursor predates the signature (legacy cursor)", async () => {
            const h = setup([makeFile("a.md", 1000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md"));
            // A cursor persisted by a pre-signature build has no
            // lastSeenDocsSig — must read as "unknown" → slow path once.
            h.db.cursor = {
                lastScanStartedAt: Date.now(),
                lastScanCompletedAt: Date.now(),
            };
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };
            h.vaultSync.compareResults.set("a.md", "identical");

            const r = await h.reconciler.reconcile("paused");
            expect(r.shortCircuited).toBe(false);
            // The slow scan re-persists the cursor in the new shape, so
            // the immediate next run short-circuits.
            expect(h.db.cursor?.lastSeenDocsSig).toEqual({ maxDocSeq: 0, docCount: 0 });
            const r2 = await h.reconciler.reconcile("paused");
            expect(r2.shortCircuited).toBe(true);
        });

        it("does not short-circuit when manifest doesn't match vault (delete pending)", async () => {
            const h = setup([]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { lastWriter: SELF }));
            h.db.cursor = {
                lastScanStartedAt: Date.now() + 60_000,
                lastScanCompletedAt: Date.now() + 60_000,
                lastSeenDocsSig: { maxDocSeq: 0, docCount: 0 },
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
            h.vaultSync.compareResults.set("readme.md", "local-edit");

            const r = await h.reconciler.reconcile("manual");

            expect(r.localWins).toEqual(["README.md"]);
            expect(h.vaultSync.fileToDbCalls).toEqual(["README.md"]);
        });
    });

    describe("Case F: PathKey collision (S4/S5)", () => {
        it("converges two same-content docs to the vclock-canonical case (DB-only variant)", async () => {
            // The scripts/Scripts incident on a case-insensitive device: vault
            // holds one file (Scripts/X), DB holds BOTH docs. Scripts/X
            // dominates scripts/X causally → canonical. scripts/X has no
            // exact-case file here → tombstone only (no disk delete).
            const h = setup([makeFile("Scripts/X", 1000)]);
            h.db.fileDocs.set("Scripts/X", makeDoc("Scripts/X", { vclock: { [OTHER]: 1, [SELF]: 1 } }));
            h.db.fileDocs.set("scripts/X", makeDoc("scripts/X", { vclock: { [OTHER]: 1 } }));
            h.db.manifest = { paths: ["Scripts/X"], updatedAt: 0 };

            const r = await h.reconciler.reconcile("manual");

            expect(r.collisionsResolved).toEqual(["Scripts/X"]);
            expect(h.vaultSync.markDeletedCalls).toEqual(["scripts/X"]);
            expect(h.vaultSync.applyRemoteDeletionCalls).toEqual([]); // no disk delete
            expect(h.vaultSync.dbToFileCalls).toEqual([]); // canonical already on disk
        });

        it("removes the non-canonical physical file on a case-sensitive FS", async () => {
            // Android: both case-variant files on disk, both docs present.
            const h = setup([makeFile("scripts/X", 1000), makeFile("Scripts/X", 1000)]);
            h.db.fileDocs.set("Scripts/X", makeDoc("Scripts/X", { vclock: { [OTHER]: 1, [SELF]: 1 } }));
            h.db.fileDocs.set("scripts/X", makeDoc("scripts/X", { vclock: { [OTHER]: 1 } }));
            h.db.manifest = { paths: ["Scripts/X", "scripts/X"], updatedAt: 0 };

            const r = await h.reconciler.reconcile("manual");

            expect(r.collisionsResolved).toEqual(["Scripts/X"]);
            // scripts/X has an exact-case file → disk delete + tombstone.
            expect(h.vaultSync.applyRemoteDeletionCalls).toEqual(["scripts/X"]);
        });

        it("does NOT auto-resolve when the variants have different content", async () => {
            const h = setup([makeFile("Scripts/X", 1000)]);
            h.db.fileDocs.set("Scripts/X", makeDoc("Scripts/X", { chunks: ["chunk:aaa"], vclock: { [SELF]: 1 } }));
            h.db.fileDocs.set("scripts/X", makeDoc("scripts/X", { chunks: ["chunk:bbb"], vclock: { [OTHER]: 1 } }));
            h.db.manifest = { paths: ["Scripts/X"], updatedAt: 0 };

            const r = await h.reconciler.reconcile("manual");

            expect(r.collisionsResolved).toEqual([]);
            expect(h.vaultSync.markDeletedCalls).toEqual([]);
            expect(h.vaultSync.applyRemoteDeletionCalls).toEqual([]);
        });

        it("does NOT auto-resolve when a colliding file has unpushed edits", async () => {
            const h = setup([makeFile("Scripts/X", 1000)]);
            h.db.fileDocs.set("Scripts/X", makeDoc("Scripts/X", { vclock: { [OTHER]: 1, [SELF]: 1 } }));
            h.db.fileDocs.set("scripts/X", makeDoc("scripts/X", { vclock: { [OTHER]: 1 } }));
            h.db.manifest = { paths: ["Scripts/X"], updatedAt: 0 };
            h.vaultSync.unpushed.add("Scripts/X");

            const r = await h.reconciler.reconcile("manual");

            expect(r.collisionsResolved).toEqual([]);
            expect(h.vaultSync.markDeletedCalls).toEqual([]);
        });

        it("fast-path does not short-circuit when the vault holds a case-duplicate (S7)", async () => {
            // Steady-state inputs that would otherwise short-circuit (cursor +
            // matching manifest + unchanged seq + old mtime), but two files
            // fold to one PathKey → the slow path must run and resolve.
            const h = setup([makeFile("scripts/X", 100), makeFile("Scripts/X", 100)]);
            h.db.fileDocs.set("Scripts/X", makeDoc("Scripts/X", { vclock: { [OTHER]: 1, [SELF]: 1 } }));
            h.db.fileDocs.set("scripts/X", makeDoc("scripts/X", { vclock: { [OTHER]: 1 } }));
            h.db.manifest = { paths: ["scripts/X", "Scripts/X"], updatedAt: 0 };
            h.db.cursor = {
                lastScanStartedAt: 10_000,
                lastScanCompletedAt: 10_000,
                lastSeenDocsSig: { maxDocSeq: 0, docCount: 0 },
            };

            const r = await h.reconciler.reconcile("onload");

            expect(r.shortCircuited).toBe(false);
            expect(r.collisionsResolved).toEqual(["Scripts/X"]);
        });

        it("concurrent variants pick a path-deterministic canonical, independent of vclock key order (H-2)", async () => {
            // Genuinely concurrent (no causal dominator): the canonical must be
            // a DEVICE-INVARIANT choice. The old tiebreak used latestDevice(),
            // which depended on vclock key order — and mergeVC can persist the
            // same logical clock with different key order per device — so two
            // devices could pick different canonicals and tombstone each other.
            // Raw path (doc id) is byte-identical everywhere → both key orders
            // of {A:1,C:1} must resolve to the same canonical.
            const run = async (scriptsUpperVclock: Record<string, number>) => {
                const h = setup([makeFile("Scripts/X", 1000)]);
                h.db.fileDocs.set("Scripts/X", makeDoc("Scripts/X", { vclock: scriptsUpperVclock }));
                h.db.fileDocs.set("scripts/X", makeDoc("scripts/X", { vclock: { B: 2 } }));
                h.db.manifest = { paths: ["Scripts/X"], updatedAt: 0 };
                const r = await h.reconciler.reconcile("manual");
                return r.collisionsResolved;
            };
            expect(await run({ A: 1, C: 1 })).toEqual(["Scripts/X"]);
            expect(await run({ C: 1, A: 1 })).toEqual(["Scripts/X"]); // same, despite key order
        });
    });
});
