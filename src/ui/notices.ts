import { Notice } from "obsidian";
import { notify, logError } from "./log.ts";

/**
 * A Notice that can be updated in-place.
 * Useful for progress reporting during long operations.
 */
export class ProgressNotice {
    private notice: Notice;
    private prefix: string;

    constructor(prefix: string) {
        this.prefix = prefix;
        this.notice = new Notice(`CouchSync: ${prefix}`, 0); // 0 = stays until hidden
    }

    update(message: string): void {
        this.notice.setMessage(`CouchSync: ${this.prefix}\n${message}`);
    }

    done(summary: string, durationMs: number = 5000): void {
        this.notice.hide();
        notify(summary, durationMs);
    }

    fail(message: string, durationMs: number = 10000): void {
        this.notice.hide();
        logError(message);
    }
}
