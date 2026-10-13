/**
 * Config Sync settings tab.
 *
 * ConfigDocs (`.obsidian/` files) live in their own remote CouchDB
 * database, separate from the vault DB. This tab mirrors the step
 * structure of Vault Sync:
 *
 *   Step 1: Encryption & compression — config-specific codec overrides: the
 *           codec the next Create builds the DB with (sync itself uses the
 *           joined DB's codec), and the passphrase. Create / Join resolve an
 *           empty passphrase to the vault's once and save the one they used
 *           here; Push / Pull use only the saved value.
 *   Step 2: Database — pick the config database name. Server credentials
 *           are shared via the CouchDB tab. Check → Apply confirms.
 *   Step 3: Setup — Create (first device: reset the shared config DB and
 *           make a new root; structural only, it does not send content) or
 *           Join (every other device: accept the existing root). Shows the
 *           binding's latest readiness.
 *   Step 4: Sync — the meaning-unit filter (what this device syncs, by
 *           meaning), then Push (send) and Pull & Reload (receive+apply).
 *           The same filter governs both directions (receive ⊆ send).
 *
 * Step 2+ is gated on `serverTested` (server connection verified in the
 * CouchDB tab).
 */
import { type App, Notice, Platform, Setting, type ButtonComponent } from "obsidian";
import type { CouchSyncSettings } from "../settings.ts";
import type { ConfigSync, RemoteConfigListing } from "../sync/config-sync.ts";
import type { SyncEngine } from "../db/sync-engine.ts";
import type { AuthGate } from "../db/sync/auth-gate.ts";
import type { VaultRemoteOps } from "../db/sync/vault-remote-ops.ts";
import type { IModalPresenter } from "../types/modal-presenter.ts";
import { addPasswordToggle } from "./vault-sync-tab.ts";
import { logWarn } from "../ui/log.ts";
import { ConfigNotReadyError } from "../sync/config-errors.ts";
import { configRelationView } from "./config-relation-view.ts";
import { describeCreateConfirm } from "../sync/config-create-preview.ts";
import {
    classifyConfigPath,
    type ClassifiedPath,
    type ConfigUnit,
} from "../sync/config-policy/classify.ts";
import {
    sendDecision,
    type ConfigSyncPolicy,
} from "../sync/config-policy/policy.ts";

/** Display labels for meaning units in the filter tree. */
const UNIT_LABELS: Record<ConfigUnit, string> = {
    "app-behavior": "App settings (app / appearance / hotkeys)",
    "core-settings": "Core plugin settings",
    "community-settings": "Community plugin settings (data.json)",
    "theme-css": "Themes (CSS)",
    snippets: "Snippets (CSS)",
    "enabled-list": "Enabled-plugin lists",
    "install-state": "Community plugin code (main.js / manifest)",
    layout: "Layout (workspace)",
    other: "Other",
};

const PORTABLE_UNITS: ConfigUnit[] = [
    "app-behavior", "theme-css", "snippets",
    "core-settings", "community-settings",
];
const INSTALL_UNITS: ConfigUnit[] = ["install-state", "enabled-list"];
import {
    resolveConfigCodec,
    isInheritingConfigEncryption,
    isInheritingConfigCompression,
} from "../sync/config-codec-policy.ts";
import { describeCodec, sameCodec } from "../sync/config-binding-record.ts";
import { CURRENT_CIPHER_VERSION } from "../db/vault-meta.ts";

export interface ConfigSyncTabDeps {
    app: App;
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    configSync: ConfigSync;
    replicator: SyncEngine;
    auth: AuthGate;
    remoteOps: VaultRemoteOps;
    modalPresenter: IModalPresenter;
    refresh: () => void;
}

interface Draft {
    db: string;
}

/** One filter-tree row: a classified config path plus where it currently
 *  exists — on THIS device (`local`), on the remote config DB (`remote`),
 *  or both. The union of the two sources is what the tree renders, so the
 *  user can see config that lives only on the server (e.g. a plugin's
 *  settings they haven't installed yet) and not just their local files. */
interface TreeItem {
    c: ClassifiedPath;
    local: boolean;
    remote: boolean;
}

