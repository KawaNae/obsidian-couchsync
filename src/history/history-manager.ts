import type { Vault, TFile } from "obsidian";
import { DiffEngine } from "./diff-engine.ts";
import type { HistoryStorage } from "./storage.ts";
import type { HistoryCapture } from "./history-capture.ts";
import type { HistoryEntry } from "./types.ts";
import type { CouchSyncSettings } from "../settings.ts";

export class HistoryManager {
    private cleanupInterval: ReturnType<typeof setInterval> | null = null;
    private diffEngine = new DiffEngine();

    constructor(
        private vault: Vault,
        private storage: HistoryStorage,
        private historyCapture: HistoryCapture,
        private getSettings: () => CouchSyncSettings,
    ) {}

    async getFileHistory(filePath: string): Promise<HistoryEntry[]> {
        const diffs = await this.storage.getDiffs(filePath);
        return diffs.map((record) => ({
            record,
            added: record.added ?? 0,
            removed: record.removed ?? 0,
        }));
    }

    async getSnapshot(filePath: string) {
        return this.storage.getSnapshot(filePath);
    }

    async reconstructAtPoint(filePath: string, timestamp: number): Promise<string | null> {
        const snapshot = await this.storage.getSnapshot(filePath);
        if (!snapshot) return null;

        const allDiffs = await this.storage.getDiffs(filePath);
        const diffsToReverse = allDiffs
            .filter((d) => d.timestamp > timestamp)
            .sort((a, b) => b.timestamp - a.timestamp);

        let content = snapshot.content;
        for (const diff of diffsToReverse) {
            const result = this.diffEngine.applyPatchReverse(content, diff.patches);
            if (!result.ok) {
                console.warn("CouchSync: Patch reverse failed at", diff.timestamp);
                return null;
            }
            content = result.text;
        }
        return content;
    }

    async restoreToPoint(filePath: string, timestamp: number): Promise<boolean> {
        const reconstructed = await this.reconstructAtPoint(filePath, timestamp);
        if (reconstructed === null) return false;

        const file = this.vault.getAbstractFileByPath(filePath);
        if (!file || !("extension" in file)) return false;

        this.historyCapture.pause();
        try {
            await this.vault.modify(file as TFile, reconstructed);
            await this.storage.saveSnapshot(filePath, reconstructed);
        } finally {
            setTimeout(() => this.historyCapture.resume(), 500);
        }
        return true;
    }

    startCleanup(): void {
        this.cleanup();
        this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 60 * 1000);
    }

    stopCleanup(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    async cleanup(): Promise<number> {
        const settings = this.getSettings();
        const cutoff = Date.now() - settings.historyRetentionDays * 24 * 60 * 60 * 1000;
        return this.storage.deleteBefore(cutoff);
    }

    async clearFileHistory(filePath: string): Promise<void> {
        await this.storage.deleteByFile(filePath);
    }

    async clearAllHistory(): Promise<void> {
        await this.storage.deleteAll();
    }
}
