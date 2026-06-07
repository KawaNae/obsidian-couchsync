import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { HistoryCapture } from "../src/history/history-capture.ts";
import { computeHash } from "../src/db/chunker.ts";
import { FakeVaultIO } from "./helpers/fake-vault-io.ts";
import { FakeVaultEvents } from "./helpers/fake-vault-events.ts";
import { makeSettings } from "./helpers/settings-factory.ts";
import type { FileSnapshot, HistorySource } from "../src/history/types.ts";

const stat = { mtime: 1000, ctime: 1000, size: 100 };

interface SavedDiff {
    filePath: string;
    patches: string;
    baseHash: string;
    added: number;
    removed: number;
    conflict: boolean;
    source: HistorySource | undefined;
}

class FakeHistoryStorage {
    diffs: SavedDiff[] = [];
    snapshots = new Map<string, FileSnapshot>();
    renames: Array<{ oldPath: string; newPath: string }> = [];

    async saveDiff(
        filePath: string,
        patches: string,
        baseHash: string,
        added: number,
        removed: number,
        conflict = false,
        source: HistorySource = "local",
    ): Promise<void> {
        this.diffs.push({
            filePath,
            patches,
            baseHash,
            added,
            removed,
            conflict,
            source: source === "local" ? undefined : source,
        });
    }

    async getSnapshot(filePath: string): Promise<FileSnapshot | undefined> {
        return this.snapshots.get(filePath);
    }

    async saveSnapshot(filePath: string, content: string): Promise<void> {
        this.snapshots.set(filePath, { filePath, content, lastModified: Date.now() });
    }

    async renamePath(oldPath: string, newPath: string): Promise<void> {
        this.renames.push({ oldPath, newPath });
        const snap = this.snapshots.get(oldPath);
        if (snap) {
            this.snapshots.delete(oldPath);
            this.snapshots.set(newPath, { ...snap, filePath: newPath });
        }
    }
}

