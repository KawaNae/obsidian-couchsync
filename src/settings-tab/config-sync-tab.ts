/**
 * Config Sync settings tab.
 *
 * New in v0.11.0. ConfigDocs (`.obsidian/` files) live in their own
 * remote CouchDB database, separate from the vault DB. This tab mirrors
 * the step structure of Vault Sync:
 *
 *   Step 1: Connection — pick the config database name. URI / user /
 *           password are inherited from Vault Sync (1 CouchDB server),
 *           shown read-only here. Test → Apply confirms the choice.
 *   Step 2: Setup (Init) — reset the shared config DB. Structural only,
 *           run once per device pool; it does not send content.
 *   Step 3: Sync — the meaning-unit filter (what this device syncs, by
 *           meaning), then Push (send) and Pull & Reload (receive+apply).
 *           The same filter governs both directions (receive ⊆ send).
 *
 * Step 1 is gated on Vault Sync being at least "tested": you can't
 * point at a config DB if there's no vault server settled yet.
 *
 * Step 2 is gated on the local "configState" UI machine reaching
 * "ready" — i.e. the user has Test→Applied a non-empty config DB name.
 * This state is NOT persisted in settings; it's a per-render UI flag,
 * because there's nothing meaningful to remember between sessions —
 * either the saved `couchdbConfigDbName` is empty (disabled) or it's
 * set (ready).
 */
import { type App, Notice, Platform, Setting, type ButtonComponent } from "obsidian";
import type { CouchSyncSettings } from "../settings.ts";
import type { ConfigSync } from "../sync/config-sync.ts";
import type { SyncEngine } from "../db/sync-engine.ts";
import type { AuthGate } from "../db/sync/auth-gate.ts";
import type { VaultRemoteOps } from "../db/sync/vault-remote-ops.ts";
import type { IModalPresenter } from "../types/modal-presenter.ts";
import { addPasswordToggle } from "./vault-sync-tab.ts";
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

export interface ConfigSyncTabDeps {
    app: App;
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    configSync: ConfigSync;
    replicator: SyncEngine;
    auth: AuthGate;
    remoteOps: VaultRemoteOps;
    modalPresenter: IModalPresenter;
    /** Config-DB codec mismatch surfaced by the onload agreement check
     *  (remote encrypted/plaintext disagrees with local, or a cipherVersion
     *  downgrade was detected). Symmetric to the vault tab's
     *  `encryptionMismatch`. */
    configEncryptionMismatch?: { status: string };
    /** Ratchet the config cipherVersion floor + persist (#config-codec). Called
     *  after a successful encrypted Init & Push so a downgrade is refused
     *  immediately, not only after the next onload early-derive. */
    ratchetConfigCipherFloor: (cv: number) => Promise<void>;
    refresh: () => void;
}

interface Draft {
    db: string;
}

export class ConfigSyncTab {
    private draft: Draft;
    private testPassed = false;

    private pencils = new Map<keyof Draft, HTMLSpanElement>();
    private testBtn: ButtonComponent | null = null;
    private applyBtn: ButtonComponent | null = null;
    private applyDesc: HTMLElement | null = null;

    constructor(private deps: ConfigSyncTabDeps) {
        this.draft = this.savedToDraft();
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
        // Empty value is a valid Apply (means "disable config sync") and
        // doesn't require Test. Non-empty must be Tested first.
        if (this.draft.db.trim() === "") return true;
        return this.testPassed;
    }

    private applyDescText(): string {
        if (this.draft.db.trim() === "") {
            return "Apply with empty name to disable config sync.";
        }
        return this.testPassed
            ? "Save the config database name."
            : "Test connection first.";
    }

