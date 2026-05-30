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

import type { LocalDB } from "../local-db.ts";
import type { CouchSyncSettings } from "../../settings.ts";
import type { ICouchClient } from "../interfaces.ts";
import type { ChunkHasher } from "../chunker.ts";
import { CouchClient, makeCouchClient } from "../couch-client.ts";
import * as remoteCouch from "../remote-couch.ts";
import type { AuthGate } from "./auth-gate.ts";

export type ProgressCallback = (docId: string, count: number) => void;

export class VaultRemoteOps {
    constructor(
        private localDb: LocalDB,
        private getSettings: () => CouchSyncSettings,
        private auth: AuthGate,
        /**
         * Codec stack wrapper — same closure used by SyncEngine's live
         * loop. Single source of truth for "how to talk to this vault";
         * captures the latest `cryptoProvider` / `compressionEnabled`
         * state on every call. Eliminates the legacy `setClientWrapper`
         * mutable setter and the Init/Clone vs sync-loop drift that
         * silently dropped the Compressing layer from Init pushes.
         */
        private wrapClient: (raw: CouchClient) => ICouchClient,
        /**
         * Vault chunk hasher (same instance the live sync loop uses, reading
         * the live cryptoProvider via closure). Threaded into `pullAll` so the
         * Clone / full-resync path verifies every chunk body against its
         * content-addressed id — the authenticated fetch boundary (Invariant I)
         * that live sync already enforced but the one-shot path did not.
         *
         * Public so maintenance/repair commands (chunk-repair) can thread the
         * SAME hasher into their one-shot `pullDocs`, keeping every remote-read
         * path verified by one source of truth.
         */
        public readonly chunkHasher: ChunkHasher,
    ) {}

    /** One-shot push of the entire vault local DB to the vault remote. */
    async pushAll(onProgress?: ProgressCallback): Promise<number> {
        return remoteCouch.pushAll(this.localDb, this.makeDataClient(), onProgress);
    }

    /** One-shot pull of the entire vault remote → local. Returns the
     *  count of docs written. */
    async pullAll(
        onProgress?: ProgressCallback,
    ): Promise<number> {
        return remoteCouch.pullAll(this.localDb, this.makeDataClient(), this.chunkHasher, onProgress);
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
     * Construct a fresh RAW CouchClient from saved settings — NO codec
     * (encryption/compression) decorators.
     *
     * Use ONLY for meta/admin operations that must bypass the codec:
     * database create/destroy, connection test, and `vault:meta` (which
     * deliberately stays plaintext because it holds the crypto salt /
     * keyCheck read by a key-less client).
     *
     * For any file/chunk/config DATA operation (diagnostics, maintenance,
     * repair) use {@link makeDataClient} instead — on an encrypted vault
     * the raw client sees `file:<hmac>` ids and ciphertext attachments, so
     * comparing against local plaintext ids or pushing local bodies
     * corrupts the vault.
     */
    makeClient(): CouchClient {
        const s = this.getSettings();
        return makeCouchClient(
            s.couchdbUri, s.couchdbDbName, s.couchdbUser, s.couchdbPassword,
        );
    }

    /**
     * Construct a fresh data-plane client: the raw client wrapped in the
     * same codec (encryption + compression) decorator stack the live sync
     * loop uses. Presents a plaintext view of the remote — path-encrypted
     * ids are restored, chunk attachments are decrypted on read and
     * encrypted on write. This is the correct client for every file/chunk
     * diagnostic, repair, and bulk data operation. Transparent (== raw)
     * when the vault is unencrypted and uncompressed.
     */
    makeDataClient(): ICouchClient {
        return this.wrapClient(this.makeClient());
    }
}
