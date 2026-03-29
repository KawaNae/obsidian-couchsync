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
        const isMobile = document.body.hasClass("is-mobile");
        const isPhone = document.body.hasClass("is-phone");

        if (!isMobile) {
            // Desktop: status bar
            const el = plugin.addStatusBarItem();
            el.addClass("cs-status");
            this.dotEl = el.createSpan({ cls: "cs-status__dot" });
            this.textEl = el.createSpan();
        } else {
            // Mobile (phone or tablet)
            this.floatingEl = createDiv({ cls: "cs-mobile-status" });
            this.dotEl = this.floatingEl.createSpan({ cls: "cs-status__dot" });
            this.textEl = this.floatingEl.createSpan();

            if (isPhone) {
                // Phone: anchor inside .mobile-navbar
                const navbar = document.querySelector(".mobile-navbar");
                if (navbar) {
                    navbar.insertBefore(this.floatingEl, navbar.firstChild);
                } else {
                    document.body.appendChild(this.floatingEl);
                }
            } else {
                // Tablet (iPad): append to body, CSS handles fixed positioning
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