export class ConfigSyncTab {
    private draft: Draft;
    private testPassed = false;

    private pencils = new Map<keyof Draft, HTMLSpanElement>();
    private testBtn: ButtonComponent | null = null;
    private applyBtn: ButtonComponent | null = null;
    private applyDesc: HTMLElement | null = null;
    /** The Step 3 status line, repainted in place when the filter tree's
     *  check records a new outcome. */
    private setupStateEl: HTMLElement | null = null;

    /** Short-lived cache of the remote config path list so re-rendering the
     *  tree (every settings refresh, incl. after each checkbox toggle) does
     *  not re-hit the network each time. Tagged with the binding it was read
     *  for (`listing.bindingKey`): it is used only while that binding is the
     *  current one. */
    private remoteCache: (RemoteConfigListing & { at: number }) | null = null;
    private static readonly REMOTE_TTL_MS = 30_000;

    constructor(private deps: ConfigSyncTabDeps) {
        this.draft = this.savedToDraft();
    }

    /** Re-supply deps on every settings display(). The instance outlives a
     *  display (it holds the draft), so deps captured at construction would
     *  go stale. Mirrors `VaultSyncTab.updateDeps`. */
    updateDeps(deps: ConfigSyncTabDeps): void {
        this.deps = deps;
    }

    /** Reset draft to match saved settings (call on settings tab hide) */
    resetDraft(): void {
        this.draft = this.savedToDraft();
        this.testPassed = false;
    }

    private savedToDraft(): Draft {
        const s = this.deps.getSettings();
        return { db: s.couchdbConfigDbName };
    }

    private isFieldDirty(field: keyof Draft): boolean {
        const saved = this.savedToDraft();
        return this.draft[field] !== saved[field];
    }

    private updateDirtyState(): void {
        for (const [field, pencilEl] of this.pencils) {
            pencilEl.style.display = this.isFieldDirty(field) ? "inline" : "none";
        }
        if (this.testBtn) {
            // Test is allowed once a non-empty draft DB name is typed.
            this.testBtn.setDisabled(this.draft.db.trim() === "");
        }
        if (this.applyBtn) {
            this.applyBtn.setDisabled(!this.canApply());
        }
        if (this.applyDesc) {
            this.applyDesc.textContent = this.applyDescText();
        }
    }

    private canApply(): boolean {
        // Apply rebinds the config DB (closes the current local store), which
        // ConfigSync refuses while an op runs — mirror that in the button.
        // Same check as the CouchDB tab's Apply (`bindingChangeBlocker`).
        if (this.deps.configSync.bindingChangeBlocker()) return false;
        // Empty value is a valid Apply (means "disable config sync") and
        // doesn't require Test. Non-empty must be Tested first.
        if (this.draft.db.trim() === "") return true;
        return this.testPassed;
    }

    private applyDescText(): string {
        const blocked = this.deps.configSync.bindingChangeBlocker();
        if (blocked) return blocked;
        if (this.draft.db.trim() === "") {
            return "Apply with empty name to disable config sync.";
        }
        return this.testPassed
            ? "Save the config database name."
            : "Check database first.";
    }

