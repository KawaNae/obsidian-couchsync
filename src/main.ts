import { Notice, Platform, Plugin, apiVersion } from "obsidian";
import { type CouchSyncSettings, DEFAULT_SETTINGS } from "./settings.ts";
import { LocalDB } from "./db/local-db.ts";
import { ConfigLocalDB } from "./db/config-local-db.ts";
import { SyncEngine } from "./db/sync-engine.ts";
import { AuthGate } from "./db/sync/auth-gate.ts";
import { VaultRemoteOps } from "./db/sync/vault-remote-ops.ts";
import { VaultSync } from "./sync/vault-sync.ts";
import { ConfigSync } from "./sync/config-sync.ts";
import { resolveConfigCodec } from "./sync/config-codec-policy.ts";
import type { ReconnectBridge } from "./sync/reconnect-bridge.ts";
import { SetupService } from "./sync/setup.ts";
import { ChangeTracker } from "./sync/change-tracker.ts";
import { Reconciler, type ReconcileReason } from "./sync/reconciler.ts";
import { ConflictOrchestrator } from "./conflict/conflict-orchestrator.ts";
import { checkInstallMarker } from "./sync/install-marker.ts";
import { StatusBar } from "./ui/status-bar.ts";
import { initLog, logInfo, logError, logWarn, notify } from "./ui/log.ts";
import { CouchSyncSettingTab } from "./settings-tab/index.ts";
import { ProgressNotice } from "./ui/notices.ts";
import { HistoryStorage } from "./history/storage.ts";
import { HistoryCapture } from "./history/history-capture.ts";
import { HistoryManager } from "./history/history-manager.ts";
import { LogStorage } from "./log/log-storage.ts";
import { LogManager } from "./log/log-manager.ts";
import type { DeviceInfo } from "./log/markdown-formatter.ts";
import { DiffHistoryView, VIEW_TYPE_DIFF_HISTORY } from "./ui/history-view.ts";
import { LogView, VIEW_TYPE_LOG } from "./ui/log-view.ts";
import { migrateSettings } from "./settings-migration.ts";
import { registerCommands } from "./commands.ts";
import { gcOrphanChunks } from "./db/chunk-gc.ts";
import { ObsidianVaultIO } from "./adapters/obsidian-vault-io.ts";
import { ObsidianAdapterIO } from "./adapters/obsidian-adapter-io.ts";
import { ObsidianVaultEvents } from "./adapters/obsidian-vault-events.ts";
import { ObsidianModalPresenter } from "./adapters/obsidian-modal-presenter.ts";
import { ObsidianCompositionTracker } from "./adapters/obsidian-composition-tracker.ts";
import { EditorAwareVaultWriter } from "./adapters/editor-aware-vault-writer.ts";
import { CompositionGate } from "./sync/composition-gate.ts";
import type { CryptoProvider } from "./db/crypto-provider.ts";
import { computeHash, type ChunkHasher } from "./db/chunker.ts";
import type { ChunkHashAlg } from "./types/doc-id.ts";
import { EncryptingCouchClient } from "./db/encrypting-couch-client.ts";
import { CompressingCouchClient } from "./db/compressing-couch-client.ts";
import { makeCouchClient, type CouchClient } from "./db/couch-client.ts";
import {
    fetchVaultMeta,
    buildInitialVaultMeta,
    pushVaultMeta,
    unlockVaultMeta,
    unlockConfigMeta,
    VAULT_META_DOC_ID,
    CONFIG_META_DOC_ID,
    type VaultMetaDoc,
    type ConfigMetaDoc,
} from "./db/vault-meta.ts";
import { checkEncryptionAgreement, type EncryptionAgreement } from "./db/encryption-agreement.ts";
import { PassphraseModal } from "./ui/passphrase-modal.ts";
import type { ICouchClient } from "./db/interfaces.ts";

export default class CouchSyncPlugin extends Plugin {
    settings!: CouchSyncSettings;
    localDb!: LocalDB;
    /** Null when `couchdbConfigDbName === ""` (config sync disabled) */
    configLocalDb: ConfigLocalDB | null = null;
    replicator!: SyncEngine;
    auth!: AuthGate;
    remoteOps!: VaultRemoteOps;
    configSync!: ConfigSync;
    private vaultSync!: VaultSync;
    private setupService!: SetupService;
    private changeTracker!: ChangeTracker;
    reconciler!: Reconciler;
    private historyStorage!: HistoryStorage;
    private historyCapture!: HistoryCapture;
    historyManager!: HistoryManager;
    logStorage!: LogStorage;
    logManager!: LogManager;
    statusBar!: StatusBar;
    modalPresenter!: ObsidianModalPresenter;
    private conflictOrchestrator!: ConflictOrchestrator;
    private compositionTracker!: ObsidianCompositionTracker;
    private compositionGate!: CompositionGate;
    private vaultWriter!: EditorAwareVaultWriter;
    /** Phase 2 (v0.26): per-DB crypto principals (invariant 18). Each
     *  DB is its own crypto root — same passphrase + different salts →
     *  different keys. vault:meta unlocks `vaultCryptoProvider`;
     *  config:meta unlocks `configCryptoProvider`. */
    private vaultCryptoProvider?: CryptoProvider;
    private configCryptoProvider?: CryptoProvider;
    /** Transient compression override active only during Clone (Invariant
     *  C — setup atomicity). The vault decorator stack reads
     *  `activeCompression`, not `settings.compressionEnabled` directly, so
     *  Clone can run the remote's codec config in-memory and persist
     *  `settings.compressionEnabled` only on success. Undefined at all
     *  other times → the getter falls back to the persisted setting, so
     *  the Step-1 toggle, onload reconcile, and Init all flow through
     *  unchanged. Symmetric to how `vaultCryptoProvider` overrides the
     *  persisted encryption flag. */
    private compressionOverride?: boolean;
    /** Transient cipherVersion floor active only during Clone, before
     *  `settings.vaultCipherVersion` is persisted on success. Mirrors
     *  `compressionOverride`: the vault decorator reads `activeCipherVersion`,
     *  so Clone can decrypt with the just-unlocked remote meta's cipherVersion
     *  in-memory while keeping the persisted floor atomic with the rest of the
     *  clone commit. Undefined at all other times → the getter falls back to
     *  the persisted floor. */
    private cipherVersionOverride?: number;
    encryptionMismatch?: EncryptionAgreement;
    /** Mismatch surfaced from the config:meta agreement check, if any.
     *  Symmetric to `encryptionMismatch` (vault). */
    configEncryptionMismatch?: EncryptionAgreement;

