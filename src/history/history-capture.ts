import type { App, TAbstractFile, TFile, EventRef } from "obsidian";
import type { HistoryStorage } from "./storage.ts";
import { DiffEngine, computeHash } from "./diff-engine.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { HistorySource } from "./types.ts";
import { minimatch } from "../utils/minimatch.ts";
import { isDiffableText } from "../utils/binary.ts";

export class HistoryCapture {
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private lastCaptureTime = new Map<string, number>();
    private pendingCapture = new Map<string, ReturnType<typeof setTimeout>>();
    private pendingQueue: TFile[] = [];
    private eventRefs: EventRef[] = [];
    private paused = false;
    private diffEngine = new DiffEngine();

    constructor(
        private app: App,
        private storage: HistoryStorage,
        private getSettings: () => CouchSyncSettings,
    ) {}

    start(): void {
        this.eventRefs.push(
            this.app.vault.on("modify", (file: TAbstractFile) => {
                if (!this.isTargetFile(file)) return;
                this.scheduleCapture(file as TFile);
            }),
        );

        this.eventRefs.push(
            this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
                if (!("extension" in file)) return;
                this.lastCaptureTime.delete(oldPath);
                this.storage.renamePath(oldPath, file.path);
            }),
        );

        this.eventRefs.push(
            this.app.vault.on("delete", (file: TAbstractFile) => {
                this.lastCaptureTime.delete(file.path);
                const timer = this.debounceTimers.get(file.path);
                if (timer) {
                    clearTimeout(timer);
                    this.debounceTimers.delete(file.path);
                }
                const pending = this.pendingCapture.get(file.path);
                if (pending) {
                    clearTimeout(pending);
                    this.pendingCapture.delete(file.path);
                }
            }),
        );
    }

    stop(): void {
        for (const ref of this.eventRefs) {
            this.app.vault.offref(ref);
        }
        this.eventRefs = [];
        for (const timer of this.debounceTimers.values()) clearTimeout(timer);
        this.debounceTimers.clear();
        for (const timer of this.pendingCapture.values()) clearTimeout(timer);
        this.pendingCapture.clear();
        this.pendingQueue = [];
    }

    pause(): void {
        this.paused = true;
    }

    resume(): void {
        this.paused = false;
        const queued = this.pendingQueue.splice(0);
        for (const file of queued) {
            this.scheduleCapture(file);
        }
    }

    async saveConflict(filePath: string, loserContent: string, winnerContent: string): Promise<void> {
        const patch = this.diffEngine.computePatch(winnerContent, loserContent);
        const hash = await computeHash(winnerContent);
        const { added, removed } = this.diffEngine.computeLineDiff(winnerContent, loserContent);
        await this.storage.saveDiff(filePath, patch, hash, added, removed, true);
    }

    /**
     * Capture a history entry for a sync-driven write. Called by VaultSync
     * after dbToFile() successfully writes remote content to the vault.
     * Bypasses debounce/rate-limit (sync events are discrete, not continuous input)
     * and tags the entry with source="sync".
     */
    async captureSyncWrite(file: TFile): Promise<void> {
        if (!this.isTargetFile(file)) return;
        await this.captureChange(file, "sync");
    }

    private isTargetFile(file: TAbstractFile): boolean {
        if (!("extension" in file)) return false;
        const tfile = file as TFile;
        // Binary detection happens in captureChange() to avoid sync I/O in
        // the modify event handler.
        if (tfile.path.startsWith(".")) return false;
        const settings = this.getSettings();
        if (settings.historyExcludePatterns) {
            for (const pattern of settings.historyExcludePatterns) {
                if (minimatch(tfile.path, pattern)) return false;
            }
        }
        return true;
    }

    private scheduleCapture(file: TFile): void {
        if (this.paused) {
            if (!this.pendingQueue.some((f) => f.path === file.path)) {
                this.pendingQueue.push(file);
            }
            return;
        }

        const existing = this.debounceTimers.get(file.path);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
            this.debounceTimers.delete(file.path);
            this.tryCapture(file);
        }, this.getSettings().historyDebounceMs);

        this.debounceTimers.set(file.path, timer);
    }

    private tryCapture(file: TFile): void {
        const settings = this.getSettings();
        const lastCapture = this.lastCaptureTime.get(file.path) ?? 0;
        const elapsed = Date.now() - lastCapture;

        if (elapsed >= settings.historyMinIntervalMs) {
            this.captureChange(file);
        } else {
            const existingPending = this.pendingCapture.get(file.path);
            if (existingPending) clearTimeout(existingPending);

            const delay = settings.historyMinIntervalMs - elapsed;
            const pendingTimer = setTimeout(() => {
                this.pendingCapture.delete(file.path);
                this.captureChange(file);
            }, delay);
            this.pendingCapture.set(file.path, pendingTimer);
        }
    }

    private async captureChange(file: TFile, source: HistorySource = "local"): Promise<void> {
        try {
            // Local edits use cachedRead (memory-cached parsed text) for the
            // typing hot path. Sync writes go through the byte-sniff path so
            // binary files don't pollute history. We re-encode the cached
            // string to validate it's diffable UTF-8 either way.
            let currentContent: string;
            if (source === "sync") {
                const buffer = await this.app.vault.readBinary(file);
                if (!isDiffableText(buffer)) return;
                currentContent = new TextDecoder("utf-8").decode(buffer);
            } else {
                currentContent = await this.app.vault.cachedRead(file);
                if (!isDiffableText(new TextEncoder().encode(currentContent))) return;
            }
            const snapshot = await this.storage.getSnapshot(file.path);

            const prevContent = snapshot?.content ?? "";
            if (prevContent === currentContent) return;

            const patches = this.diffEngine.computePatch(prevContent, currentContent);
            const baseHash = await computeHash(prevContent);
            const { added, removed } = this.diffEngine.computeLineDiff(prevContent, currentContent);
            await this.storage.saveDiff(file.path, patches, baseHash, added, removed, false, source);

            await this.storage.saveSnapshot(file.path, currentContent);
            this.lastCaptureTime.set(file.path, Date.now());
            console.log(`CouchSync: History captured for ${file.path} (${source})`);
            (this.app.workspace as any).trigger("couchsync:diff-saved", file.path);
        } catch (e) {
            console.error("CouchSync: Failed to capture history:", e);
        }
    }
}
