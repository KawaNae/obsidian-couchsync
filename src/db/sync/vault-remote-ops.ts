/**
 * VaultRemoteOps — one-shot remote operations.
 *
 * Every operation here runs outside the live sync loop: a fresh
 * CouchClient is allocated per call, the request finishes, the client
 * is discarded. These are the operations that belong to setup flows,
 * connection tests, and manual commands — never to the continuous
 * push/pull session.
 *
 * Keeping them distinct from `SyncEngine` (which owns the live loop)
 * clarifies the mental model: `replicator` = streaming sync,
 * `remoteOps` = batched request/response.
 *
 * Auth latching is shared with the live loop via the injected AuthGate —
 * a 401/403 from any caller raises the gate and the live loop pauses
 * accordingly on its next iteration.
 */

import type { CouchSyncDoc } from "../../types.ts";
import type { LocalDB } from "../local-db.ts";
import type { CouchSyncSettings } from "../../settings.ts";
import type { ICouchClient } from "../interfaces.ts";
import { CouchClient, makeCouchClient } from "../couch-client.ts";
import * as remoteCouch from "../remote-couch.ts";
import type { AuthGate } from "./auth-gate.ts";

export type ProgressCallback = (docId: string, count: number) => void;

export class VaultRemoteOps {
    private clientWrapper?: (raw: CouchClient) => ICouchClient;

    constructor(
        private localDb: LocalDB,
        private getSettings: () => CouchSyncSettings,
        private auth: AuthGate,
    ) {}

    setClientWrapper(wrapper: ((raw: CouchClient) => ICouchClient) | undefined): void {
        this.clientWrapper = wrapper;
    }

    /** One-shot push of the entire vault local DB to the vault remote. */
    async pushAll(onProgress?: ProgressCallback): Promise<number> {
        return remoteCouch.pushAll(this.localDb, this.makeWrappedClient(), onProgress);
    }

    /** One-shot pull of the entire vault remote → local. */
    async pullAll(
        onProgress?: ProgressCallback,
    ): Promise<{ written: number; docs: CouchSyncDoc[] }> {
        return remoteCouch.pullAll(this.localDb, this.makeWrappedClient(), onProgress);
    }

    /** Destroy the vault remote database (auto-recreated on next push). */
    async destroyRemote(): Promise<void> {
        await remoteCouch.destroyRemote(this.makeClient());
    }

    /** Create the vault remote database if it doesn't exist. */
    async ensureRemoteDb(): Promise<void> {
        await this.makeClient().ensureDb();
    }

    /**
     * Test connection with explicit credentials — used by the Settings
     * tab's draft flow, before the values have been saved.
     */
    async testConnectionWith(
        uri: string, user: string, pass: string, db: string,
    ): Promise<string | null> {
        try {
            const client = makeCouchClient(uri, db, user, pass);
            await client.info();
            return null;
        } catch (e: any) {
            if (e?.status === 401 || e?.status === 403) {
                this.auth.raise(e.status, e?.message);
            }
            return e?.message || "Connection failed";
        }
    }

    /** Test connection using saved settings. */
    async testConnection(): Promise<string | null> {
        const s = this.getSettings();
        return this.testConnectionWith(
            s.couchdbUri, s.couchdbUser, s.couchdbPassword, s.couchdbDbName,
        );
    }

    /**
     * Construct a fresh CouchClient from saved settings. Public so that
     * other one-shot callers (diagnostic commands, maintenance tooling)
     * can reuse the exact same factory — settings, auth, URL encoding
     * all live here in one place.
     */
    makeClient(): CouchClient {
        const s = this.getSettings();
        return makeCouchClient(
            s.couchdbUri, s.couchdbDbName, s.couchdbUser, s.couchdbPassword,
        );
    }

    private makeWrappedClient(): ICouchClient {
        const raw = this.makeClient();
        return this.clientWrapper ? this.clientWrapper(raw) : raw;
    }
}
