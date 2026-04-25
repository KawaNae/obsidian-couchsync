import type { IVaultIO } from "../types/vault-io.ts";
import type { IModalPresenter } from "../types/modal-presenter.ts";
import type { ConfigLocalDB } from "../db/config-local-db.ts";
import type { AuthGate } from "../db/sync/auth-gate.ts";
import type { VisibilityGate } from "../db/visibility-gate.ts";
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
import { logError, logWarn } from "../ui/log.ts";
import * as remoteCouch from "../db/remote-couch.ts";
import {
    detectDivergence,
    dangerousForPush,
    dangerousForPull,
    type Divergence,
} from "./config-divergence.ts";
import {
    ConfigOperation,
    CONFIG_TIMEOUTS,
    type ConfigOpContext,
} from "./config-operation.ts";
import type { ReconnectBridge } from "./reconnect-bridge.ts";

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
 *     server as the vault DB (auth shared via a common `AuthGate`)
 *   - Replication: every public op runs inside a `ConfigOperation` epoch
 *     that owns an AbortController, runs a 15s reachability probe, and
 *     waits for visibility=visible before fetching. Vault sync's session
 *     lifecycle disciplines the live loops; ConfigOperation is the same
 *     discipline for one-shot user-triggered ops.
 *   - Ordering: every write increments the device's `vclock` counter,
 *     same VC discipline as FileDoc — concurrent edits are detected
 *     and surfaced rather than silently LWW-merged.
 */
export class ConfigSync {
    private static readonly SKIP_DIRS = new Set(["node_modules", ".git"]);
    private static readonly SKIP_FILES = new Set(["workspace.json", "workspace-mobile.json"]);
    /** Own data.json — contains deviceId, must not be synced across devices. */
    private static readonly SKIP_PATHS = new Set([
        ".obsidian/plugins/obsidian-couchsync/data.json",
    ]);
    private static readonly MAX_CONFIG_SIZE = 5 * 1024 * 1024; // 5MB

    /** In-flight op, or null. Concurrent ops are rejected. */
    private inflight: ConfigOperation | null = null;

