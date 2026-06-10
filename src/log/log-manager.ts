/**
 * LogManager — coordinates the in-memory ring (src/ui/log.ts) and the
 * persistent IDB buffer (LogStorage), and produces the user-facing .md
 * export.
 *
 * Subscribes to `onLogEntry` and pushes incoming entries into an in-memory
 * queue; flushes the queue to LogStorage on a trailing throttle (50 ms or
 * 100 entries, whichever comes first). On `visibilitychange→hidden` and
 * `pagehide`, a fire-and-forget flush is invoked — IDB writes are not
 * synchronously waitable but Dexie's microtask commit gives them a chance.
 *
 * Cleanup: every hour, drop entries older than `logRetentionDays` and trim
 * to the byte-budget defined by `logMaxStorageMB` (0 = unlimited). The
 * byte budget is approximated as a count cap (avg ~200 B/entry).
 *
 * No call here ever invokes logError on its own failure path: that would
 * re-enter the log subsystem and risk an unbounded loop. console.warn
 * only.
 */

import {
    onLogEntry,
    type LogEntry,
} from "../ui/log.ts";
import type { LogStorage, PersistedLogEntry } from "./log-storage.ts";
import {
    formatLogExport,
    buildExportFileName,
    type ExportMeta,
    type DeviceInfo,
} from "./markdown-formatter.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { IVaultIO } from "../types/vault-io.ts";

/** Trailing throttle parameters. Flush whichever comes first. */
const FLUSH_INTERVAL_MS = 50;
const FLUSH_MAX_BATCH = 100;

/** Periodic cleanup cadence. Matches HistoryManager. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Average bytes per persisted entry, used to translate MB → entry count
 *  for the size cap. The actual size is computed via approxEntryBytes
 *  for stats display, but the cap enforcement uses this constant to
 *  avoid the cost of a full per-entry scan on every cleanup. */
export const AVG_ENTRY_BYTES = 200;

export interface SyncDiagnostics {
    state: string;
    connectionState: string;
    lastPushedSeq?: number;
    remoteSeq?: string;
}

export interface LogManagerDeps {
    storage: LogStorage;
    getSettings: () => CouchSyncSettings;
    getPluginVersion: () => string;
    getObsidianVersion: () => string;
    getPlatform: () => { os: string; isMobile: boolean };
    getSyncDiagnostics: () => SyncDiagnostics;
    /** Best-effort device specs collected at export time. Optional — when
     *  absent the export simply omits the `device:` block. */
    getDeviceInfo?: () => DeviceInfo;
    vault: IVaultIO;
    /** Defaults to `Date.now`; tests override. */
    now?: () => number;
    /** Defaults to window/document/setInterval; tests override. */
    timer?: {
        setTimeout: (cb: () => void, ms: number) => any;
        clearTimeout: (id: any) => void;
        setInterval: (cb: () => void, ms: number) => any;
        clearInterval: (id: any) => void;
    };
    /** When undefined, visibility/pagehide listeners are skipped (test mode). */
    doc?: {
        addEventListener: (type: string, listener: () => void) => void;
        removeEventListener: (type: string, listener: () => void) => void;
        visibilityState?: string;
    };
    win?: {
        addEventListener: (type: string, listener: () => void) => void;
        removeEventListener: (type: string, listener: () => void) => void;
    };
}

export class LogManager {
    private queue: PersistedLogEntry[] = [];
    private flushTimer: any = null;
    private cleanupTimer: any = null;
    private unsubscribe: (() => void) | null = null;
    private running = false;
    private flushInFlight: Promise<void> | null = null;

    private readonly storage: LogStorage;
    private readonly getSettings: () => CouchSyncSettings;
    private readonly getPluginVersion: () => string;
    private readonly getObsidianVersion: () => string;
    private readonly getPlatform: () => { os: string; isMobile: boolean };
    private readonly getSyncDiagnostics: () => SyncDiagnostics;
    private readonly getDeviceInfo?: () => DeviceInfo;
    private readonly vault: IVaultIO;
    private readonly now: () => number;
    private readonly timer: NonNullable<LogManagerDeps["timer"]>;
    private readonly doc: LogManagerDeps["doc"];
    private readonly win: LogManagerDeps["win"];

    private readonly boundOnVisibility = () => {
        if (this.doc?.visibilityState === "hidden") this.fireAndForgetFlush();
    };
    private readonly boundOnPageHide = () => this.fireAndForgetFlush();

    constructor(deps: LogManagerDeps) {
        this.storage = deps.storage;
        this.getSettings = deps.getSettings;
        this.getPluginVersion = deps.getPluginVersion;
        this.getObsidianVersion = deps.getObsidianVersion;
        this.getPlatform = deps.getPlatform;
        this.getSyncDiagnostics = deps.getSyncDiagnostics;
        this.getDeviceInfo = deps.getDeviceInfo;
        this.vault = deps.vault;
        this.now = deps.now ?? (() => Date.now());
        this.timer = deps.timer ?? {
            setTimeout: (cb, ms) => setTimeout(cb, ms),
            clearTimeout: (id) => clearTimeout(id),
            setInterval: (cb, ms) => setInterval(cb, ms),
            clearInterval: (id) => clearInterval(id),
        };
        this.doc = deps.doc;
        this.win = deps.win;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.unsubscribe = onLogEntry((e) => this.enqueue(e));

        // Initial cleanup is fire-and-forget — never block plugin startup
        // on an IDB scan.
        void this.cleanup();
        this.cleanupTimer = this.timer.setInterval(
            () => { void this.cleanup(); },
            CLEANUP_INTERVAL_MS,
        );

        this.doc?.addEventListener("visibilitychange", this.boundOnVisibility);
        this.win?.addEventListener("pagehide", this.boundOnPageHide);
    }

