# diff-history Integration Phase 1: Foundation + Basic UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** diff-history のコア機能（Dexie ストレージ、DiffEngine、変更キャプチャ、diff ビューア）を CouchSync に統合し、ローカル変更履歴を自動保存できるようにする。

**Architecture:** HistoryCapture が vault イベントに独立登録し、DiffEngine で差分計算、Dexie で保存。ChangeTracker（PouchDB 用）のピアとして動作。UI は DiffCompareModal と ConfirmModal をそのまま取り込み、DiffHistoryView をサイドバーに配置。

**Tech Stack:** Dexie 4, diff-match-patch, xxhash-wasm (既存)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/history/types.ts` | DiffRecord, FileSnapshot, HistoryEntry 型定義 |
| `src/history/diff-engine.ts` | diff-match-patch ラッパー（パッチ生成/適用/逆適用、行数カウント） |
| `src/history/storage.ts` | Dexie DB ラッパー（diffs + snapshots テーブル） |
| `src/history/history-capture.ts` | vault イベント監視 → 差分キャプチャ → Dexie 保存 |
| `src/history/history-manager.ts` | ポイントインタイム復元、クリーンアップ |
| `src/ui/diff-compare-modal.ts` | サイドバイサイド diff ビューア |
| `src/ui/confirm-modal.ts` | 復元確認ダイアログ |
| `src/ui/history-view.ts` | サイドバー履歴ビュー |
| `src/utils/format.ts` | formatTime, formatDate, groupBy |
| `src/utils/minimatch.ts` | glob パターンマッチング |
| `src/settings-tab/history-tab.ts` | History 設定タブ |

---

### Task 1: Dependencies + Utility modules

**Files:**
- Modify: `package.json`
- Create: `src/utils/format.ts`
- Create: `src/utils/minimatch.ts`

- [ ] **Step 1: Install dependencies**

```bash
cd C:/VScode/obsidian-couchsync
npm install dexie@4 diff-match-patch@1
npm install -D @types/diff-match-patch
```

- [ ] **Step 2: Create `src/utils/format.ts`**

```typescript
export function formatTime(timestamp: number): string {
    const d = new Date(timestamp);
    return d.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

export function formatDate(timestamp: number): string {
    const d = new Date(timestamp);
    return d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

export function groupBy<T>(
    items: T[],
    keyFn: (item: T) => string
): Map<string, T[]> {
    const map = new Map<string, T[]>();
    for (const item of items) {
        const key = keyFn(item);
        const group = map.get(key);
        if (group) {
            group.push(item);
        } else {
            map.set(key, [item]);
        }
    }
    return map;
}
```

- [ ] **Step 3: Create `src/utils/minimatch.ts`**

```typescript
export function minimatch(filePath: string, pattern: string): boolean {
    const regex = globToRegex(pattern);
    return regex.test(filePath);
}

function globToRegex(glob: string): RegExp {
    let regex = "";
    let i = 0;
    while (i < glob.length) {
        const c = glob[i];
        if (c === "*") {
            if (glob[i + 1] === "*") {
                if (glob[i + 2] === "/") {
                    regex += "(?:.+/)?";
                    i += 3;
                    continue;
                }
                regex += ".*";
                i += 2;
                continue;
            }
            regex += "[^/]*";
        } else if (c === "?") {
            regex += "[^/]";
        } else if (c === ".") {
            regex += "\\.";
        } else {
            regex += c;
        }
        i++;
    }
    return new RegExp(`^${regex}$`);
}
```

- [ ] **Step 4: Build check**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/utils/format.ts src/utils/minimatch.ts
git commit -m "feat: add dexie, diff-match-patch deps + utility modules"
```

---

### Task 2: History types + DiffEngine + Storage

**Files:**
- Create: `src/history/types.ts`
- Create: `src/history/diff-engine.ts`
- Create: `src/history/storage.ts`

- [ ] **Step 1: Create `src/history/types.ts`**

```typescript
export interface DiffRecord {
    id?: string;
    filePath: string;
    timestamp: number;
    patches: string;
    baseHash: string;
    added?: number;
    removed?: number;
    conflict?: boolean;
}

export interface FileSnapshot {
    filePath: string;
    content: string;
    lastModified: number;
}

export interface HistoryEntry {
    record: DiffRecord;
    added: number;
    removed: number;
}
```

- [ ] **Step 2: Create `src/history/diff-engine.ts`**

Uses xxhash from chunker instead of FNV-1a.

```typescript
import DiffMatchPatch from "diff-match-patch";
import { computeHash } from "../db/chunker.ts";

const dmp = new DiffMatchPatch();

interface PatchObj {
    diffs: [number, string][];
    start1: number;
    start2: number;
    length1: number;
    length2: number;
}

export { computeHash };

export class DiffEngine {
    computePatch(oldText: string, newText: string): string {
        const patches = dmp.patch_make(oldText, newText);
        return dmp.patch_toText(patches);
    }

    applyPatch(text: string, patchStr: string): { text: string; ok: boolean } {
        const patches = dmp.patch_fromText(patchStr);
        const [result, applied] = dmp.patch_apply(patches, text);
        return { text: result, ok: applied.every(Boolean) };
    }

    applyPatchReverse(text: string, patchStr: string): { text: string; ok: boolean } {
        const patches = dmp.patch_fromText(patchStr) as unknown as PatchObj[];
        for (const patch of patches) {
            for (const diff of patch.diffs) {
                if (diff[0] === DiffMatchPatch.DIFF_INSERT) {
                    diff[0] = DiffMatchPatch.DIFF_DELETE;
                } else if (diff[0] === DiffMatchPatch.DIFF_DELETE) {
                    diff[0] = DiffMatchPatch.DIFF_INSERT;
                }
            }
            const tmp = patch.length1;
            patch.length1 = patch.length2;
            patch.length2 = tmp;
            const tmpStart = patch.start1;
            patch.start1 = patch.start2;
            patch.start2 = tmpStart;
        }
        const [result, applied] = dmp.patch_apply(patches as any, text);
        return { text: result, ok: applied.every(Boolean) };
    }

    computeLineDiff(oldText: string, newText: string): { added: number; removed: number } {
        const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(oldText, newText);
        const diffs = dmp.diff_main(chars1, chars2, false);
        dmp.diff_charsToLines_(diffs, lineArray);
        dmp.diff_cleanupSemantic(diffs);
        let added = 0;
        let removed = 0;
        for (const [op, text] of diffs) {
            const lines = (text.match(/\n/g) || []).length;
            if (op === DiffMatchPatch.DIFF_INSERT) added += lines;
            else if (op === DiffMatchPatch.DIFF_DELETE) removed += lines;
        }
        return { added, removed };
    }
}
```

- [ ] **Step 3: Create `src/history/storage.ts`**

```typescript
import Dexie, { type Table } from "dexie";
import type { DiffRecord, FileSnapshot } from "./types.ts";

class HistoryDB extends Dexie {
    diffs!: Table<DiffRecord, string>;
    snapshots!: Table<FileSnapshot, string>;

    constructor(vaultName: string) {
        super(`couchsync-history-${vaultName}`);
        this.version(1).stores({
            diffs: "++id, [filePath+timestamp], filePath, timestamp",
            snapshots: "filePath",
        });
    }
}

export class HistoryStorage {
    private db: HistoryDB;

    constructor(vaultName: string) {
        this.db = new HistoryDB(vaultName);
    }

    async saveDiff(
        filePath: string,
        patches: string,
        baseHash: string,
        added: number,
        removed: number,
        conflict = false,
    ): Promise<void> {
        await this.db.diffs.add({
            filePath,
            timestamp: Date.now(),
            patches,
            baseHash,
            added,
            removed,
            conflict: conflict || undefined,
        });
    }

    async getSnapshot(filePath: string): Promise<FileSnapshot | undefined> {
        return this.db.snapshots.get(filePath);
    }

    async saveSnapshot(filePath: string, content: string): Promise<void> {
        await this.db.snapshots.put({
            filePath,
            content,
            lastModified: Date.now(),
        });
    }

    async getDiffs(filePath: string, since?: number): Promise<DiffRecord[]> {
        const lowerBound = [filePath, since ?? Dexie.minKey];
        const upperBound = [filePath, Dexie.maxKey];
        return this.db.diffs
            .where("[filePath+timestamp]")
            .between(lowerBound, upperBound)
            .sortBy("timestamp");
    }

    async deleteBefore(timestamp: number): Promise<number> {
        return this.db.diffs.where("timestamp").below(timestamp).delete();
    }

    async deleteByFile(filePath: string): Promise<number> {
        const count = await this.db.diffs.where("filePath").equals(filePath).delete();
        await this.db.snapshots.delete(filePath);
        return count;
    }

    async deleteAll(): Promise<void> {
        await this.db.diffs.clear();
        await this.db.snapshots.clear();
    }

    async renamePath(oldPath: string, newPath: string): Promise<void> {
        await this.db.transaction("rw", this.db.diffs, this.db.snapshots, async () => {
            const diffs = await this.db.diffs.where("filePath").equals(oldPath).toArray();
            for (const diff of diffs) {
                await this.db.diffs.update(diff.id!, { filePath: newPath });
            }
            const snapshot = await this.db.snapshots.get(oldPath);
            if (snapshot) {
                await this.db.snapshots.delete(oldPath);
                await this.db.snapshots.put({ ...snapshot, filePath: newPath });
            }
        });
    }

    async getStorageEstimate(): Promise<{ count: number; oldest?: number }> {
        const count = await this.db.diffs.count();
        const oldest = await this.db.diffs.orderBy("timestamp").first();
        return { count, oldest: oldest?.timestamp };
    }

    close(): void {
        this.db.close();
    }
}
```

- [ ] **Step 4: Build check**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/history/
git commit -m "feat: add history types, diff engine, and Dexie storage"
```

---

### Task 3: HistoryCapture service

**Files:**
- Create: `src/history/history-capture.ts`

- [ ] **Step 1: Create `src/history/history-capture.ts`**

```typescript
import type { App, TAbstractFile, TFile, EventRef } from "obsidian";
import type { HistoryStorage } from "./storage.ts";
import { DiffEngine, computeHash } from "./diff-engine.ts";
import type { CouchSyncSettings } from "../settings.ts";
import { minimatch } from "../utils/minimatch.ts";

export class HistoryCapture {
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private lastCaptureTime = new Map<string, number>();
    private pendingCapture = new Map<string, ReturnType<typeof setTimeout>>();
    private pendingQueue: TFile[] = [];
    private eventRefs: EventRef[] = [];
    private paused = false;
    private diffEngine = new DiffEngine();

    onDiffSaved?: (filePath: string) => void;

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
                this.storage.renamePath(oldPath, file.path);
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

    private isTargetFile(file: TAbstractFile): boolean {
        if (!("extension" in file)) return false;
        const tfile = file as TFile;
        if (tfile.extension !== "md") return false;
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

    private async captureChange(file: TFile): Promise<void> {
        try {
            const currentContent = await this.app.vault.cachedRead(file);
            const snapshot = await this.storage.getSnapshot(file.path);

            if (snapshot) {
                if (snapshot.content === currentContent) return;
                const patches = this.diffEngine.computePatch(snapshot.content, currentContent);
                const baseHash = await computeHash(snapshot.content);
                const { added, removed } = this.diffEngine.computeLineDiff(snapshot.content, currentContent);
                await this.storage.saveDiff(file.path, patches, baseHash, added, removed);
            } else {
                const patches = this.diffEngine.computePatch("", currentContent);
                const baseHash = await computeHash("");
                const { added, removed } = this.diffEngine.computeLineDiff("", currentContent);
                await this.storage.saveDiff(file.path, patches, baseHash, added, removed);
            }

            await this.storage.saveSnapshot(file.path, currentContent);
            this.lastCaptureTime.set(file.path, Date.now());
            this.onDiffSaved?.(file.path);
        } catch (e) {
            console.error("CouchSync: Failed to capture history:", e);
        }
    }
}
```

- [ ] **Step 2: Add `historyExcludePatterns` to settings**

In `src/settings.ts`, add to the interface and defaults:

```typescript
// Add to CouchSyncSettings interface
historyExcludePatterns: string[];

// Add to DEFAULT_SETTINGS
historyExcludePatterns: [],
```

- [ ] **Step 3: Build check**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/history/history-capture.ts src/settings.ts
git commit -m "feat: add HistoryCapture service with vault event listening"
```

---

### Task 4: HistoryManager + UI modals

**Files:**
- Create: `src/history/history-manager.ts`
- Create: `src/ui/diff-compare-modal.ts`
- Create: `src/ui/confirm-modal.ts`

- [ ] **Step 1: Create `src/history/history-manager.ts`**

```typescript
import type { Vault, TFile } from "obsidian";
import { DiffEngine } from "./diff-engine.ts";
import type { HistoryStorage } from "./storage.ts";
import type { HistoryCapture } from "./history-capture.ts";
import type { DiffRecord, HistoryEntry } from "./types.ts";
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
```

- [ ] **Step 2: Create `src/ui/diff-compare-modal.ts`**

Copy from diff-history verbatim (the class is self-contained):

```typescript
import { App, Modal } from "obsidian";
import DiffMatchPatch from "diff-match-patch";

const dmp = new DiffMatchPatch();

export class DiffCompareModal extends Modal {
    constructor(
        app: App,
        private oldText: string,
        private newText: string,
        private title: string,
        private leftLabel = "Before",
        private rightLabel = "After"
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl, modalEl } = this;
        modalEl.addClass("diff-history-compare-modal");
        contentEl.createEl("h3", { text: this.title });

        const diffs = dmp.diff_main(this.oldText, this.newText);
        dmp.diff_cleanupSemantic(diffs);

        const container = contentEl.createDiv({ cls: "diff-compare-container" });
        const leftPanel = container.createDiv({ cls: "diff-compare-panel diff-compare-left" });
        leftPanel.createDiv({ cls: "diff-compare-panel-header", text: this.leftLabel });
        const leftContent = leftPanel.createDiv({ cls: "diff-compare-content" });

        const rightPanel = container.createDiv({ cls: "diff-compare-panel diff-compare-right" });
        rightPanel.createDiv({ cls: "diff-compare-panel-header", text: this.rightLabel });
        const rightContent = rightPanel.createDiv({ cls: "diff-compare-content" });

        this.buildSideBySide(diffs, leftContent, rightContent);

        leftContent.addEventListener("scroll", () => { rightContent.scrollTop = leftContent.scrollTop; });
        rightContent.addEventListener("scroll", () => { leftContent.scrollTop = rightContent.scrollTop; });
    }

    onClose(): void { this.contentEl.empty(); }

    private buildSideBySide(diffs: DiffMatchPatch.Diff[], leftEl: HTMLElement, rightEl: HTMLElement): void {
        const oldLines = this.oldText.split("\n");
        const newLines = this.newText.split("\n");
        const lineDiffs = this.computeLineDiffs(oldLines, newLines);

        let leftLineNum = 1;
        let rightLineNum = 1;

        for (const chunk of lineDiffs) {
            if (chunk.type === "equal") {
                for (const line of chunk.lines) {
                    this.addLine(leftEl, leftLineNum++, line, "");
                    this.addLine(rightEl, rightLineNum++, line, "");
                }
            } else if (chunk.type === "delete") {
                for (const line of chunk.lines) {
                    this.addLine(leftEl, leftLineNum++, line, "diff-line-removed");
                    this.addLine(rightEl, null, "", "diff-line-placeholder");
                }
            } else if (chunk.type === "insert") {
                for (const line of chunk.lines) {
                    this.addLine(leftEl, null, "", "diff-line-placeholder");
                    this.addLine(rightEl, rightLineNum++, line, "diff-line-added");
                }
            }
        }
    }

    private addLine(container: HTMLElement, lineNum: number | null, text: string, cls: string): void {
        const row = container.createDiv({ cls: `diff-line ${cls}` });
        row.createSpan({ cls: "diff-line-num", text: lineNum != null ? String(lineNum) : "" });
        row.createSpan({ cls: "diff-line-text", text: text || "\u00A0" });
    }

    private computeLineDiffs(oldLines: string[], newLines: string[]): Array<{ type: "equal" | "insert" | "delete"; lines: string[] }> {
        const { chars1, chars2, lineArray } = this.linesToChars(oldLines, newLines);
        const charDiffs = dmp.diff_main(chars1, chars2, false);
        dmp.diff_cleanupSemantic(charDiffs);

        const result: Array<{ type: "equal" | "insert" | "delete"; lines: string[] }> = [];
        for (const [op, chars] of charDiffs) {
            const lines: string[] = [];
            for (let i = 0; i < chars.length; i++) {
                const idx = chars.charCodeAt(i);
                if (idx < lineArray.length) lines.push(lineArray[idx]);
            }
            let type: "equal" | "insert" | "delete";
            if (op === DiffMatchPatch.DIFF_EQUAL) type = "equal";
            else if (op === DiffMatchPatch.DIFF_INSERT) type = "insert";
            else type = "delete";
            result.push({ type, lines });
        }
        return result;
    }

    private linesToChars(oldLines: string[], newLines: string[]): { chars1: string; chars2: string; lineArray: string[] } {
        const lineArray: string[] = [""];
        const lineHash = new Map<string, number>();
        const encode = (lines: string[]): string => {
            let chars = "";
            for (const line of lines) {
                let idx = lineHash.get(line);
                if (idx === undefined) {
                    idx = lineArray.length;
                    lineHash.set(line, idx);
                    lineArray.push(line);
                }
                chars += String.fromCharCode(idx);
            }
            return chars;
        };
        return { chars1: encode(oldLines), chars2: encode(newLines), lineArray };
    }
}
```

- [ ] **Step 3: Create `src/ui/confirm-modal.ts`**

```typescript
import { App, Modal, Setting } from "obsidian";

export class ConfirmModal extends Modal {
    private resolved = false;
    private resolve: (value: boolean) => void = () => {};

    constructor(app: App, private title: string, private message: string) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: this.title });
        contentEl.createEl("p", { text: this.message });

        new Setting(contentEl)
            .addButton((btn) => btn.setButtonText("Restore").setCta().onClick(() => {
                this.resolved = true;
                this.resolve(true);
                this.close();
            }))
            .addButton((btn) => btn.setButtonText("Cancel").onClick(() => {
                this.resolved = true;
                this.resolve(false);
                this.close();
            }));
    }

    onClose(): void {
        if (!this.resolved) this.resolve(false);
        this.contentEl.empty();
    }

    waitForResult(): Promise<boolean> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }
}
```

- [ ] **Step 4: Build check**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/history/history-manager.ts src/ui/diff-compare-modal.ts src/ui/confirm-modal.ts
git commit -m "feat: add HistoryManager, DiffCompareModal, ConfirmModal"
```

---

### Task 5: HistoryView sidebar

**Files:**
- Create: `src/ui/history-view.ts`

- [ ] **Step 1: Create `src/ui/history-view.ts`**

Adapted from diff-history: uses CouchSyncPlugin type, adds conflict badge.

```typescript
import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import type CouchSyncPlugin from "../main.ts";
import type { HistoryEntry } from "../history/types.ts";
import { ConfirmModal } from "./confirm-modal.ts";
import { DiffCompareModal } from "./diff-compare-modal.ts";
import { formatTime, formatDate, groupBy } from "../utils/format.ts";

export const VIEW_TYPE_DIFF_HISTORY = "couchsync-history-view";

export class DiffHistoryView extends ItemView {
    private currentFile: string | null = null;
    private entries: HistoryEntry[] = [];

    constructor(leaf: WorkspaceLeaf, private plugin: CouchSyncPlugin) {
        super(leaf);
    }

    getViewType(): string { return VIEW_TYPE_DIFF_HISTORY; }
    getDisplayText(): string { return "Diff History"; }
    getIcon(): string { return "history"; }

    async onOpen(): Promise<void> { this.renderEmpty(); }
    async onClose(): Promise<void> { this.contentEl.empty(); }

    getCurrentFile(): string | null { return this.currentFile; }

    async showFileHistory(filePath: string): Promise<void> {
        this.currentFile = filePath;
        this.entries = await this.plugin.historyManager.getFileHistory(filePath);
        this.entries.reverse();
        this.render();
    }

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();
        const container = contentEl.createDiv({ cls: "diff-history-view" });

        if (!this.currentFile) { this.renderEmpty(); return; }

        const header = container.createDiv({ cls: "diff-history-file-header" });
        const fileName = this.currentFile.split("/").pop() || this.currentFile;
        header.createEl("strong", { text: fileName });

        if (this.entries.length === 0) { this.renderEmpty(); return; }

        const groups = groupBy(this.entries, (e) => formatDate(e.record.timestamp));

        for (const [date, entries] of groups) {
            const group = container.createDiv({ cls: "diff-history-date-group" });
            group.createDiv({ cls: "diff-history-date-header", text: date });

            for (const entry of entries) {
                const row = group.createDiv({ cls: "diff-history-entry" });
                row.createSpan({ cls: "diff-history-time", text: formatTime(entry.record.timestamp) });

                if (entry.record.conflict) {
                    row.createSpan({ cls: "diff-history-conflict-badge", text: "conflict" });
                }

                const summary = row.createSpan({ cls: "diff-history-summary" });
                if (entry.added > 0) summary.createSpan({ cls: "diff-history-additions", text: `+${entry.added}` });
                if (entry.removed > 0) summary.createSpan({ cls: "diff-history-deletions", text: `-${entry.removed}` });

                const actions = row.createSpan({ cls: "diff-history-entry-actions" });
                const diffBtn = actions.createEl("button", { cls: "diff-history-btn", text: "Diff" });
                diffBtn.addEventListener("click", (e) => { e.stopPropagation(); this.onShowDiff(entry, this.entries.indexOf(entry)); });

                const restoreBtn = actions.createEl("button", { cls: "diff-history-btn", text: "Restore" });
                restoreBtn.addEventListener("click", (e) => { e.stopPropagation(); this.onRestore(entry); });
            }
        }
    }

    private renderEmpty(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createDiv({ cls: "diff-history-view" }).createDiv({
            cls: "diff-history-empty",
            text: "No history available. Open a file and start editing to see changes here.",
        });
    }

    private async onShowDiff(entry: HistoryEntry, index: number): Promise<void> {
        if (!this.currentFile) return;
        const reconstructed = await this.plugin.historyManager.reconstructAtPoint(this.currentFile, entry.record.timestamp);
        if (reconstructed === null) { new Notice("Failed to reconstruct file at this point."); return; }

        let previousContent: string;
        let leftLabel: string;
        const prevIndex = index + 1;
        if (prevIndex < this.entries.length) {
            const prev = await this.plugin.historyManager.reconstructAtPoint(this.currentFile, this.entries[prevIndex].record.timestamp);
            if (prev === null) { new Notice("Failed to reconstruct previous state."); return; }
            previousContent = prev;
            leftLabel = `${formatDate(this.entries[prevIndex].record.timestamp)} ${formatTime(this.entries[prevIndex].record.timestamp)}`;
        } else {
            previousContent = "";
            leftLabel = "(empty)";
        }

        const rightLabel = `${formatDate(entry.record.timestamp)} ${formatTime(entry.record.timestamp)}`;
        new DiffCompareModal(this.plugin.app, previousContent, reconstructed, `${leftLabel} → ${rightLabel}`, leftLabel, rightLabel).open();
    }

    private async onRestore(entry: HistoryEntry): Promise<void> {
        if (!this.currentFile) return;
        const time = formatTime(entry.record.timestamp);
        const date = formatDate(entry.record.timestamp);

        const confirmed = await new ConfirmModal(this.plugin.app, "Restore file", `Restore to ${date} ${time}?`).waitForResult();
        if (!confirmed) return;

        const success = await this.plugin.historyManager.restoreToPoint(this.currentFile, entry.record.timestamp);
        if (success) {
            new Notice("File restored successfully.");
            await this.showFileHistory(this.currentFile);
        } else {
            new Notice("Failed to restore file.");
        }
    }
}
```

- [ ] **Step 2: Build check**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/ui/history-view.ts
git commit -m "feat: add DiffHistoryView sidebar with conflict badges"
```

---

### Task 6: History settings tab + styles

**Files:**
- Create: `src/settings-tab/history-tab.ts`
- Modify: `src/settings-tab/index.ts`
- Modify: `styles.css`

- [ ] **Step 1: Create `src/settings-tab/history-tab.ts`**

```typescript
import { Notice, Setting } from "obsidian";
import type { CouchSyncSettings } from "../settings.ts";
import type { HistoryManager } from "../history/history-manager.ts";

interface HistoryTabDeps {
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    historyManager: HistoryManager;
}

export function renderHistoryTab(el: HTMLElement, deps: HistoryTabDeps): void {
    const settings = deps.getSettings();

    el.createEl("h3", { text: "Diff History" });

    new Setting(el)
        .setName("Retention period (days)")
        .setDesc("How many days to keep diff history.")
        .addText((text) => text
            .setValue(String(settings.historyRetentionDays))
            .onChange(async (value) => {
                const num = parseInt(value, 10);
                if (!isNaN(num) && num >= 1) {
                    await deps.updateSettings({ historyRetentionDays: num });
                }
            })
        );

    new Setting(el)
        .setName("Debounce interval (seconds)")
        .setDesc("Wait after last edit before saving a diff.")
        .addText((text) => text
            .setValue(String(settings.historyDebounceMs / 1000))
            .onChange(async (value) => {
                const num = parseFloat(value);
                if (!isNaN(num) && num >= 1) {
                    await deps.updateSettings({ historyDebounceMs: num * 1000 });
                }
            })
        );

    new Setting(el)
        .setName("Minimum interval (seconds)")
        .setDesc("Minimum time between consecutive saves for the same file.")
        .addText((text) => text
            .setValue(String(settings.historyMinIntervalMs / 1000))
            .onChange(async (value) => {
                const num = parseFloat(value);
                if (!isNaN(num) && num >= 1) {
                    await deps.updateSettings({ historyMinIntervalMs: num * 1000 });
                }
            })
        );

    new Setting(el)
        .setName("Exclude patterns")
        .setDesc("Glob patterns to exclude from history (one per line).")
        .addTextArea((text) => text
            .setPlaceholder("templates/**\ndaily/**")
            .setValue(settings.historyExcludePatterns.join("\n"))
            .onChange(async (value) => {
                await deps.updateSettings({
                    historyExcludePatterns: value.split("\n").map((s) => s.trim()).filter(Boolean),
                });
            })
        );

    new Setting(el)
        .setName("Clear all history")
        .setDesc("Permanently delete all saved diffs and snapshots.")
        .addButton((btn) => btn
            .setButtonText("Clear")
            .setWarning()
            .onClick(async () => {
                await deps.historyManager.clearAllHistory();
                new Notice("All diff history cleared.");
            })
        );
}
```

- [ ] **Step 2: Add History tab to `src/settings-tab/index.ts`**

Add to imports:
```typescript
import { renderHistoryTab } from "./history-tab.ts";
```

Add to tabs array:
```typescript
{ id: "history", label: "History" },
```

Add panel rendering (after filesPanel block):
```typescript
const historyPanel = panels.get("history");
if (historyPanel) {
    renderHistoryTab(historyPanel, {
        ...settingsDeps,
        historyManager: this.plugin.historyManager,
    });
}
```

- [ ] **Step 3: Append diff-history styles to `styles.css`**

Append the full diff-history CSS plus conflict badge style to the end of `styles.css`.

- [ ] **Step 4: Build check**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/settings-tab/history-tab.ts src/settings-tab/index.ts styles.css
git commit -m "feat: add History settings tab and diff-history styles"
```

---

### Task 7: Wire everything in main.ts

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add imports**

```typescript
import { HistoryStorage } from "./history/storage.ts";
import { HistoryCapture } from "./history/history-capture.ts";
import { HistoryManager } from "./history/history-manager.ts";
import { DiffHistoryView, VIEW_TYPE_DIFF_HISTORY } from "./ui/history-view.ts";
import { isBinaryFile } from "./utils/binary.ts";
import { joinChunks } from "./db/chunker.ts";
```

- [ ] **Step 2: Add class properties**

```typescript
private historyStorage!: HistoryStorage;
private historyCapture!: HistoryCapture;
historyManager!: HistoryManager;
```

- [ ] **Step 3: Initialize history services in `onload()`**

After existing service initialization:

```typescript
this.historyStorage = new HistoryStorage(this.app.vault.getName());
this.historyCapture = new HistoryCapture(this.app, this.historyStorage, () => this.settings);
this.historyManager = new HistoryManager(
    this.app.vault, this.historyStorage, this.historyCapture, () => this.settings,
);
```

- [ ] **Step 4: Update onChange handler to pause/resume HistoryCapture**

```typescript
this.replicator.onChange((doc: CouchSyncDoc) => {
    if (isFileDoc(doc)) {
        this.changeTracker.pause();
        this.historyCapture.pause();
        this.vaultSync.dbToFile(doc).finally(() => {
            setTimeout(() => {
                this.changeTracker.resume();
                this.historyCapture.resume();
            }, 500);
        });
        this.conflictResolver.resolveIfConflicted(doc);
    }
});
```

- [ ] **Step 5: Update ConflictResolver with callback**

```typescript
this.conflictResolver = new ConflictResolver(
    this.localDb,
    async (filePath, winnerDoc, loserDoc) => {
        if (isBinaryFile(filePath)) return;
        try {
            const loserChunks = await this.localDb.getChunks(loserDoc.chunks);
            const loserContent = joinChunks(loserChunks, false) as string;
            const winnerChunks = await this.localDb.getChunks(winnerDoc.chunks);
            const winnerContent = joinChunks(winnerChunks, false) as string;
            await this.historyCapture.saveConflict(filePath, loserContent, winnerContent);
            showNotice(`Conflict resolved: ${filePath.split("/").pop()}. Losing version saved to history.`);
        } catch (e) {
            console.error("CouchSync: Failed to save conflict to history:", e);
        }
    },
);
```

- [ ] **Step 6: Register view and commands**

```typescript
this.registerView(VIEW_TYPE_DIFF_HISTORY, (leaf) => new DiffHistoryView(leaf, this));

this.addRibbonIcon("history", "Diff History", () => {
    this.activateHistoryView();
});

this.addCommand({
    id: "couchsync-show-history",
    name: "Show file history",
    callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file) this.showHistory(file.path);
    },
});
```

- [ ] **Step 7: Add helper methods**

```typescript
async activateHistoryView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DIFF_HISTORY);
    if (existing.length > 0) {
        this.app.workspace.revealLeaf(existing[0]);
        return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_DIFF_HISTORY, active: true });
        this.app.workspace.revealLeaf(leaf);
    }
}

