import type { App } from "obsidian";
import type { ConfigLocalDB } from "../db/config-local-db.ts";
import type { SyncEngine } from "../db/sync-engine.ts";
import type { ConfigDoc, CouchSyncDoc } from "../types.ts";
import {
    DOC_ID,
    makeConfigId,
    configPathFromId,
} from "../types/doc-id.ts";
import type { CouchSyncSettings } from "../settings.ts";
import { ProgressNotice } from "../ui/notices.ts";
import { arrayBufferToBase64, base64ToArrayBuffer } from "../db/chunker.ts";
import { incrementVC } from "./vector-clock.ts";
import { CouchClient, makeCouchClient } from "../db/couch-client.ts";
import { logError } from "../ui/log.ts";
import * as remoteCouch from "../db/remote-couch.ts";

/**
 * ConfigSync — scan-based replication of `.obsidian/` configuration files
 * against a SEPARATE CouchDB database from the vault (v0.11.0+).
 *
 * Why separate? Because vault content is shared across all peer devices,
 * but `.obsidian/` may legitimately differ between device pools (mobile
 * vs desktop). Putting them in the same DB would conflate "vault edit"
 * concurrency with "device-pool config drift" — different problems with
 * different resolution policies.
 *
 * Architecturally:
 *   - Local storage: `ConfigLocalDB` (Dexie-backed IndexedDB store)
 *   - Remote storage: `settings.couchdbConfigDbName` on the same CouchDB
 *     server as the vault DB (auth shared via `SyncEngine.isAuthBlocked`)
 *   - Replication: one-shot push/pull/list via `remote-couch` helpers,
 *     never live-sync (manual init/push/pull from the settings UI)
 *   - Ordering: every write increments the device's `vclock` counter,
 *     same VC discipline as FileDoc — concurrent edits are detected
 *     and surfaced rather than silently LWW-merged
 */
export class ConfigSync {
    private static readonly SKIP_DIRS = new Set(["node_modules", ".git"]);
    private static readonly SKIP_FILES = new Set(["workspace.json", "workspace-mobile.json"]);
    /** Own data.json — contains deviceId, must not be synced across devices. */
    private static readonly SKIP_PATHS = new Set([
        ".obsidian/plugins/obsidian-couchsync/data.json",
    ]);
    private static readonly MAX_CONFIG_SIZE = 5 * 1024 * 1024; // 5MB

    constructor(
        private app: App,
        private configDb: ConfigLocalDB | null,
        private replicator: SyncEngine,
        private getSettings: () => CouchSyncSettings,
    ) {}

    // ── Remote URL + auth helpers ──────────────────────

    /**
     * Build a CouchClient for the config database, using credentials
     * inherited from the vault sync settings. Returns null if config
     * sync is not configured.
     */
    private makeConfigClient(): CouchClient | null {
        const settings = this.getSettings();
        if (!settings.couchdbConfigDbName) return null;
        return makeCouchClient(
            settings.couchdbUri,
            settings.couchdbConfigDbName,
            settings.couchdbUser,
            settings.couchdbPassword,
        );
    }

    /**
     * Build a CouchClient, run the caller's operation, then return.
     * Centralises auth-latch checks so every remote call honours the
     * shared latch.
     *
     * Throws "Config sync not configured" if the config DB name is empty.
     * Latches the shared auth state on 401/403.
     */
    private async withConfigRemote<T>(
        op: (client: CouchClient) => Promise<T>,
    ): Promise<T> {
        const client = this.makeConfigClient();
        if (client === null) {
            throw new Error("Config sync not configured (couchdbConfigDbName is empty)");
        }
        if (this.replicator.isAuthBlocked()) {
            throw new Error("Auth blocked — fix credentials in Vault Sync first");
        }
        try {
            return await op(client);
        } catch (e: any) {
            if (e?.status === 401 || e?.status === 403) {
                this.replicator.markAuthError(e.status, e?.message);
            }
            throw e;
        }
    }

    // ── High-level operations ──────────────────────────

    /**
     * Run a config-sync operation with ProgressNotice lifecycle:
     * update() during work, done() on success, fail() + rethrow on error.
     */
    private async withProgress<T>(
        label: string,
        op: (progress: ProgressNotice) => Promise<T>,
    ): Promise<T> {
        const progress = new ProgressNotice(label);
        try {
            return await op(progress);
        } catch (e: any) {
            progress.fail(`${label} failed: ${e?.message ?? e}`);
            throw e;
        }
    }

