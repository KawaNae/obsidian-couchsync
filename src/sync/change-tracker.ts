import type { App, TFile } from "obsidian";
import type { VaultSync } from "./vault-sync.ts";
import type { CouchSyncSettings } from "../settings.ts";

export class ChangeTracker {
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private paused = false;
    private pendingQueue: TFile[] = [];
    private eventRefs: ReturnType<App["vault"]["on"]>[] = [];

    constructor(
        private app: App,
        private vaultSync: VaultSync,
        private getSettings: () => CouchSyncSettings
    ) {}

    start(): void {
        this.eventRefs.push(
            this.app.vault.on("modify", (file) => {
                if (file instanceof Object && "path" in file && "stat" in file) {
                    this.scheduleSync(file as TFile);
                }
            })
        );

        this.eventRefs.push(
            this.app.vault.on("create", (file) => {
                if (file instanceof Object && "stat" in file) {
                    this.scheduleSync(file as TFile);
                }
            })
        );

        this.eventRefs.push(
            this.app.vault.on("delete", (file) => {
                this.cancelPending(file.path);
                if (!this.paused) {
                    this.vaultSync.markDeleted(file.path);
                }
            })
        );

        this.eventRefs.push(
            this.app.vault.on("rename", (file, oldPath) => {
                this.cancelPending(oldPath);
                if (!this.paused && file instanceof Object && "stat" in file) {
                    this.vaultSync.handleRename(file as TFile, oldPath);
                }
            })
        );
    }

    stop(): void {
        for (const ref of this.eventRefs) {
            this.app.vault.offref(ref);
        }
        this.eventRefs = [];
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        this.pendingQueue = [];
    }

    pause(): void {
        this.paused = true;
    }

    resume(): void {
        this.paused = false;
        const queued = this.pendingQueue.splice(0);
        for (const file of queued) {
            this.scheduleSync(file);
        }
    }

    private scheduleSync(file: TFile): void {
        if (this.paused) {
            if (!this.pendingQueue.some((f) => f.path === file.path)) {
                this.pendingQueue.push(file);
            }
            return;
        }

        this.cancelPending(file.path);

        const debounceMs = 2000;
        const timer = setTimeout(() => {
            this.timers.delete(file.path);
            this.vaultSync.fileToDb(file).catch((e) => {
                console.error(`CouchSync: Failed to sync ${file.path}:`, e);
            });
        }, debounceMs);

        this.timers.set(file.path, timer);
    }

    private cancelPending(path: string): void {
        const existing = this.timers.get(path);
        if (existing) {
            clearTimeout(existing);
            this.timers.delete(path);
        }
    }
}
