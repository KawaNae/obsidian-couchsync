/**
 * Production IVaultIO backed by Obsidian's `App.vault` and
 * `App.vault.adapter`.
 *
 * This is the ONLY file in the project that touches `App.vault` for file
 * I/O. All TFile ↔ path resolution is confined here.
 */

import type { App, TFile } from "obsidian";
import type { IVaultIO, FileStat, VaultFile } from "../types/vault-io.ts";

export class ObsidianVaultIO implements IVaultIO {
    constructor(private app: App) {}

    async readBinary(path: string): Promise<ArrayBuffer> {
        const file = this.resolveFile(path);
        return this.app.vault.readBinary(file);
    }

    async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
        const file = this.resolveFile(path);
        await this.app.vault.modifyBinary(file, data);
    }

    async createBinary(path: string, data: ArrayBuffer): Promise<void> {
        await this.app.vault.createBinary(path, data);
    }

    async delete(path: string): Promise<void> {
        const abs = this.app.vault.getAbstractFileByPath(path);
        if (abs) await this.app.vault.delete(abs);
    }

    async exists(path: string): Promise<boolean> {
        return (await this.app.vault.adapter.exists(path));
    }

    async stat(path: string): Promise<FileStat | null> {
        const abs = this.app.vault.getAbstractFileByPath(path);
        if (!abs || !("stat" in abs)) return null;
        const f = abs as TFile;
        return { mtime: f.stat.mtime, ctime: f.stat.ctime, size: f.stat.size };
    }

    async createFolder(path: string): Promise<void> {
        await this.app.vault.createFolder(path);
    }

    async list(path: string): Promise<{ files: string[]; folders: string[] }> {
        return this.app.vault.adapter.list(path);
    }

    async cachedRead(path: string): Promise<string> {
        const file = this.resolveFile(path);
        return this.app.vault.cachedRead(file);
    }

    getFiles(): VaultFile[] {
        return this.app.vault.getFiles().map((f) => ({
            path: f.path,
            stat: { mtime: f.stat.mtime, ctime: f.stat.ctime, size: f.stat.size },
        }));
    }

    // ── internal ──────────────────────────────────────

    private resolveFile(path: string): TFile {
        const abs = this.app.vault.getAbstractFileByPath(path);
        if (!abs || !("stat" in abs)) {
            throw new Error(`File not found: ${path}`);
        }
        return abs as TFile;
    }
}
