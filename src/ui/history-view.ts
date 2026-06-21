import { ItemView, WorkspaceLeaf, Notice, setIcon } from "obsidian";
import type CouchSyncPlugin from "../main.ts";
import type { HistoryEntry } from "../history/types.ts";
import { ConfirmModal } from "./confirm-modal.ts";
import { DiffCompareModal } from "./diff-compare-modal.ts";
import { formatTime, formatDate } from "../utils/format.ts";
import { buildGraphLayout, getMaxColumn, type GraphRow } from "./history-graph.ts";

export const VIEW_TYPE_DIFF_HISTORY = "couchsync-history-view";

const COLUMN_WIDTH = 16;
const ROW_HEIGHT = 32;
const DOT_RADIUS = 4;
const SVG_NS = "http://www.w3.org/2000/svg";

export class DiffHistoryView extends ItemView {
    private currentFile: string | null = null;
    private graphRows: GraphRow[] = [];
    private headRecordId: number | null = null;

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
        const entries = await this.plugin.historyManager.getFileHistory(filePath);
        const snapshot = await this.plugin.historyManager.getSnapshot(filePath);
        this.headRecordId = snapshot?.headRecordId ?? null;
        this.graphRows = buildGraphLayout(entries, this.headRecordId);
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

        if (this.graphRows.length === 0) { this.renderEmpty(); return; }

        const maxCol = getMaxColumn(this.graphRows);
        const graphWidth = (maxCol + 1) * COLUMN_WIDTH;

