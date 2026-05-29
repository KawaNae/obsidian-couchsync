import type { IVaultIO } from "../types/vault-io.ts";
import type { IModalPresenter } from "../types/modal-presenter.ts";
import type { ConfigLocalDB } from "../db/config-local-db.ts";
import type { AuthGate } from "../db/sync/auth-gate.ts";
import type { VisibilityGate } from "../db/visibility-gate.ts";
import type { ConfigDoc, CouchSyncDoc, ChunkDoc } from "../types.ts";
import { CONFIG_SCHEMA_VERSION } from "../types.ts";
import {
    DOC_ID,
    makeConfigId,
    configPathFromId,
} from "../types/doc-id.ts";
import type { CouchSyncSettings } from "../settings.ts";
import { ProgressNotice } from "../ui/notices.ts";
import {
    splitIntoChunks,
    joinChunks,
    computeHash,
    MAX_CHUNK_BYTES_CONFIG,
    type ChunkHasher,
} from "../db/chunker.ts";

/** Plaintext xxhash64 hasher — used by test harnesses that don't wire a
 *  cryptoProvider through. Production main.ts always injects a hasher
 *  closure that flips to HMAC when encryption is on. */
function defaultHasher(): ChunkHasher {
    return { alg: "x64", hash: computeHash };
}
import { incrementVC } from "./vector-clock.ts";
import type { ICouchClient } from "../db/interfaces.ts";
import { makeCouchClient } from "../db/couch-client.ts";
import type { CryptoProvider } from "../db/crypto-provider.ts";
import { logError, logWarn } from "../ui/log.ts";
import * as remoteCouch from "../db/remote-couch.ts";
import {
    ConfigOperation,
    CONFIG_TIMEOUTS,
    type ConfigOpContext,
} from "./config-operation.ts";
import type { ReconnectBridge } from "./reconnect-bridge.ts";
import {
    ConfigLastSynced,
    configLastSyncedKey,
} from "../db/sync/config-last-synced.ts";
import { ConfigCheckpoints } from "../db/sync/config-checkpoints.ts";
import {
    ConfigPullWriter,
    type ConfigConcurrentEntry,
} from "../db/sync/config-pull-writer.ts";
import { SchemaVersionMismatchError } from "../db/sync/schema-gate.ts";
import {
    ConfigPushPipeline,
    type ConfigPushDivergence,
} from "../db/sync/config-push-pipeline.ts";
import { ConflictResolver } from "../conflict/conflict-resolver.ts";
import { ConfigSetupService } from "./config-setup.ts";

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
function defaultClientFactory(settings: CouchSyncSettings): ICouchClient | null {
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
    private readonly clientFactory: (settings: CouchSyncSettings) => ICouchClient | null;

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

    /** Chunk hasher — bundles algorithm identity with the hash function.
     *  Same `ChunkHasher` shape vault-side uses, fed from a closure that
     *  reads the live **config** `cryptoProvider` (Phase 2 invariant 18:
     *  per-DB hasher) so encryption-state flips propagate without
     *  rebuilding the hasher. Optional for the older test harnesses
     *  that didn't pre-thread it; null → fall back to the chunker's
     *  default xxhash64 (plaintext-only call sites). */
    private readonly hasher?: ChunkHasher;

    /** Phase 2 callback: hand the host (main.ts) a freshly-built
     *  `CryptoProvider` after a Config Init / Pull derivation. The
     *  host stores it on `configCryptoProvider` so subsequent
     *  `wrapConfigClient` calls produce the right encrypting stack
     *  for live sync ops. Null = encryption is disabled for config. */
    private readonly onConfigCryptoChange?: (crypto: CryptoProvider | null) => void;

    /** Phase 2: RAW config-DB client factory (no codec wrapping) used
     *  by ConfigSetupService for the `config:meta` push. The meta doc
     *  is never encrypted or compressed — bypassing the codec stack
     *  keeps it readable by a fresh-Clone device that hasn't unlocked
     *  the passphrase yet. Optional; falls back to building one from
     *  settings via `makeCouchClient`. Tests pass the same in-memory
     *  FakeCouchClient as the wrapped client factory so the meta push
     *  lands on the same fixture. */
    private readonly rawClientFactory?: (settings: CouchSyncSettings) => ICouchClient | null;

    constructor(
        private vault: IVaultIO,
        private modal: IModalPresenter,
        private configDb: ConfigLocalDB | null,
        private auth: AuthGate,
        private visibility: VisibilityGate,
        private reconnectBridge: ReconnectBridge,
        private getSettings: () => CouchSyncSettings,
        clientFactory?: (settings: CouchSyncSettings) => ICouchClient | null,
        hasher?: ChunkHasher,
        onConfigCryptoChange?: (crypto: CryptoProvider | null) => void,
        rawClientFactory?: (settings: CouchSyncSettings) => ICouchClient | null,
    ) {
        this.clientFactory = clientFactory ?? defaultClientFactory;
        this.lastSynced = configDb ? new ConfigLastSynced(configDb) : null;
        this.checkpoints = configDb ? new ConfigCheckpoints(configDb) : null;
        this.conflictResolver = new ConflictResolver();
        this.hasher = hasher;
        this.onConfigCryptoChange = onConfigCryptoChange;
        this.rawClientFactory = rawClientFactory;
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
    private makeConfigClient(): ICouchClient | null {
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
     * Init: real clean slate.
     *
     * 1. Local: destroy + reopen ConfigLocalDB (drops docs, meta, vclock
     *    baselines, cursors atomically — the IndexedDB store goes away).
     * 2. Remote: DELETE /<configDb> + PUT /<configDb> via the operation
     *    epoch's CouchClient. True rev-tree reset, not the legacy
     *    "tombstone-only" pseudo-reset that left rev tree intact.
     * 2b. Build a SELF-CONTAINED `config:meta` (Phase 2 invariant 17):
     *     fresh salt + own keyCheck derived from `opts.passphrase`.
     *     The new `CryptoProvider` is propagated to the host via
     *     `onConfigCryptoChange` so subsequent push round-trips inside
     *     this same Init flow use the correct keys.
     * 3. Scan vault → seed local from current `.obsidian/` truth.
     * 4. Push to empty remote (no conflicts possible).
     *
     * Symmetric with `SetupService.init()` for vault sync. Resolves the
     * audit-2026-05-08 finding where init() left rev=N+1 with vclock
     * reset to {device:1}, silently destroying peer causality history.
     *
     * Phase 2 signature change: takes an explicit `opts` describing the
     * desired config-side codec policy. The host (main.ts) reads this
     * from `settings.configEncryptionEnabled ?? settings.encryptionEnabled`
     * etc., letting Phase 3 surface independent UI without altering this
     * layer.
     */
    async init(opts: {
        encryption: boolean;
        passphrase?: string;
        compression: boolean;
    }): Promise<number> {
        const db = this.requireConfigDb();
        return this.runOperation("Config Init", async (ctx, progress) => {
            const setup = new ConfigSetupService(
                db,
                this.getSettings,
                {
                    clearLastSynced: () => this.lastSynced?.clear(),
                    invalidateCheckpoints: () => { this.checkpointsLoaded = false; },
                    scan: (cb) => this.scan(cb),
                    onCryptoProviderReady: (crypto) => {
                        this.onConfigCryptoChange?.(crypto);
                    },
                    makeRawConfigClient: this.rawClientFactory
                        ? () => {
                            const c = this.rawClientFactory!(this.getSettings());
                            if (!c) throw new Error("ConfigSync: raw client factory returned null");
                            return c;
                        }
                        : undefined,
                },
            );
            const result = await setup.init(
                ctx.client,
                ctx.signal,
                (msg) => progress.update(msg),
                opts,
            );
            progress.done(
                `Config init: scanned ${result.scanned} file(s), pushed ${result.pushed}.`,
            );
            return result.scanned;
        });
    }

    /**
     * Re-initialize the config DB as part of an encryption state change.
     * Called from initVault/cloneFromRemote in main.ts.
     *
     * Bypasses ConfigOperation (no auth/visibility gate) because the
     * caller is already in a user-triggered Settings flow where those
     * preconditions are satisfied. The client comes from the caller's
     * clientFactory, which reflects the current cryptoProvider state.
     */
    async reinitForEncryptionChange(
        onProgress: (msg: string) => void,
        opts: {
            encryption: boolean;
            passphrase?: string;
            compression: boolean;
        },
    ): Promise<void> {
        const db = this.configDb;
        if (!db) return;
        const client = this.clientFactory(this.getSettings());
        if (!client) return;
        const controller = new AbortController();
        const setup = new ConfigSetupService(
            db,
            this.getSettings,
            {
                clearLastSynced: () => this.lastSynced?.clear(),
                invalidateCheckpoints: () => { this.checkpointsLoaded = false; },
                scan: (cb) => this.scan(cb),
                onCryptoProviderReady: (crypto) => {
                    this.onConfigCryptoChange?.(crypto);
                },
            },
        );
        await setup.init(client, controller.signal, onProgress, opts);
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
                hasher: this.hasher,
            });
            let result;
            try {
                result = await writer.run((msg) => progress.update(msg));
            } catch (e: any) {
                if (e instanceof SchemaVersionMismatchError) {
                    // Remote ConfigDoc shape this build can't read — re-init
                    // flow required. Surface the error's own version-accurate
                    // message via the operation's progress.fail path; the
                    // host's findLegacyConfigDoc startup guard also catches
                    // the local-side copy on next reload.
                    throw new Error(e.userMessage);
                }
                throw e;
            }

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

    // ── Low-level operations ───────────────────────────

    /** Scan entire .obsidian/ directory to local DB.
     *
     *  Short-circuit: if the per-path lastSynced cache reports a matching
     *  `{size, chunks}`, skip the rewrite entirely. v0.26 symmetric to
     *  VaultSync.fileToDb's `chunksEqual` early-out — without it every
     *  scan rev-bumps every config doc, which inflates the remote rev
     *  tree and produces phantom divergence for peers (audit 2026-05-08).
     *  Chunk-list comparison is O(N) over chunk ids; the full payload
     *  is never re-encoded for the equality check.
     *
     *  v0.26 chunking: each config file is split into ChunkDocs via
     *  `splitIntoChunks` (256 KiB chunks). The ConfigDoc carries only
     *  `chunks: string[]`; chunk bodies live as separate docs with
     *  envelope-formatted attachment "c" (gzip + encrypt transparently
     *  applied by the wrapped client). */
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
                const chunks = await splitIntoChunks(
                    buf,
                    this.hasher
                        ? { hasher: this.hasher, chunkBytes: MAX_CHUNK_BYTES_CONFIG }
                        : { hasher: defaultHasher(), chunkBytes: MAX_CHUNK_BYTES_CONFIG },
                );
                const chunkIds = chunks.map((c) => c._id);

                const cached = lastSynced.get(file);
                if (cached && cached.size === stat.size
                    && ConfigSync.chunksEqual(cached.chunks, chunkIds)) {
                    continue; // unchanged since last sync — no rewrite
                }

                const configId = makeConfigId(file);
                await db.runWriteBuilder(async (snap) => {
                    const existing = (await snap.get(configId)) as ConfigDoc | null;
                    const newVclock = incrementVC(existing?.vclock, deviceId);
                    const doc: ConfigDoc = {
                        _id: configId,
                        schemaVersion: CONFIG_SCHEMA_VERSION,
                        type: "config",
                        chunks: chunkIds,
                        mtime: stat.mtime,
                        size: stat.size,
                        vclock: newVclock,
                    };
                    return {
                        chunks: chunks as unknown as CouchSyncDoc[],
                        docs: [{ doc: doc as unknown as CouchSyncDoc }],
                        meta: [{
                            op: "put",
                            key: configLastSyncedKey(file),
                            value: {
                                vclock: newVclock,
                                size: stat.size,
                                chunks: chunkIds,
                            },
                        }],
                        onCommit: () => {
                            lastSynced.set(file, {
                                vclock: newVclock,
                                size: stat.size,
                                chunks: chunkIds,
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

    /** Chunk-list equality. O(N) over ids; chunks are content-addressed,
     *  so id-equality is byte-equality (invariant 14). Mirrors
     *  VaultSync.chunksEqual. */
    private static chunksEqual(a: readonly string[], b: readonly string[]): boolean {
        return a.length === b.length && a.every((id, i) => id === b[i]);
    }


    /** Write config docs to filesystem, filtered by configSyncPaths.
     *
     *  v0.26 chunking: assembles each config file's binary content by
     *  fetching the referenced ChunkDocs from the config DB and joining
     *  them. Missing chunks cause a WARN + skip (symmetric with
     *  VaultSync.dbToFile); the missing chunk is expected to arrive on
     *  the next pull. Tombstones (`deleted: true`) are silently skipped
     *  \u2014 config-sync currently has no continuous tombstone-driven flow,
     *  but the field is honoured for safety. */
    async write(onProgress?: (path: string, index: number, total: number) => void): Promise<number> {
        const db = this.requireConfigDb();
        const paths = this.getSettings().configSyncPaths;
        if (paths.length === 0) return 0;

        const docs: ConfigDoc[] = [];
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
                    if (doc.deleted) continue;
                    docs.push(doc);
                }
            } else {
                const doc = await db.get(makeConfigId(p)) as ConfigDoc | null;
                if (doc && doc.type === "config" && !doc.deleted) docs.push(doc);
            }
        }

        let count = 0;
        for (let i = 0; i < docs.length; i++) {
            const doc = docs[i];
            const path = configPathFromId(doc._id);
            if (ConfigSync.SKIP_PATHS.has(path)) continue;
            try {
                onProgress?.(path, i + 1, docs.length);
                const chunks = await db.getChunks(doc.chunks);
                if (chunks.length !== doc.chunks.length) {
                    const missing = doc.chunks.filter(
                        (id) => !chunks.some((c) => c._id === id),
                    );
                    logWarn(
                        `CouchSync: Skipping config write ${path} \u2014 ` +
                        `missing ${missing.length} chunk(s): ${missing.slice(0, 3).join(", ")}`,
                    );
                    continue;
                }
                const buf = ConfigSync.assembleChunks(doc.chunks, chunks);
                await this.ensureDir(path);
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

    /** Order the fetched chunks by the ConfigDoc.chunks reference list
     *  and join into a single ArrayBuffer. The fetch order from
     *  `getChunks` is not guaranteed (keys-array allDocs returns rows
     *  in id order, not request order), so we re-order through a map. */
    private static assembleChunks(
        order: readonly string[],
        chunks: readonly ChunkDoc[],
    ): ArrayBuffer {
        const byId = new Map<string, ChunkDoc>();
        for (const c of chunks) byId.set(c._id, c);
        const ordered = order
            .map((id) => byId.get(id))
            .filter((c): c is ChunkDoc => c != null);
        return joinChunks(ordered as ChunkDoc[]);
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
