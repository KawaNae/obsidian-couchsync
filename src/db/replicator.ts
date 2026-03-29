import PouchDB from "pouchdb-browser/lib/index.js";
import type { CouchSyncDoc } from "../types.ts";
import type { LocalDB } from "./local-db.ts";
import type { CouchSyncSettings } from "../settings.ts";

export type SyncState = "disconnected" | "connected" | "syncing" | "error" | "paused";

export type OnChangeHandler = (doc: CouchSyncDoc) => void;
export type OnStateChangeHandler = (state: SyncState) => void;
export type OnErrorHandler = (message: string) => void;

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 30000;

export class Replicator {
    private sync: PouchDB.Replication.Sync<CouchSyncDoc> | null = null;
    private state: SyncState = "disconnected";
    private onChangeHandlers: OnChangeHandler[] = [];
    private onStateChangeHandlers: OnStateChangeHandler[] = [];
    private onErrorHandlers: OnErrorHandler[] = [];
    private retryCount = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;

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

    private scheduleRetry(): void {
        if (this.retryTimer) return;
        if (this.retryCount >= MAX_RETRIES) {
            this.emitError(`Sync failed ${MAX_RETRIES} times. Open Settings > Maintenance to reconnect.`);
            return;
        }
        this.retryCount++;
        this.emitError(`Sync error. Retrying in ${RETRY_DELAY_MS / 1000}s... (${this.retryCount}/${MAX_RETRIES})`);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.stop();
            this.start();
        }, RETRY_DELAY_MS);
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
        });

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
                this.scheduleRetry();
            } else {
                // Caught up — reset retry count on success
                this.retryCount = 0;
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
            this.scheduleRetry();
        });

        this.sync.on("complete", () => {
            this.setState("disconnected");
        });

        this.setState("syncing");
    }

    stop(): void {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.sync) {
            this.sync.cancel();
            this.sync = null;
        }
        this.setState("disconnected");
    }

    /** Reset retry counter — call after manual reconnect */
    resetRetries(): void {
        this.retryCount = 0;
    }

    /** One-shot push: local → remote. Returns number of docs pushed. */
    async pushToRemote(): Promise<number> {
        const remoteUrl = this.getRemoteUrl();
        const remoteDb = new PouchDB<CouchSyncDoc>(remoteUrl, { skip_setup: true });
        const db = this.localDb.getDb();
        const result = await db.replicate.to(remoteDb, { batch_size: 100 });
        await remoteDb.close();
        return result.docs_written;
    }

    /** One-shot pull: remote → local. Returns number of docs pulled. */
    async pullFromRemote(): Promise<number> {
        const remoteUrl = this.getRemoteUrl();
        const remoteDb = new PouchDB<CouchSyncDoc>(remoteUrl, { skip_setup: true });
        const db = this.localDb.getDb();
        const result = await db.replicate.from(remoteDb, { batch_size: 100 });
        await remoteDb.close();
        return result.docs_written;
    }

    async testConnection(): Promise<string | null> {
        try {
            const remoteUrl = this.getRemoteUrl();
            const remoteDb = new PouchDB(remoteUrl, { skip_setup: true });
            await remoteDb.info();
            await remoteDb.close();
            return null;
        } catch (e: any) {
            return e.message || "Connection failed";
        }
    }
}