    /**
     * Config-DB codec settings, independent from Vault Sync. Each value is a
     * config-specific override (`config* ?? vault`): we surface the effective
     * value and persist an explicit config value the moment the user toggles it
     * — no migration backfills the inherited defaults, so an untouched install
     * keeps inheriting. Mirrors `VaultSyncTab.renderEncryptionStep`.
     *
     * Encryption and compression here are the input of the NEXT Create
     * only. Push and Pull use the codec of the database this device created
     * or joined (its attachment), so a toggle never stops sync; when the two
     * differ, the step says so.
     *
     * The passphrase field holds the value Push and Pull unlock with. Left
     * empty, it means "use the Vault Sync passphrase" for the next Create or
     * Join only; a successful Create / Join of an encrypted database saves
     * the passphrase it used into this field, so later vault-side changes
     * never reach config sync.
     */
    private renderConfigCodecStep(el: HTMLElement, settings: CouchSyncSettings): void {
        el.createEl("h3", { text: "Step 1: Encryption & compression" });
        el.createEl("p", {
            text: "Config sync has its own codec, independent of Vault Sync. " +
                "Unset values inherit the Vault Sync setting. Encryption and " +
                "compression are what Create (Step 3) builds the config database " +
                "with; syncing always uses the codec of the database this device " +
                "created or joined. The passphrase is what this device unlocks that " +
                "database with; Create and Join save the one they used below.",
            cls: "setting-item-description",
        });

        const codec = resolveConfigCodec(settings);
        const binding = settings.couchdbConfigDbName.trim() !== ""
            ? this.deps.configSync.currentBinding() : null;
        const joined = binding?.attachment ?? null;
        if (joined && !sameCodec(joined.codec, codec)) {
            const note = el.createEl("p", {
                text: `Differs from the current database: "${binding!.dbName}" uses ` +
                    `${describeCodec(joined.codec)}, and syncing keeps using that. ` +
                    `The settings below (${describeCodec(codec)}) take effect only when ` +
                    "you run Create, which rebuilds the database with them.",
                cls: "setting-item-description",
            });
            note.style.color = "var(--text-accent)";
        }

        const encEnabled = codec.encryption;
        const inheritingEnc = isInheritingConfigEncryption(settings);
        new Setting(el)
            .setName("E2E encryption")
            .setDesc(
                inheritingEnc
                    ? `Inheriting Vault Sync (${settings.encryptionEnabled ? "encrypted" : "plaintext"}). Toggle to set an independent value.`
                    : "Independent config setting, used by the next Create.",
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(encEnabled)
                    .onChange(async (value) => {
                        // The passphrase is kept: the joined database may
                        // still be encrypted and need it to sync.
                        await this.deps.updateSettings({ configEncryptionEnabled: value });
                        this.deps.refresh();
                    })
            );

        // Shown whenever a passphrase can matter: Create would encrypt, or
        // the joined database is encrypted.
        if (encEnabled || joined?.codec.encryption) {
            const passphraseSetting = new Setting(el)
                .setName("Passphrase")
                .setDesc(
                    "Push and Pull unlock the config database with the passphrase " +
                        "saved here. Empty: the next Create or Join uses the Vault " +
                        "Sync passphrase (Join asks when that is empty too) and, once " +
                        "it succeeds, saves the passphrase it used here — later Vault " +
                        "Sync changes do not affect config sync. Other devices: enter " +
                        "the passphrase the config database was created with.",
                )
                .addText((text) => {
                    text.setPlaceholder("Empty: Create / Join use the Vault Sync passphrase")
                        .setValue(settings.configEncryptionPassphrase ?? "")
                        .onChange(async (value) => {
                            await this.deps.updateSettings({ configEncryptionPassphrase: value });
                        });
                    text.inputEl.type = "password";
                });
            addPasswordToggle(passphraseSetting);
        }

        const compressEnabled = codec.compression;
        const inheritingCompress = isInheritingConfigCompression(settings);
        new Setting(el)
            .setName("Compress (gzip)")
            .setDesc(
                inheritingCompress
                    ? `Inheriting Vault Sync (${settings.compressionEnabled ? "on" : "off"}). Toggle to set an independent value.`
                    : "Independent config setting, used by the next Create.",
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(compressEnabled)
                    .onChange(async (value) => {
                        await this.deps.updateSettings({ configCompressionEnabled: value });
                        this.deps.refresh();
                    })
            );
    }

