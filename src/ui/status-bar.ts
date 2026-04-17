import { Platform, type Plugin } from "obsidian";
import type { SyncState, SyncErrorDetail } from "../db/reconnect-policy.ts";
import type { CouchSyncSettings } from "../settings.ts";

const STATE_LABELS: Record<SyncState, string> = {
    disconnected: "Disconnected",
    connected: "Connected",
    syncing: "Syncing...",
    reconnecting: "Reconnecting...",
    error: "Error",
};

const STATE_DOT_CLASS: Record<SyncState, string> = {
    disconnected: "cs-status__dot--disconnected",
    connected: "cs-status__dot--connected",
    syncing: "cs-status__dot--syncing",
    reconnecting: "cs-status__dot--reconnecting",
    error: "cs-status__dot--disconnected",
};

/**
 * Format the age of a timestamp as a human-readable relative string.
 * Tuned for the status bar: "just now" under 5s, then s / m / h / d.
 */
function formatAge(timestamp: number): string {
    const diffSec = Math.floor((Date.now() - timestamp) / 1000);
    if (diffSec < 5) return "just now";
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
}

export class StatusBar {
    private dotEl: HTMLSpanElement | null = null;
    private textEl: HTMLSpanElement | null = null;
    private floatingEl: HTMLElement | null = null;
    private getSettings: () => CouchSyncSettings;
    private getLastHealthyAt: () => number;
    private getErrorDetail: () => SyncErrorDetail | null;
    private state: SyncState = "disconnected";
    private detail?: string;
    private tickTimer: ReturnType<typeof setInterval> | null = null;
    private lastRenderedText = "";
    private lastDotClass = "";

    constructor(
        plugin: Plugin,
        getSettings: () => CouchSyncSettings,
        getLastHealthyAt: () => number,
        getErrorDetail: () => SyncErrorDetail | null,
    ) {
        this.getSettings = getSettings;
        this.getLastHealthyAt = getLastHealthyAt;
        this.getErrorDetail = getErrorDetail;

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
        // 1s re-render so the "last synced" age stays current without
        // requiring a state change event.
        this.tickTimer = setInterval(() => this.render(), 1000);
    }

    update(state: SyncState, detail?: string): void {
        this.state = state;
        this.detail = detail;
        this.render();
    }

    private render(): void {
        const dotClass = STATE_DOT_CLASS[this.state];
        if (this.dotEl && dotClass !== this.lastDotClass) {
            this.dotEl.className = "cs-status__dot";
            this.dotEl.addClass(dotClass);
            this.lastDotClass = dotClass;
        }
        if (!this.textEl) return;

        let text: string;
        if (this.detail !== undefined) {
            text = this.detail;
        } else if (this.state === "error") {
            // Compose an informative error label from the classified
            // detail. HTTP code (if any) is preferred over kind — "401"
            // is more specific than "auth", "503" more than "server".
            const errDetail = this.getErrorDetail();
            const tag = errDetail?.code ?? errDetail?.kind ?? null;
            const base = tag != null ? `Error (${tag})` : "Error";
            const lastHealthy = this.getLastHealthyAt();
            text = lastHealthy > 0
                ? `${base} · last seen ${formatAge(lastHealthy)}`
                : base;
        } else {
            const base = STATE_LABELS[this.state];
            const lastHealthy = this.getLastHealthyAt();
            if (lastHealthy > 0 && this.state === "connected") {
                text = `${base} · ${formatAge(lastHealthy)}`;
            } else if (lastHealthy > 0 && this.state === "disconnected") {
                text = `${base} (last seen ${formatAge(lastHealthy)})`;
            } else {
                text = base;
            }
        }
        if (text !== this.lastRenderedText) {
            this.textEl.setText(text);
            this.lastRenderedText = text;
        }
    }

    /** Re-apply position from settings (call after settings change) */
    applyPosition(): void {
        if (!this.floatingEl) return;
        const s = this.getSettings();
        const m = s.mobileStatus;
        this.floatingEl.style.bottom = `${m.bottom}px`;
        this.floatingEl.style.left = m.align === "left" ? `${m.offset}px` : "";
        this.floatingEl.style.right = m.align === "right" ? `${m.offset}px` : "";
    }

    destroy(): void {
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
        this.floatingEl?.remove();
        this.floatingEl = null;
    }
}
