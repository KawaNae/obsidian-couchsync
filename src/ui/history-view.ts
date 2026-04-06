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

    async onOpen(): Promise<void> {
        this.renderEmpty();

        this.registerEvent(
            this.app.workspace.on("active-leaf-change", () => {
                const file = this.app.workspace.getActiveFile();
                if (file) {
                    this.showFileHistory(file.path);
                }
            }),
        );

        this.registerEvent(
            (this.app.workspace as any).on("couchsync:diff-saved", (filePath: string) => {
                if (this.currentFile === filePath) {
                    this.showFileHistory(filePath);
                }
            }),
        );

        const file = this.app.workspace.getActiveFile();
        if (file) {
            await this.showFileHistory(file.path);
        }
    }
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

        const confirmed = await new ConfirmModal(this.plugin.app, "Restore file", `Restore to ${date} ${time}?`, "Restore").waitForResult();
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
