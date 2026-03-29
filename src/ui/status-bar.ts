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
    // Desktop: status bar item
    private desktopEl: HTMLElement | null = null;
    private desktopDot: HTMLSpanElement | null = null;
    private desktopText: HTMLSpanElement | null = null;

    // Mobile: anchored to navbar
    private mobileEl: HTMLElement | null = null;
    private mobileDot: HTMLSpanElement | null = null;
    private mobileText: HTMLSpanElement | null = null;

    constructor(plugin: Plugin) {
        if (Platform.isMobile) {
            this.createMobileIndicator();
        } else {
            this.desktopEl = plugin.addStatusBarItem();
            this.desktopEl.addClass("cs-status");
            this.desktopDot = this.desktopEl.createSpan({ cls: "cs-status__dot" });
            this.desktopText = this.desktopEl.createSpan();
        }

        this.update("disconnected");
    }

    private createMobileIndicator(): void {
        this.mobileEl = createDiv({ cls: "cs-mobile-status" });
        this.mobileDot = this.mobileEl.createSpan({ cls: "cs-status__dot" });
        this.mobileText = this.mobileEl.createSpan();

        // Insert inside .mobile-navbar, at the beginning
        const navbar = document.querySelector(".mobile-navbar");
        if (navbar) {
            navbar.insertBefore(this.mobileEl, navbar.firstChild);
        } else {
            // Fallback: append to body with fixed position
            this.mobileEl.addClass("cs-mobile-status--fallback");
            document.body.appendChild(this.mobileEl);
        }
    }

    update(state: SyncState): void {
        const dotClass = STATE_DOT_CLASS[state];
        const label = STATE_LABELS[state];

        if (this.desktopDot && this.desktopText) {
            this.desktopDot.className = "cs-status__dot";
            this.desktopDot.addClass(dotClass);
            this.desktopText.setText(label);
        }

        if (this.mobileDot && this.mobileText) {
            this.mobileDot.className = "cs-status__dot";
            this.mobileDot.addClass(dotClass);
            this.mobileText.setText(label);
        }
    }

    destroy(): void {
        this.mobileEl?.remove();
        this.mobileEl = null;
    }
}
