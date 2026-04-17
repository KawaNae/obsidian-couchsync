/**
 * Portable vault I/O abstraction.
 *
 * Decouples every module that touches the vault filesystem from Obsidian's
 * `App.vault` / `App.vault.adapter`. The real implementation
 * (`ObsidianVaultIO`) lives in `src/adapters/` and is the *only* place in
 * the tree that imports `App` for file operations.
 *
 * Test code injects `FakeVaultIO` (in-memory Map) instead, so assertions
 * check data ("is the file there?") rather than method calls.
 */

export interface FileStat {
    mtime: number;
    ctime: number;
    size: number;
}

export interface IVaultIO {
    /** Read raw bytes. Throws if the file does not exist. */
    readBinary(path: string): Promise<ArrayBuffer>;

    /**
     * Overwrite an existing file's content. Throws if the file does not
     * exist — callers must use `createBinary` for new files.
     */
    writeBinary(path: string, data: ArrayBuffer): Promise<void>;

    /** Create a new file with the given content. */
    createBinary(path: string, data: ArrayBuffer): Promise<void>;

    /** Delete a file (or folder). */
    delete(path: string): Promise<void>;

    /** True when a file or folder exists at `path`. */
    exists(path: string): Promise<boolean>;

    /**
     * Return stat for a file. Returns null when the path doesn't exist
     * or points to a non-file (folder).
     */
    stat(path: string): Promise<FileStat | null>;

    /** Recursively create the directory tree. No-op if it already exists. */
    createFolder(path: string): Promise<void>;

    /**
     * List immediate children of `path`. Returns an object with `files`
     * (full paths) and `folders` (full paths).
     */
    list(path: string): Promise<{ files: string[]; folders: string[] }>;

    /**
     * Read a text file using the host's cache when available. Falls back
     * to a fresh read when no cache exists. Used by HistoryCapture for
     * the typing hot-path where repeated reads of unchanged content are
     * the common case.
     */
    cachedRead(path: string): Promise<string>;

    /**
     * Return all files in the vault (not folders, not dot-prefixed).
     * Each entry carries `path` and a subset of `stat` needed by Reconciler.
     */
    getFiles(): VaultFile[];
}

/** Lightweight file descriptor returned by `IVaultIO.getFiles()`. */
export interface VaultFile {
    path: string;
    stat: FileStat;
}