    /**
     * Config-DB codec settings, independent from Vault Sync. Each value is a
     * config-specific override (`config* ?? vault`): we surface the effective
     * value and persist an explicit config value the moment the user toggles it
     * — no migration backfills the inherited defaults, so an untouched install
     * keeps inheriting. Mirrors `VaultSyncTab.renderEncryptionStep`. A codec
     * change only takes effect on the next Init & Push (Step 3), which destroys
     * and rebuilds the config DB — flagged in the descriptions here.
     */
    private renderConfigCodecStep(el: HTMLElement, settings: CouchSyncSettings): void {
        el.createEl("h3", { text: "Step 1: Encryption & compression" });
        el.createEl("p", {
            text: "Config sync has its own codec, independent of Vault Sync. " +
                "Unset values inherit the Vault Sync setting. Changes apply on the " +
                "next Init & Push (Step 3), which rebuilds the config database.",
            cls: "setting-item-description",
        });

        if (this.deps.configEncryptionMismatch) {
            const warn = el.createEl("p", {
                text: "Config DB encryption state disagrees with this device " +
                    "(or a cipherVersion downgrade was detected on the server). " +
                    "Re-run Config Init & Push, or verify the server.",
                cls: "setting-item-description mod-warning",
            });
            warn.style.color = "var(--text-error)";
        }

        const codec = resolveConfigCodec(settings);
        const encEnabled = codec.encryption;
        const inheritingEnc = isInheritingConfigEncryption(settings);
        new Setting(el)
            .setName("E2E encryption")
            .setDesc(
                inheritingEnc
                    ? `Inheriting Vault Sync (${settings.encryptionEnabled ? "encrypted" : "plaintext"}). Toggle to set an independent value.`
                    : "Independent config setting. Re-run Init & Push to apply.",
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(encEnabled)
                    .onChange(async (value) => {
                        const patch: Partial<CouchSyncSettings> = { configEncryptionEnabled: value };
                        if (!value) patch.configEncryptionPassphrase = "";
                        await this.deps.updateSettings(patch);
                        this.deps.refresh();
                    })
            );

        if (encEnabled) {
            const passphraseSetting = new Setting(el)
                .setName("Passphrase")
                .setDesc(
                    settings.configEncryptionPassphrase
                        ? "Independent config passphrase. Re-run Init & Push to apply."
                        : "Empty inherits the Vault Sync passphrase; set a value to use a different one.",
                )
                .addText((text) => {
                    text.setPlaceholder("Inherit Vault Sync passphrase")
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
                    : "Independent config setting. Re-run Init & Push to apply.",
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
        const vaultState = settings.connectionState;
        const vaultReady = vaultState === "tested" || vaultState === "setupDone" || vaultState === "syncing";

        // Reset DOM references
        this.pencils.clear();
        this.testBtn = null;
        this.applyBtn = null;
        this.applyDesc = null;

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

        // ── Gate: vault sync must be at least Tested ────────
        if (!vaultReady) {
            el.createEl("h3", { text: "Step 2: Connection" });
            el.createEl("p", {
                text: "Complete Vault Sync Step 2 (Connection) first.",
                cls: "setting-item-description",
            });
            return;
        }

        // ── Step 2: Connection ──────────────────────────────
        el.createEl("h3", { text: "Step 2: Connection" });

        el.createEl("p", {
            text:
                "Config sync uses a separate database on the same CouchDB server. " +
                "Leave empty to disable config sync.",
            cls: "setting-item-description",
        });

        const serverSetting = new Setting(el).setName("Server");
        serverSetting.settingEl.addClass("cs-field-2row");
        serverSetting.descEl.createEl("span", {
            text: settings.couchdbUri || "(not set)",
            cls: "cs-inherited-value",
        });

        const userSetting = new Setting(el).setName("Username");
        userSetting.settingEl.addClass("cs-field-2row");
        userSetting.descEl.createEl("span", {
            text: settings.couchdbUser || "(not set)",
            cls: "cs-inherited-value",
        });

        this.renderField(el, "Config Database Name", "db", "obsidian-config");

        new Setting(el)
            .setName("Test Connection")
            .setDesc("Verify the config database is reachable")
            .addButton((btn) => {
                this.testBtn = btn;
                btn.setButtonText("Test")
                    .setDisabled(this.draft.db.trim() === "")
                    .onClick(async () => this.handleTest(btn));
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
        el.createEl("h3", { text: "Step 3: Setup" });

        const configEnabled = settings.couchdbConfigDbName.trim() !== "";

        if (!configEnabled) {
            el.createEl("p", {
                text: "Apply a config database name in Step 2 to enable setup.",
                cls: "setting-item-description",
            });
        }

        new Setting(el)
            .setName("Init")
            .setDesc(
                "Reset the shared config database: wipe remote + local and " +
                "establish the encryption root. Run once per device pool, then " +
                "use Push (below) to send this device's config.",
            )
            .addButton((btn) =>
                btn.setButtonText("Init").setWarning()
                    .setDisabled(!configEnabled)
                    .onClick(async () => {
                        const ok = await this.deps.modalPresenter.showConfirmModal(
                            "Init",
                            "Delete the existing remote config DB and reset to an " +
                                "empty database? You'll send this device's config " +
                                "with Push afterwards. This cannot be undone.",
                            "Init",
                            true,
                        );
                        if (!ok) return;
                        btn.setButtonText("Initializing...");
                        btn.setDisabled(true);
                        try {
                            // Config codec is independent (#config-codec): the
                            // single resolver applies the per-field inherit rules.
                            const codec = resolveConfigCodec(this.deps.getSettings());
                            await this.deps.configSync.init(codec);
                            // Init minted a fresh config:meta at cipherVersion 3
                            // when encrypted — ratchet the local floor now so a
                            // downgrade is refused immediately, not only after
                            // the next onload early-derive.
                            if (codec.encryption) {
                                await this.deps.ratchetConfigCipherFloor(3);
                            }
                        } catch { /* handled */ }
                        btn.setButtonText("Init");
                        btn.setDisabled(false);
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
                        try { await this.deps.configSync.push(); } catch { /* handled */ }
                        btn.setButtonText("Push ↑");
                        btn.setDisabled(false);
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
                            await this.deps.configSync.pull();
                            new Notice("CouchSync: Reloading Obsidian...");
                            setTimeout(() => {
                                (this.deps.app as any).commands.executeCommandById("app:reload");
                            }, 500);
                        } catch {
                            btn.setButtonText("Pull & Reload ↓");
                            btn.setDisabled(false);
                        }
                    })
            );
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
        let paths: string[];
        try {
            paths = await this.deps.configSync.listLocalConfigPaths();
        } catch (e: any) {
            treeEl.empty();
            treeEl.createEl("p", {
                text: `Failed to list config: ${e?.message ?? e}`,
                cls: "setting-item-description mod-warning",
            });
            return;
        }
        treeEl.empty();
        const policy = this.deps.getSettings().configSyncPolicy;

        const byUnit = new Map<ConfigUnit, ClassifiedPath[]>();
        for (const p of paths) {
            const c = classifyConfigPath(p);
            const arr = byUnit.get(c.unit) ?? [];
            arr.push(c);
            byUnit.set(c.unit, arr);
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

    private renderUnit(
        parent: HTMLElement,
        unit: ConfigUnit,
        items: ClassifiedPath[],
        policy: ConfigSyncPolicy,
    ): void {
        const locked = policy.blockPluginCode && unit === "install-state";
        const details = parent.createEl("details", { cls: "cs-unit" });
        const summary = details.createEl("summary");
        const groupCb = summary.createEl("input", { cls: "cs-unit-group" }) as HTMLInputElement;
        groupCb.type = "checkbox";

        const effs = items.map((c) => sendDecision(policy, c));
        const allOn = effs.length > 0 && effs.every(Boolean);
        const anyOn = effs.some(Boolean);
        groupCb.checked = items.length > 0 ? allOn : (policy.unitDefaults[unit] ?? false);
        groupCb.indeterminate = anyOn && !allOn;
        groupCb.disabled = locked;
        summary.createSpan({
            text: ` ${UNIT_LABELS[unit]} (${items.length})${locked ? " — locked by JS safety" : ""}`,
        });

        groupCb.addEventListener("change", async () => {
            const on = groupCb.checked;
            const overrides = { ...policy.overrides };
            for (const c of items) delete overrides[c.path];
            await this.updatePolicy({
                unitDefaults: { ...policy.unitDefaults, [unit]: on },
                overrides,
            });
            this.deps.refresh();
        });

        const list = details.createDiv({ cls: "cs-unit-children" });
        for (const c of items) {
            const row = list.createDiv({ cls: "cs-unit-child" });
            const cb = row.createEl("input") as HTMLInputElement;
            cb.type = "checkbox";
            cb.checked = sendDecision(policy, c);
            cb.disabled = locked;
            row.createSpan({
                text: ` ${c.path.replace(".obsidian/", "")}${c.isPluginCode ? " ⚠️" : ""}`,
            });
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

    private async handleTest(btn: ButtonComponent): Promise<void> {
        btn.setButtonText("Testing...");
        btn.setDisabled(true);

        // Validation: vault and config DB names must differ
        const settings = this.deps.getSettings();
        if (this.draft.db.trim() === settings.couchdbDbName) {
            new Notice("Vault and config databases must have different names.", 8000);
            btn.setButtonText("Test");
            btn.setDisabled(false);
            return;
        }

        // Construct a temporary URL using the inherited credentials and
        // the draft config DB name. VaultRemoteOps.testConnectionWith
        // handles the HEAD check and auth-latch bookkeeping.
        const error = await this.deps.remoteOps.testConnectionWith(
            settings.couchdbUri,
            settings.couchdbUser,
            settings.couchdbPassword,
            this.draft.db,
        );
        if (error) {
            this.testPassed = false;
            new Notice(`Connection failed: ${error}`, 8000);
        } else {
            this.testPassed = true;
            this.deps.auth.clear();
            new Notice("Connection successful!", 3000);
        }
        this.deps.refresh();
    }

    private async handleApply(): Promise<void> {
        await this.deps.updateSettings({
            couchdbConfigDbName: this.draft.db.trim(),
        });
        this.testPassed = false;
        this.deps.refresh();
    }
}

