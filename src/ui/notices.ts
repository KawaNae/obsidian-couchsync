import { Notice } from "obsidian";
import { notify, logDebug, logError, logWarn } from "./log.ts";
import { describeError, rawErrorMessage } from "./describe-error.ts";

/**
 * Long-lived Notice that can be updated in-place, with a unified
 * lifecycle (start → update* → done|fail) routed through a single
 * `report()` so UI updates and log records always travel together.
 *
 * `update()` is throttled at the LOG level (500ms + same-message dedupe)
 * so progress spam doesn't flood the log buffer; the UI Notice itself
 * always reflects the latest message for smooth user feedback.
 *
 * The label is added here and only here: callers pass a bare summary to
 * `done` and the error itself to `fail`, whose sentence comes from
 * `describeError` — `<label> failed — <cause and fix>`, or
 * `<label> cancelled`. The "CouchSync: " prefix of the log-routed notices
 * is added by the log sink (see log.ts); only the in-place Notice this class
 * creates itself carries it explicitly.
 */
type Phase = "start" | "update" | "done";

const UPDATE_LOG_THROTTLE_MS = 500;
/** How long the "cancelled" line stays on the in-place Notice. */
const CANCELLED_NOTICE_MS = 4000;

export class ProgressNotice {
    private notice: Notice;
    private label: string;
    private lastLoggedMessage = "";
    private lastLoggedAt = 0;

    constructor(label: string) {
        this.label = label;
        this.notice = new Notice(`CouchSync: ${label}`, 0);
        this.report("start", "");
    }

    update(message: string): void {
        this.report("update", message);
    }

    done(summary: string, durationMs = 5000): void {
        this.notice.hide();
        this.report("done", summary, durationMs);
    }

    /**
     * End the operation with `err`. A failure is logged as an error (which
     * also shows it as a notice); a cancellation only as a warning, with a
     * short-lived line on this Notice — the user asked for it. When the
     * sentence does not contain the raw message (a domain error's own
     * sentence), the raw message is logged at debug level so the log always
     * keeps what was actually thrown.
     */
    fail(err: unknown): void {
        const d = describeError(err);
        if (d.cancelled) {
            const line = d.text ? `${this.label} cancelled — ${d.text}` : `${this.label} cancelled`;
            this.notice.setMessage(`CouchSync: ${line}`);
            setTimeout(() => this.notice.hide(), CANCELLED_NOTICE_MS);
            logWarn(line);
            return;
        }
        this.notice.hide();
        logError(`${this.label} failed — ${d.text}`);
        const raw = rawErrorMessage(err);
        if (raw && !d.text.includes(raw)) {
            logDebug(`${this.label} failed — raw error: ${raw}`);
        }
    }

    private report(phase: Phase, message: string, durationMs?: number): void {
        switch (phase) {
            case "start":
                logDebug(`${this.label} — started`);
                return;

            case "update": {
                this.notice.setMessage(`CouchSync: ${this.label}\n${message}`);
                const now = Date.now();
                if (message === this.lastLoggedMessage) return;
                if (now - this.lastLoggedAt < UPDATE_LOG_THROTTLE_MS) return;
                this.lastLoggedMessage = message;
                this.lastLoggedAt = now;
                logDebug(`${this.label} — ${message}`);
                return;
            }

            case "done":
                notify(`${this.label} — ${message}`, durationMs);
                return;
        }
    }
}
