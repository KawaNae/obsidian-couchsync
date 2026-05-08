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
import { paginateAllDocs } from "../db/sync/pagination.ts";
import type { ReconnectBridge } from "./reconnect-bridge.ts";
import {
    ConfigLastSynced,
    computeConfigDataHash,
    configLastSyncedKey,
    CONFIG_LAST_SYNCED_PREFIX,
} from "../db/sync/config-last-synced.ts";
import { ConfigCheckpoints } from "../db/sync/config-checkpoints.ts";
import {
    ConfigPullWriter,
    type ConfigConcurrentEntry,
} from "../db/sync/config-pull-writer.ts";
import {
    ConfigPushPipeline,
    type ConfigPushDivergence,
} from "../db/sync/config-push-pipeline.ts";
import { ConflictResolver } from "../conflict/conflict-resolver.ts";

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
function defaultClientFactory(settings: CouchSyncSettings): CouchClient | null {
    if (!settings.couchdbConfigDbName) return null;
    return makeCouchClient(
        settings.couchdbUri,
        settings.couchdbConfigDbName,
        settings.couchdbUser,
        settings.couchdbPassword,
    );
}

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

    /**
     * Optional override for client construction. Tests inject a fake
     * here to exercise init/push/pull end-to-end without standing up
     * a real CouchDB. Production code never sets this, so the default
     * `makeCouchClient` factory is used.
     */
    private readonly clientFactory: (settings: CouchSyncSettings) => CouchClient | null;

    /** Per-path `{vclock, size, dataHash}` cache. Drives the scan()
     *  short-circuit so unchanged files don't get rewritten on every
     *  scan-triggered op. Mirror of VaultSync.lastSynced. */
    private readonly lastSynced: ConfigLastSynced | null;

    /** Persistent pull/push cursors for `_changes`-based incremental
     *  replication. Loaded lazily on first pull/push. Mirror of
     *  vault sync's `Checkpoints`. */
    private readonly checkpoints: ConfigCheckpoints | null;
    private checkpointsLoaded = false;

    /** vclock-based pull-time conflict classifier. Stateless; one
     *  shared instance is enough. Same class as vault sync. */
    private readonly conflictResolver: ConflictResolver;

    constructor(
        private vault: IVaultIO,
        private modal: IModalPresenter,
        private configDb: ConfigLocalDB | null,
        private auth: AuthGate,
        private visibility: VisibilityGate,
        private reconnectBridge: ReconnectBridge,
        private getSettings: () => CouchSyncSettings,
        clientFactory?: (settings: CouchSyncSettings) => CouchClient | null,
    ) {
        this.clientFactory = clientFactory ?? defaultClientFactory;
        this.lastSynced = configDb ? new ConfigLastSynced(configDb) : null;
        this.checkpoints = configDb ? new ConfigCheckpoints(configDb) : null;
        this.conflictResolver = new ConflictResolver();
    }

    /** Lazy-load the persisted pull/push cursors. Idempotent — safe to
     *  call from every public op. */
    private async ensureCheckpointsLoaded(): Promise<void> {
        if (this.checkpointsLoaded) return;
        if (!this.checkpoints) throw new Error("ConfigSync.ensureCheckpointsLoaded: not configured");
        await this.checkpoints.load();
        this.checkpointsLoaded = true;
    }

    // ── Remote URL + auth helpers ──────────────────────

    /**
     * Build a CouchClient for the config database, using credentials
     * inherited from the vault sync settings. Returns null if config
     * sync is not configured.
     */
    private makeConfigClient(): CouchClient | null {
        return this.clientFactory(this.getSettings());
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

    /**
     * Init: wipe local + remote, then re-seed both from a fresh vault scan.
     *
     * Semantically a "make remote match local vault as of now". The
     * earlier implementation only scanned + pushed, which silently
     * left stale `config:*` docs on the remote when files had been
     * deleted from `.obsidian/` between inits. v0.20.6 explicitly
     * tombstones the remote-only ids so init really is idempotent.
     */
    async init(): Promise<number> {
        const db = this.requireConfigDb();
        return this.runOperation("Config Init", async (ctx, progress) => {
            // 1. Wipe local: scan() is additive, so without this stale
            //    docs from a previous larger scan would persist locally.
            progress.update("Deleting old config docs...");
            await db.deleteByPrefix(DOC_ID.CONFIG);
            // Drop per-path lastSynced meta + in-memory cache so the
            // following scan() doesn't short-circuit against stale
            // baselines for docs that no longer exist.
            await this.clearLastSyncedMeta();

            // 2. Scan vault to populate local DB with current truth.
            const scanned = await this.scan((path, i, total) => {
                progress.update(`Scanning: ${path} (${i}/${total})`);
            });
            const localIds = await this.allDocIds();
            const localSet = new Set(localIds);

            // 3. Fetch remote inventory (ids only, paginated). Anything
            //    on remote not in local-after-scan needs a tombstone so
            //    the remote view ends up matching local vault.
            progress.update("Fetching remote inventory...");
            const remoteIds = await remoteCouch.listRemoteByPrefix(
                ctx.client,
                DOC_ID.CONFIG,
                ctx.signal,
            );
            const toTombstone = remoteIds.filter((id) => !localSet.has(id));

            // 4. Tombstone remote-only ids.
            if (toTombstone.length > 0) {
                await remoteCouch.deleteRemoteDocs(
                    ctx.client,
                    toTombstone,
                    (docId, n) => {
                        progress.update(
                            `Removing stale remote: ${configPathFromId(docId)} (${n}/${toTombstone.length})`,
                        );
                    },
                    ctx.signal,
                );
            }

            // 5. Push current local docs.
            if (localIds.length > 0) {
                await remoteCouch.pushDocs(
                    db,
                    ctx.client,
                    localIds,
                    (docId, n) => {
                        progress.update(`Pushing: ${configPathFromId(docId)} (${n}/${localIds.length})`);
                    },
                    ctx.signal,
                );
            }

            progress.done(
                `Config init: pushed ${scanned}, tombstoned ${toTombstone.length} stale remote doc(s).`,
            );
            return scanned;
        });
    }

    /** Push: scan .obsidian/ → enumerate local delta via changes feed →
     *  per-doc remote-rev fetch → bulkDocs.
     *
     *  Replaces the snapshot-style push (full `fetchRemoteConfigDocs` +
     *  `pushDocs` by id list) in PR4 of the diff-sync plan. Divergence is
     *  detected per pair via `compareVC`; on hit, the modal asks for
     *  confirm-and-overwrite (matches the prior UX). Confirmed → bump
     *  local vclocks above remote and re-run the pipeline. */
    async push(): Promise<number> {
        const db = this.requireConfigDb();
        return this.runOperation("Config Push", async (ctx, progress) => {
            await this.ensureCheckpointsLoaded();

            const scanned = await this.scan((path, i, total) => {
                progress.update(`Scanning: ${path} (${i}/${total})`);
            });

            const pipeline = new ConfigPushPipeline({
                db,
                client: ctx.client,
                checkpoints: this.checkpoints!,
                getDeviceId: () => this.getSettings().deviceId,
                signal: ctx.signal,
            });

            let result = await pipeline.run((msg) => progress.update(msg));

            if (result.divergent.length > 0) {
                const ok = await this.confirmPushDivergence(result.divergent);
                if (!ok) {
                    throw new Error(
                        "Cancelled by user (concurrent edits detected)",
                    );
                }
                progress.update("Resolving divergence (advancing vclocks)...");
                await pipeline.forcePushAdvanceVclocks(result.divergent);
                result = await pipeline.run((msg) => progress.update(msg));
            }

            const summaryParts: string[] = [];
            if (result.stats.pushed) summaryParts.push(`${result.stats.pushed} pushed`);
            if (result.stats.skipped) summaryParts.push(`${result.stats.skipped} skipped`);
            if (result.stats.conflicts) summaryParts.push(`${result.stats.conflicts} conflicts (will retry)`);
            const summary = summaryParts.length > 0 ? summaryParts.join(", ") : "no changes";
            progress.done(`Push: ${summary}. (Scanned ${scanned} local file(s).)`);
            return result.stats.pushed;
        });
    }

    /** Pull: incremental `_changes`-based delta + write configSyncPaths to filesystem.
     *
     *  Replaces the snapshot-style pullByPrefix in PR3 of the diff-sync plan.
     *  Concurrent edits are surfaced AFTER the batch commit (informational),
     *  not pre-flight — the resolver classifies them as keep-local equivalents
     *  and the cursor advances past them, so re-running pull() will surface
     *  them again until manually resolved (matches vault-sync semantics). */
    async pull(): Promise<number> {
        const db = this.requireConfigDb();
        return this.runOperation("Config Pull", async (ctx, progress) => {
            await this.ensureCheckpointsLoaded();

            const writer = new ConfigPullWriter({
                db,
                client: ctx.client,
                checkpoints: this.checkpoints!,
                lastSynced: this.lastSynced!,
                getConflictResolver: () => this.conflictResolver,
                signal: ctx.signal,
            });
            const result = await writer.run((msg) => progress.update(msg));

            if (result.concurrent.length > 0) {
                this.notifyConcurrentPull(result.concurrent);
            }

            progress.update("Writing config files...");
            const written = await this.write((path, i, total) => {
                progress.update(`Writing: ${path} (${i}/${total})`);
            });

            const summaryParts: string[] = [];
            if (result.stats.accepted) summaryParts.push(`${result.stats.accepted} accepted`);
            if (result.stats.deleted) summaryParts.push(`${result.stats.deleted} deleted`);
            if (result.stats.convergedSkip) summaryParts.push(`${result.stats.convergedSkip} converged`);
            if (result.stats.concurrent) summaryParts.push(`${result.stats.concurrent} concurrent`);
            const summary = summaryParts.length > 0 ? summaryParts.join(", ") : "no changes";
            progress.done(`Pull: ${summary}. Wrote ${written} file(s). Reload Obsidian to apply.`);
            return written;
        });
    }

    /**
     * Fetch ConfigDocs from remote: by `keys` if given, otherwise by the
     * full `config:` prefix range (paginated). Filters out tombstones and
     * any non-config stragglers defensively.
     *
     * Both paths are batched. On slow mobile networks the per-request
     * payload of an unsplit `keys` list is exactly the same problem as
     * the unsplit prefix range \u2014 fix it the same way.
     */
    private async fetchRemoteConfigDocs(
        client: CouchClient,
        signal: AbortSignal,
        ids?: string[],
        onProgress?: (fetched: number) => void,
    ): Promise<ConfigDoc[]> {
        const docs: ConfigDoc[] = [];
        if (ids) {
            const KEYS_BATCH = 100;
            for (let i = 0; i < ids.length; i += KEYS_BATCH) {
                if (signal.aborted) throw makeAbortError();
                const batch = ids.slice(i, i + KEYS_BATCH);
                const result = await client.allDocs<ConfigDoc>(
                    { keys: batch, include_docs: true },
                    signal,
                );
                for (const row of result.rows) {
                    if (row.doc && !row.value?.deleted && row.doc.type === "config") {
                        docs.push(row.doc);
                    }
                }
                onProgress?.(docs.length);
            }
            return docs;
        }
        for await (const rows of paginateAllDocs<ConfigDoc>(
            client,
            {
                startkey: DOC_ID.CONFIG,
                endkey: DOC_ID.CONFIG + "\ufff0",
                include_docs: true,
            },
            { signal, onBatch: onProgress },
        )) {
            for (const row of rows) {
                if (row.doc && !row.value?.deleted && row.doc.type === "config") {
                    docs.push(row.doc);
                }
            }
        }
        return docs;
    }

    /**
     * Surface concurrent-edit findings collected during a diff pull.
     * Pull is already committed by the time this runs — concurrent docs
     * were filtered out of `accepted` by the resolver, so the only effect
     * here is informational. Logs the full list and shows a single-button
     * notice modal so the user can investigate without blocking the op.
     *
     * Re-running pull() will re-classify the same docs as concurrent
     * until the local copy is causally advanced (i.e., the user edits
     * the file or accepts a manual resolve), matching the vault-sync
     * conflict-orchestrator UX.
     */
    private notifyConcurrentPull(entries: ConfigConcurrentEntry[]): void {
        const paths = entries.map((e) => `  • ${e.path}`).join("\n");
        logWarn(
            `CouchSync: Config pull surfaced ${entries.length} concurrent edit(s):\n${paths}`,
        );
        const previewLimit = 5;
        const preview = entries.slice(0, previewLimit).map((e) => e.path).join(", ");
        const more = entries.length > previewLimit ? ` (+${entries.length - previewLimit} more)` : "";
        // Fire-and-forget: this is informational, the op already completed.
        void this.modal.showConfirmModal(
            `Config pull: ${entries.length} concurrent edit(s) detected`,
            `Local copies of ${preview}${more} have diverged from remote. ` +
            `See the Log View for the full list. ` +
            `Edit a file or trigger Init to advance past the conflict.`,
            "OK",
            false,
        );
    }

    /**
     * Push-side confirm for divergent local↔remote vclock pairs.
     * Returns true on "push anyway", false on cancel.
     *
     * "Push anyway" means: bump each divergent doc's local vclock to
     * dominate remote (mergeVC + bump), then retry the push pipeline.
     * Peers will see the new revision as a normal `dominated` update,
     * not a conflict — same end-state as the legacy snapshot push, but
     * without the rev-tree inflation.
     */
    private async confirmPushDivergence(
        divergent: ConfigPushDivergence[],
    ): Promise<boolean> {
        const paths = divergent
            .map((d) => `  • ${d.path} (${d.relation})`).join("\n");
        logWarn(
            `CouchSync: Config push would overwrite ${divergent.length} divergent doc(s):\n${paths}`,
        );
        const previewLimit = 5;
        const preview = divergent.slice(0, previewLimit)
            .map((d) => d.path).join(", ");
        const more = divergent.length > previewLimit
            ? ` (+${divergent.length - previewLimit} more)` : "";
        const message =
            `Pushing would overwrite remote for ${divergent.length} doc(s) ` +
            `with concurrent / outdated edits: ${preview}${more}. ` +
            `See the Log View for the full list. Continue anyway?`;
        return await this.modal.showConfirmModal(
            `Config push: ${divergent.length} divergent doc(s)`,
            message,
            "Push anyway",
            true,
        );
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

    /** Wipe per-path lastSynced meta + in-memory cache. Called from
     *  init() before scan() so the short-circuit can't be tricked by
     *  baselines whose corresponding ConfigDocs were just deleted. */
    private async clearLastSyncedMeta(): Promise<void> {
        const db = this.requireConfigDb();
        const rows = await db.getMetaByPrefix(CONFIG_LAST_SYNCED_PREFIX);
        if (rows.length > 0) {
            await db.runWriteTx({
                meta: rows.map(({ key }) => ({ op: "delete", key })),
            });
        }
        this.lastSynced?.clear();
    }

    /** Scan entire .obsidian/ directory to local DB.
     *
     *  Short-circuit: if the per-path lastSynced cache reports a matching
     *  `{size, dataHash}`, skip the rewrite entirely. This is the config
     *  symmetric to VaultSync.fileToDb's `chunksEqual` early-out — without
     *  it every scan rev-bumps every config doc, which inflates the remote
     *  rev tree and produces phantom divergence for peers (see audit
     *  2026-05-08). Hash + size compared, not base64 equality, to avoid
     *  holding the full 5MB×N base64 in memory. */
    async scan(onProgress?: (path: string, index: number, total: number) => void): Promise<number> {
        const db = this.requireConfigDb();
        const lastSynced = this.lastSynced;
        if (!lastSynced) throw new Error("ConfigSync.scan: lastSynced not initialised");
        await lastSynced.ensureLoaded();

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
                const dataHash = await computeConfigDataHash(buf);

                const cached = lastSynced.get(file);
                if (cached && cached.size === stat.size && cached.dataHash === dataHash) {
                    continue; // unchanged since last sync — no rewrite
                }

                const data = arrayBufferToBase64(buf);
                const configId = makeConfigId(file);
                await db.runWriteBuilder(async (snap) => {
                    const existing = (await snap.get(configId)) as ConfigDoc | null;
                    const newVclock = incrementVC(existing?.vclock, deviceId);
                    const doc: ConfigDoc = {
                        _id: configId,
                        type: "config",
                        data,
                        mtime: stat.mtime,
                        size: stat.size,
                        vclock: newVclock,
                    };
                    return {
                        docs: [{ doc }],
                        meta: [{
                            op: "put",
                            key: configLastSyncedKey(file),
                            value: { vclock: newVclock, size: stat.size, dataHash },
                        }],
                        onCommit: () => {
                            lastSynced.set(file, {
                                vclock: newVclock,
                                size: stat.size,
                                dataHash,
                            });
                        },
                    };
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

function makeAbortError(): Error {
    const e: any = new Error("The operation was aborted.");
    e.name = "AbortError";
    return e;
}