describe("HistoryCapture", () => {
    beforeAll(async () => {
        // Preload xxhash WASM so fake timers don't race the dynamic import.
        await computeHash("warmup");
    });

    let vault: FakeVaultIO;
    let events: FakeVaultEvents;
    let storage: FakeHistoryStorage;
    let settings: ReturnType<typeof makeSettings>;
    let capture: HistoryCapture;

    beforeEach(() => {
        vi.useFakeTimers();
        vault = new FakeVaultIO();
        events = new FakeVaultEvents();
        storage = new FakeHistoryStorage();
        settings = makeSettings({
            historyDebounceMs: 100,
            historyMinIntervalMs: 0,
            historyExcludePatterns: [],
        });
        capture = new HistoryCapture(vault, events, storage as any, () => settings);
    });

    afterEach(() => {
        capture.stop();
        vi.useRealTimers();
    });

    // ── Lifecycle ───────────────────────────────────────

    describe("start/stop", () => {
        it("registers modify/rename/delete handlers on start", () => {
            expect(events.subscriberCount).toBe(0);
            capture.start();
            expect(events.subscriberCount).toBe(3);
        });

        it("unregisters all handlers on stop", () => {
            capture.start();
            capture.stop();
            expect(events.subscriberCount).toBe(0);
        });

        it("stop clears pending debounce timers", async () => {
            capture.start();
            vault.addFile("a.md", "v1");
            events.emit("modify", "a.md", stat);

            capture.stop();
            await vi.advanceTimersByTimeAsync(1000);

            expect(storage.diffs).toHaveLength(0);
        });
    });

    // ── Path filtering ──────────────────────────────────

    describe("path filtering", () => {
        it("ignores dotfiles", async () => {
            capture.start();
            vault.addFile(".hidden.md", "content");
            events.emit("modify", ".hidden.md", stat);

            await vi.advanceTimersByTimeAsync(100);

            expect(storage.diffs).toHaveLength(0);
        });

        it("ignores excludePatterns (glob)", async () => {
            settings.historyExcludePatterns = ["*.tmp"];
            capture.start();
            vault.addFile("note.tmp", "x");
            events.emit("modify", "note.tmp", stat);

            await vi.advanceTimersByTimeAsync(100);

            expect(storage.diffs).toHaveLength(0);
        });

        it("captureSyncWrite respects dotfile filter", async () => {
            vault.addFile(".secret.md", "content");
            await capture.captureSyncWrite(".secret.md");
            expect(storage.diffs).toHaveLength(0);
        });
    });

    // ── Debounce ────────────────────────────────────────

    describe("debounce", () => {
        it("captures after debounce window", async () => {
            capture.start();
            vault.addFile("a.md", "hello");
            events.emit("modify", "a.md", stat);

            expect(storage.diffs).toHaveLength(0);
            await vi.advanceTimersByTimeAsync(100);

            expect(storage.diffs).toHaveLength(1);
            expect(storage.diffs[0].filePath).toBe("a.md");
        });

        it("rapid modify events collapse to one capture", async () => {
            capture.start();
            vault.addFile("a.md", "v1");

            events.emit("modify", "a.md", stat);
            await vi.advanceTimersByTimeAsync(50);
            events.emit("modify", "a.md", stat); // resets timer
            await vi.advanceTimersByTimeAsync(50);
            events.emit("modify", "a.md", stat); // resets timer
            await vi.advanceTimersByTimeAsync(100);

            expect(storage.diffs).toHaveLength(1);
        });
    });

    // ── Rate limit ──────────────────────────────────────

    describe("rate limit", () => {
        it("defers capture when within historyMinIntervalMs", async () => {
            settings.historyMinIntervalMs = 500;
            capture.start();
            vault.addFile("a.md", "v1");

            events.emit("modify", "a.md", stat);
            await vi.advanceTimersByTimeAsync(100);
            expect(storage.diffs).toHaveLength(1);

            vault.addFile("a.md", "v2");
            events.emit("modify", "a.md", stat);
            await vi.advanceTimersByTimeAsync(100); // debounce fires, enters rate-limit pending
            // Still 1 — second capture is pending rate-limit window
            expect(storage.diffs).toHaveLength(1);

            await vi.advanceTimersByTimeAsync(500);
            expect(storage.diffs).toHaveLength(2);
        });
    });

    // ── captureChange local ─────────────────────────────

    describe("local capture", () => {
        it("skips capture when content unchanged since last snapshot", async () => {
            capture.start();
            vault.addFile("a.md", "same");
            await storage.saveSnapshot("a.md", "same");

            events.emit("modify", "a.md", stat);
            await vi.advanceTimersByTimeAsync(100);

            expect(storage.diffs).toHaveLength(0);
        });

        it("saves diff with source undefined (local)", async () => {
            capture.start();
            vault.addFile("a.md", "hello");
            events.emit("modify", "a.md", stat);

            await vi.advanceTimersByTimeAsync(100);

            expect(storage.diffs[0].source).toBeUndefined();
            expect(storage.diffs[0].conflict).toBe(false);
        });

        it("saves snapshot alongside diff", async () => {
            capture.start();
            vault.addFile("a.md", "content");
            events.emit("modify", "a.md", stat);

            await vi.advanceTimersByTimeAsync(100);

            expect(storage.snapshots.get("a.md")?.content).toBe("content");
        });

        it("skips binary content (NUL byte)", async () => {
            capture.start();
            // NUL byte survives TextDecoder roundtrip → isDiffableText rejects.
            const bin = new Uint8Array([0x68, 0x00, 0x69]);
            vault.addBinaryFile("bin.dat", bin.buffer);
            events.emit("modify", "bin.dat", stat);

            await vi.advanceTimersByTimeAsync(100);

            expect(storage.diffs).toHaveLength(0);
        });
    });

    // ── captureSyncWrite ────────────────────────────────

    describe("captureSyncWrite", () => {
        it("tags entry with source=sync", async () => {
            vault.addFile("a.md", "pulled");
            await capture.captureSyncWrite("a.md");

            expect(storage.diffs).toHaveLength(1);
            expect(storage.diffs[0].source).toBe("sync");
        });

        it("bypasses debounce/rate-limit", async () => {
            settings.historyMinIntervalMs = 60000;
            vault.addFile("a.md", "v1");
            await capture.captureSyncWrite("a.md");

            vault.addFile("a.md", "v2");
            await capture.captureSyncWrite("a.md");

            expect(storage.diffs).toHaveLength(2);
        });

        it("skips binary via sniff on raw bytes", async () => {
            const bin = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
            vault.addBinaryFile("img.png", bin.buffer);
            await capture.captureSyncWrite("img.png");

            expect(storage.diffs).toHaveLength(0);
        });
    });

    // ── pause/resume ────────────────────────────────────

    describe("pause/resume", () => {
        it("queues modify events while paused", async () => {
            capture.start();
            capture.pause();
            vault.addFile("a.md", "v1");
            events.emit("modify", "a.md", stat);

            vi.advanceTimersByTime(1000);
            await vi.runAllTimersAsync();
            expect(storage.diffs).toHaveLength(0);
        });

        it("replays queued events on resume", async () => {
            capture.start();
            capture.pause();
            vault.addFile("a.md", "v1");
            events.emit("modify", "a.md", stat);

            capture.resume();
            await vi.advanceTimersByTimeAsync(100);

            expect(storage.diffs).toHaveLength(1);
        });

        it("deduplicates queued paths", async () => {
            capture.start();
            capture.pause();
            vault.addFile("a.md", "v1");
            events.emit("modify", "a.md", stat);
            events.emit("modify", "a.md", stat);
            events.emit("modify", "a.md", stat);

            capture.resume();
            await vi.advanceTimersByTimeAsync(100);

            expect(storage.diffs).toHaveLength(1);
        });
    });

    // ── delete event ────────────────────────────────────

    describe("delete event", () => {
        it("cancels pending debounce on delete", async () => {
            capture.start();
            vault.addFile("a.md", "v1");
            events.emit("modify", "a.md", stat);

            events.emit("delete", "a.md");
            vi.advanceTimersByTime(1000);
            await vi.runAllTimersAsync();

            expect(storage.diffs).toHaveLength(0);
        });
    });

    // ── rename event ────────────────────────────────────

    describe("rename event", () => {
        it("forwards to storage.renamePath", async () => {
            capture.start();
            events.emit("rename", "new.md", "old.md", stat);

            expect(storage.renames).toEqual([{ oldPath: "old.md", newPath: "new.md" }]);
        });

        it("re-targets a pending debounce capture at the new path", async () => {
            capture.start();
            vault.addFile("old.md", "v1");
            events.emit("modify", "old.md", stat);
            // Rename fires while the debounce timer is still armed.
            await vault.delete("old.md");
            vault.addFile("new.md", "v1");
            events.emit("rename", "new.md", "old.md", stat);

            await vi.advanceTimersByTimeAsync(1000);

            // The capture lands at the NEW path — not lost to a
            // "File not found" against the old one.
            expect(storage.diffs).toHaveLength(1);
            expect(storage.diffs[0].filePath).toBe("new.md");
        });

        it("carries the rate-limit window across the rename", async () => {
            capture.start();
            const t = Date.now();
            (capture as any).lastCaptureTime.set("old.md", t);
            events.emit("rename", "new.md", "old.md", stat);
            expect((capture as any).lastCaptureTime.get("new.md")).toBe(t);
            expect((capture as any).lastCaptureTime.has("old.md")).toBe(false);
        });
    });

    // ── saveConflict ────────────────────────────────────

    describe("saveConflict", () => {
        it("winner=local: snapshot is localContent, conflict=true", async () => {
            await capture.saveConflict("a.md", "LOCAL", "REMOTE", "local");

            expect(storage.diffs).toHaveLength(1);
            expect(storage.diffs[0].conflict).toBe(true);
            expect(storage.snapshots.get("a.md")?.content).toBe("LOCAL");
        });

        it("winner=remote: snapshot is remoteContent, conflict=true", async () => {
            await capture.saveConflict("a.md", "LOCAL", "REMOTE", "remote");

            expect(storage.diffs).toHaveLength(1);
            expect(storage.diffs[0].conflict).toBe(true);
            expect(storage.snapshots.get("a.md")?.content).toBe("REMOTE");
        });

        it("diff failure does NOT throw and still advances the snapshot", async () => {
            // A saveConflict throw is treated by the orchestrator as an
            // APPLY failure (clearDurable skipped → ghost re-presentation),
            // so diff-stage errors must be swallowed while the baseline
            // advances (incident 2026-06-04 cascade shape).
            storage.saveDiff = async () => { throw new Error("URI malformed"); };
            await expect(
                capture.saveConflict("a.md", "LOCAL", "REMOTE", "remote"),
            ).resolves.toBeUndefined();
            expect(storage.snapshots.get("a.md")?.content).toBe("REMOTE");
        });
    });

    // ── record-keeping advances on diff failure ─────────

    describe("capture failure containment (incident 2026-06-04)", () => {
        it("saveDiff throw: snapshot and rate-limit still advance (no cascade)", async () => {
            capture.start();
            vault.addFile("a.md", "v1");
            storage.snapshots.set("a.md", { filePath: "a.md", content: "v0", lastModified: 1 });
            let failures = 0;
            storage.saveDiff = async () => { failures++; throw new Error("URI malformed"); };

            events.emit("modify", "a.md", stat);
            await vi.advanceTimersByTimeAsync(1000);

            expect(failures).toBe(1);
            // Snapshot advanced to current content → the next capture diffs
            // from fresh state instead of re-deriving the same failing diff.
            expect(storage.snapshots.get("a.md")?.content).toBe("v1");
            expect((capture as any).lastCaptureTime.has("a.md")).toBe(true);

            // Next edit: snapshot is current, so the same failure does not
            // re-fire for unchanged content.
            events.emit("modify", "a.md", stat);
            await vi.advanceTimersByTimeAsync(1000);
            expect(failures).toBe(1); // content == snapshot → early return
        });

        it("content-read failure does NOT advance the snapshot", async () => {
            capture.start();
            storage.snapshots.set("a.md", { filePath: "a.md", content: "v0", lastModified: 1 });
            // No file in vault → cachedRead throws → nothing to base an
            // advance on; baseline must stay put for a later retry.
            events.emit("modify", "a.md", stat);
            await vi.advanceTimersByTimeAsync(1000);
            expect(storage.snapshots.get("a.md")?.content).toBe("v0");
        });
    });
});
