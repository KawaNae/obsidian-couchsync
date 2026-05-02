import type { IVaultIO } from "../types/vault-io.ts";
import type { IVaultEvents, VaultEventRef } from "../types/vault-events.ts";
import type { HistoryStorage } from "./storage.ts";
import { DiffEngine, computeHash } from "./diff-engine.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { HistorySource } from "./types.ts";
import { minimatch } from "../utils/minimatch.ts";
import { isDiffableText } from "../utils/binary.ts";
import { logDebug, logError } from "../ui/log.ts";

export class HistoryCapture {
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private lastCaptureTime = new Map<string, number>();
    private pendingCapture = new Map<string, ReturnType<typeof setTimeout>>();
    private pendingQueue: string[] = [];
    private eventRefs: VaultEventRef[] = [];
    private paused = false;
    private diffEngine = new DiffEngine();

    constructor(
        private vault: IVaultIO,
        private events: IVaultEvents,
        private storage: HistoryStorage,
        private getSettings: () => CouchSyncSettings,
    ) {}

    start(): void {
        this.eventRefs.push(
            this.events.on("modify", (path) => {
                if (!this.isTargetPath(path)) return;
                this.scheduleCapture(path);
            }),
        );

        this.eventRefs.push(
            this.events.on("rename", (path, oldPath) => {
                this.lastCaptureTime.delete(oldPath);
                this.storage.renamePath(oldPath, path);
            }),
        );

        this.eventRefs.push(
            this.events.on("delete", (path) => {
                this.lastCaptureTime.delete(path);
                const timer = this.debounceTimers.get(path);
                if (timer) {
                    clearTimeout(timer);
                    this.debounceTimers.delete(path);
                }
                const pending = this.pendingCapture.get(path);
                if (pending) {
                    clearTimeout(pending);
                    this.pendingCapture.delete(path);
                }
            }),
        );
    }

    stop(): void {
        for (const ref of this.eventRefs) {
            this.events.offref(ref);
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

    async saveConflict(
        filePath: string,
        localContent: string,
        remoteContent: string,
        winner: "local" | "remote",
    ): Promise<void> {
        const winnerContent = winner === "local" ? localContent : remoteContent;
        const loserContent = winner === "local" ? remoteContent : localContent;
        const patch = this.diffEngine.computePatch(winnerContent, loserContent);
        const hash = await computeHash(winnerContent);
        const { added, removed } = this.diffEngine.computeLineDiff(winnerContent, loserContent);
        await this.storage.saveDiff(filePath, patch, hash, added, removed, true);
        // Update snapshot to winner content so subsequent diffs have correct baseline.
        await this.storage.saveSnapshot(filePath, winnerContent);
    }

    /**
     * Capture a history entry for a sync-driven write. Called by
     * VaultWriter immediately after dispatching the remote content
     * (CM transaction or disk write). When `content` is provided the
     * capture skips the disk read — used by the editor-aware writer
     * because Obsidian's autosave hasn't yet written the new content
     * to disk at the time of capture (~2 s gap between CM dispatch
     * and autosave). Bypasses debounce/rate-limit and tags the entry
     * with source="sync".
     */
    async captureSyncWrite(path: string, content?: string): Promise<void> {
        if (!this.isTargetPath(path)) return;
        await this.captureChange(path, "sync", content);
    }

    private isTargetPath(path: string): boolean {
        // Binary detection happens in captureChange() to avoid sync I/O in
        // the modify event handler.
        if (path.startsWith(".")) return false;
        const settings = this.getSettings();
        if (settings.historyExcludePatterns) {
            for (const pattern of settings.historyExcludePatterns) {
                if (minimatch(path, pattern)) return false;
            }
        }
        return true;
    }

    private scheduleCapture(path: string): void {
        if (this.paused) {
            if (!this.pendingQueue.includes(path)) {
                this.pendingQueue.push(path);
            }
            return;
        }

        const existing = this.debounceTimers.get(path);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
            this.debounceTimers.delete(path);
            this.tryCapture(path);
        }, this.getSettings().historyDebounceMs);

        this.debounceTimers.set(path, timer);
    }

    private tryCapture(path: string): void {
        const settings = this.getSettings();
        const lastCapture = this.lastCaptureTime.get(path) ?? 0;
        const elapsed = Date.now() - lastCapture;

        if (elapsed >= settings.historyMinIntervalMs) {
            this.captureChange(path);
        } else {
            const existingPending = this.pendingCapture.get(path);
            if (existingPending) clearTimeout(existingPending);

            const delay = settings.historyMinIntervalMs - elapsed;
            const pendingTimer = setTimeout(() => {
                this.pendingCapture.delete(path);
                this.captureChange(path);
            }, delay);
            this.pendingCapture.set(path, pendingTimer);
        }
    }

    private async captureChange(
        path: string,
        source: HistorySource = "local",
        providedContent?: string,
    ): Promise<void> {
        try {
            // Local edits use cachedRead (memory-cached parsed text) for the
            // typing hot path. Sync writes go through the byte-sniff path so
            // binary files don't pollute history. We re-encode the cached
            // string to validate it's diffable UTF-8 either way.
            let currentContent: string;
            if (providedContent !== undefined) {
                if (!isDiffableText(new TextEncoder().encode(providedContent))) return;
                currentContent = providedContent;
            } else if (source === "sync") {
                const buffer = await this.vault.readBinary(path);
                if (!isDiffableText(buffer)) return;
                currentContent = new TextDecoder("utf-8").decode(buffer);
            } else {
                currentContent = await this.vault.cachedRead(path);
                if (!isDiffableText(new TextEncoder().encode(currentContent))) return;
            }
            const snapshot = await this.storage.getSnapshot(path);

            const prevContent = snapshot?.content ?? "";
            if (prevContent === currentContent) return;

            const patches = this.diffEngine.computePatch(prevContent, currentContent);
            const baseHash = await computeHash(prevContent);
            const { added, removed } = this.diffEngine.computeLineDiff(prevContent, currentContent);
            await this.storage.saveDiff(path, patches, baseHash, added, removed, false, source);

            await this.storage.saveSnapshot(path, currentContent);
            this.lastCaptureTime.set(path, Date.now());
            logDebug(`History captured for ${path} (${source})`);
        } catch (e) {
            logError(`CouchSync: Failed to capture history: ${e?.message ?? e}`);
        }
    }
}