    render(el: HTMLElement): void {
        const settings = this.deps.getSettings();

        // Reset DOM references
        this.pencils.clear();
        this.testBtn = null;
        this.applyBtn = null;
        this.applyDesc = null;
        this.setupStateEl = null;

        // ── Device Name (inherited) ────────────────────────
        el.createEl("h3", { text: "Device Name" });
        const deviceSetting = new Setting(el).setName("Device name");
        deviceSetting.settingEl.addClass("cs-field-2row");
        deviceSetting.descEl.createEl("span", {
            text: settings.deviceId || "(not set)",
            cls: "cs-inherited-value",
        });

        // ── Step 1: Encryption & compression (independent) ──
        this.renderConfigCodecStep(el, settings);

        // ── Gate: server must be tested ─────────────────────
        if (!settings.serverTested) {
            el.createEl("h3", { text: "Step 2: Database" });
            el.createEl("p", {
                text: "Complete server connection in the CouchDB tab first.",
                cls: "setting-item-description",
            });
            return;
        }

        // ── Step 2: Database ────────────────────────────────
        el.createEl("h3", { text: "Step 2: Database" });

        el.createEl("p", {
            text:
                "Config sync uses a separate database on the same CouchDB server. " +
                "Leave empty to disable config sync.",
            cls: "setting-item-description",
        });

        this.renderField(el, "Config Database Name", "db", "obsidian-config");

        new Setting(el)
            .setName("Check Database")
            .setDesc("Verify the config database exists or create it")
            .addButton((btn) => {
                this.testBtn = btn;
                btn.setButtonText("Check")
                    .setDisabled(this.draft.db.trim() === "")
                    .onClick(async () => this.handleCheck(btn));
            });

        const applySetting = new Setting(el)
            .setName("Apply")
            .setDesc(this.applyDescText())
            .addButton((btn) => {
                this.applyBtn = btn;
                btn
                    .setButtonText("Apply")
                    .setDisabled(!this.canApply())
                    .onClick(async () => this.handleApply());
            });
        this.applyDesc = applySetting.settingEl.querySelector(
            ".setting-item-description",
        ) as HTMLElement;

        // ── Step 3: Setup ───────────────────────────────────
        // Mirrors Vault Sync's Step 3 (Init / Clone): one state line, then
        // the first-device and the other-device action.
        el.createEl("h3", { text: "Step 3: Setup" });

        const configEnabled = settings.couchdbConfigDbName.trim() !== "";
        this.renderSetupState(el);

        new Setting(el)
            .setName("Create")
            .setDesc(
                "Reset the remote config database with a new root from the Step 1 " +
                "settings (1st device). Then Push. Every other device must Join again.",
            )
            .addButton((btn) =>
                btn.setButtonText("Create").setWarning()
                    .setDisabled(!configEnabled)
                    .onClick(async () => this.handleCreate(btn))
            );

        new Setting(el)
            .setName("Join")
            .setDesc(
                "Join the existing config database with its own encryption and " +
                "compression (2nd+ device). Neither the server nor Step 1 is changed. " +
                "Then Pull.",
            )
            .addButton((btn) =>
                btn.setButtonText("Join")
                    .setDisabled(!configEnabled)
                    .onClick(async () => {
                        btn.setButtonText("Joining...");
                        btn.setDisabled(true);
                        try {
                            await this.trackOp(this.deps.configSync.join());
                        } catch {
                            // Reported by ConfigSync (ProgressNotice + log).
                        }
                        this.afterRelationOp();
                    })
            );

        // ── Step 4: Sync ────────────────────────────────────
        el.createEl("h3", { text: "Step 4: Sync" });

        if (!configEnabled) {
            el.createEl("p", {
                text: "Complete Step 2 and Step 3 first.",
                cls: "setting-item-description",
            });
        } else {
            el.createEl("p", {
                text: `Active: ${settings.couchdbConfigDbName}`,
                cls: "setting-item-description",
            });
        }

        // ── Filter (meaning-unit policy tree) — the "what", shown first
        //    since it governs both Push and Pull below. ────────
        this.renderFilterTree(el, configEnabled);

        new Setting(el)
            .setName("Push")
            .setDesc("Scan .obsidian/ and push the selected units to remote.")
            .addButton((btn) =>
                btn.setButtonText("Push ↑")
                    .setDisabled(!configEnabled)
                    .onClick(async () => {
                        btn.setButtonText("Pushing...");
                        btn.setDisabled(true);
                        try {
                            await this.trackOp(this.deps.configSync.push());
                        } catch {
                            // Reported by ConfigSync (ProgressNotice + log).
                        }
                        // The status line shows this op's outcome.
                        this.remoteCache = null;
                        this.deps.refresh();
                    })
            );

        new Setting(el)
            .setName("Pull & Reload")
            .setDesc(
                "Pull config from remote, write the selected units to this device, then reload Obsidian.",
            )
            .addButton((btn) =>
                btn.setButtonText("Pull & Reload ↓")
                    .setDisabled(!configEnabled)
                    .onClick(async () => {
                        btn.setButtonText("Pulling...");
                        btn.setDisabled(true);
                        try {
                            await this.trackOp(this.deps.configSync.pull());
                            new Notice("CouchSync: Reloading Obsidian...");
                            setTimeout(() => {
                                (this.deps.app as any).commands.executeCommandById("app:reload");
                            }, 500);
                        } catch {
                            // Reported by ConfigSync (ProgressNotice + log);
                            // no reload on failure. Re-render so the button
                            // and the status line reflect this attempt.
                            this.deps.refresh();
                        }
                    })
            );
    }

