import type { Plugin } from "obsidian";
import type { SyncState } from "../db/replicator.ts";

const STATE_LABELS: Record<SyncState, string> = {
    disconnected: "Disconnected",
    connected: "Synced",
    syncing: "Syncing...",
    error: "Error",
    paused: "Paused",
};

const STATE_DOT_CLASS: Record<SyncState, string> = {
    disconnected: "cs-status__dot--disconnected",
    connected: "cs-status__dot--connected",
    syncing: "cs-status__dot--syncing",
    error: "cs-status__dot--disconnected",
    paused: "cs-status__dot--disconnected",
};

export class StatusBar {
    private el: HTMLElement;
    private dotEl: HTMLSpanElement;
    private textEl: HTMLSpanElement;

    constructor(plugin: Plugin) {
        this.el = plugin.addStatusBarItem();
        this.el.addClass("cs-status");

        this.dotEl = this.el.createSpan({ cls: "cs-status__dot" });
        this.textEl = this.el.createSpan();

        this.update("disconnected");
    }

    update(state: SyncState): void {
        this.dotEl.className = "cs-status__dot";
        this.dotEl.addClass(STATE_DOT_CLASS[state]);
        this.textEl.setText(STATE_LABELS[state]);
    }
}