    /**
     * Wrap a raw CouchClient with the vault-DB decorator stack. Reads
     * `vaultCryptoProvider` + `settings.compressionEnabled` via closure
     * on every invocation, so Init/Clone state changes propagate to all
     * vault-side consumers (VaultRemoteOps + SyncEngine) automatically.
     *
     * Compose order encodes invariant 10: `compress(encrypt(raw))` on
     * push so the plain payload reaches gzip before the cipher renders
     * the stream incompressible. Pull traverses the inverse order.
     */
    private wrapVaultClient = (raw: CouchClient): ICouchClient => {
        // Policy-gated codec stack (Invariant III). The encryption POLICY
        // (`encryptionEnabled`) gates whether the encrypt layer is applied —
        // not the provider's existence. A stale in-memory provider left over
        // from a prior encrypted session must not activate the encrypt layer
        // when the policy says plaintext. Symmetric with compression, which
        // is already policy-gated via `activeCompression`.
        let client: ICouchClient = raw;
        if (this.settings.encryptionEnabled) {
            if (!this.vaultCryptoProvider) {
                throw new Error(
                    "CouchSync: refusing to build vault client — vault is encrypted " +
                        "but no crypto provider is unlocked (provisioning incomplete). " +
                        "Re-run Init/Clone or unlock the vault.",
                );
            }
            client = new EncryptingCouchClient(
                client, this.vaultCryptoProvider, this.activeCipherVersion,
            );
        }
        if (this.activeCompression) {
            client = new CompressingCouchClient(client);
        }
        return client;
    };

    /** Compression flag the vault decorator stack actually uses. Equals
     *  the persisted setting except during Clone, when the remote's flag
     *  is applied in-memory before `settings.compressionEnabled` is
     *  committed (Invariant C). See `compressionOverride`. */
    private get activeCompression(): boolean {
        return this.compressionOverride ?? this.settings.compressionEnabled;
    }

    /** cipherVersion policy floor the vault decorator stack enforces. Equals
     *  the persisted floor (`settings.vaultCipherVersion`, TOFU) except during
     *  Clone, when the just-unlocked remote meta's cipherVersion is applied
     *  in-memory before the floor is committed (Invariant C). See
     *  `cipherVersionOverride`. */
    private get activeCipherVersion(): number | undefined {
        return this.cipherVersionOverride ?? this.settings.vaultCipherVersion;
    }

    /** TOFU ratchet for the vault cipherVersion floor: record the highest
     *  cipherVersion observed at a trusted unlock. Never decreases (a server
     *  cannot lower it — the agreement check refuses meta below the floor).
     *  Mutates `this.settings` only; the caller owns `saveSettings()` so it can
     *  batch with other Init/Clone writes. Returns true if the floor changed. */
    private ratchetVaultCipherFloor(observed: number): boolean {
        if (observed > (this.settings.vaultCipherVersion ?? 0)) {
            this.settings.vaultCipherVersion = observed;
            return true;
        }
        return false;
    }

    /** Cross-platform OS label for the log frontmatter. Desktop uses Node
     *  `process.platform` (win32/darwin/linux); mobile has no Node, so derive
     *  from Obsidian `Platform` + the userAgent version (the old code emitted
     *  a useless "unknown" on every mobile export). */
    private deriveOsLabel(): string {
        if (typeof process !== "undefined" && process.platform) return process.platform;
        const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
        if (Platform.isAndroidApp) {
            const m = /Android (\d+(?:\.\d+)?)/.exec(ua);
            return m ? `android ${m[1]}` : "android";
        }
        if (Platform.isIosApp) {
            const base = Platform.isTablet ? "ipados" : "ios";
            const m = /OS (\d+(?:_\d+)*)/.exec(ua); // "CPU OS 17_4 like Mac OS X"
            return m ? `${base} ${m[1].replace(/_/g, ".")}` : base;
        }
        return "unknown";
    }

    /** Best-effort device specs for the log frontmatter. Every field is
     *  collected defensively and platform-asymmetric (Node `os` is desktop
     *  only via `window.require`, kept off esbuild's static path; deviceMemory
     *  and performance.memory are absent on iOS WebKit). Missing fields are
     *  simply omitted from the export. */
    private collectDeviceInfo(): DeviceInfo {
        const d: DeviceInfo = {};
        try {
            if (typeof navigator !== "undefined") {
                if (typeof navigator.hardwareConcurrency === "number") {
                    d.cpuCores = navigator.hardwareConcurrency;
                }
                if (navigator.userAgent) d.userAgent = navigator.userAgent;
                const dm = (navigator as any).deviceMemory;
                if (typeof dm === "number") d.deviceMemoryGb = dm;
            }
        } catch { /* best effort */ }
        try {
            const pm = typeof performance !== "undefined" ? (performance as any).memory : undefined;
            if (pm) {
                if (typeof pm.usedJSHeapSize === "number") {
                    d.jsHeapUsedMb = Math.round(pm.usedJSHeapSize / 1048576);
                }
                if (typeof pm.jsHeapSizeLimit === "number") {
                    d.jsHeapLimitMb = Math.round(pm.jsHeapSizeLimit / 1048576);
                }
            }
        } catch { /* best effort */ }
        try {
            // Desktop (Electron) only. `window.require` keeps the node builtin
            // off esbuild's browser-target static analysis; undefined on mobile.
            const req = typeof window !== "undefined" ? (window as any).require : undefined;
            if (typeof req === "function") {
                const os = req("os");
                d.arch = os.arch();
                d.osRelease = os.release();
                const cpus = os.cpus();
                if (cpus?.length) {
                    d.cpuCores = cpus.length;
                    const model = (cpus[0]?.model ?? "").trim();
                    if (model) d.cpuModel = model;
                }
                d.totalRamGb = Math.round((os.totalmem() / 1073741824) * 10) / 10;
                d.freeRamGb = Math.round((os.freemem() / 1073741824) * 10) / 10;
            }
        } catch { /* best effort */ }
        return d;
    }

