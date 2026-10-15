import { Notice } from "obsidian";
import { notify, logDebug, logError, logWarn, PLUGIN_PREFIX } from "./log.ts";
import { describeError, rawErrorMessage, type ErrorOutcome } from "./describe-error.ts";

/** The text an Obsidian Notice shows for `message`: the plugin prefix, once. */
export function noticeText(message: string): string {
    return PLUGIN_PREFIX + message;
}

/**
 * Show `message` as an Obsidian Notice. Every Notice the plugin shows is
 * created here — the log sink passed to `initLog` included — so the prefix
 * is added in one place and callers pass bare text.
 */
export function showNotice(message: string, durationMs?: number): Notice {
    return new Notice(noticeText(message), durationMs);
}

/** How long the "cancelled" line stays on a Notice. */
const CANCELLED_NOTICE_MS = 4000;
/** How long the "not started" line stays on a Notice: as long as an error
 *  notice, since it names what to wait for. */
const REFUSED_NOTICE_MS = 8000;

/** The line `<label>`'s end with `err` is shown and logged with, and how
 *  it ended. */
function endLine(label: string, err: unknown): { outcome: ErrorOutcome; line: string; text: string } {
    const d = describeError(err);
    const line = d.outcome === "cancelled"
        ? (d.text ? `${label} cancelled — ${d.text}` : `${label} cancelled`)
        : d.outcome === "refused"
            ? `${label} not started — ${d.text}`
            : `${label} failed — ${d.text}`;
    return { outcome: d.outcome, line, text: d.text };
}

/** Log a failure as an error (which also shows it as a notice). When the
 *  sentence does not contain the raw message (a domain error's own
 *  sentence), the raw message is logged at debug level so the log always
 *  keeps what was actually thrown. */
function logFailure(label: string, line: string, text: string, err: unknown): void {
    logError(line);
    const raw = rawErrorMessage(err);
    if (raw && !text.includes(raw)) {
        logDebug(`${label} failed — raw error: ${raw}`);
    }
}

/**
 * End `label`, an action that runs without a ProgressNotice (a change of
 * a setting the operations read), with `err`, worded and logged as
 * `ProgressNotice.fail` does: a failure as an error, a cancellation or a
 * refusal as a warning with a notice of its own.
 */
export function reportError(label: string, err: unknown): void {
    const { outcome, line, text } = endLine(label, err);
    if (outcome === "failed") {
        logFailure(label, line, text, err);
        return;
    }
    showNotice(line, outcome === "refused" ? REFUSED_NOTICE_MS : CANCELLED_NOTICE_MS);
    logWarn(line);
}

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
 * `describeError` — `<label> failed — <cause and fix>`,
 * `<label> cancelled` or `<label> not started — <what runs>`. The summary
 * therefore does not repeat the label. The in-place Notice gets the plugin
 * prefix from `showNotice` / `noticeText`, like every other notice.
 */
type Phase = "start" | "update" | "done";

const UPDATE_LOG_THROTTLE_MS = 500;

export class ProgressNotice {
    private notice: Notice;
    private label: string;
    private lastLoggedMessage = "";
    private lastLoggedAt = 0;

    constructor(label: string) {
        this.label = label;
        this.notice = showNotice(label, 0);
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
     * also shows it as a notice). A cancellation (the user asked for it)
     * and a refusal (another operation runs, nothing was started) are only
     * warnings, with their line on this Notice for a while.
     */
    fail(err: unknown): void {
        const { outcome, line, text } = endLine(this.label, err);
        if (outcome === "failed") {
            this.notice.hide();
            logFailure(this.label, line, text, err);
            return;
        }
        this.notice.setMessage(noticeText(line));
        setTimeout(
            () => this.notice.hide(),
            outcome === "refused" ? REFUSED_NOTICE_MS : CANCELLED_NOTICE_MS,
        );
        logWarn(line);
    }

    private report(phase: Phase, message: string, durationMs?: number): void {
        switch (phase) {
            case "start":
                logDebug(`${this.label} — started`);
                return;

            case "update": {
                this.notice.setMessage(noticeText(`${this.label}\n${message}`));
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
