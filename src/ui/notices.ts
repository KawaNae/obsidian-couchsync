import { Notice } from "obsidian";
import { notify, logDebug, logError } from "./log.ts";

/**
 * Long-lived Notice that can be updated in-place, with a unified
 * lifecycle (start → update* → done|fail) routed through a single
 * `report()` so UI updates and log records always travel together.
 *
 * `update()` is throttled at the LOG level (500ms + same-message dedupe)
 * so progress spam doesn't flood the log buffer; the UI Notice itself
 * always reflects the latest message for smooth user feedback.
 */
type Phase = "start" | "update" | "done" | "fail";

const UPDATE_LOG_THROTTLE_MS = 500;

export class ProgressNotice {
    private notice: Notice;
    private prefix: string;
    private lastLoggedMessage = "";
    private lastLoggedAt = 0;

    constructor(prefix: string) {
        this.prefix = prefix;
        this.notice = new Notice(`CouchSync: ${prefix}`, 0);
        this.report("start", "");
    }

    update(message: string): void {
        this.report("update", message);
    }

    done(summary: string, durationMs = 5000): void {
        this.notice.hide();
        this.report("done", summary, durationMs);
    }

    fail(message: string, _durationMs = 10000): void {
        this.notice.hide();
        this.report("fail", message);
    }

    private report(phase: Phase, message: string, durationMs?: number): void {
        switch (phase) {
            case "start":
                logDebug(`CouchSync: ${this.prefix} — started`);
                return;

            case "update": {
                this.notice.setMessage(`CouchSync: ${this.prefix}\n${message}`);
                const now = Date.now();
                if (message === this.lastLoggedMessage) return;
                if (now - this.lastLoggedAt < UPDATE_LOG_THROTTLE_MS) return;
                this.lastLoggedMessage = message;
                this.lastLoggedAt = now;
                logDebug(`CouchSync: ${this.prefix} — ${message}`);
                return;
            }

            case "done":
                notify(`CouchSync: ${this.prefix} — ${message}`, durationMs);
                return;

            case "fail":
                logError(`CouchSync: ${this.prefix} — ${message}`);
                return;
        }
    }
}