        let prevDate = "";
        for (let i = 0; i < this.graphRows.length; i++) {
            const gRow = this.graphRows[i];
            const entry = gRow.entry;
            const isHead = entry.record.id === this.headRecordId;

            const curDate = formatDate(entry.record.timestamp);
            if (curDate !== prevDate) {
                this.renderDateSeparator(container, curDate, graphWidth, i > 0 ? this.graphRows[i - 1] : undefined, gRow);
                prevDate = curDate;
            }

            const row = container.createDiv({ cls: "diff-history-entry" });

            this.renderGraphCell(row, gRow, graphWidth);

            if (isHead) {
                row.createSpan({ cls: "diff-history-head-badge", text: "HEAD" });
            }

            row.createSpan({ cls: "diff-history-time", text: formatTime(entry.record.timestamp) });

            if (entry.record.conflict) {
                row.createSpan({ cls: "diff-history-conflict-badge", text: "conflict" });
            }

            const summary = row.createSpan({ cls: "diff-history-summary" });
            if (entry.added > 0) summary.createSpan({ cls: "diff-history-additions", text: `+${entry.added}` });
            if (entry.removed > 0) summary.createSpan({ cls: "diff-history-deletions", text: `-${entry.removed}` });

            if ((entry.record.source ?? "local") === "sync") {
                const icon = row.createSpan({ cls: "diff-history-sync-icon", attr: { "aria-label": "from sync" } });
                setIcon(icon, "cloud-download");
            }

            const actions = row.createSpan({ cls: "diff-history-entry-actions" });
            const diffBtn = actions.createEl("button", { cls: "diff-history-btn", text: "Diff" });
            diffBtn.addEventListener("click", (e) => { e.stopPropagation(); this.onShowDiff(entry); });

            if (!isHead) {
                const restoreBtn = actions.createEl("button", { cls: "diff-history-btn", text: "Restore" });
                restoreBtn.addEventListener("click", (e) => { e.stopPropagation(); this.onRestore(entry); });
            }
        }
    }

    private renderGraphCell(row: HTMLElement, gRow: GraphRow, graphWidth: number): void {
        row.style.paddingLeft = `${graphWidth + 8}px`;
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "diff-history-graph");
        svg.setAttribute("width", String(graphWidth));
        svg.setAttribute("viewBox", `0 0 ${graphWidth} ${ROW_HEIGHT}`)
        svg.setAttribute("preserveAspectRatio", "none");

        const cx = gRow.column * COLUMN_WIDTH + COLUMN_WIDTH / 2;
        const cy = ROW_HEIGHT / 2;
        const isBranch = gRow.column > 0;
        const mainCls = isBranch ? "graph-branch" : "graph-main";

        for (const col of gRow.passThrough) {
            const x = col * COLUMN_WIDTH + COLUMN_WIDTH / 2;
            const cls = col > 0 ? "graph-branch" : "graph-main";
            this.svgLine(svg, x, 0, x, ROW_HEIGHT, cls);
        }

        if (gRow.hasUp) {
            this.svgLine(svg, cx, 0, cx, cy - DOT_RADIUS, mainCls);
        }
        if (gRow.hasDown) {
            this.svgLine(svg, cx, cy + DOT_RADIUS, cx, ROW_HEIGHT, mainCls);
        }

        for (const fromCol of gRow.mergeFrom) {
            const fx = fromCol * COLUMN_WIDTH + COLUMN_WIDTH / 2;
            this.svgLine(svg, fx, 0, cx, cy, "graph-branch");
        }

        const circle = document.createElementNS(SVG_NS, "circle");
        circle.setAttribute("cx", String(cx));
        circle.setAttribute("cy", String(cy));
        circle.setAttribute("r", String(DOT_RADIUS));
        circle.setAttribute("class", `graph-dot ${mainCls}`);
        svg.appendChild(circle);

        row.appendChild(svg);
    }

    private renderDateSeparator(
        container: HTMLElement,
        date: string,
        graphWidth: number,
        above: GraphRow | undefined,
        below: GraphRow,
    ): void {
        const SEP_HEIGHT = 24;
        const sep = container.createDiv({ cls: "diff-history-date-sep" });
        sep.style.paddingLeft = `${graphWidth + 8}px`;

        const active = new Set<number>();
        if (above) {
            if (above.hasDown) active.add(above.column);
            for (const c of above.passThrough) active.add(c);
        }
        if (below.hasUp) active.add(below.column);
        for (const c of below.passThrough) active.add(c);
        for (const c of below.mergeFrom) active.add(c);

        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "diff-history-graph");
        svg.setAttribute("width", String(graphWidth));
        svg.setAttribute("viewBox", `0 0 ${graphWidth} ${SEP_HEIGHT}`);
        svg.setAttribute("preserveAspectRatio", "none");

        for (const col of active) {
            const x = col * COLUMN_WIDTH + COLUMN_WIDTH / 2;
            const cls = col > 0 ? "graph-branch" : "graph-main";
            this.svgLine(svg, x, 0, x, SEP_HEIGHT, cls);
        }

        sep.appendChild(svg);
        sep.createSpan({ cls: "diff-history-date-label", text: date });
    }

    private svgLine(svg: SVGElement, x1: number, y1: number, x2: number, y2: number, cls: string): void {
        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("x1", String(x1));
        line.setAttribute("y1", String(y1));
        line.setAttribute("x2", String(x2));
        line.setAttribute("y2", String(y2));
        line.setAttribute("class", cls);
        svg.appendChild(line);
    }

    private renderEmpty(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createDiv({ cls: "diff-history-view" }).createDiv({
            cls: "diff-history-empty",
            text: "No history available. Open a file and start editing to see changes here.",
        });
    }

    private async onShowDiff(entry: HistoryEntry): Promise<void> {
        if (!this.currentFile || entry.record.id == null) return;

        const reconstructed = await this.plugin.historyManager.reconstructAtRecord(this.currentFile, entry.record.id);
        if (reconstructed === null) { new Notice("Failed to reconstruct file at this point."); return; }

        let previousContent: string;
        let leftLabel: string;

        if (entry.record.parentId != null) {
            const prev = await this.plugin.historyManager.reconstructAtRecord(this.currentFile, entry.record.parentId);
            if (prev === null) { new Notice("Failed to reconstruct previous state."); return; }
            previousContent = prev;
            const parentEntry = this.graphRows.find((r) => r.entry.record.id === entry.record.parentId);
            if (parentEntry) {
                leftLabel = `${formatDate(parentEntry.entry.record.timestamp)} ${formatTime(parentEntry.entry.record.timestamp)}`;
            } else {
                leftLabel = "(previous)";
            }
        } else {
            previousContent = "";
            leftLabel = "(empty)";
        }

        const rightLabel = `${formatDate(entry.record.timestamp)} ${formatTime(entry.record.timestamp)}`;
        new DiffCompareModal(this.plugin.app, previousContent, reconstructed, `${leftLabel} → ${rightLabel}`, leftLabel, rightLabel).open();
    }

    private async onRestore(entry: HistoryEntry): Promise<void> {
        if (!this.currentFile || entry.record.id == null) return;
        const time = formatTime(entry.record.timestamp);
        const date = formatDate(entry.record.timestamp);

        const confirmed = await new ConfirmModal(
            this.plugin.app,
            "Restore file",
            `Restore to ${date} ${time}?\nCurrent changes will remain on a separate branch.`,
            "Restore",
        ).waitForResult();
        if (!confirmed) return;

        const success = await this.plugin.restoreFromHistory(this.currentFile, entry.record.id);
        if (success) {
            new Notice("File restored successfully.");
            await this.showFileHistory(this.currentFile);
        } else {
            new Notice("Failed to restore file.");
        }
    }
}
