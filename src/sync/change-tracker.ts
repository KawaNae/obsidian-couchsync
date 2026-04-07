import type { App, TFile } from "obsidian";
import type { VaultSync } from "./vault-sync.ts";
import type { CouchSyncSettings } from "../settings.ts";

export class ChangeTracker {
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private pendingMinInterval = new Map<string, ReturnType<typeof setTimeout>>();
    private lastSyncTime = new Map<string, number>();
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
                this.lastSyncTime.delete(file.path);
                if (!this.paused) {
                    this.vaultSync.markDeleted(file.path);
                }
            })
        );

        this.eventRefs.push(
            this.app.vault.on("rename", (file, oldPath) => {
                this.cancelPending(oldPath);
                this.lastSyncTime.delete(oldPath);
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
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        for (const timer of this.pendingMinInterval.values()) clearTimeout(timer);
        this.pendingMinInterval.clear();
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

        const debounceMs = this.getSettings().syncDebounceMs;
        const timer = setTimeout(() => {
            this.timers.delete(file.path);
            this.trySync(file);
        }, debounceMs);

        this.timers.set(file.path, timer);
    }

    private trySync(file: TFile): void {
        const minIntervalMs = this.getSettings().syncMinIntervalMs;
        if (minIntervalMs > 0) {
            const last = this.lastSyncTime.get(file.path) ?? 0;
            const elapsed = Date.now() - last;
            if (elapsed < minIntervalMs) {
                const existing = this.pendingMinInterval.get(file.path);
                if (existing) clearTimeout(existing);
                const delay = minIntervalMs - elapsed;
                const t = setTimeout(() => {
                    this.pendingMinInterval.delete(file.path);
                    this.runSync(file);
                }, delay);
                this.pendingMinInterval.set(file.path, t);
                return;
            }
        }
        this.runSync(file);
    }

    private runSync(file: TFile): void {
        this.lastSyncTime.set(file.path, Date.now());
        this.vaultSync.fileToDb(file).catch((e) => {
            console.error(`CouchSync: Failed to sync ${file.path}:`, e);
        });
    }

    private cancelPending(path: string): void {
        const existing = this.timers.get(path);
        if (existing) {
            clearTimeout(existing);
            this.timers.delete(path);
        }
        const pending = this.pendingMinInterval.get(path);
        if (pending) {
            clearTimeout(pending);
            this.pendingMinInterval.delete(path);
        }
    }
}
