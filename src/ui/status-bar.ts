import { Platform, type Plugin } from "obsidian";
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
    private dotEl: HTMLSpanElement | null = null;
    private textEl: HTMLSpanElement | null = null;
    private floatingEl: HTMLElement | null = null;

    constructor(plugin: Plugin) {
        if (!Platform.isMobile) {
            // Desktop: status bar
            const el = plugin.addStatusBarItem();
            el.addClass("cs-status");
            this.dotEl = el.createSpan({ cls: "cs-status__dot" });
            this.textEl = el.createSpan();
        } else {
            // Mobile: phone or tablet
            this.floatingEl = createDiv();
            this.dotEl = this.floatingEl.createSpan({ cls: "cs-status__dot" });
            this.textEl = this.floatingEl.createSpan();

            const navbar = document.querySelector(".mobile-navbar");
            if (navbar) {
                // Phone: anchor inside navbar
                this.floatingEl.addClass("cs-mobile-status");
                navbar.insertBefore(this.floatingEl, navbar.firstChild);
            } else {
                // iPad: fixed bottom-right (no navbar, no status bar)
                this.floatingEl.addClass("cs-mobile-status", "cs-mobile-status--tablet");
                document.body.appendChild(this.floatingEl);
            }
        }

        this.update("disconnected");
    }

    update(state: SyncState): void {
        if (this.dotEl) {
            this.dotEl.className = "cs-status__dot";
            this.dotEl.addClass(STATE_DOT_CLASS[state]);
        }
        if (this.textEl) {
            this.textEl.setText(STATE_LABELS[state]);
        }
    }

    destroy(): void {
        this.floatingEl?.remove();
        this.floatingEl = null;
    }
}
