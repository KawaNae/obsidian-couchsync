import { Platform, type Plugin } from "obsidian";
import type { SyncState } from "../db/replicator.ts";
import type { CouchSyncSettings } from "../settings.ts";

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
    private dotEl: HTMLSpanElement | null = null;
    private textEl: HTMLSpanElement | null = null;
    private floatingEl: HTMLElement | null = null;
    private getSettings: () => CouchSyncSettings;

    constructor(plugin: Plugin, getSettings: () => CouchSyncSettings) {
        this.getSettings = getSettings;

        if (!Platform.isMobile) {
            const el = plugin.addStatusBarItem();
            el.addClass("cs-status");
            this.dotEl = el.createSpan({ cls: "cs-status__dot" });
            this.textEl = el.createSpan();
        } else {
            this.floatingEl = createDiv({ cls: "cs-mobile-status" });
            this.dotEl = this.floatingEl.createSpan({ cls: "cs-status__dot" });
            this.textEl = this.floatingEl.createSpan();
            document.body.appendChild(this.floatingEl);
            this.applyPosition();
        }

        this.update("disconnected");
    }

    update(state: SyncState, detail?: string): void {
        if (this.dotEl) {
            this.dotEl.className = "cs-status__dot";
            this.dotEl.addClass(STATE_DOT_CLASS[state]);
        }
        if (this.textEl) {
            this.textEl.setText(detail ?? STATE_LABELS[state]);
        }
    }

    /** Re-apply position from settings (call after settings change) */
    applyPosition(): void {
        if (!this.floatingEl) return;
        const s = this.getSettings();
        this.floatingEl.style.bottom = `${s.mobileStatusBottom}px`;
        this.floatingEl.style.left = s.mobileStatusAlign === "left" ? `${s.mobileStatusOffset}px` : "";
        this.floatingEl.style.right = s.mobileStatusAlign === "right" ? `${s.mobileStatusOffset}px` : "";
    }

    destroy(): void {
        this.floatingEl?.remove();
        this.floatingEl = null;
    }
}
