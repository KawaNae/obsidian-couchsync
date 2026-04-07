import { describe, it, expect, beforeEach } from "vitest";
import { Reconciler, totalDiscrepancies } from "../src/sync/reconciler.ts";
import type { ScanCursor, VaultManifest } from "../src/db/local-db.ts";
import type { FileDoc } from "../src/types.ts";

const SELF = "device-self";
const OTHER = "device-other";

interface FakeFile {
    path: string;
    stat: { mtime: number; ctime: number; size: number };
}

function makeFile(path: string, mtime: number, size = 100): FakeFile {
    return { path, stat: { mtime, ctime: mtime, size } };
}

function makeDoc(
    path: string,
    overrides: Partial<FileDoc> & { editedBy?: string; deleted?: boolean } = {},
): FileDoc {
    return {
        _id: path,
        type: "file",
        chunks: ["chunk:abc"],
        mtime: overrides.mtime ?? 1000,
        ctime: 1000,
        size: overrides.size ?? 100,
        editedAt: overrides.editedAt ?? 1000,
        editedBy: overrides.editedBy ?? SELF,
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
    /** Bump the simulated PouchDB update_seq. Tests can call this to mimic
     *  external writes that the Reconciler short-circuit must notice. */
    bumpSeq() { this.updateSeq++; }
    getDb() {
        const seq = () => this.updateSeq;
        return { info: async () => ({ update_seq: seq() }) } as any;
    }
}

interface FakeVaultSync {
    fileToDbCalls: string[];
    dbToFileCalls: string[];
    markDeletedCalls: string[];
    skipResults: Map<string, boolean>;
    fileToDb(file: { path: string }): Promise<void>;
    dbToFile(doc: FileDoc): Promise<void>;
    markDeleted(path: string): Promise<void>;
    checkSkipWrite(doc: FileDoc, file: any): Promise<boolean>;
}

function makeVaultSync(): FakeVaultSync {
    return {
        fileToDbCalls: [],
        dbToFileCalls: [],
        markDeletedCalls: [],
        skipResults: new Map(),
        async fileToDb(file) { this.fileToDbCalls.push(file.path); },
        async dbToFile(doc) { this.dbToFileCalls.push(doc._id); },
        async markDeleted(path) { this.markDeletedCalls.push(path); },
        async checkSkipWrite(doc, file) {
            const v = this.skipResults.get(doc._id);
            return v ?? false;
        },
    };
}

function setup(files: FakeFile[]) {
    const db = new FakeLocalDb();
    const vaultSync = makeVaultSync();
    const notifyCalls: string[] = [];
    const app = { vault: { getFiles: () => files } };
    const reconciler = new Reconciler(
        app as any,
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
            h.db.fileDocs.set("a.md", makeDoc("a.md", { editedBy: SELF }));
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };
            h.vaultSync.skipResults.set("a.md", true);

            const r = await h.reconciler.reconcile("manual");
            expect(r.inSync).toBe(1);
            expect(totalDiscrepancies(r)).toBe(0);
            expect(h.vaultSync.fileToDbCalls).toEqual([]);
            expect(h.vaultSync.dbToFileCalls).toEqual([]);
        });
    });

    describe("Case B: content differs", () => {
        it("local-win when vault mtime > remote editedAt", async () => {
            const h = setup([makeFile("a.md", 5000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { editedAt: 3000 }));
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };
            h.vaultSync.skipResults.set("a.md", false);

            const r = await h.reconciler.reconcile("manual");
            expect(r.localWins).toEqual(["a.md"]);
            expect(h.vaultSync.fileToDbCalls).toEqual(["a.md"]);
        });

        it("remote-win when remote editedAt > vault mtime", async () => {
            const h = setup([makeFile("a.md", 1000)]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { editedAt: 5000 }));
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };
            h.vaultSync.skipResults.set("a.md", false);

            const r = await h.reconciler.reconcile("manual");
            expect(r.remoteWins).toEqual(["a.md"]);
            expect(h.vaultSync.dbToFileCalls).toEqual(["a.md"]);
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
            h.db.fileDocs.set("a.md", makeDoc("a.md", { editedBy: SELF }));
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };
            const r = await h.reconciler.reconcile("manual");
            expect(r.deleted).toEqual(["a.md"]);
            expect(h.vaultSync.markDeletedCalls).toEqual(["a.md"]);
        });

        it("deletes when editedBy === other but manifest had the path", async () => {
            const h = setup([]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { editedBy: OTHER }));
            h.db.manifest = { paths: ["a.md"], updatedAt: 0 };
            const r = await h.reconciler.reconcile("manual");
            expect(r.deleted).toEqual(["a.md"]);
        });

        it("restores when editedBy === other AND manifest didn't have the path", async () => {
            const h = setup([]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { editedBy: OTHER }));
            h.db.manifest = { paths: [], updatedAt: 0 };
            const r = await h.reconciler.reconcile("manual");
            expect(r.restored).toEqual(["a.md"]);
            expect(h.vaultSync.dbToFileCalls).toEqual(["a.md"]);
            expect(h.vaultSync.markDeletedCalls).toEqual([]);
        });

        it("manifest null falls back to restore (safe side, R1)", async () => {
            const h = setup([]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { editedBy: SELF }));
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
            h.vaultSync.skipResults.set("a.md", true);
            h.db.bumpSeq();

            const r = await h.reconciler.reconcile("paused");
            expect(r.shortCircuited).toBe(false);
            expect(r.inSync).toBe(1);
        });

        it("does not short-circuit when manifest doesn't match vault (delete pending)", async () => {
            const h = setup([]);
            h.db.fileDocs.set("a.md", makeDoc("a.md", { editedBy: SELF }));
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
            h.db.fileDocs.set("old.md", makeDoc("old.md", { editedBy: SELF }));
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
                h.db.fileDocs.set(p, makeDoc(p, { editedBy: SELF }));
                manifestPaths.push(p);
            }
            for (const f of files) h.db.fileDocs.set(f.path, makeDoc(f.path));
            h.db.manifest = { paths: manifestPaths, updatedAt: 0 };
            for (const f of files) h.vaultSync.skipResults.set(f.path, true);

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
            h.vaultSync.skipResults.set("a.md", true);
            h.vaultSync.skipResults.set("b.md", true);

            await h.reconciler.reconcile("manual");
            expect(h.db.manifest).not.toBeNull();
            expect(new Set(h.db.manifest!.paths)).toEqual(new Set(["a.md", "b.md"]));
        });
    });
});