    /** Init: delete all local config docs → scan .obsidian/ → push to remote */
    async init(): Promise<number> {
        const db = this.requireConfigDb();
        return this.withProgress("Config Init", async (progress) => {
            progress.update("Deleting old config docs...");
            const deletedIds = await db.deleteByPrefix(DOC_ID.CONFIG);

            const scanned = await this.scan((path, i, total) => {
                progress.update(`Scanning: ${path} (${i}/${total})`);
            });

            const currentIds = await this.allDocIds();
            const affectedIds = [...new Set([...deletedIds, ...currentIds])];

            if (affectedIds.length > 0) {
                await this.withConfigRemote((client) =>
                    remoteCouch.pushDocs(
                        db,
                        client,
                        affectedIds,
                        (docId, n) => {
                            progress.update(`Pushing: ${configPathFromId(docId)} (${n}/${affectedIds.length})`);
                        },
                    ),
                );
            }

            progress.done(`Config init: deleted ${deletedIds.length}, pushed ${scanned} file(s).`);
            return scanned;
        });
    }

    /** Push: scan .obsidian/ → push config docs to remote */
    async push(): Promise<number> {
        const db = this.requireConfigDb();
        return this.withProgress("Config Push", async (progress) => {
            const scanned = await this.scan((path, i, total) => {
                progress.update(`Scanning: ${path} (${i}/${total})`);
            });

            const docIds = await this.allDocIds();
            if (docIds.length > 0) {
                await this.withConfigRemote((client) =>
                    remoteCouch.pushDocs(
                        db,
                        client,
                        docIds,
                        (docId, n) => {
                            progress.update(`Pushing: ${configPathFromId(docId)} (${n}/${docIds.length})`);
                        },
                    ),
                );
            }

            progress.done(`Pushed ${scanned} config file(s).`);
            return scanned;
        });
    }

    /** Pull: pull config docs from remote → write configSyncPaths to filesystem */
    async pull(): Promise<number> {
        const db = this.requireConfigDb();
        return this.withProgress("Config Pull", async (progress) => {
            progress.update("Pulling config from remote...");
            await this.withConfigRemote((client) =>
                remoteCouch.pullByPrefix(db, client, DOC_ID.CONFIG),
            );

            const written = await this.write((path, i, total) => {
                progress.update(`Writing: ${path} (${i}/${total})`);
            });

            progress.done(`Pulled ${written} config file(s). Reload Obsidian to apply.`);
            return written;
        });
    }

    // ── Low-level operations ───────────────────────────