    /**
     * Step 3 state line: this device's relation to the bound config DB, as
     * `configRelationView` words it (the binding's `relation()` and the auth
     * latch). Colours follow Vault Sync's check result: green for ready, red
     * for a problem.
     */
    private renderSetupState(el: HTMLElement): void {
        this.setupStateEl = el.createEl("p");
        this.paintSetupState();
    }

    private paintSetupState(): void {
        const p = this.setupStateEl;
        if (!p) return;
        const settings = this.deps.getSettings();
        const enabled = settings.couchdbConfigDbName.trim() !== "";
        const binding = enabled ? this.deps.configSync.currentBinding() : null;
        const auth = this.deps.auth;
        const view = configRelationView(
            { enabled, relation: binding?.relation() ?? null },
            auth.isBlocked() ? auth.blockedError() : null,
        );
        p.textContent = view.text;
        p.className = view.tone === "error"
            ? "setting-item-description mod-warning" : "setting-item-description";
        p.style.color = view.tone === "ok" ? "var(--text-success)"
            : view.tone === "error" ? "var(--text-error)" : "";
    }

    /** Create: show what it would delete (read from the server now, never
     *  guessed) and the codec it builds, confirm, run — against the binding
     *  the dialog described, or not at all. */
    private async handleCreate(btn: ButtonComponent): Promise<void> {
        const settings = this.deps.getSettings();
        const dbName = settings.couchdbConfigDbName;
        const step1 = resolveConfigCodec(settings);
        const next = {
            encryption: step1.encryption,
            compression: step1.compression,
            ...(step1.encryption ? { cipherVersion: CURRENT_CIPHER_VERSION } : {}),
        };
        btn.setButtonText("Checking server...");
        btn.setDisabled(true);
        const preview = await this.deps.configSync.previewCreate();
        const ok = await this.deps.modalPresenter.showConfirmModal(
            `Create config database "${dbName}"?`,
            describeCreateConfirm(dbName, preview, next),
            "Create",
            true,
        );
        if (!ok) {
            btn.setButtonText("Create");
            btn.setDisabled(false);
            return;
        }
        // The dialog described `preview.bindingKey`. Checked in the same tick
        // as create() takes the op lock, so nothing can switch in between.
        if (this.deps.configSync.currentBinding()?.key !== preview.bindingKey) {
            new Notice(
                "CouchSync: the config database changed while the dialog was open — " +
                    "Create was not run. Press Create again.",
                10000,
            );
            this.afterRelationOp();
            return;
        }
        btn.setButtonText("Creating...");
        try {
            await this.trackOp(this.deps.configSync.create());
        } catch {
            // Reported by ConfigSync (ProgressNotice + log); the tab only
            // restores its button.
        }
        this.afterRelationOp();
    }

    /** After Create / Join: the remote listing and the status changed. */
    private afterRelationOp(): void {
        this.remoteCache = null;
        this.deps.refresh();
    }

    // ── Filter tree (meaning-unit policy) ───────────────

    private async updatePolicy(patch: Partial<ConfigSyncPolicy>): Promise<void> {
        const cur = this.deps.getSettings().configSyncPolicy;
        await this.deps.updateSettings({ configSyncPolicy: { ...cur, ...patch } });
    }

