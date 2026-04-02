import PouchDB from "pouchdb-browser/lib/index.js";
import type { CouchSyncDoc } from "../types.ts";
import type { LocalDB } from "./local-db.ts";
import type { CouchSyncSettings } from "../settings.ts";

export type SyncState = "disconnected" | "connected" | "syncing" | "error";
export type SyncPhase = "idle" | "pulling" | "applying" | "live";

export type OnChangeHandler = (doc: CouchSyncDoc) => void;
export type OnStateChangeHandler = (state: SyncState) => void;
export type OnErrorHandler = (message: string) => void;

export interface PullFirstOptions {
    pullFirst: true;
    onPulledDocs: (docs: CouchSyncDoc[]) => Promise<void>;
}

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
    private lastSyncedSeq: number | string = 0;
    private lastRestartTime = 0;
    private remoteDb: PouchDB.Database<CouchSyncDoc> | null = null;
    private idleCallbacks: (() => void)[] = [];
    private hasBeenIdle = false;
    private phase: SyncPhase = "idle";
    private onReconnectHandlers: (() => void)[] = [];

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

    getPhase(): SyncPhase {
        return this.phase;
    }

    /** Register callback for network reconnection (called instead of direct restart) */
    onReconnect(handler: () => void): void {
        this.onReconnectHandlers.push(handler);
    }

    /** Register callback to fire once initial sync reaches idle state */
    onceIdle(callback: () => void): void {
        if (this.hasBeenIdle) {
            callback();
            return;
        }
        this.idleCallbacks.push(callback);
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

    /** Restart sync session (preserves PouchDB checkpoint, 5s cooldown) */
    restart(options?: PullFirstOptions): void {
        const now = Date.now();
        if (now - this.lastRestartTime < 5000) return;
        this.lastRestartTime = now;
        this.stop();
        if (options?.pullFirst) {
            this.startWithPullFirst(options.onPulledDocs);
        } else {
            this.start();
        }
    }

    /** Pull-first start: one-shot pull → apply callback → bidirectional live sync */
    private startWithPullFirst(onPulledDocs: (docs: CouchSyncDoc[]) => Promise<void>): void {
        if (this.sync) return;
        this.phase = "pulling";
        this.setState("syncing");

        const remoteUrl = this.getRemoteUrl();
        const pullRemoteDb = new PouchDB<CouchSyncDoc>(remoteUrl, { skip_setup: true });
        const db = this.localDb.getDb();
        const pulledDocs: CouchSyncDoc[] = [];

        const replication = db.replicate.from(pullRemoteDb, {
            batch_size: 50,
            batches_limit: 5,
        });

        replication.on("change", (info) => {
            if (info.docs) {
                for (const doc of info.docs) {
                    pulledDocs.push(doc as unknown as CouchSyncDoc);
                }
            }
        });

        replication.on("complete", async () => {
            await pullRemoteDb.close();
            this.phase = "applying";
            try {
                await onPulledDocs(pulledDocs);
            } catch (e) {
                console.error("CouchSync: Error applying pulled docs:", e);
            }
            this.phase = "live";
            this.start();
        });

        replication.on("error", async (err) => {
            await pullRemoteDb.close();
            this.phase = "idle";
            console.error("CouchSync: Pull-first replication error:", err);
            this.setState("error");
            this.emitError("Pull-first sync failed: " + (err?.message || "unknown"));
        });
    }

    start(): void {
        if (this.sync) return;

        const remoteUrl = this.getRemoteUrl();
        this.remoteDb = new PouchDB<CouchSyncDoc>(remoteUrl, {
            skip_setup: true,
        });

        const db = this.localDb.getDb();
        this.sync = db.sync(this.remoteDb, {
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
                this.updateLastSyncedSeq();
                this.setState("connected");
                if (!this.hasBeenIdle) {
                    this.hasBeenIdle = true;
                    for (const cb of this.idleCallbacks) cb();
                    this.idleCallbacks = [];
                }
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
        if (this.remoteDb) {
            this.remoteDb.close();
            this.remoteDb = null;
        }
        this.hasBeenIdle = false;
        this.idleCallbacks = [];
        this.phase = "idle";
        this.setState("disconnected");
    }

    /** One-shot push: local → remote */
    async pushToRemote(onProgress?: (docId: string, count: number) => void): Promise<number> {
        const remoteUrl = this.getRemoteUrl();
        const remoteDb = new PouchDB<CouchSyncDoc>(remoteUrl, {});
        const db = this.localDb.getDb();
        let total = 0;
        return new Promise<number>((resolve, reject) => {
            const replication = db.replicate.to(remoteDb, { batch_size: 100 });
            replication.on("change", (info) => {
                if (info.docs) {
                    for (const doc of info.docs) {
                        total++;
                        onProgress?.(doc._id, total);
                    }
                }
            });
            replication.on("complete", async (info) => {
                await remoteDb.close();
                resolve(info.docs_written);
            });
            replication.on("error", async (err) => {
                await remoteDb.close();
                reject(err);
            });
        });
    }

    /** One-shot pull: remote → local */
    async pullFromRemote(onProgress?: (docId: string, count: number) => void): Promise<number> {
        const remoteUrl = this.getRemoteUrl();
        const remoteDb = new PouchDB<CouchSyncDoc>(remoteUrl, {});
        const db = this.localDb.getDb();
        let total = 0;
        return new Promise<number>((resolve, reject) => {
            const replication = db.replicate.from(remoteDb, { batch_size: 100 });
            replication.on("change", (info) => {
                if (info.docs) {
                    for (const doc of info.docs) {
                        total++;
                        onProgress?.(doc._id, total);
                    }
                }
            });
            replication.on("complete", async (info) => {
                await remoteDb.close();
                resolve(info.docs_written);
            });
            replication.on("error", async (err) => {
                await remoteDb.close();
                reject(err);
            });
        });
    }

    /** List remote document IDs matching a prefix (lightweight, no content fetched) */
    async listRemoteByPrefix(prefix: string): Promise<string[]> {
        const remoteUrl = this.getRemoteUrl();
        const remoteDb = new PouchDB<CouchSyncDoc>(remoteUrl, {});
        try {
            const result = await remoteDb.allDocs({
                startkey: prefix,
                endkey: prefix + "\ufff0",
            });
            return result.rows.map((row) => row.id);
        } finally {
            await remoteDb.close();
        }
    }

    /** Push specific documents to remote by doc IDs */
    async pushDocs(
        docIds: string[],
        onProgress?: (docId: string, count: number) => void,
    ): Promise<number> {
        if (docIds.length === 0) return 0;
        const remoteUrl = this.getRemoteUrl();
        const remoteDb = new PouchDB<CouchSyncDoc>(remoteUrl, {});
        const db = this.localDb.getDb();
        let total = 0;
        return new Promise<number>((resolve, reject) => {
            const replication = db.replicate.to(remoteDb, {
                doc_ids: docIds,
            } as any);
            replication.on("change", (info) => {
                if (info.docs) {
                    for (const doc of info.docs) {
                        total++;
                        onProgress?.(doc._id, total);
                    }
                }
            });
            replication.on("complete", async (info) => {
                await remoteDb.close();
                resolve(info.docs_written);
            });
            replication.on("error", async (err) => {
                await remoteDb.close();
                reject(err);
            });
        });
    }

    /** Pull documents matching ID prefix from remote */
    async pullByPrefix(prefix: string): Promise<number> {
        const remoteUrl = this.getRemoteUrl();
        const remoteDb = new PouchDB<CouchSyncDoc>(remoteUrl, {});
        const db = this.localDb.getDb();

        const result = await remoteDb.allDocs({
            startkey: prefix,
            endkey: prefix + "\ufff0",
        });
        const docIds = result.rows.map((row) => row.id);

        if (docIds.length === 0) {
            await remoteDb.close();
            return 0;
        }

        return new Promise<number>((resolve, reject) => {
            const replication = db.replicate.from(remoteDb, {
                doc_ids: docIds,
            } as any);
            replication.on("complete", async (info) => {
                await remoteDb.close();
                resolve(info.docs_written);
            });
            replication.on("error", async (err) => {
                await remoteDb.close();
                reject(err);
            });
        });
    }

    /** Destroy the remote database (it will be auto-created on next push) */
    async destroyRemote(): Promise<void> {
        const remoteUrl = this.getRemoteUrl();
        const remoteDb = new PouchDB(remoteUrl, {});
        await remoteDb.destroy();
    }

    /** Test connection with explicit credentials (for unsaved draft values) */
    async testConnectionWith(
        uri: string, user: string, pass: string, db: string
    ): Promise<string | null> {
        try {
            const url = new URL(uri);
            url.pathname = url.pathname.replace(/\/$/, "") + "/" + db;
            if (user) { url.username = user; url.password = pass; }
            const remoteDb = new PouchDB(url.toString(), {});
            await remoteDb.info();
            await remoteDb.close();
            return null;
        } catch (e: any) {
            return e.message || "Connection failed";
        }
    }

    /** Test connection using saved settings */
    async testConnection(): Promise<string | null> {
        const s = this.getSettings();
        return this.testConnectionWith(s.couchdbUri, s.couchdbUser, s.couchdbPassword, s.couchdbDbName);
    }

    private async updateLastSyncedSeq(): Promise<void> {
        const info = await this.localDb.getDb().info();
        this.lastSyncedSeq = info.update_seq;
    }

    private async checkHealth(): Promise<void> {
        if (this.state !== "connected") return;

        try {
            const info = await this.localDb.getDb().info();
            const currentSeq = info.update_seq;

            if (currentSeq !== this.lastSyncedSeq) {
                console.log("CouchSync: Stalled sync detected, restarting session");
                this.restart();
                return;
            }

            const err = await this.testConnection();
            if (err) {
                console.log("CouchSync: Server unreachable, restarting session");
                this.restart();
            }
        } catch (e) {
            console.error("CouchSync: Health check error:", e);
        }
    }

    private handleOffline(): void {
        if (this.state === "connected" || this.state === "syncing") {
            this.setState("disconnected");
            this.emitError("Network offline");
        }
    }

    private handleOnline(): void {
        if (this.state === "disconnected" || this.state === "error") {
            console.log("CouchSync: Network online, restarting session");
            if (this.onReconnectHandlers.length > 0) {
                for (const handler of this.onReconnectHandlers) {
                    handler();
                }
            } else {
                this.restart();
            }
        }
    }
}
