/**
 * In-memory IVaultIO for tests. All state lives in `files` Map — tests
 * assert on map contents ("is the file there?") rather than method calls.
 */

import type { IVaultIO, FileStat, VaultFile } from "../../src/types/vault-io.ts";

interface FileEntry {
    data: ArrayBuffer;
    stat: FileStat;
}

export class FakeVaultIO implements IVaultIO {
    files = new Map<string, FileEntry>();

    /** When true, path lookups fold case (Windows/macOS semantics): an
     *  exact-key miss falls back to a case-insensitive match, and creating
     *  over an existing case-variant overwrites THAT entry (the on-disk
     *  case is owned by whoever created the file first). */
    constructor(private opts: { caseInsensitive?: boolean } = {}) {}

    /** Resolve `path` to the stored map key (exact first; case-folded when
     *  caseInsensitive). Returns null when nothing matches. */
    private resolveKey(path: string): string | null {
        if (this.files.has(path)) return path;
        if (this.opts.caseInsensitive) {
            const folded = path.toLowerCase();
            for (const key of this.files.keys()) {
                if (key.toLowerCase() === folded) return key;
            }
        }
        return null;
    }

    // ── helpers for test setup ──────────────────────────

    /** Seed a file with string content. */
    addFile(path: string, content: string, stat?: Partial<FileStat>): void {
        const buf = new TextEncoder().encode(content).buffer;
        this.addBinaryFile(path, buf, stat);
    }

    /** Seed a file with binary content. */
    addBinaryFile(path: string, data: ArrayBuffer, stat?: Partial<FileStat>): void {
        const now = Date.now();
        this.files.set(path, {
            data,
            stat: { mtime: now, ctime: now, size: data.byteLength, ...stat },
        });
    }

    /** Read file content as UTF-8 string (convenience for assertions). */
    readText(path: string): string {
        const entry = this.files.get(path);
        if (!entry) throw new Error(`FakeVaultIO: file not found: ${path}`);
        return new TextDecoder().decode(entry.data);
    }

    // ── IVaultIO implementation ─────────────────────────

    async readBinary(path: string): Promise<ArrayBuffer> {
        const key = this.resolveKey(path);
        const entry = key !== null ? this.files.get(key) : undefined;
        if (!entry) throw new Error(`File not found: ${path}`);
        return entry.data;
    }

    async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
        const key = this.resolveKey(path);
        const entry = key !== null ? this.files.get(key) : undefined;
        if (!entry) throw new Error(`File not found: ${path}`);
        entry.data = data;
        entry.stat = { ...entry.stat, mtime: Date.now(), size: data.byteLength };
    }

    async createBinary(path: string, data: ArrayBuffer): Promise<void> {
        const existingKey = this.resolveKey(path);
        if (existingKey !== null) {
            // Case-insensitive FS: creating over a case-variant writes the
            // existing physical file — its on-disk case is preserved.
            await this.writeBinary(existingKey, data);
            return;
        }
        const now = Date.now();
        this.files.set(path, {
            data,
            stat: { mtime: now, ctime: now, size: data.byteLength },
        });
    }

    async delete(path: string): Promise<void> {
        const key = this.resolveKey(path);
        if (key !== null) this.files.delete(key);
    }

    async exists(path: string): Promise<boolean> {
        return this.resolveKey(path) !== null;
    }

    async stat(path: string): Promise<FileStat | null> {
        const key = this.resolveKey(path);
        const entry = key !== null ? this.files.get(key) : undefined;
        return entry ? { ...entry.stat } : null;
    }

    async createFolder(_path: string): Promise<void> {
        // No-op — flat map doesn't model directories.
    }

    async list(path: string): Promise<{ files: string[]; folders: string[] }> {
        const prefix = path.endsWith("/") ? path : path + "/";
        const files: string[] = [];
        const folderSet = new Set<string>();
        for (const key of this.files.keys()) {
            if (!key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            const slashIdx = rest.indexOf("/");
            if (slashIdx === -1) {
                files.push(key);
            } else {
                folderSet.add(prefix + rest.slice(0, slashIdx));
            }
        }
        return { files, folders: [...folderSet] };
    }

    async cachedRead(path: string): Promise<string> {
        const buf = await this.readBinary(path);
        return new TextDecoder().decode(buf);
    }

    getFiles(): VaultFile[] {
        const result: VaultFile[] = [];
        for (const [path, entry] of this.files) {
            if (path.startsWith(".")) continue;
            result.push({ path, stat: { ...entry.stat } });
        }
        return result;
    }

    getFolders(): string[] {
        // Flat map: folders are the ancestor prefixes implied by file paths.
        const folders = new Set<string>();
        for (const path of this.files.keys()) {
            if (path.startsWith(".")) continue;
            const parts = path.split("/");
            for (let i = 1; i < parts.length; i++) {
                folders.add(parts.slice(0, i).join("/"));
            }
        }
        return [...folders];
    }

    async abstractType(path: string): Promise<"file" | "folder" | null> {
        if (this.files.has(path)) return "file";
        const prefix = path + "/";
        for (const key of this.files.keys()) {
            if (key.startsWith(prefix)) return "folder";
        }
        return null;
    }
}
