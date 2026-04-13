import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import {
    type LogLevel,
    type LogEntry,
    getLogEntries,
    clearLog,
    onLogEntry,
} from "./log.ts";
import { formatTime } from "../utils/format.ts";

export const VIEW_TYPE_LOG = "couchsync-log-view";

const LEVEL_LABELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export class LogView extends ItemView {
    private filter: LogLevel | "all" = "all";
    private unsubscribe: (() => void) | null = null;
    private listEl: HTMLElement | null = null;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType(): string { return VIEW_TYPE_LOG; }
    getDisplayText(): string { return "CouchSync Log"; }
    getIcon(): string { return "scroll-text"; }

    async onOpen(): Promise<void> {
        this.render();
        this.unsubscribe = onLogEntry((entry) => this.appendEntry(entry));
    }

    async onClose(): Promise<void> {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.contentEl.empty();
    }

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("couchsync-log-view");

        // ── Header bar ──
        const header = contentEl.createDiv({ cls: "couchsync-log-header" });

        const filterGroup = header.createDiv({ cls: "couchsync-log-filters" });
        for (const level of ["all", ...LEVEL_LABELS] as const) {
            const btn = filterGroup.createEl("button", {
                text: level,
                cls: `couchsync-log-filter-btn${this.filter === level ? " is-active" : ""}`,
            });
            btn.addEventListener("click", () => {
                this.filter = level;
                this.render();
            });
        }

        const actions = header.createDiv({ cls: "couchsync-log-actions" });

        const copyBtn = actions.createEl("button", {
            cls: "couchsync-log-action-btn",
            attr: { "aria-label": "Copy visible log" },
        });
        setIcon(copyBtn, "copy");
        copyBtn.addEventListener("click", () => this.copyVisible());

        const clearBtn = actions.createEl("button", {
            cls: "couchsync-log-action-btn",
            attr: { "aria-label": "Clear log" },
        });
        setIcon(clearBtn, "trash-2");
        clearBtn.addEventListener("click", () => {
            clearLog();
            this.render();
        });

        // ── Log list ──
        this.listEl = contentEl.createDiv({ cls: "couchsync-log-list" });
        const entries = getLogEntries();
        // Newest first
        for (let i = entries.length - 1; i >= 0; i--) {
            if (this.matchesFilter(entries[i])) {
                this.renderEntry(this.listEl, entries[i]);
            }
        }
    }

    private appendEntry(entry: LogEntry): void {
        if (!this.listEl || !this.matchesFilter(entry)) return;
        const row = this.createEntryEl(entry);
        this.listEl.insertBefore(row, this.listEl.firstChild);
    }

    private renderEntry(container: HTMLElement, entry: LogEntry): void {
        container.appendChild(this.createEntryEl(entry));
    }

    private createEntryEl(entry: LogEntry): HTMLElement {
        const row = document.createElement("div");
        row.className = `couchsync-log-entry couchsync-log-${entry.level}`;

        const time = row.createSpan({ cls: "couchsync-log-time" });
        time.textContent = formatTime(entry.timestamp);

        const level = row.createSpan({ cls: "couchsync-log-level" });
        level.textContent = entry.level;

        const msg = row.createSpan({ cls: "couchsync-log-message" });
        msg.textContent = entry.message;

        return row;
    }

    private copyVisible(): void {
        const entries = getLogEntries().filter((e) => this.matchesFilter(e));
        const text = entries
            .map((e) => `${formatTime(e.timestamp)} [${e.level.toUpperCase()}] ${e.message}`)
            .join("\n");
        navigator.clipboard.writeText(text).then(
            () => new Notice("Log copied to clipboard"),
            () => new Notice("Failed to copy log"),
        );
    }

    private matchesFilter(entry: LogEntry): boolean {
        if (this.filter === "all") return true;
        if (this.filter === "debug") return true; // same as all
        if (this.filter === "info") return entry.level !== "debug";
        if (this.filter === "warn") return entry.level === "warn" || entry.level === "error";
        return entry.level === this.filter; // "error"
    }
}
