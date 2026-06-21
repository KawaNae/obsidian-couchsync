import type { IVaultIO } from "../types/vault-io.ts";
import { DiffEngine } from "./diff-engine.ts";
import type { HistoryStorage } from "./storage.ts";
import type { HistoryCapture } from "./history-capture.ts";
import type { DiffRecord, HistoryEntry } from "./types.ts";
import type { CouchSyncSettings } from "../settings.ts";
import { logWarn } from "../ui/log.ts";

export class HistoryManager {
    private cleanupInterval: ReturnType<typeof setInterval> | null = null;
    private diffEngine = new DiffEngine();

    constructor(
        private vault: IVaultIO,
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

    private buildPathToRoot(
        recordId: number,
        recordMap: Map<number, DiffRecord>,
    ): DiffRecord[] {
        const path: DiffRecord[] = [];
        let currentId: number | null = recordId;
        const visited = new Set<number>();
        while (currentId !== null) {
            if (visited.has(currentId)) break;
            visited.add(currentId);
            const record = recordMap.get(currentId);
            if (!record) break;
            path.unshift(record);
            currentId = record.parentId;
        }
        return path;
    }

    async reconstructAtRecord(filePath: string, recordId: number): Promise<string | null> {
        const snapshot = await this.storage.getSnapshot(filePath);
        if (!snapshot) return null;

        const allDiffs = await this.storage.getDiffs(filePath);
        const recordMap = new Map<number, DiffRecord>();
        for (const d of allDiffs) {
            if (d.id != null) recordMap.set(d.id, d);
        }

        if (snapshot.headRecordId === recordId) return snapshot.content;

        if (snapshot.headRecordId === null) return null;

        const headPath = this.buildPathToRoot(snapshot.headRecordId, recordMap);
        const targetPath = this.buildPathToRoot(recordId, recordMap);

        let forkIdx = -1;
        const minLen = Math.min(headPath.length, targetPath.length);
        for (let i = 0; i < minLen; i++) {
            if (headPath[i].id === targetPath[i].id) {
                forkIdx = i;
            } else {
                break;
            }
        }

        if (forkIdx === -1) {
            logWarn(`CouchSync: No common ancestor for record ${recordId}`);
            return null;
        }

        let content = snapshot.content;

        for (let i = headPath.length - 1; i > forkIdx; i--) {
            const result = this.diffEngine.applyPatchReverse(content, headPath[i].patches);
            if (!result.ok) {
                logWarn(`CouchSync: Patch reverse failed at ${headPath[i].timestamp} (id=${headPath[i].id})`);
            }
            content = result.text;
        }

        for (let i = forkIdx + 1; i < targetPath.length; i++) {
            const result = this.diffEngine.applyPatch(content, targetPath[i].patches);
            if (!result.ok) {
                logWarn(`CouchSync: Patch forward failed at ${targetPath[i].timestamp} (id=${targetPath[i].id})`);
            }
            content = result.text;
        }

        return content;
    }

    async restoreToRecord(filePath: string, recordId: number): Promise<string | null> {
        const reconstructed = await this.reconstructAtRecord(filePath, recordId);
        if (reconstructed === null) return null;

        const stat = await this.vault.stat(filePath);
        if (!stat) return null;

        this.historyCapture.pause();
        try {
            const bytes = new TextEncoder().encode(reconstructed);
            await this.vault.writeBinary(filePath, bytes.buffer as ArrayBuffer);
            await this.storage.saveSnapshot(filePath, reconstructed, recordId);
        } finally {
            setTimeout(() => this.historyCapture.resume(), 500);
        }
        return reconstructed;
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