    private renderFilterTree(el: HTMLElement, configEnabled: boolean): void {
        const policy = this.deps.getSettings().configSyncPolicy;

        el.createEl("h4", { text: "Filter" });
        el.createEl("p", {
            text: "Choose what this device syncs, by meaning. The same selection " +
                "applies on push (send) and pull (write). These settings are " +
                "device-local — they are not themselves synced.",
            cls: "setting-item-description",
        });
        el.createEl("p", {
            text: "The tree lists config present on THIS device; the per-unit " +
                "defaults also govern plugins, themes and snippets that arrive " +
                "from other devices.",
            cls: "setting-item-description",
        });
        if (Platform.isMobile) {
            const note = el.createEl("p", {
                text: "On this mobile device, desktop-only plugins are never " +
                    "received — their settings stay on desktop even when selected.",
                cls: "setting-item-description",
            });
            note.style.color = "var(--text-accent)";
        }

        new Setting(el)
            .setName("Don't sync plugin code (JavaScript)")
            .setDesc(
                "Safety interlock: never send or receive plugin main.js / manifest. " +
                "Stops a malicious server from running code on your devices, and " +
                "auto-applies to plugins you install later. Install plugins per " +
                "device via the plugin manager.",
            )
            .addToggle((t) =>
                t.setValue(policy.blockPluginCode)
                    .setDisabled(!configEnabled)
                    .onChange(async (v) => {
                        await this.updatePolicy({ blockPluginCode: v });
                        this.deps.refresh();
                    }),
            );

        const treeEl = el.createDiv({ cls: "cs-config-tree" });
        if (!configEnabled) {
            treeEl.createEl("p", {
                text: "Complete Step 2 and Step 3 first.",
                cls: "setting-item-description",
            });
            return;
        }
        treeEl.createEl("p", { text: "Loading config tree…", cls: "setting-item-description" });
        void this.populateFilterTree(treeEl);
    }

    private async populateFilterTree(treeEl: HTMLElement): Promise<void> {
        let localPaths: string[];
        try {
            localPaths = await this.deps.configSync.listLocalConfigPaths();
        } catch (e: any) {
            treeEl.empty();
            treeEl.createEl("p", {
                text: `Failed to list config: ${e?.message ?? e}`,
                cls: "setting-item-description mod-warning",
            });
            return;
        }

        // Remote is best-effort: the tree still works offline, just without
        // the "on server" provenance. A short TTL cache keeps checkbox
        // toggles (which re-render the whole tab) from re-hitting the network.
        const listing = await this.fetchRemotePathsCached();
        if (!listing) {
            // Read for a binding that was replaced meanwhile: list again for
            // the current one (bindings change only on Apply, so this ends).
            return this.populateFilterTree(treeEl);
        }
        const { paths: remotePaths, ok: remoteOk } = listing;
        // A fresh listing recorded a check on the binding.
        this.paintSetupState();

        treeEl.empty();
        const policy = this.deps.getSettings().configSyncPolicy;

        // Merge local ∪ remote, tagging each path with where it lives.
        const prov = new Map<string, { local: boolean; remote: boolean }>();
        for (const p of localPaths) prov.set(p, { local: true, remote: false });
        for (const p of remotePaths) {
            const e = prov.get(p);
            if (e) e.remote = true;
            else prov.set(p, { local: false, remote: true });
        }

        const byUnit = new Map<ConfigUnit, TreeItem[]>();
        for (const [path, pr] of prov) {
            const c = classifyConfigPath(path);
            const arr = byUnit.get(c.unit) ?? [];
            arr.push({ c, local: pr.local, remote: pr.remote });
            byUnit.set(c.unit, arr);
        }
        for (const arr of byUnit.values()) {
            arr.sort((a, b) => a.c.path.localeCompare(b.c.path));
        }

        if (!remoteOk) {
            // Why the server was not listed is the status line's to say
            // (Step 3); repeating it here would be a second wording of it.
            treeEl.createEl("p", {
                text: "Showing this device's config only — see Step 3.",
                cls: "setting-item-description",
            });
        }

        treeEl.createEl("h5", { text: "Portable settings" });
        for (const unit of PORTABLE_UNITS) {
            this.renderUnit(treeEl, unit, byUnit.get(unit) ?? [], policy);
        }
        treeEl.createEl("h5", { text: "Installation state (device / version-specific, default off)" });
        for (const unit of INSTALL_UNITS) {
            this.renderUnit(treeEl, unit, byUnit.get(unit) ?? [], policy);
        }

        const layout = byUnit.get("layout") ?? [];
        if (layout.length > 0) {
            treeEl.createEl("p", {
                text: `Always excluded: ${layout.length} workspace/layout file(s).`,
                cls: "setting-item-description",
            });
        }
    }

