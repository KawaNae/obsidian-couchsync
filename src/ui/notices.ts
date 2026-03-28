import { Notice } from "obsidian";

export function showNotice(message: string, durationMs: number = 5000): void {
    new Notice(`CouchSync: ${message}`, durationMs);
}

export function showError(message: string): void {
    new Notice(`CouchSync Error: ${message}`, 10000);
}
