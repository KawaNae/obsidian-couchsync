/**
 * Browser environment listeners extracted from SyncEngine.
 *
 * Manages online/offline, visibilitychange, and beforeunload event
 * handlers. Fires callbacks into SyncEngine when the environment
 * state changes.
 */

import type { SyncState, ReconnectReason } from "./reconnect-policy.ts";
import { logDebug, logError } from "../ui/log.ts";

// ── Callbacks supplied by SyncEngine ─────────────────────

export interface EnvListenerHost {
    getState(): SyncState;
    setState(state: SyncState): void;
    emitError(message: string): void;
    requestReconnect(reason: ReconnectReason): Promise<void>;
    fireReconnectHandlers(): void;
    isMobile: boolean;
}

// ── EnvListeners ─────────────────────────────────────────

export class EnvListeners {
    private attached = false;
    private backgroundedAt = 0;

    private boundOnOffline = () => this.handleOffline();
    private boundOnOnline = () => this.handleOnline();
    private boundOnVisibility = () =>
        this.handleVisibilityChange(document.visibilityState === "visible");

    constructor(private host: EnvListenerHost) {}

    attach(): void {
        if (this.attached) return;
        window.addEventListener("offline", this.boundOnOffline);
        window.addEventListener("online", this.boundOnOnline);
        document.addEventListener("visibilitychange", this.boundOnVisibility);
        this.attached = true;
    }

    detach(): void {
        if (!this.attached) return;
        window.removeEventListener("offline", this.boundOnOffline);
        window.removeEventListener("online", this.boundOnOnline);
        document.removeEventListener("visibilitychange", this.boundOnVisibility);
        this.attached = false;
    }

    // ── Handlers ─────────────────────────────────────────

    private handleVisibilityChange(visible: boolean): void {
        if (!visible) {
            this.backgroundedAt = Date.now();
            logDebug(`visibility: hidden at=${this.backgroundedAt} state=${this.host.getState()}`);
            return;
        }
        const hiddenMs = this.backgroundedAt
            ? Date.now() - this.backgroundedAt
            : 0;
        this.backgroundedAt = 0;
        const reason: ReconnectReason =
            this.host.isMobile || hiddenMs >= 30_000
                ? "app-resume"
                : "app-foreground";
        logDebug(
            `visibility: visible after ${hiddenMs}ms (mobile=${this.host.isMobile}) → reason=${reason} state=${this.host.getState()}`,
        );
        void this.host.requestReconnect(reason);
    }

    private handleOffline(): void {
        const state = this.host.getState();
        logDebug(`network: offline state=${state}`);
        if (state === "connected" || state === "syncing") {
            this.host.setState("disconnected");
            this.host.emitError("Network offline");
        }
    }

    private handleOnline(): void {
        const state = this.host.getState();
        logDebug(`network: online state=${state}`);
        void this.host.requestReconnect("network-online");
        if (state === "disconnected" || state === "error") {
            this.host.fireReconnectHandlers();
        }
    }
}