    /** Scan entire .obsidian/ directory to local DB */
    async scan(onProgress?: (path: string, index: number, total: number) => void): Promise<number> {
        const db = this.requireConfigDb();
        const files: string[] = [];
        await this.listFilesRecursive(".obsidian", files);

        const deviceId = this.getSettings().deviceId;
        let count = 0;
        const adapter = this.app.vault.adapter;
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fileName = file.split("/").pop() ?? "";
            if (ConfigSync.SKIP_FILES.has(fileName)) continue;
            if (ConfigSync.SKIP_PATHS.has(file)) continue;

            try {
                onProgress?.(file, i + 1, files.length);
                const stat = await adapter.stat(file);
                if (!stat || stat.size > ConfigSync.MAX_CONFIG_SIZE) continue;

                const buf = await adapter.readBinary(file);
                const data = arrayBufferToBase64(buf);

                const configId = makeConfigId(file);
                await db.update<ConfigDoc>(configId, (existing) => ({
                    _id: configId,
                    type: "config",
                    data,
                    mtime: stat.mtime,
                    size: stat.size,
                    vclock: incrementVC(existing?.vclock, deviceId),
                } as ConfigDoc));
                count++;
            } catch (e) {
                logError(`CouchSync: Failed to scan config ${file}: ${e?.message ?? e}`);
            }
        }
        return count;
    }

    /** Write config docs to filesystem, filtered by configSyncPaths */
    async write(onProgress?: (path: string, index: number, total: number) => void): Promise<number> {
        const db = this.requireConfigDb();
        const paths = this.getSettings().configSyncPaths;
        if (paths.length === 0) return 0;

        const entries: { path: string; data: string }[] = [];
        for (const p of paths) {
            if (p.endsWith("/")) {
                // Prefix-range scan for everything under the folder.
                const prefix = makeConfigId(p.replace(/\/$/, "") + "/");
                const result = await db.allDocs({
                    startkey: prefix,
                    endkey: prefix + "\ufff0",
                    include_docs: true,
                });
                for (const row of result.rows) {
                    if (!row.doc) continue;
                    const doc = row.doc as unknown as ConfigDoc;
                    if (doc.type !== "config") continue;
                    entries.push({
                        path: configPathFromId(doc._id),
                        data: doc.data,
                    });
                }
            } else {
                const doc = await db.get(makeConfigId(p));
                if (doc) entries.push({ path: p, data: doc.data });
            }
        }

        let count = 0;
        for (let i = 0; i < entries.length; i++) {
            const { path, data } = entries[i];
            if (ConfigSync.SKIP_PATHS.has(path)) continue;
            try {
                onProgress?.(path, i + 1, entries.length);
                await this.ensureDir(path);
                // ConfigDoc is always base64-encoded binary; decode verbatim.
                const buf = base64ToArrayBuffer(data);
                await this.app.vault.adapter.writeBinary(path, buf);
                count++;
            } catch (e) {
                logError(`CouchSync: Failed to write config ${path}: ${e?.message ?? e}`);
            }
        }
        return count;
    }

    // ── Utilities (public for settings UI) ─────────────

    /** True when config sync has a target DB configured and a local store exists. */
    isConfigured(): boolean {
        return this.configDb !== null && this.makeConfigClient() !== null;
    }

    /** Return the config DB, throwing if not configured. */
    private requireConfigDb(): ConfigLocalDB {
        if (!this.configDb) {
            throw new Error("Config sync not configured (no local config DB)");
        }
        return this.configDb;
    }

    /** List config file paths available on remote */
    async listRemotePaths(): Promise<string[]> {
        const docIds = await this.withConfigRemote((client) =>
            remoteCouch.listRemoteByPrefix(client, DOC_ID.CONFIG),
        );
        return docIds.map(configPathFromId);
    }

    /** List installed plugin folder paths (fallback when remote unavailable) */
    async listPluginFolders(): Promise<string[]> {
        const adapter = this.app.vault.adapter;
        const folders: string[] = [];
        try {
            const listing = await adapter.list(".obsidian/plugins");
            for (const folder of listing.folders) {
                folders.push(folder + "/");
            }
        } catch (e) {
            // plugins dir might not exist
        }
        return folders.sort();
    }

    getCommonConfigPaths(): string[] {
        return [
            ".obsidian/app.json",
            ".obsidian/appearance.json",
            ".obsidian/hotkeys.json",
            ".obsidian/community-plugins.json",
            ".obsidian/core-plugins.json",
            ".obsidian/core-plugins-migration.json",
        ];
    }

    /**
     * Test connectivity against the configured config DB. Returns null on
     * success, or an error message string. 401/403 latches the shared
     * auth state. 404 means the DB doesn't exist yet — that's not a
     * failure (Config Init will auto-create it on first push).
     */
    async testConnection(): Promise<string | null> {
        const client = this.makeConfigClient();
        if (client === null) return "Config sync is not configured";
        try {
            await client.info();
            return null;
        } catch (e: any) {
            if (e?.status === 404) return null; // DB will be created on first push
            if (e?.status === 401 || e?.status === 403) {
                this.replicator.markAuthError(e.status, e?.message);
            }
            return e?.message || "Connection failed";
        }
    }

    // ── Private ────────────────────────────────────────

    private async allDocIds(): Promise<string[]> {
        const docs = await this.requireConfigDb().allConfigDocs();
        return docs.map((d) => d._id);
    }

    private async ensureDir(filePath: string): Promise<void> {
        const dir = filePath.split("/").slice(0, -1).join("/");
        if (dir && !(await this.app.vault.adapter.exists(dir))) {
            await this.app.vault.adapter.mkdir(dir);
        }
    }

    private async listFilesRecursive(dir: string, result: string[]): Promise<void> {
        try {
            const listing = await this.app.vault.adapter.list(dir);
            for (const file of listing.files) {
                result.push(file);
            }
            for (const folder of listing.folders) {
                const folderName = folder.split("/").pop() ?? "";
                if (ConfigSync.SKIP_DIRS.has(folderName)) continue;
                await this.listFilesRecursive(folder, result);
            }
        } catch (e) {
            // skip inaccessible dirs
        }
    }
}
