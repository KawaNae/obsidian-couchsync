/**
 * Low-level IVaultIO backed entirely by Obsidian's `App.vault.adapter`.
 *
 * Unlike `ObsidianVaultIO` (which resolves TFile through the vault
 * index), this implementation talks to the filesystem directly via the
 * adapter API. This makes it suitable for paths that Obsidian does NOT
 * index — most notably `.obsidian/` configuration files.
 *
 * Injected into `ConfigSync`; all other modules receive `ObsidianVaultIO`.
 */

import type { App } from "obsidian";
import type { IVaultIO, FileStat, VaultFile } from "../types/vault-io.ts";

export class ObsidianAdapterIO implements IVaultIO {
    constructor(private app: App) {}

    async readBinary(path: string): Promise<ArrayBuffer> {
        return this.app.vault.adapter.readBinary(path);
    }

    async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
        await this.app.vault.adapter.writeBinary(path, data);
    }

    async createBinary(path: string, data: ArrayBuffer): Promise<void> {
        await this.app.vault.adapter.writeBinary(path, data);
    }

    async delete(path: string): Promise<void> {
        if (await this.app.vault.adapter.exists(path)) {
            await this.app.vault.adapter.remove(path);
        }
    }

    async exists(path: string): Promise<boolean> {
        return this.app.vault.adapter.exists(path);
    }

    async stat(path: string): Promise<FileStat | null> {
        const s = await this.app.vault.adapter.stat(path);
        if (!s) return null;
        return { mtime: s.mtime, ctime: s.ctime, size: s.size };
    }

    async createFolder(path: string): Promise<void> {
        if (!(await this.app.vault.adapter.exists(path))) {
            await this.app.vault.adapter.mkdir(path);
        }
    }

    async list(path: string): Promise<{ files: string[]; folders: string[] }> {
        return this.app.vault.adapter.list(path);
    }

    async cachedRead(path: string): Promise<string> {
        const buf = await this.app.vault.adapter.readBinary(path);
        return new TextDecoder().decode(buf);
    }

    /** Not applicable — adapter has no vault file index. */
    getFiles(): VaultFile[] {
        return [];
    }
}
