import { Notice } from "obsidian";

export function showNotice(message: string, durationMs: number = 5000): void {
    new Notice(`CouchSync: ${message}`, durationMs);
}

export function showError(message: string): void {
    new Notice(`CouchSync Error: ${message}`, 10000);
}

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
        new Notice(`CouchSync: ${summary}`, durationMs);
    }
}
