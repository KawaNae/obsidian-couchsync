/**
 * Production IVaultEvents backed by Obsidian's `App.vault.on()` /
 * `App.vault.offref()`.
 *
 * Performs the `isTFile` guard and unpacks `TFile` / `TAbstractFile`
 * into plain `{path, stat}` values before dispatching to consumers.
 */

import type { App, TAbstractFile, TFile, EventRef } from "obsidian";
import type { IVaultEvents, VaultEventRef } from "../types/vault-events.ts";
import type { FileStat } from "../types/vault-io.ts";

function isTFile(file: TAbstractFile): file is TFile {
    return "stat" in file;
}

function toStat(file: TFile): FileStat {
    return { mtime: file.stat.mtime, ctime: file.stat.ctime, size: file.stat.size };
}

/**
 * Wraps an Obsidian `EventRef` so it satisfies the branded
 * `VaultEventRef` interface while remaining a plain object.
 */
function wrap(ref: EventRef): VaultEventRef {
    return ref as unknown as VaultEventRef;
}

export class ObsidianVaultEvents implements IVaultEvents {
    constructor(private app: App) {}

    on(
        event: "modify",
        cb: (path: string, stat: FileStat) => void,
    ): VaultEventRef;
    on(
        event: "create",
        cb: (path: string, stat: FileStat) => void,
    ): VaultEventRef;
    on(
        event: "delete",
        cb: (path: string) => void,
    ): VaultEventRef;
    on(
        event: "rename",
        cb: (path: string, oldPath: string, stat: FileStat | undefined) => void,
    ): VaultEventRef;
    on(event: string, cb: (...args: any[]) => void): VaultEventRef {
        switch (event) {
            case "modify":
                return wrap(
                    this.app.vault.on("modify", (file: TAbstractFile) => {
                        if (!isTFile(file)) return;
                        cb(file.path, toStat(file));
                    }),
                );
            case "create":
                return wrap(
                    this.app.vault.on("create", (file: TAbstractFile) => {
                        if (!isTFile(file)) return;
                        cb(file.path, toStat(file));
                    }),
                );
            case "delete":
                return wrap(
                    this.app.vault.on("delete", (file: TAbstractFile) => {
                        cb(file.path);
                    }),
                );
            case "rename":
                return wrap(
                    this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
                        if (isTFile(file)) {
                            cb(file.path, oldPath, toStat(file));
                        } else {
                            cb(file.path, oldPath, undefined);
                        }
                    }),
                );
            default:
                throw new Error(`Unsupported vault event: ${event}`);
        }
    }

    offref(ref: VaultEventRef): void {
        this.app.vault.offref(ref as unknown as EventRef);
    }
}
