import * as PouchDBModule from "pouchdb-browser";
const PouchDB = (PouchDBModule as any).default || PouchDBModule;
import type { CouchSyncDoc } from "../types.ts";
import type { LocalDB } from "./local-db.ts";
import type { CouchSyncSettings } from "../settings.ts";

export type SyncState = "disconnected" | "connected" | "syncing" | "error" | "paused";

export type OnChangeHandler = (doc: CouchSyncDoc) => void;
export type OnStateChangeHandler = (state: SyncState) => void;

export class Replicator {
    private sync: PouchDB.Replication.Sync<CouchSyncDoc> | null = null;
    private state: SyncState = "disconnected";
    private onChangeHandlers: OnChangeHandler[] = [];
    private onStateChangeHandlers: OnStateChangeHandler[] = [];

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

    private setState(state: SyncState): void {
        this.state = state;
        for (const handler of this.onStateChangeHandlers) {
            handler(state);
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
            this.setState(err ? "error" : "connected");
        });

        this.sync.on("active", () => {
            this.setState("syncing");
        });

        this.sync.on("denied", (err) => {
            console.error("CouchSync: replication denied:", err);
            this.setState("error");
        });

        this.sync.on("error", (err) => {
            console.error("CouchSync: replication error:", err);
            this.setState("error");
        });

        this.sync.on("complete", () => {
            this.setState("disconnected");
        });

        this.setState("syncing");
    }

    stop(): void {
        if (this.sync) {
            this.sync.cancel();
            this.sync = null;
        }
        this.setState("disconnected");
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