    /**
     * The single, supervised encryption-agreement gate (#1c). Passed to
     * SyncEngine as `preCatchupCheck`, so it runs inside openSession before
     * catchup — and crucially, under the engine's retry supervision.
     *
     * Outcomes:
     *   - agreed-encrypted/plaintext → unlock the vault crypto provider
     *     (once; cached in `vaultCryptoProvider`), ratchet the cipher floor,
     *     reconcile the compression flag. Returns normally → catchup proceeds.
     *   - transient network/abort while checking → throws the raw error,
     *     which openSession routes to `enterError` → retry-backoff. The
     *     network's return auto-recovers it (this is the #1 fix: the old
     *     onload gate dead-`return`ed here and never retried).
     *   - user-actionable state (server downgrade, cross-device mismatch,
     *     pre-v2 legacy meta, wrong passphrase) → `encryptionPause()` sets
     *     connectionState back to "tested" and throws an `encryptionPaused`
     *     error → terminal kind (no retry), surfaced once by the host.
     */
    private async reconcileEncryptionAgreement(_signal: AbortSignal): Promise<void> {
        const raw = makeCouchClient(
            this.settings.couchdbUri, this.settings.couchdbDbName,
            this.settings.couchdbUser, this.settings.couchdbPassword,
        );
        const agreement = await checkEncryptionAgreement(
            raw, this.settings.encryptionEnabled,
            VAULT_META_DOC_ID, this.settings.vaultCipherVersion,
        );

        if (agreement.status === "cipher-downgrade-detected") {
            this.encryptionMismatch = agreement;
            throw await this.encryptionPause(
                "CouchSync: vault encryption was downgraded on the server " +
                `(cipherVersion below this device's floor ${agreement.localFloor}). ` +
                "Sync paused — verify the server has not been tampered with.",
            );
        }

        if (agreement.status === "agreed-encrypted") {
            if (!this.vaultCryptoProvider) {
                let passphrase = this.settings.encryptionPassphrase;
                if (!passphrase) {
                    const modal = new PassphraseModal(this.app, false);
                    passphrase = await modal.waitForResult() ?? "";
                    if (!passphrase) {
                        throw await this.encryptionPause(
                            "CouchSync: passphrase required. Sync paused.",
                        );
                    }
                }
                const result = await unlockVaultMeta(agreement.meta as VaultMetaDoc, passphrase);
                if (!result) {
                    this.settings.encryptionPassphrase = "";
                    await this.saveSettings();
                    throw await this.encryptionPause(
                        "CouchSync: wrong passphrase. Sync paused.",
                    );
                }
                if (!this.settings.encryptionPassphrase) {
                    this.settings.encryptionPassphrase = passphrase;
                    await this.saveSettings();
                }
                this.vaultCryptoProvider = result.crypto;
                // TOFU: anchor / ratchet the local cipherVersion floor.
                const cv = agreement.meta.encryption.enabled
                    ? agreement.meta.encryption.cipherVersion : 0;
                if (this.ratchetVaultCipherFloor(cv)) await this.saveSettings();
                // wrapVaultClient picks up the new provider on next invocation.
            }
        } else if (agreement.status === "remote-encrypted"
            || agreement.status === "remote-plaintext") {
            this.encryptionMismatch = agreement;
            throw await this.encryptionPause(
                "CouchSync: encryption state changed by another device. " +
                "Open Settings → Vault Sync to re-run Init or Clone.",
            );
        } else if (agreement.status === "legacy-meta-only") {
            // Pre-v2 `encryption:meta` doc found but no v2 `vault:meta`.
            throw await this.encryptionPause(
                "CouchSync: this vault was set up with a pre-v2 build. " +
                "Open Settings → Vault Sync and re-run Init or Clone to migrate.",
            );
        }

        // Compression flag is server-of-record — reconcile so the decorator
        // stack is identical across devices.
        const remoteMeta = (agreement.status === "agreed-encrypted"
            || agreement.status === "agreed-plaintext") ? agreement.meta : null;
        if (remoteMeta
            && this.settings.compressionEnabled !== remoteMeta.compression.enabled) {
            this.settings.compressionEnabled = remoteMeta.compression.enabled;
            await this.saveSettings();
        }
        if (agreement.status === "agreed-encrypted" || agreement.status === "agreed-plaintext") {
            this.encryptionMismatch = undefined;
        }
    }

    /** Pause sync for a user-actionable encryption state: persist the
     *  "tested" connectionState (so the next onload won't auto-sync and the
     *  settings tab shows the re-Init affordance) and return a terminal
     *  `encryptionPaused` error for the caller to throw. The host toasts the
     *  message once via the "error" event (#1d). */
    private async encryptionPause(message: string): Promise<Error> {
        this.settings.connectionState = "tested";
        await this.saveSettings();
        return Object.assign(new Error(message), { encryptionPaused: true });
    }

    /** Config-DB equivalent of `ratchetVaultCipherFloor`. Public so the
     *  settings tab can ratchet the floor right after an encrypted Config
     *  Init (#config-codec); caller persists via saveSettings on a true return. */
    ratchetConfigCipherFloor(observed: number): boolean {
        if (observed > (this.settings.configCipherVersion ?? 0)) {
            this.settings.configCipherVersion = observed;
            return true;
        }
        return false;
    }

    /**
     * Wrap a raw CouchClient with the config-DB decorator stack. Mirror
     * of `wrapVaultClient` but reads `configCryptoProvider` and the
     * config-specific compression flag (`configCompressionEnabled` falls
     * back to `compressionEnabled` when undefined — Phase 3 will surface
     * an independent UI toggle).
     */
    private wrapConfigClient = (raw: CouchClient): ICouchClient => {
        // Policy-gated codec stack, symmetric with wrapVaultClient (#12).
        // The encryption POLICY (`codec.encryption`) gates whether the encrypt
        // layer is applied — not the provider's existence. Mirrors the
        // compression branch below (`if (codec.compression)`).
        const codec = resolveConfigCodec(this.settings);
        let client: ICouchClient = raw;
        if (codec.encryption) {
            if (!this.configCryptoProvider) {
                throw new Error(
                    "CouchSync: refusing to build config client — config DB is " +
                        "encrypted but no crypto provider is unlocked (provisioning " +
                        "incomplete). Re-run Config Init or unlock the vault.",
                );
            }
            client = new EncryptingCouchClient(
                client, this.configCryptoProvider, this.settings.configCipherVersion,
            );
        }
        if (codec.compression) {
            client = new CompressingCouchClient(client);
        }
        return client;
    };

