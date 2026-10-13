/**
 * Copies of config files taken before a Pull overwrites them.
 *
 * Each Pull that writes files keeps the previous content of exactly those
 * files in one generation folder, `<root>/<stamp>/<path below .obsidian/>`.
 * The newest `BACKUP_GENERATIONS` generations are kept. The root lies in
 * this plugin's folder; ConfigSync excludes it from Push and from the
 * settings tree, since a backed-up plugin data.json may hold secrets.
 */

import type { IVaultIO } from "../types/vault-io.ts";

export const BACKUP_GENERATIONS = 10;

export interface BackupFile {
    path: string;
    bytes: Uint8Array;
}

function pad(n: number, width = 2): string {
    return String(n).padStart(width, "0");
}

/** Folder name of a generation: local time, sortable as text. */
export function backupStamp(d: Date): string {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
        `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

const CONFIG_ROOT = ".obsidian/";

function relativeName(path: string): string {
    return path.startsWith(CONFIG_ROOT) ? path.slice(CONFIG_ROOT.length) : path;
}

/** Create `dir` and its missing ancestors. */
async function ensureFolder(vault: IVaultIO, dir: string): Promise<void> {
    const parts = dir.split("/");
    for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join("/");
        if (p && !(await vault.exists(p))) await vault.createFolder(p);
    }
}

/**
 * Copy `files` into a new generation under `root` and prune old
 * generations. Returns the generation folder. Throws when a copy fails, so
 * the caller writes nothing it could not back up.
 */
export async function backupConfigFiles(
    vault: IVaultIO,
    root: string,
    files: readonly BackupFile[],
    now: Date = new Date(),
): Promise<string> {
    const taken = new Set(await listGenerations(vault, root));
    const stamp = backupStamp(now);
    let dir = `${root}/${stamp}`;
    for (let n = 2; taken.has(dir); n++) dir = `${root}/${stamp}_${n}`;
    for (const f of files) {
        const target = `${dir}/${relativeName(f.path)}`;
        await ensureFolder(vault, target.split("/").slice(0, -1).join("/"));
        const copy = f.bytes.slice().buffer as ArrayBuffer;
        await vault.createBinary(target, copy);
    }
    await pruneBackups(vault, root, BACKUP_GENERATIONS);
    return dir;
}

/** Delete all but the newest `keep` generations under `root`. */
export async function pruneBackups(vault: IVaultIO, root: string, keep: number): Promise<void> {
    const sorted = (await listGenerations(vault, root)).sort();
    for (const old of sorted.slice(0, Math.max(0, sorted.length - keep))) {
        await vault.delete(old);
    }
}

/** Generation folders under `root` (none when `root` does not exist). */
async function listGenerations(vault: IVaultIO, root: string): Promise<string[]> {
    try {
        return (await vault.list(root)).folders;
    } catch {
        return [];
    }
}