async showHistory(filePath: string): Promise<void> {
    await this.activateHistoryView();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DIFF_HISTORY);
    if (leaves.length > 0) {
        const view = leaves[0].view as DiffHistoryView;
        await view.showFileHistory(filePath);
    }
}
```

- [ ] **Step 8: Start/stop history services in lifecycle**

In `onLayoutReady`:
```typescript
this.historyCapture.start();
this.historyManager.startCleanup();
```

In `onunload`:
```typescript
this.historyCapture?.stop();
this.historyManager?.stopCleanup();
this.historyStorage?.close();
```

- [ ] **Step 9: Update ConflictResolver constructor**

Modify `src/conflict/conflict-resolver.ts` to accept the callback:

```typescript
constructor(
    private db: LocalDB,
    private onConflictResolved?: (
        filePath: string,
        winnerDoc: FileDoc,
        loserDoc: FileDoc,
    ) => Promise<void>,
) {}
```

In `resolveIfConflicted`, before `db.remove()`, call the callback with winner and loser FileDocs.

- [ ] **Step 10: Build check**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 11: Commit**

```bash
git add src/main.ts src/conflict/conflict-resolver.ts
git commit -m "feat: wire history services, conflict callback, view registration"
```

---

### Task 8: Final integration + version bump

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 2: Commit all remaining changes**

```bash
git add -A
git commit -m "v0.5.0: diff-history integration — local change history, conflict preservation, diff viewer"
```