    async onload(): Promise<void> {
        await this.loadSettings();

        // Install-marker check (advisory only — does NOT regenerate deviceId).
        {
            const result = checkInstallMarker({
                lastInstallMarker: this.settings.lastInstallMarker,
                storage: {
                    get: (k) => window.localStorage.getItem(k),
                    set: (k, v) => window.localStorage.setItem(k, v),
                },
                generateUuid: () => crypto.randomUUID(),
            });
            if (result.markerMismatch) {
                notify(
                    "CouchSync: this vault may have been copied from another installation. " +
                        "Please verify your device name in Settings → Vault Sync.",
                    10000,
                );
            }
            this.settings.lastInstallMarker = result.nextInstallMarker;
            await this.saveSettings();
        }

        const vaultName = this.app.vault.getName();
        const dbName = `couchsync-${vaultName}`;
        this.localDb = new LocalDB(dbName);
        this.localDb.open();
        await this.localDb.ensureSchemaVersion();

        // Open the config-side local store only when the user has set
        // a config DB name. The local store is keyed by both vault name
        // and config DB name so switching device pools (e.g. mobile ↔
        // desktop) creates a fresh local store rather than mixing.
        if (this.settings.couchdbConfigDbName) {
            const configLocalName =
                `couchsync-${vaultName}-config-${this.settings.couchdbConfigDbName}`;
            this.configLocalDb = new ConfigLocalDB(configLocalName);
            this.configLocalDb.open();
            await this.configLocalDb.ensureSchemaVersion();
        }

        initLog(
            () => this.settings,
            (msg, dur) => new Notice(`CouchSync: ${msg}`, dur),
        );
        const vaultIO = new ObsidianVaultIO(this.app);
        const adapterIO = new ObsidianAdapterIO(this.app);
        const vaultEvents = new ObsidianVaultEvents(this.app);
        this.modalPresenter = new ObsidianModalPresenter(this.app);
        const modalPresenter = this.modalPresenter;

        this.auth = new AuthGate();
        // ChunkHasher: bundles the hash function with its own algorithm
        // identity so the chunk id is stamped with the truly-used tag
        // (`chunk:x64:<xxhash>` vs `chunk:hmac:<HMAC>`). Phase 2 splits
        // this into two — vault and config each read their own
        // cryptoProvider live via closure, so encryption-state changes
        // propagate without rebuilding the hasher and the two DBs mint
        // chunk ids in disjoint id spaces (invariant 18). Constructed here
        // (before remoteOps) because VaultRemoteOps.pullAll now verifies
        // pulled chunks with it — the authenticated Clone fetch boundary.
        //
        // Outer `this` is captured via local alias because the object
        // literal's own `this` would refer to itself (not the plugin).
        const plugin = this;
        const vaultChunkHasher: ChunkHasher = {
            get alg(): ChunkHashAlg {
                return plugin.settings.encryptionEnabled && plugin.vaultCryptoProvider ? "hmac" : "x64";
            },
            hash: (data) => plugin.settings.encryptionEnabled && plugin.vaultCryptoProvider
                ? plugin.vaultCryptoProvider.hmacHash(data)
                : computeHash(data),
        };
        const configChunkHasher: ChunkHasher = {
            get alg(): ChunkHashAlg {
                return resolveConfigCodec(plugin.settings).encryption && plugin.configCryptoProvider
                    ? "hmac" : "x64";
            },
            hash: (data) => resolveConfigCodec(plugin.settings).encryption && plugin.configCryptoProvider
                ? plugin.configCryptoProvider.hmacHash(data)
                : computeHash(data),
        };
        this.remoteOps = new VaultRemoteOps(
            this.localDb, () => this.settings, this.auth, this.wrapVaultClient,
            vaultChunkHasher,
        );
        this.historyStorage = new HistoryStorage(this.app.vault.getName());
        await this.historyStorage.ensureSchemaVersion();
        this.historyCapture = new HistoryCapture(vaultIO, vaultEvents, this.historyStorage, () => this.settings);

        // Editor-aware write layer: defers vault writes while the
        // path's editor is in IME composition, dispatches CodeMirror
        // transactions instead of triggering Obsidian's external-edit
        // reload (which would break IME), and falls back to disk
        // write when no editor session exists.
        this.compositionTracker = new ObsidianCompositionTracker(this.app);
        this.compositionGate = new CompositionGate(this.compositionTracker);
        this.vaultWriter = new EditorAwareVaultWriter(
            this.app, vaultIO, this.compositionGate,
            null, this.historyCapture,
        );
        this.vaultSync = new VaultSync(vaultIO, this.localDb, () => this.settings, this.vaultWriter, vaultChunkHasher);
        this.changeTracker = new ChangeTracker(vaultEvents, this.vaultSync, () => this.settings);
        // Late-bind the writeIgnore once ChangeTracker exists. It is
        // used by VaultWriter only on the deletion path (the modify
        // path now relies on chunksEqual idempotency in fileToDb).
        this.vaultWriter.setWriteIgnore(this.changeTracker);
        // Late-bind the pending-edit probe (invariant 4). VaultSync uses
        // it from `hasUnpushedChanges` to detect debounced user edits
        // before applying a remote deletion.
        this.vaultSync.setPendingProbe(this.changeTracker);
        // SyncEngine constructed AFTER vaultSync so the pull-writer can
        // call vaultSync.dbToFile directly via constructor DI (replaces
        // the former events.onAsync("pull-write", ...) bus, whose catch-
        // all swallowed write errors and let `Pull: N written` lie).
        const encClientFactory: (s: CouchSyncSettings) => ICouchClient = (s) =>
            this.wrapVaultClient(
                makeCouchClient(s.couchdbUri, s.couchdbDbName, s.couchdbUser, s.couchdbPassword),
            );
        this.replicator = new SyncEngine(
            this.localDb,
            () => this.settings,
            (doc) => this.vaultSync.dbToFile(doc),
            (path) => this.vaultSync.hasUnpushedChanges(path),
            Platform.isMobile,
            this.auth,
            encClientFactory,
            (signal) => this.reconcileEncryptionAgreement(signal),
        );
        // Verify pulled chunk bodies hash to their content-addressed id
        // (the inverse of the mint in splitIntoChunks). Reads the live
        // crypto provider, so encryption-state changes propagate.
        this.replicator.setChunkHasher(vaultChunkHasher);
        const reconnectBridge: ReconnectBridge = {
            notifyTransient: () => {
                // Fire-and-forget: ConfigSync surfaces the original error to
                // the user via ProgressNotice/log; this only nudges the
                // vault session to verify reachability if it itself is
                // unhealthy. decideReconnect skips when vault is healthy.
                this.replicator.requestReconnect("config-failure").catch((e: any) =>
                    logError(`CouchSync: config-failure reconnect failed: ${e?.message ?? e}`),
                );
            },
        };
        const encConfigClientFactory = (s: CouchSyncSettings): ICouchClient | null => {
            if (!s.couchdbConfigDbName) return null;
            return this.wrapConfigClient(
                makeCouchClient(s.couchdbUri, s.couchdbConfigDbName, s.couchdbUser, s.couchdbPassword),
            );
        };
        this.configSync = new ConfigSync(
            adapterIO,
            modalPresenter,
            this.configLocalDb,
            this.auth,
            this.replicator.getVisibilityGate(),
            reconnectBridge,
            () => this.settings,
            {
                clientFactory: encConfigClientFactory,
                hasher: configChunkHasher,
                // Phase 2: hand a freshly-derived config CryptoProvider back
                // so subsequent `wrapConfigClient` calls produce the right
                // encrypting stack. Null = encryption disabled on config.
                onConfigCryptoChange: (crypto) => {
                    this.configCryptoProvider = crypto ?? undefined;
                },
                // Real own-data.json path so ConfigSync excludes it from
                // replication even under a renamed plugin folder (#14).
                // manifest.dir is the actual install dir; fall back to the
                // configDir + id composition.
                ownDataJsonPath: this.manifest.dir
                    ? `${this.manifest.dir}/data.json`
                    : `${this.app.vault.configDir}/plugins/${this.manifest.id}/data.json`,
                // Receive-side platform gate: don't materialise desktop-only
                // plugins on a mobile device. Mirrors the getPlatform wiring.
                getIsMobile: () => Platform.isMobile,
                persistConfigSettingUp: async (active) => {
                    this.settings.configSettingUp = active;
                    await this.saveSettings();
                },
                persistConfigCodecApplied: async (fingerprint) => {
                    this.settings.configCodecApplied = fingerprint;
                    await this.saveSettings();
                },
            },
        );
        this.statusBar = new StatusBar(
            this,
            () => this.settings,
            () => this.replicator.getLastHealthyAt(),
            () => this.replicator.getLastErrorDetail(),
        );
        this.replicator.events.on("state-change", ({ state }) => this.statusBar.update(state));
        // Single notify authority (#1d). Only user-actionable errors warrant
        // a Notice; transient kinds (network / timeout / aborted / server /
        // not-found) auto-recover and are shown via the status bar alone —
        // toasting every blip was the spurious resume-notification noise
        // (#6). encryption-paused additionally re-runs the onload reconcile,
        // preserving the local-state pass the old onload gate did on pause.
        this.replicator.events.on("error", ({ message, kind }) => {
            const userActionable =
                kind === "auth" || kind === "schema-mismatch" || kind === "encryption-paused";
            if (userActionable) {
                notify(message, kind === "auth" ? 8000 : 15000);
            }
            if (kind === "encryption-paused") {
                this.fireReconcile("onload");
            }
        });
        // Local DB handle is poisoned (typically iOS WebKit IDB after a
        // long suspend — only a page reload reseats the IDB connection).
        // Surface a sticky Notice with a "Reload now" button that fires
        // `app:reload`; emitted at most once per SyncEngine lifecycle.
        this.replicator.events.on("degraded", ({ message }) => {
            const notice = new Notice(`${message} Tap "Reload now" to recover.`, 0);
            const btn = notice.noticeEl.createEl("button", {
                text: "Reload now",
                cls: "mod-cta",
            });
            btn.style.marginLeft = "8px";
            btn.addEventListener("click", () => {
                notice.hide();
                (this.app as any).commands.executeCommandById("app:reload");
            });
        });
        this.reconciler = new Reconciler(
            vaultIO,
            this.localDb,
            this.vaultSync,
            () => this.settings,
            (msg) => notify(msg),
            (doc) => this.replicator.ensureFileChunks(doc),
        );
        this.setupService = new SetupService(
            vaultIO, this.localDb, this.remoteOps, this.vaultSync, this.reconciler,
        );
        this.historyManager = new HistoryManager(
            vaultIO, this.historyStorage, this.historyCapture, () => this.settings,
        );
        this.logStorage = new LogStorage(vaultName);
        await this.logStorage.ensureSchemaVersion();
        this.logManager = new LogManager({
            storage: this.logStorage,
            getSettings: () => this.settings,
            getPluginVersion: () => this.manifest.version,
            getObsidianVersion: () => apiVersion,
            getPlatform: () => ({
                os: this.deriveOsLabel(),
                isMobile: Platform.isMobile,
            }),
            getDeviceInfo: () => this.collectDeviceInfo(),
            getSyncDiagnostics: () => {
                const snap = this.replicator.getDiagnosticsSnapshot();
                return {
                    state: snap.state,
                    connectionState: this.settings.connectionState,
                    lastPushedSeq: typeof snap.lastPushedSeq === "number" ? snap.lastPushedSeq : undefined,
                    remoteSeq: typeof snap.remoteSeq === "string" ? snap.remoteSeq : String(snap.remoteSeq),
                };
            },
            vault: vaultIO,
            doc: typeof document !== "undefined" ? document : undefined,
            win: typeof window !== "undefined" ? window : undefined,
        });
        this.conflictOrchestrator = new ConflictOrchestrator({
            modal: modalPresenter,
            localDb: this.localDb,
            replicator: this.replicator,
            historyCapture: this.historyCapture,
            dbToFile: (doc) => this.vaultSync.dbToFile(doc),
            getSettings: () => this.settings,
            vault: vaultIO,
            vaultSync: this.vaultSync,
        });
        this.conflictOrchestrator.register();
        this.reconciler.setConflictOrchestrator(this.conflictOrchestrator);

        // Pull-driven deletions are handled entirely inside the pull-writer
        // now (#del-1): the unpushed-edit probe is the `probeUnpushed` DI wired
        // into SyncEngine below, and the deletion is applied through the same
        // durable accepted→pending-deletion→drain path as a soft-delete rather
        // than the former tx-external applyRemoteDeletion in this handler.

        // Reconcile AFTER catchup completes — never concurrent with pull.
        // This ordering guarantees reconcile sees the latest DB state.
        this.replicator.events.on("catchup-complete", () => this.fireReconcile("onload"));
        this.replicator.events.on("catchup-failed", () => this.fireReconcile("onload"));

        // Pull-write skip leaves LocalDB ahead of vault for N files.
        // Without this trigger, idle longpoll persists divergent state
        // until the next visibility/reconnect cycle. Fire reconcile so
        // dbToFile retries on the next pass — typically resolves the
        // divergence within seconds rather than hours.
        this.replicator.events.on("pull-skipped", () => this.fireReconcile("paused"));

        // Run orphan-chunk GC once after the first idle (catchup done,
        // no pending pull/push). Cleans up chunks left by pre-v0.15
        // non-atomic writes and stale content changes.
        this.replicator.events.onceIdle(() => {
            gcOrphanChunks(this.localDb).catch((e) =>
                logError(`Chunk GC failed: ${e?.message ?? e}`),
            );
        });

        this.addSettingTab(new CouchSyncSettingTab(this.app, this));

        this.registerView(VIEW_TYPE_DIFF_HISTORY, (leaf) => new DiffHistoryView(leaf, this));
        this.registerView(VIEW_TYPE_LOG, (leaf) => new LogView(leaf));

        this.addRibbonIcon("history", "Diff History", () => {
            this.activateHistoryView();
        });

        registerCommands(this);

        this.app.workspace.onLayoutReady(async () => {
            this.historyCapture.setOnDiffSaved((filePath) => {
                (this.app.workspace as any).trigger("couchsync:diff-saved", filePath);
            });
            this.historyCapture.start();
            this.historyManager.startCleanup();
            this.logManager.start();
            // Startup declaration — first persisted line of every session's log.
            // Pins exactly which build is running (version, build time, commit)
            // so a field report's log self-identifies. Logged right after
            // logManager.start() so it lands in the persistent buffer. typeof
            // guards keep it safe in the test runtime (build-time defines absent).
            {
                const built = typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "unknown";
                const commit = typeof __COMMIT_HASH__ !== "undefined" ? __COMMIT_HASH__ : "unknown";
                logInfo(`CouchSync v${this.manifest.version} starting — built ${built}, commit ${commit}`);
            }
            this.compositionTracker.start();
            this.compositionGate.start();

            // One-time notice after the legacy configSyncPaths → configSyncPolicy
            // migration. Surfaces the safe-side behaviour change (plugin code is
            // no longer synced) so it isn't silent. Cleared immediately so it
            // shows once.
            if (this.settings.configSyncPolicyMigrated) {
                this.settings.configSyncPolicyMigrated = false;
                await this.saveSettings();
                new Notice(
                    "CouchSync: Config sync filtering was upgraded to a " +
                    "meaning-based model. Plugin executable code is no longer " +
                    "synced by default (safety). Review Settings → Config Sync.",
                    12000,
                );
            }

            // E2E encryption: derive **both** cryptoProviders FIRST,
            // before the legacy guard. The recovery action the legacy
            // guard tells the user to perform (Config Init / Vault Init)
            // needs the chunk hasher to flip to HMAC mode — which only
            // happens once `*CryptoProvider` is set. Without this
            // early-derive, a user in legacy-blocked state who clicks
            // "Config Init" would unknowingly mint x64 (plaintext)
            // chunk ids on an otherwise-encrypted vault.
            //
            // Phase 2: vault and config are independent crypto principals
            // (invariant 18). Each meta is unlocked against its own
            // passphrase source — vault uses `encryptionPassphrase`;
            // config uses `configEncryptionPassphrase || encryptionPassphrase` (empty = inherit)
            // so the common "one passphrase for both" UX stays default
            // while advanced users can decouple. Errors here fall through
            // — the legacy guard runs anyway, the user just stays in a
            // crypto-uninitialised state until they retry.
            if (this.settings.connectionState === "syncing"
                && this.settings.deviceId) {
                try {
                    const rawClient = makeCouchClient(
                        this.settings.couchdbUri,
                        this.settings.couchdbDbName,
                        this.settings.couchdbUser,
                        this.settings.couchdbPassword,
                    );
                    const agreement = await checkEncryptionAgreement(
                        rawClient, this.settings.encryptionEnabled,
                        VAULT_META_DOC_ID, this.settings.vaultCipherVersion,
                    );
                    if (agreement.status === "cipher-downgrade-detected") {
                        logWarn(
                            `CouchSync: vault:meta cipherVersion downgrade detected ` +
                            `(below floor ${agreement.localFloor}) — refusing early unlock.`,
                        );
                        this.encryptionMismatch = agreement;
                    } else if (agreement.status === "agreed-encrypted"
                        && !this.vaultCryptoProvider
                        && this.settings.encryptionPassphrase
                        && agreement.meta && (agreement.meta as VaultMetaDoc).type === "vault-meta") {
                        const result = await unlockVaultMeta(
                            agreement.meta as VaultMetaDoc, this.settings.encryptionPassphrase,
                        );
                        if (result) {
                            this.vaultCryptoProvider = result.crypto;
                            // TOFU: anchor / ratchet the local cipherVersion floor.
                            const cv = agreement.meta.encryption.enabled
                                ? agreement.meta.encryption.cipherVersion : 0;
                            if (this.ratchetVaultCipherFloor(cv)) await this.saveSettings();
                        }
                    }
                } catch (e: any) {
                    logWarn(
                        `CouchSync: early vault crypto derivation failed (non-fatal): ${e?.message ?? e}`,
                    );
                }
                // Config-side early derive — independent of vault.
                if (this.settings.couchdbConfigDbName) {
                    try {
                        const rawConfigClient = makeCouchClient(
                            this.settings.couchdbUri,
                            this.settings.couchdbConfigDbName,
                            this.settings.couchdbUser,
                            this.settings.couchdbPassword,
                        );
                        // Independent config codec — the single resolver applies
                        // the per-field inherit rules (empty passphrase inherits
                        // the vault one via ||, see config-codec-policy). (#config-codec)
                        const configCodec = resolveConfigCodec(this.settings);
                        const configPassphrase = configCodec.passphrase;
                        const agreement = await checkEncryptionAgreement(
                            rawConfigClient, configCodec.encryption, CONFIG_META_DOC_ID,
                            this.settings.configCipherVersion,
                        );
                        if (agreement.status === "cipher-downgrade-detected") {
                            logWarn(
                                `CouchSync: config:meta cipherVersion downgrade detected ` +
                                `(below floor ${agreement.localFloor}) — refusing early unlock.`,
                            );
                            this.configEncryptionMismatch = agreement;
                        } else if (agreement.status === "agreed-encrypted"
                            && !this.configCryptoProvider
                            && configPassphrase
                            && agreement.meta && agreement.meta.type === "config-meta") {
                            const configMeta = agreement.meta as ConfigMetaDoc;
                            // Phase 2 migration guard: the Phase 1
                            // in-progress config:meta (schemaVersion: 1)
                            // was a clone of vault:meta — not a real
                            // crypto root. Reject it loudly so the user
                            // re-runs Config Init and gets a Phase 2
                            // self-contained meta.
                            if (configMeta.schemaVersion !== 2) {
                                notify(
                                    `CouchSync: Config DB has legacy meta ` +
                                    `(schemaVersion ${configMeta.schemaVersion}). ` +
                                    `Open Settings → Config Sync → Init & Push to upgrade.`,
                                    15000,
                                );
                                logWarn(
                                    `CouchSync: config:meta schemaVersion ${configMeta.schemaVersion} — Phase 2 expects 2. Re-Init required.`,
                                );
                            } else {
                                const result = await unlockConfigMeta(
                                    configMeta, configPassphrase,
                                );
                                if (result) {
                                    this.configCryptoProvider = result.crypto;
                                    const cv = configMeta.encryption.enabled
                                        ? configMeta.encryption.cipherVersion : 0;
                                    if (this.ratchetConfigCipherFloor(cv)) {
                                        await this.saveSettings();
                                    }
                                } else {
                                    logWarn(
                                        "CouchSync: config:meta unlock failed — passphrase mismatch. " +
                                        "Re-run Config Init to recover.",
                                    );
                                }
                            }
                        } else if (
                            agreement.status === "remote-encrypted"
                            || agreement.status === "remote-plaintext"
                        ) {
                            this.configEncryptionMismatch = agreement;
                        }
                    } catch (e: any) {
                        logWarn(
                            `CouchSync: early config crypto derivation failed (non-fatal): ${e?.message ?? e}`,
                        );
                    }
                }
            }

            // Schema guard. Two checks:
            //
            //   1. The vault DB must NOT contain bare-path docs, missing
            //      vclock FileDocs, or `config:*` orphans (the latter
            //      indicates a pre-v0.11.0 DB where configs lived in
            //      the vault store and need migration).
            //   2. The config DB (if configured) must NOT contain
            //      non-config docs or vclock-less ConfigDocs.
            //
            // If either check fails we block replicator.start() and tell
            // the user to use the Maintenance tab to migrate / rebuild.
            try {
                const vaultLegacy = await this.localDb.findLegacyVaultDoc();
                if (vaultLegacy) {
                    const isConfigOrphan = vaultLegacy.startsWith("config:");
                    const message = isConfigOrphan
                        ? `CouchSync: legacy config doc found in vault DB (${vaultLegacy}). ` +
                            "Open Settings → Maintenance → Clean up legacy configs from vault DB " +
                            "after running Config Init in Config Sync. Sync is paused until then."
                        : `CouchSync: old schema detected in vault DB (${vaultLegacy}). ` +
                            "Open Settings → Maintenance → Delete local vault database, " +
                            "then re-run Init or Clone. Sync is paused until then.";
                    notify(message, 15000);
                    logWarn(
                        `CouchSync: blocking replicator.start() — legacy vault doc: ${vaultLegacy}`,
                    );
                    this.fireReconcile("onload");
                    return;
                }

                if (this.configLocalDb) {
                    const configLegacy = await this.configLocalDb.findLegacyConfigDoc();
                    if (configLegacy) {
                        notify(
                            `CouchSync: old schema detected in config DB (${configLegacy}). ` +
                                "Open Settings → Maintenance → Delete local config database, " +
                                "then re-run Config Init or Pull. Sync is paused until then.",
                            15000,
                        );
                        logWarn(
                            `CouchSync: blocking replicator.start() — legacy config doc: ${configLegacy}`,
                        );
                        this.fireReconcile("onload");
                        return;
                    }
                }
            } catch (e) {
                logError(`CouchSync: schema guard probe failed: ${e?.message ?? e}`);
            }

            if (!this.settings.deviceId) {
                notify(
                    "CouchSync: Please set a device name (Settings → Vault Sync). " +
                        "Sync will not start until a device name is configured.",
                    15000,
                );
            } else if (this.isLegacyDeviceId(this.settings.deviceId)) {
                notify(
                    "CouchSync: Please set a device name (Settings → Vault Sync). " +
                        "Currently using an auto-generated ID.",
                    10000,
                );
            }

            // E2E encryption agreement + passphrase unlock now runs inside the
            // SyncEngine session as the supervised preCatchupCheck
            // (`reconcileEncryptionAgreement`), NOT as an unsupervised onload
            // gate. The old gate's catch `return`ed on a transient fetch
            // failure and left sync permanently dead until a manual reload
            // (#1). Funnelling the single gate through openSession means a
            // network blip now throws into the retry loop and auto-recovers
            // when the network returns; user-actionable states pause via the
            // encryption-paused terminal kind. So onload just starts the
            // engine — start() → openSession → preCatchupCheck does the rest.

            // Load vclock cache BEFORE reconciler or changeTracker run.
            // Without this, compareFileToDoc() misclassifies local edits
            // as "remote-pending" and overwrites them with stale DB content.
            await this.vaultSync.loadLastSyncedVclocks();

            if (this.settings.connectionState === "syncing" && this.settings.deviceId) {
                this.replicator.start();
                this.changeTracker.start();
                // Reconcile fires via onCatchupComplete/onCatchupFailed.
            } else {
                // Sync disabled: no catchup, reconcile directly.
                this.fireReconcile("onload");
            }
        });

    }