    constructor(
        private vault: IVaultIO,
        private modal: IModalPresenter,
        private configDb: ConfigLocalDB | null,
        private auth: AuthGate,
        private visibility: VisibilityGate,
        private reconnectBridge: ReconnectBridge,
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

    // ── Operation runner ───────────────────────────────

    /**
     * Run a config operation inside a ConfigOperation epoch and a
     * ProgressNotice. Rejects if another op is already in flight —
     * the settings tab disables buttons during in-flight ops.
     */
    private async runOperation<T>(
        label: string,
        body: (ctx: ConfigOpContext, progress: ProgressNotice) => Promise<T>,
    ): Promise<T> {
        if (this.inflight !== null) {
            throw new Error(
                `Another config operation is already in progress. ` +
                `Wait for it to finish or cancel it first.`,
            );
        }
        const op = new ConfigOperation({
            auth: this.auth,
            visibility: this.visibility,
            reconnectBridge: this.reconnectBridge,
            makeClient: () => this.makeConfigClient(),
        });
        this.inflight = op;
        const progress = new ProgressNotice(label);
        try {
            return await op.run((ctx) => body(ctx, progress));
        } catch (e: any) {
            if (e?.name === "AbortError") {
                progress.fail(`${label} cancelled`);
            } else {
                progress.fail(`${label} failed: ${e?.message ?? e}`);
            }
            throw e;
        } finally {
            this.inflight = null;
        }
    }

    /** Cancel the in-flight op (if any). Idempotent / noop when idle. */
    cancelCurrent(): void {
        this.inflight?.cancel();
    }

    /** True iff an op is currently running. UI uses this to disable buttons. */
    isInflight(): boolean {
        return this.inflight !== null;
    }

    // ── High-level operations ──────────────────────────

    /** Init: delete all local config docs → scan .obsidian/ → push to remote */
    async init(): Promise<number> {
        const db = this.requireConfigDb();
        return this.runOperation("Config Init", async (ctx, progress) => {
            progress.update("Deleting old config docs...");
            const deletedIds = await db.deleteByPrefix(DOC_ID.CONFIG);

            const scanned = await this.scan((path, i, total) => {
                progress.update(`Scanning: ${path} (${i}/${total})`);
            });

            const currentIds = await this.allDocIds();
            const affectedIds = [...new Set([...deletedIds, ...currentIds])];

            if (affectedIds.length > 0) {
                await remoteCouch.pushDocs(
                    db,
                    ctx.client,
                    affectedIds,
                    (docId, n) => {
                        progress.update(`Pushing: ${configPathFromId(docId)} (${n}/${affectedIds.length})`);
                    },
                    ctx.signal,
                );
            }

            progress.done(`Config init: deleted ${deletedIds.length}, pushed ${scanned} file(s).`);
            return scanned;
        });
    }

    /** Push: scan .obsidian/ → divergence check → push config docs to remote */
    async push(): Promise<number> {
        const db = this.requireConfigDb();
        return this.runOperation("Config Push", async (ctx, progress) => {
            const scanned = await this.scan((path, i, total) => {
                progress.update(`Scanning: ${path} (${i}/${total})`);
            });

            const localDocs = await db.allConfigDocs();
            if (localDocs.length === 0) {
                progress.done(`Pushed 0 config file(s).`);
                return scanned;
            }

            // Divergence check: fetch remote counterparts and compare vclocks.
            // Surfacing here is the "concurrent edits are detected and
            // surfaced" guarantee the class docstring promises.
            progress.update("Checking remote for concurrent edits...");
            const localIds = localDocs.map((d) => d._id);
            const remoteDocs = await this.fetchRemoteConfigDocs(ctx.client, ctx.signal, localIds);
            const dangerous = dangerousForPush(detectDivergence(localDocs, remoteDocs));
            if (dangerous.length > 0) {
                const ok = await this.confirmDivergence(dangerous, "push");
                if (!ok) throw new Error("Cancelled by user (concurrent edits detected)");
            }

            await remoteCouch.pushDocs(
                db,
                ctx.client,
                localIds,
                (docId, n) => {
                    progress.update(`Pushing: ${configPathFromId(docId)} (${n}/${localIds.length})`);
                },
                ctx.signal,
            );

            progress.done(`Pushed ${scanned} config file(s).`);
            return scanned;
        });
    }

    /** Pull: divergence check → pull config docs from remote → write configSyncPaths to filesystem */
    async pull(): Promise<number> {
        const db = this.requireConfigDb();
        return this.runOperation("Config Pull", async (ctx, progress) => {
            // Divergence check: fetch what we'd be overwriting and compare
            // vclocks before pullByPrefix unconditionally clobbers local.
            progress.update("Checking local for concurrent edits...");
            const localDocs = await db.allConfigDocs();
            const remoteDocs = await this.fetchRemoteConfigDocs(ctx.client, ctx.signal);
            const dangerous = dangerousForPull(detectDivergence(localDocs, remoteDocs));
            if (dangerous.length > 0) {
                const ok = await this.confirmDivergence(dangerous, "pull");
                if (!ok) throw new Error("Cancelled by user (concurrent edits detected)");
            }

            progress.update("Pulling config from remote...");
            await remoteCouch.pullByPrefix(db, ctx.client, DOC_ID.CONFIG, ctx.signal);

            const written = await this.write((path, i, total) => {
                progress.update(`Writing: ${path} (${i}/${total})`);
            });

            progress.done(`Pulled ${written} config file(s). Reload Obsidian to apply.`);
            return written;
        });
    }

    /**
     * Fetch ConfigDocs from remote: by `keys` if given, otherwise by the
     * full `config:` prefix range. Filters out tombstones and any non-config
     * stragglers defensively.
     */
    private async fetchRemoteConfigDocs(
        client: CouchClient,
        signal: AbortSignal,
        ids?: string[],
    ): Promise<ConfigDoc[]> {
        const opts = ids
            ? { keys: ids, include_docs: true }
            : { startkey: DOC_ID.CONFIG, endkey: DOC_ID.CONFIG + "\ufff0", include_docs: true };
        const result = await client.allDocs<ConfigDoc>(opts, signal);
        const docs: ConfigDoc[] = [];
        for (const row of result.rows) {
            if (row.doc && !row.value?.deleted && row.doc.type === "config") {
                docs.push(row.doc);
            }
        }
        return docs;
    }

    /**
     * Show a confirm modal listing the divergent paths, returning true if
     * the user chose to proceed (overwrite the other side) and false on
     * cancel. The full path list is also written to the log so the user
     * can review it after the modal closes.
     */
    private async confirmDivergence(
        divs: Divergence[],
        direction: "push" | "pull",
    ): Promise<boolean> {
        const verb = direction === "push" ? "Pushing" : "Pulling";
        const target = direction === "push" ? "remote" : "local";
        const paths = divs.map((d) => `  • ${d.path} (${d.relation})`).join("\n");
        logWarn(
            `CouchSync: Config ${direction} would overwrite concurrent edits on ${divs.length} doc(s):\n${paths}`,
        );
        const previewLimit = 5;
        const preview = divs
            .slice(0, previewLimit)
            .map((d) => d.path)
            .join(", ");
        const more = divs.length > previewLimit ? ` (+${divs.length - previewLimit} more)` : "";
        const message =
            `${verb} would overwrite ${target} for ${divs.length} doc(s) ` +
            `with concurrent edits: ${preview}${more}. ` +
            `See the Log View for the full list. Continue anyway?`;
        return await this.modal.showConfirmModal(
            `Config ${direction}: concurrent edits detected`,
            message,
            direction === "push" ? "Push anyway" : "Pull anyway",
            true,
        );
    }

    // ── Low-level operations ───────────────────────────

    /** Scan entire .obsidian/ directory to local DB */
    async scan(onProgress?: (path: string, index: number, total: number) => void): Promise<number> {
        const db = this.requireConfigDb();
        const files: string[] = [];
        await this.listFilesRecursive(".obsidian", files);

        const deviceId = this.getSettings().deviceId;
        let count = 0;
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fileName = file.split("/").pop() ?? "";
            if (ConfigSync.SKIP_FILES.has(fileName)) continue;
            if (ConfigSync.SKIP_PATHS.has(file)) continue;

            try {
                onProgress?.(file, i + 1, files.length);
                const stat = await this.vault.stat(file);
                if (!stat || stat.size > ConfigSync.MAX_CONFIG_SIZE) continue;

                const buf = await this.vault.readBinary(file);
                const data = arrayBufferToBase64(buf);

                const configId = makeConfigId(file);
                await db.runWriteBuilder(async (snap) => {
                    const existing = (await snap.get(configId)) as ConfigDoc | null;
                    const doc: ConfigDoc = {
                        _id: configId,
                        type: "config",
                        data,
                        mtime: stat.mtime,
                        size: stat.size,
                        vclock: incrementVC(existing?.vclock, deviceId),
                    };
                    return { docs: [{ doc }] };
                });
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
                if (await this.vault.exists(path)) {
                    await this.vault.writeBinary(path, buf);
                } else {
                    await this.vault.createBinary(path, buf);
                }
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
        return this.runOperation("Config List Remote", async (ctx) => {
            const docIds = await remoteCouch.listRemoteByPrefix(ctx.client, DOC_ID.CONFIG, ctx.signal);
            return docIds.map(configPathFromId);
        });
    }

    /** List installed plugin folder paths (fallback when remote unavailable) */
    async listPluginFolders(): Promise<string[]> {
        const folders: string[] = [];
        try {
            const listing = await this.vault.list(".obsidian/plugins");
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
     *
     * Uses a short reachability timeout (15s) so the user doesn't wait
     * 30s on the Test button when the iPad has flaky network.
     */
    async testConnection(): Promise<string | null> {
        const client = this.makeConfigClient();
        if (client === null) return "Config sync is not configured";
        try {
            await client.withTimeout(CONFIG_TIMEOUTS.reachability).info();
            return null;
        } catch (e: any) {
            if (e?.status === 404) return null; // DB will be created on first push
            if (e?.status === 401 || e?.status === 403) {
                this.auth.raise(e.status, e?.message);
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
        if (dir && !(await this.vault.exists(dir))) {
            await this.vault.createFolder(dir);
        }
    }

    private async listFilesRecursive(dir: string, result: string[]): Promise<void> {
        try {
            const listing = await this.vault.list(dir);
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