    stop(): void {
        if (!this.running) return;
        this.running = false;
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.cleanupTimer !== null) {
            this.timer.clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        if (this.flushTimer !== null) {
            this.timer.clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.doc?.removeEventListener("visibilitychange", this.boundOnVisibility);
        this.win?.removeEventListener("pagehide", this.boundOnPageHide);
        // Final fire-and-forget flush. Cannot block onunload.
        this.fireAndForgetFlush();
    }

    /** Force any queued entries to disk and await completion. Used by
     *  the export path so the snapshot reflects the most recent entries. */
    async flush(): Promise<void> {
        // If a flush is already in flight, await it then re-enter once to
        // catch entries that landed during the previous flush.
        if (this.flushInFlight) {
            await this.flushInFlight;
        }
        if (this.queue.length === 0) return;
        await this.doFlush();
    }

    /** Snapshot stats for the Maintenance tab. */
    async getStats() {
        return this.storage.getStats();
    }

    async clearStoredLogs(): Promise<void> {
        await this.storage.clearAll();
    }

    async deleteLogDatabase(): Promise<void> {
        await this.storage.deleteDatabase();
    }

    /** Run the export flow end-to-end. Returns the path written. */
    async exportToVault(): Promise<{ path: string; count: number }> {
        // Drain any queued entries so the snapshot captures the most
        // recent log lines (within ~50 ms of the click).
        await this.flush();

        const settings = this.getSettings();
        const exportedAt = this.now();
        const entries = await this.storage.getAll();
        const meta: ExportMeta = {
            deviceId: settings.deviceId,
            pluginVersion: this.getPluginVersion(),
            obsidianVersion: this.getObsidianVersion(),
            platform: this.getPlatform(),
            exportedAt,
            syncState: this.getSyncDiagnostics(),
            device: this.getDeviceInfo?.(),
        };
        const content = formatLogExport(entries, meta);

        // Resolve a non-colliding filename. Same-second double-export is
        // already guarded by the Maintenance tab button disable, but the
        // suffix loop is the structural guarantee.
        const baseName = buildExportFileName(settings.deviceId, exportedAt);
        let path = baseName;
        let suffix = 1;
        while (await this.vault.exists(path)) {
            path = baseName.replace(/\.md$/, `_${suffix}.md`);
            suffix++;
        }

        const bytes = new TextEncoder().encode(content);
        await this.vault.createBinary(path, bytes.buffer as ArrayBuffer);
        return { path, count: entries.length };
    }

    // ── Internals ──────────────────────────────────────────

    private enqueue(entry: LogEntry): void {
        if (!this.running) return;
        this.queue.push({
            timestamp: entry.timestamp,
            level: entry.level,
            message: entry.message,
        });
        if (this.queue.length >= FLUSH_MAX_BATCH) {
            this.scheduleFlush(true);
        } else {
            this.scheduleFlush(false);
        }
    }

    private scheduleFlush(immediate: boolean): void {
        if (immediate) {
            if (this.flushTimer !== null) {
                this.timer.clearTimeout(this.flushTimer);
                this.flushTimer = null;
            }
            // microtask — keep within the same tick to avoid races with
            // a subsequent enqueue.
            queueMicrotask(() => { void this.doFlush(); });
            return;
        }
        if (this.flushTimer !== null) return;  // trailing throttle: keep first timer
        this.flushTimer = this.timer.setTimeout(() => {
            this.flushTimer = null;
            void this.doFlush();
        }, FLUSH_INTERVAL_MS);
    }

    private async doFlush(): Promise<void> {
        if (this.queue.length === 0) return;
        // Snapshot then clear synchronously so concurrent enqueues land
        // in a fresh queue for the next flush.
        const batch = this.queue;
        this.queue = [];
        const work = this.storage.bulkAppend(batch);
        this.flushInFlight = work.finally(() => {
            if (this.flushInFlight === work) this.flushInFlight = null;
        });
        await this.flushInFlight;
    }

    /** Used by visibility/pagehide and stop(). Schedules a flush but
     *  does not await it — the caller (e.g. plugin onunload) cannot
     *  reliably await async work. */
    private fireAndForgetFlush(): void {
        if (this.queue.length === 0) return;
        void this.doFlush();
    }

    /** Periodic cleanup: drop entries older than the retention window,
     *  then trim by the size budget (count proxy). */
    private async cleanup(): Promise<{ removedByAge: number; removedBySize: number }> {
        const settings = this.getSettings();
        const retentionDays = Math.max(1, settings.logRetentionDays | 0);
        const cutoff = this.now() - retentionDays * 24 * 60 * 60 * 1000;
        const removedByAge = await this.storage.deleteBefore(cutoff);

        let removedBySize = 0;
        const maxMB = settings.logMaxStorageMB;
        if (maxMB > 0) {
            const maxEntries = Math.max(1, Math.floor((maxMB * 1024 * 1024) / AVG_ENTRY_BYTES));
            removedBySize = await this.storage.trimToCount(maxEntries);
        }
        return { removedByAge, removedBySize };
    }
}
