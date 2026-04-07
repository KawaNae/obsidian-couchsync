import { describe, it, expect, afterEach } from "vitest";
import { CatchUpScanner } from "../src/sync/catch-up.ts";
import type { ScanCursor } from "../src/db/local-db.ts";
import type { FileDoc } from "../src/types.ts";

interface FakeFile {
    path: string;
    stat: { mtime: number; ctime: number; size: number };
}

function makeFile(path: string, mtime: number): FakeFile {
    return { path, stat: { mtime, ctime: mtime, size: 100 } };
}

/** In-memory stand-in for LocalDB exposing only what CatchUpScanner uses. */
class FakeLocalDb {
    private cursor: ScanCursor | null = null;
    private fileDocs = new Map<string, FileDoc>();

    async getScanCursor(): Promise<ScanCursor | null> {
        return this.cursor;
    }
    async putScanCursor(cursor: ScanCursor): Promise<void> {
        this.cursor = { ...cursor };
    }
    async getFileDoc(path: string): Promise<FileDoc | null> {
        return this.fileDocs.get(path) ?? null;
    }
    async getFileDocs(paths: string[]): Promise<Map<string, FileDoc>> {
        const result = new Map<string, FileDoc>();
        for (const p of paths) {
            const doc = this.fileDocs.get(p);
            if (doc) result.set(p, doc);
        }
        return result;
    }
    setFileDoc(doc: FileDoc): void {
        this.fileDocs.set(doc._id, doc);
    }
}

function setupHarness(files: FakeFile[]) {
    const localDb = new FakeLocalDb();

    const fileToDbCalls: string[] = [];
    const vaultSync = {
        fileToDb: async (file: { path: string }) => {
            fileToDbCalls.push(file.path);
        },
    };

    const statusBar = { update: () => {} };
    const app = { vault: { getFiles: () => files } };

    const scanner = new CatchUpScanner(
        app as any,
        localDb as any,
        vaultSync as any,
        statusBar as any,
    );

    return { scanner, localDb, fileToDbCalls, files };
}

describe("CatchUpScanner", () => {
    let harness: ReturnType<typeof setupHarness>;

    afterEach(() => {
        // FakeLocalDb has no persistent resources to release.
        harness = undefined as any;
    });

    it("first scan with no cursor processes all files", async () => {
        harness = setupHarness([
            makeFile("a.md", 1000),
            makeFile("b.md", 2000),
        ]);
        const synced = await harness.scanner.scan("onload");
        expect(synced).toBe(2);
        expect(harness.fileToDbCalls.sort()).toEqual(["a.md", "b.md"]);
    });

    it("first scan persists cursor after completion", async () => {
        harness = setupHarness([makeFile("a.md", 1000)]);
        await harness.scanner.scan("onload");
        const cursor = await harness.localDb.getScanCursor();
        expect(cursor).not.toBeNull();
        expect(cursor!.lastScanStartedAt).toBeGreaterThan(0);
        expect(cursor!.lastScanCompletedAt).toBeGreaterThanOrEqual(cursor!.lastScanStartedAt);
    });

    it("subsequent scan with all files unchanged is zero-cost", async () => {
        // First scan with files newer than time 0
        harness = setupHarness([
            makeFile("a.md", 1000),
            makeFile("b.md", 2000),
        ]);
        await harness.scanner.scan("onload");
        harness.fileToDbCalls.length = 0;

        // Second scan: cursor has been set to ~Date.now(), all file mtimes are
        // far below threshold (after subtracting 5s margin) → no candidates.
        const synced = await harness.scanner.scan("startSync");
        expect(synced).toBe(0);
        expect(harness.fileToDbCalls).toEqual([]);
    });

    it("scan picks up files modified after cursor", async () => {
        harness = setupHarness([makeFile("a.md", 1000)]);
        await harness.scanner.scan("onload");
        harness.fileToDbCalls.length = 0;

        // Mutate the file to a future mtime well beyond the safety margin.
        harness.files[0].stat.mtime = Date.now() + 60_000;
        const synced = await harness.scanner.scan("startSync");
        expect(synced).toBe(1);
        expect(harness.fileToDbCalls).toEqual(["a.md"]);
    });

    it("concurrent scans are dropped (running guard)", async () => {
        harness = setupHarness([makeFile("a.md", 1000)]);
        const p1 = harness.scanner.scan("onload");
        const p2 = harness.scanner.scan("onload");
        const [r1, r2] = await Promise.all([p1, p2]);
        // One scan does the work; the other returns 0 immediately.
        expect((r1 === 1 && r2 === 0) || (r1 === 0 && r2 === 1)).toBe(true);
    });

    it("clock skew safety margin: files with mtime within 5s of cursor still scan", async () => {
        harness = setupHarness([makeFile("a.md", 1000)]);
        await harness.scanner.scan("onload");
        const cursor = await harness.localDb.getScanCursor();
        // Place a file just 1s before cursor — it should still be considered
        // a candidate due to the 5s safety margin.
        harness.files.push(makeFile("b.md", cursor!.lastScanStartedAt - 1000));
        harness.fileToDbCalls.length = 0;
        const synced = await harness.scanner.scan("startSync");
        // The candidate filter passes b.md, but fileToDb is only called when
        // existing.mtime < file.mtime. Since b.md has no existing doc, it
        // should be synced.
        expect(synced).toBe(1);
        expect(harness.fileToDbCalls).toEqual(["b.md"]);
    });
});
