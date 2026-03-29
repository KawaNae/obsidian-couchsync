import PouchDB from "pouchdb-browser/lib/index.js";
import type { CouchSyncDoc } from "../types.ts";
import type { LocalDB } from "./local-db.ts";
import type { CouchSyncSettings } from "../settings.ts";

export type SyncState = "disconnected" | "connected" | "syncing" | "error";

export type OnChangeHandler = (doc: CouchSyncDoc) => void;
export type OnStateChangeHandler = (state: SyncState) => void;
export type OnErrorHandler = (message: string) => void;

const HEALTH_CHECK_INTERVAL = 30000; // 30s

export class Replicator {
    private sync: PouchDB.Replication.Sync<CouchSyncDoc> | null = null;
    private state: SyncState = "disconnected";
    private onChangeHandlers: OnChangeHandler[] = [];
    private onStateChangeHandlers: OnStateChangeHandler[] = [];
    private onErrorHandlers: OnErrorHandler[] = [];
    private healthTimer: ReturnType<typeof setInterval> | null = null;
    private boundOnOffline = () => this.handleOffline();
    private boundOnOnline = () => this.handleOnline();

    constructor(
        private localDb: LocalDB,
        private getSettings: () => CouchSyncSettings
    ) {}

    getState(): SyncState {
        return this.state;
    }

    onChange(handler: OnChangeHandler): void {
        this.onChangeHandlers.push(handler);
    }

    onStateChange(handler: OnStateChangeHandler): void {
        this.onStateChangeHandlers.push(handler);
    }

    onError(handler: OnErrorHandler): void {
        this.onErrorHandlers.push(handler);
    }

    private setState(state: SyncState): void {
        if (this.state === state) return;
        this.state = state;
        for (const handler of this.onStateChangeHandlers) {
            handler(state);
        }
    }

    private emitError(message: string): void {
        for (const handler of this.onErrorHandlers) {
            handler(message);
        }
    }

    private getRemoteUrl(): string {
        const settings = this.getSettings();
        const url = new URL(settings.couchdbUri);
        url.pathname = url.pathname.replace(/\/$/, "") + "/" + settings.couchdbDbName;
        if (settings.couchdbUser) {
            url.username = settings.couchdbUser;
            url.password = settings.couchdbPassword;
        }
        return url.toString();
    }

    start(): void {
        if (this.sync) return;

        const remoteUrl = this.getRemoteUrl();
        const remoteDb = new PouchDB<CouchSyncDoc>(remoteUrl, {
            skip_setup: true,
        });

        const db = this.localDb.getDb();
        this.sync = db.sync(remoteDb, {
            live: true,
            retry: true,
            batch_size: 50,
            batches_limit: 5,
            timeout: 30000,
            heartbeat: 10000,
            back_off_function: (delay: number) => {
                if (delay === 0) return 1000;
                return Math.min(delay * 2, 60000);
            },
        } as any); // PouchDB types don't include timeout/heartbeat/back_off_function

        this.sync.on("change", (info) => {
            this.setState("syncing");
            if (info.direction === "pull" && info.change?.docs) {
                for (const doc of info.change.docs) {
                    const typed = doc as unknown as CouchSyncDoc;
                    for (const handler of this.onChangeHandlers) {
                        try {
                            handler(typed);
                        } catch (e) {
                            console.error("CouchSync: onChange handler error:", e);
                        }
                    }
                }
            }
        });

        this.sync.on("paused", (err) => {
            if (err) {
                this.setState("error");
                this.emitError("Sync paused: connection issue");
            } else {
                this.setState("connected");
            }
        });

        this.sync.on("active", () => {
            this.setState("syncing");
        });

        this.sync.on("denied", (err) => {
            console.error("CouchSync: replication denied:", err);
            this.setState("error");
            this.emitError("Sync denied: check CouchDB permissions.");
        });

        this.sync.on("error", (err) => {
            console.error("CouchSync: replication error:", err);
            this.setState("error");
            this.emitError("Sync error: " + (err?.message || "unknown"));
        });

        this.sync.on("complete", () => {
            this.setState("disconnected");
        });

        // Health check: detect silent disconnections (PouchDB bug #3714)
        this.healthTimer = setInterval(() => this.checkHealth(), HEALTH_CHECK_INTERVAL);

        // Network state listeners for immediate detection
        window.addEventListener("offline", this.boundOnOffline);
        window.addEventListener("online", this.boundOnOnline);

        this.setState("syncing");
    }

    stop(): void {
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
            this.healthTimer = null;
        }
        window.removeEventListener("offline", this.boundOnOffline);
        window.removeEventListener("online", this.boundOnOnline);
        if (this.sync) {
            this.sync.cancel();
            this.sync = null;
        }
        this.setState("disconnected");
    }

    /** One-shot push: local → remote */
    async pushToRemote(): Promise<number> {
        const remoteUrl = this.getRemoteUrl();
        const remoteDb = new PouchDB<CouchSyncDoc>(remoteUrl, {});
        const db = this.localDb.getDb();
        const result = await db.replicate.to(remoteDb, { batch_size: 100 });
        await remoteDb.close();
        return result.docs_written;
    }

    /** One-shot pull: remote → local */
    async pullFromRemote(): Promise<number> {
        const remoteUrl = this.getRemoteUrl();
        const remoteDb = new PouchDB<CouchSyncDoc>(remoteUrl, {});
        const db = this.localDb.getDb();
        const result = await db.replicate.from(remoteDb, { batch_size: 100 });
        await remoteDb.close();
        return result.docs_written;
    }

    /** Test connection to CouchDB. Returns null on success or error message. */
    async testConnection(): Promise<string | null> {
        try {
            const remoteUrl = this.getRemoteUrl();
            const remoteDb = new PouchDB(remoteUrl, {});
            await remoteDb.info();
            await remoteDb.close();
            return null;
        } catch (e: any) {
            return e.message || "Connection failed";
        }
    }

    private async checkHealth(): Promise<void> {
        if (this.state !== "connected") return;
        const err = await this.testConnection();
        if (err) {
            this.setState("disconnected");
            this.emitError("Server unreachable");
        }
    }

    private handleOffline(): void {
        if (this.state === "connected" || this.state === "syncing") {
            this.setState("disconnected");
            this.emitError("Network offline");
        }
    }

    private handleOnline(): void {
        // PouchDB retry will auto-reconnect, just update status
        if (this.state === "disconnected") {
            this.setState("syncing");
        }
    }
}