    /** Fetch the remote config path list, memoised for a short TTL per
     *  binding. On failure returns an empty list (`ok: false`), so the tree
     *  degrades to a local-only view. While a config op runs the server is
     *  not listed: the last listing of the same binding is shown instead,
     *  however old.
     *
     *  Returns null when the binding changed while the listing was being
     *  read (it belongs to the previous DB / server): the result is dropped,
     *  never cached or shown. */
    private async fetchRemotePathsCached(): Promise<RemoteConfigListing | null> {
        const now = Date.now();
        const key = this.deps.configSync.currentBinding()?.key ?? null;
        const cached = this.remoteCache;
        if (cached && cached.bindingKey === key && (
            now - cached.at < ConfigSyncTab.REMOTE_TTL_MS
            || this.deps.configSync.isInflight()
        )) {
            return { paths: cached.paths, ok: cached.ok, bindingKey: cached.bindingKey };
        }
        const busyBefore = this.deps.configSync.bindingChangeBlocker() !== null;
        const listing = await this.deps.configSync.listRemoteConfigPathsQuiet();
        const current = this.deps.configSync.currentBinding()?.key ?? null;
        if (listing.bindingKey !== key || current !== key) return null;
        // An answer given while an op ran says nothing about the server —
        // never cache it.
        if (!busyBefore) this.remoteCache = { ...listing, at: now };
        return listing;
    }

    private renderUnit(
        parent: HTMLElement,
        unit: ConfigUnit,
        items: TreeItem[],
        policy: ConfigSyncPolicy,
    ): void {
        const locked = policy.blockPluginCode && unit === "install-state";
        const details = parent.createEl("details", { cls: "cs-unit" });
        const summary = details.createEl("summary");
        const groupCb = summary.createEl("input", { cls: "cs-unit-group" }) as HTMLInputElement;
        groupCb.type = "checkbox";

        const effs = items.map((it) => sendDecision(policy, it.c));
        const allOn = effs.length > 0 && effs.every(Boolean);
        const anyOn = effs.some(Boolean);
        groupCb.checked = items.length > 0 ? allOn : (policy.unitDefaults[unit] ?? false);
        groupCb.indeterminate = anyOn && !allOn;
        groupCb.disabled = locked;
        // Count shows the union size, calling out items that exist only on the
        // server (not yet on this device) so the "+N on server" is visible
        // without expanding the group.
        const serverOnly = items.filter((it) => it.remote && !it.local).length;
        const count = serverOnly > 0
            ? `${items.length}, +${serverOnly} on server`
            : `${items.length}`;
        summary.createSpan({
            text: ` ${UNIT_LABELS[unit]} (${count})${locked ? " — locked by JS safety" : ""}`,
        });

        groupCb.addEventListener("change", async () => {
            const on = groupCb.checked;
            const overrides = { ...policy.overrides };
            for (const it of items) delete overrides[it.c.path];
            await this.updatePolicy({
                unitDefaults: { ...policy.unitDefaults, [unit]: on },
                overrides,
            });
            this.deps.refresh();
        });

        const list = details.createDiv({ cls: "cs-unit-children" });
        for (const it of items) {
            const c = it.c;
            const row = list.createDiv({ cls: "cs-unit-child" });
            const cb = row.createEl("input") as HTMLInputElement;
            cb.type = "checkbox";
            cb.checked = sendDecision(policy, c);
            cb.disabled = locked;
            row.createSpan({
                text: ` ${c.path.replace(".obsidian/", "")}${c.isPluginCode ? " ⚠️" : ""}`,
            });
            // Provenance + receive-gate hint. "on server" items that a gate
            // would block on this device explain why (e.g. the plugin isn't
            // installed here yet).
            let prov: string;
            if (it.local && it.remote) prov = "synced";
            else if (it.local) prov = "local only";
            else prov = "on server";
            if (!it.local && c.unit === "community-settings") {
                prov += " — install the plugin to receive";
            }
            row.createSpan({ cls: "cs-prov", text: prov });
            cb.addEventListener("change", async () => {
                const overrides = { ...policy.overrides };
                const unitDef = policy.unitDefaults[c.unit] ?? false;
                if (cb.checked === unitDef) delete overrides[c.path];
                else overrides[c.path] = cb.checked;
                await this.updatePolicy({ overrides });
                this.deps.refresh();
            });
        }
    }