    async onunload(): Promise<void> {
        this.changeTracker?.stop();
        this.historyCapture?.stop();
        this.historyManager?.stopCleanup();
        this.logManager?.stop();
        this.vaultWriter?.flushAll();
        this.compositionGate?.stop();
        this.compositionTracker?.stop();
        this.replicator?.stop();
        await this.vaultSync?.teardown();
        // Latch disposal, then drain any in-flight reconcile BEFORE closing
        // localDb — otherwise a mid-flight vclock-adopt/restore writes through
        // a torn-down handle (DatabaseClosedError). destroy() stops new runs;
        // settle() waits for the current one.
        this.reconciler?.destroy();
        await this.reconciler?.settle();
        this.statusBar?.destroy();
        this.historyStorage?.close();
        this.logStorage?.close();
        await this.localDb?.close();
        if (this.configLocalDb) {
            try {
                await this.configLocalDb.close();
            } catch (e) {
                logError(`CouchSync: failed to close config local DB: ${e?.message ?? e}`);
            }
            this.configLocalDb = null;
        }
    }

    async loadSettings(): Promise<void> {
        const data = (await this.loadData()) ?? {};
        migrateSettings(data);
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    /** True if the deviceId looks like an auto-generated UUID (pre-v0.12). */
    isLegacyDeviceId(id: string): boolean {
        return /^[0-9a-f]{8}-/.test(id);
    }

    async initVault(): Promise<void> {
        this.replicator.stop();
        this.changeTracker.stop();
        // Invariant C: drop to a non-syncable state and persist it BEFORE
        // setupService.init destroys the local DB. A failure (or a crash)
        // mid-init then leaves "settingUp", never the prior setupDone/
        // syncing — so the user can't start sync on a half-built DB.
        this.settings.connectionState = "settingUp";
        await this.saveSettings();
        const progress = new ProgressNotice("Init");
        try {
            const enc = this.settings.encryptionEnabled;
            const compress = this.settings.compressionEnabled;

            if (enc && !this.settings.encryptionPassphrase) {
                throw new Error("Encryption is enabled but no passphrase set. Enter a passphrase in Step 1.");
            }

            let meta: VaultMetaDoc;

            if (enc && this.vaultCryptoProvider) {
                // Re-init with existing keys: preserve salt + keyCheck
                // so other devices can still decrypt with the same
                // passphrase. Compression flag may change between inits.
                const rawClient = makeCouchClient(
                    this.settings.couchdbUri, this.settings.couchdbDbName,
                    this.settings.couchdbUser, this.settings.couchdbPassword,
                );
                const existing = await fetchVaultMeta(rawClient);
                if (!existing || !existing.encryption.enabled) {
                    throw new Error("vault:meta with encryption not found on remote");
                }
                meta = {
                    ...existing,
                    // Preserve salt + keyCheck (same passphrase still unlocks),
                    // but stamp the current cipher format: a re-init on a build
                    // that writes encBody bodies produces a cipherVersion-3 vault
                    // (#2). Without this the marker would wrongly stay at the
                    // value the vault was first created with.
                    encryption: { ...existing.encryption, cipherVersion: 3 },
                    compression: compress
                        ? { enabled: true, algorithm: "gzip", version: 1 }
                        : { enabled: false },
                };
            } else {
                progress.update(enc ? "Deriving encryption keys..." : "Preparing vault metadata...");
                const derived = await buildInitialVaultMeta({
                    encryption: enc,
                    passphrase: enc ? this.settings.encryptionPassphrase : undefined,
                    compression: compress,
                });
                meta = derived.meta;
                this.vaultCryptoProvider = derived.crypto ?? undefined;
            }

            const result = await this.setupService.init((msg) => progress.update(msg));

            progress.update("Writing vault metadata...");
            await pushVaultMeta(this.remoteOps.makeClient(), meta);

            if (!enc) {
                this.settings.encryptionPassphrase = "";
            }
            this.settings.connectionState = "setupDone";
            this.encryptionMismatch = undefined;
            // TOFU: anchor the local cipherVersion floor to the just-written
            // meta (re-init stamps 3; fresh encrypted init also mints v3).
            if (meta.encryption.enabled) {
                this.ratchetVaultCipherFloor(meta.encryption.cipherVersion);
            }
            await this.saveSettings();
            const modes: string[] = [];
            if (enc) modes.push("encrypted");
            if (compress) modes.push("compressed");
            const tag = modes.length ? ` (${modes.join(", ")})` : "";
            progress.done(`Init complete! ${result.vaultFiles} files, ${result.totalDocs} docs pushed${tag}.`);
        } catch (e: any) {
            if (this.settings.encryptionEnabled) {
                this.vaultCryptoProvider = undefined;
            }
            progress.fail(`Init failed: ${e?.message ?? e}`);
            throw e;
        }
    }

    async cloneFromRemote(): Promise<void> {
        const rawClient = makeCouchClient(
            this.settings.couchdbUri, this.settings.couchdbDbName,
            this.settings.couchdbUser, this.settings.couchdbPassword,
        );
        const meta = await fetchVaultMeta(rawClient);

        // Invariant C: Clone is a transaction. We derive the remote's codec
        // config into IN-MEMORY state only (vaultCryptoProvider for
        // encryption, compressionOverride for compression) so the pull can
        // decrypt/decompress, but we DO NOT touch persisted settings until
        // the clone succeeds. The target values to persist on success are
        // computed up front and held locally.
        let targetEncryptionEnabled: boolean;
        let targetPassphrase: string;
        // Clone re-anchors the cipherVersion floor to the vault being adopted
        // (set, NOT ratchet): a device re-cloning a legitimately-v2 vault must
        // not inherit a stale v3 floor from a previously-cloned vault.
        // `undefined` for a plaintext clone (no floor). This is the TOFU
        // first-sight anchor — clone has the passphrase-holder present.
        let targetCipherVersion: number | undefined;
        if (meta && meta.encryption.enabled) {
            let passphrase = this.settings.encryptionPassphrase;
            if (!passphrase) {
                const modal = new PassphraseModal(this.app, false);
                passphrase = await modal.waitForResult() ?? "";
                if (!passphrase) {
                    throw new Error("Passphrase required to clone encrypted vault.");
                }
            }
            const unlockResult = await unlockVaultMeta(meta, passphrase);
            if (!unlockResult) throw new Error("Wrong passphrase.");

            this.vaultCryptoProvider = unlockResult.crypto;
            targetEncryptionEnabled = true;
            targetPassphrase = passphrase;
            targetCipherVersion = meta.encryption.cipherVersion;
        } else {
            this.vaultCryptoProvider = undefined;
            targetEncryptionEnabled = false;
            targetPassphrase = "";
            targetCipherVersion = undefined;
        }

        // Clone-side: the server's compression flag wins. Apply it as an
        // in-memory override so the decorator stack uses it during the
        // pull; the persisted `compressionEnabled` is written only on
        // success (below), keeping the setting atomic with the rest.
        const targetCompression = meta
            ? meta.compression.enabled
            : this.settings.compressionEnabled;
        this.compressionOverride = targetCompression;
        // Same in-memory-during-clone treatment for the cipherVersion floor:
        // the pull decrypts under the remote's declared cipherVersion before
        // the floor is persisted on success.
        this.cipherVersionOverride = targetCipherVersion;

        this.replicator.stop();
        this.changeTracker.stop();
        // Persist the non-syncable transient before the destructive clone
        // (see initVault). On failure we stay here, persisted settings
        // untouched.
        this.settings.connectionState = "settingUp";
        await this.saveSettings();
        const progress = new ProgressNotice("Clone");
        try {
            const result = await this.setupService.clone((msg) => progress.update(msg));

            // Success: commit the codec config + setupDone in one save.
            this.settings.encryptionEnabled = targetEncryptionEnabled;
            this.settings.encryptionPassphrase = targetPassphrase;
            this.settings.compressionEnabled = targetCompression;
            this.settings.vaultCipherVersion = targetCipherVersion;
            this.compressionOverride = undefined;
            this.cipherVersionOverride = undefined;
            this.settings.connectionState = "setupDone";
            this.encryptionMismatch = undefined;
            await this.saveSettings();
            progress.done(`Clone complete! ${result.vaultFiles} files written.`);
        } catch (e: any) {
            // Failure: roll back in-memory codec state. Persisted settings
            // were never mutated; connectionState stays "settingUp".
            this.compressionOverride = undefined;
            this.cipherVersionOverride = undefined;
            if (meta) {
                this.vaultCryptoProvider = undefined;
            }
            progress.fail(`Clone failed: ${e?.message ?? e}`);
            throw e;
        }
    }

    async startSync(): Promise<void> {
        if (this.settings.connectionState !== "syncing") return;
        if (!this.settings.deviceId) {
            notify("CouchSync: Set a device name before starting sync.");
            return;
        }
        await this.vaultSync.loadLastSyncedVclocks();
        this.replicator.stop();
        this.replicator.start();
        this.changeTracker.start();
        // Reconcile fires via onCatchupComplete.
    }

    stopSync(): void {
        this.replicator.stop();
        this.changeTracker.stop();
    }

    private fireReconcile(reason: ReconcileReason): void {
        this.reconciler.reconcile(reason).catch((e) =>
            logError(`CouchSync: ${reason} reconcile failed: ${e?.message ?? e}`),
        );
    }

    async activateLogView(): Promise<void> {
        const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_LOG);
        if (existing.length > 0) {
            this.app.workspace.revealLeaf(existing[0]);
            return;
        }
        const leaf = this.app.workspace.getRightLeaf(false);
        if (leaf) {
            await leaf.setViewState({ type: VIEW_TYPE_LOG, active: true });
            this.app.workspace.revealLeaf(leaf);
        }
    }

    async activateHistoryView(): Promise<void> {
        const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DIFF_HISTORY);
        if (existing.length > 0) {
            this.app.workspace.revealLeaf(existing[0]);
            return;
        }
        const leaf = this.app.workspace.getRightLeaf(false);
        if (leaf) {
            await leaf.setViewState({ type: VIEW_TYPE_DIFF_HISTORY, active: true });
            this.app.workspace.revealLeaf(leaf);
        }
    }

    async showHistory(filePath: string): Promise<void> {
        await this.activateHistoryView();
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DIFF_HISTORY);
        if (leaves.length > 0) {
            const view = leaves[0].view as DiffHistoryView;
            await view.showFileHistory(filePath);
        }
    }

    async restoreFromHistory(filePath: string, recordId: number): Promise<boolean> {
        this.changeTracker.ignoreNextModify(filePath);
        const content = await this.historyManager.restoreToRecord(filePath, recordId);
        if (content === null) return false;
        try {
            await this.vaultSync.forceLocalEdit(filePath, {});
        } catch {
            // Sync propagation failure is non-fatal — file is already restored on disk.
        }
        return true;
    }
}