    private renderField(
        el: HTMLElement,
        name: string,
        field: keyof Draft,
        placeholder: string,
    ): void {
        const setting = new Setting(el).setName(name);
        setting.settingEl.addClass("cs-field-2row");

        const nameEl = setting.settingEl.querySelector(".setting-item-name");
        if (nameEl) {
            const pencil = nameEl.createSpan({ cls: "cs-pencil", text: "✏️" });
            pencil.style.display = this.isFieldDirty(field) ? "inline" : "none";
            this.pencils.set(field, pencil);
        }

        setting.addText((text) => {
            text.setPlaceholder(placeholder)
                .setValue(this.draft[field])
                .onChange((value) => {
                    this.draft[field] = value;
                    this.testPassed = false;
                    this.updateDirtyState();
                });
        });
    }

    private async handleCheck(btn: ButtonComponent): Promise<void> {
        btn.setButtonText("Checking...");
        btn.setDisabled(true);

        const settings = this.deps.getSettings();
        if (this.draft.db.trim() === settings.couchdbDbName) {
            new Notice("Vault and config databases must have different names.", 8000);
            btn.setButtonText("Check");
            btn.setDisabled(false);
            return;
        }

        const result = await this.deps.remoteOps.checkDatabaseWith(
            settings.couchdbUri,
            settings.couchdbUser,
            settings.couchdbPassword,
            this.draft.db,
        );

        if (result.status === "error") {
            this.testPassed = false;
            new Notice(`Database check failed: ${result.message}`, 8000);
        } else {
            this.testPassed = true;
            this.deps.auth.clear();
            if (result.status === "created") {
                new Notice(`Database "${this.draft.db}" created.`, 3000);
            } else {
                new Notice(
                    `Database "${this.draft.db}" found — ${result.docCount.toLocaleString()} docs.`,
                    3000,
                );
            }
        }
        this.deps.refresh();
    }

    /** Track a ConfigSync op started from this tab so the Apply button is
     *  disabled while it runs. ConfigSync registers the op synchronously, so
     *  the state is refreshed right after the call and again when it ends. */
    private async trackOp<T>(op: Promise<T>): Promise<T> {
        this.updateDirtyState();
        try {
            return await op;
        } finally {
            this.updateDirtyState();
        }
    }

    /**
     * Apply = switch the config binding and persist the name, together:
     * the name is saved by `rebind`'s `commit`, inside its lock, so the
     * settings and the binding never disagree (invariant on
     * `ConfigSync.rebind`). Rebinding closes the current DB's store /
     * cursors / key memo and opens the new DB's, so the new name takes
     * effect without a reload and nothing of the old DB is used against the
     * new one.
     *
     * A busy refusal changes nothing (settings stay as they were). Any other
     * rebind failure leaves config sync unbound; the name is still saved so
     * ops report the failure against the name the user chose.
     */
    private async handleApply(): Promise<void> {
        const name = this.draft.db.trim();
        this.applyBtn?.setDisabled(true);
        try {
            await this.deps.configSync.rebind(name || null, {
                commit: () => this.deps.updateSettings({ couchdbConfigDbName: name }),
            });
        } catch (e: any) {
            logWarn(`CouchSync: config database switch failed: ${e?.message ?? e}`);
            new Notice(`CouchSync: could not switch the config database — ${e?.message ?? e}`, 10000);
            if (e instanceof ConfigNotReadyError && e.kind === "busy") {
                this.updateDirtyState();
                return;
            }
        }
        // The remote listing belonged to the previous DB.
        this.remoteCache = null;
        this.testPassed = false;
        this.deps.refresh();
    }
}

