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
 *   Step 2: Operations — Init & Push, Push, Pull & Reload, and the
 *           configSyncPaths editor (Add path with smart suggestions).
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
import { type App, Notice, Setting, type ButtonComponent } from "obsidian";
import type { CouchSyncSettings } from "../settings.ts";
import type { ConfigSync } from "../sync/config-sync.ts";
import type { SyncEngine } from "../db/sync-engine.ts";

export interface ConfigSyncTabDeps {
    app: App;
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    configSync: ConfigSync;
    replicator: SyncEngine;
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

    render(el: HTMLElement): void {
        const settings = this.deps.getSettings();
        const vaultState = settings.connectionState;
        const vaultReady = vaultState === "tested" || vaultState === "setupDone" || vaultState === "syncing";

        // Reset DOM references
        this.pencils.clear();
        this.testBtn = null;
        this.applyBtn = null;
        this.applyDesc = null;

        // ── Gate: vault sync must be at least Tested ────────
        if (!vaultReady) {
            el.createEl("p", {
                text: "Configure Vault Sync (Step 1) before setting up Config Sync.",
                cls: "setting-item-description",
            });
            return;
        }

        // ── Step 1: Connection ──────────────────────────────
        el.createEl("h3", { text: "Step 1: Connection" });

        el.createEl("p", {
            text:
                "Config sync uses a separate database on the same CouchDB server. " +
                "URI, username, and password are inherited from Vault Sync. " +
                "Use distinct names like obsidian-config-mobile vs obsidian-config-desktop " +
                "to keep device pools' .obsidian/ configurations independent. " +
                "Leave empty to disable config sync.",
            cls: "setting-item-description",
        });

        // Read-only display of inherited credentials
        new Setting(el)
            .setName("Server")
            .setDesc("Inherited from Vault Sync")
            .addText((text) => {
                text.setValue(settings.couchdbUri || "(not set)");
                text.setDisabled(true);
            });

        new Setting(el)
            .setName("Username")
            .setDesc("Inherited from Vault Sync")
            .addText((text) => {
                text.setValue(settings.couchdbUser || "(not set)");
                text.setDisabled(true);
            });

        // Editable: config DB name
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

        // ── Step 2: Operations ──────────────────────────────
        // Always rendered so the user can see the available actions even
        // before Step 1 has been applied. Buttons are disabled until
        // `couchdbConfigDbName` is set in saved settings.
        el.createEl("h3", { text: "Step 2: Operations" });

        const configEnabled = settings.couchdbConfigDbName.trim() !== "";

        if (!configEnabled) {
            el.createEl("p", {
                text: "Apply a config database name in Step 1 to enable these actions.",
                cls: "setting-item-description",
            });
        } else {
            el.createEl("p", {
                text: `Active: ${settings.couchdbConfigDbName}`,
                cls: "setting-item-description",
            });
        }

        new Setting(el)
            .setName("Init & Push")
            .setDesc("Delete old config, re-scan .obsidian/, push to remote.")
            .addButton((btn) =>
                btn.setButtonText("Init & Push").setWarning()
                    .setDisabled(!configEnabled)
                    .onClick(async () => {
                        btn.setButtonText("Initializing...");
                        btn.setDisabled(true);
                        try { await this.deps.configSync.init(); } catch { /* handled */ }
                        btn.setButtonText("Init & Push");
                        btn.setDisabled(false);
                    })
            );

        new Setting(el)
            .setName("Push")
            .setDesc("Scan .obsidian/ and push changes to remote.")
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

        // ── Receive: configSyncPaths editor + Pull & Reload ──
        el.createEl("h4", { text: "Receive filter" });
        el.createEl("p", {
            text: "Pull writes only the paths below to this device.",
            cls: "setting-item-description",
        });

        const paths = settings.configSyncPaths;
        for (const path of paths) {
            new Setting(el)
                .setName(path)
                .addButton((btn) =>
                    btn
                        .setButtonText("×")
                        .setWarning()
                        .setDisabled(!configEnabled)
                        .onClick(async () => {
                            const updated = settings.configSyncPaths.filter((p) => p !== path);
                            await this.deps.updateSettings({ configSyncPaths: updated });
                            this.deps.refresh();
                        })
                );
        }

        const addPathContainer = el.createDiv();
        const addSetting = new Setting(addPathContainer).setName("Add path");

        let inputValue = "";
        const suggestionsEl = addPathContainer.createDiv({ cls: "cs-suggest-list" });
        suggestionsEl.style.display = "none";

        addSetting.addText((text) => {
            text.setPlaceholder(".obsidian/plugins/my-plugin/");
            text.setDisabled(!configEnabled);
            text.inputEl.addEventListener("focus", () => {
                if (!configEnabled) return;
                loadSuggestions(suggestionsEl, this.deps);
            });
            text.inputEl.addEventListener("input", () => {
                inputValue = text.inputEl.value;
                filterSuggestions(suggestionsEl, inputValue);
            });
            text.onChange((value) => {
                inputValue = value;
            });
        });

        addSetting.addButton((btn) =>
            btn.setButtonText("+ Add")
                .setDisabled(!configEnabled)
                .onClick(async () => {
                    if (!inputValue.trim()) return;
                    const trimmed = inputValue.trim();
                    if (settings.configSyncPaths.includes(trimmed)) {
                        new Notice("Path already added.");
                        return;
                    }
                    const updated = [...settings.configSyncPaths, trimmed];
                    await this.deps.updateSettings({ configSyncPaths: updated });
                    this.deps.refresh();
                })
        );

        new Setting(el)
            .setName("Pull & Reload")
            .setDesc(
                configEnabled
                    ? `Pull config from remote, write ${paths.length} path(s), then reload Obsidian.`
                    : "Pull config from remote, write configured path(s), then reload Obsidian.",
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

    private renderField(
        el: HTMLElement,
        name: string,
        field: keyof Draft,
        placeholder: string,
    ): void {
        const setting = new Setting(el).setName(name);

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
        // the draft config DB name. Re-use Replicator's testConnectionWith
        // helper which already handles HEAD checks and surfaces errors.
        const error = await this.deps.replicator.testConnectionWith(
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
            this.deps.replicator.clearAuthError();
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

// ── Suggestion list (migrated from files-tab.ts) ────────

let cachedRemotePaths: { files: string[]; folders: string[] } | null = null;

function groupPaths(paths: string[]): { files: string[]; folders: string[] } {
    const files: string[] = [];
    const folderSet = new Set<string>();
    for (const path of paths) {
        const segments = path.split("/");
        for (let depth = 1; depth < segments.length; depth++) {
            folderSet.add(segments.slice(0, depth).join("/") + "/");
        }
        if (segments.length <= 2) {
            files.push(path);
        }
    }
    return { files: files.sort(), folders: [...folderSet].sort() };
}

async function loadSuggestions(suggestionsEl: HTMLElement, deps: ConfigSyncTabDeps): Promise<void> {
    suggestionsEl.empty();
    suggestionsEl.style.display = "block";
    const currentPaths = new Set(deps.getSettings().configSyncPaths);

    if (!cachedRemotePaths && !deps.replicator.isAuthBlocked()) {
        try {
            const rawPaths = await deps.configSync.listRemotePaths();
            cachedRemotePaths = groupPaths(rawPaths);
        } catch (e: any) {
            if (e?.status === 401 || e?.status === 403) {
                deps.replicator.markAuthError(e.status, e.message ?? "Auth failed");
            }
            cachedRemotePaths = null;
        }
    }

    if (cachedRemotePaths) {
        renderRemoteSuggestions(suggestionsEl, cachedRemotePaths, currentPaths, deps);
    } else {
        await renderLocalFallback(suggestionsEl, currentPaths, deps);
    }
}

function renderRemoteSuggestions(
    el: HTMLElement,
    remote: { files: string[]; folders: string[] },
    currentPaths: Set<string>,
    deps: ConfigSyncTabDeps,
): void {
    if (remote.files.length === 0 && remote.folders.length === 0) {
        el.createEl("div", {
            text: "No config found on remote. Run Init & Push first.",
            cls: "cs-suggest-header",
        });
        return;
    }

    if (remote.files.length > 0) {
        el.createEl("div", { text: "── Config files ──", cls: "cs-suggest-header" });
        for (const file of remote.files) {
            if (currentPaths.has(file)) continue;
            createSuggestionItem(el, file, deps);
        }
    }

    if (remote.folders.length > 0) {
        el.createEl("div", { text: "── Folders ──", cls: "cs-suggest-header" });
        for (const folder of remote.folders) {
            if (currentPaths.has(folder)) continue;
            createSuggestionItem(el, folder, deps);
        }
    }
}

async function renderLocalFallback(
    el: HTMLElement,
    currentPaths: Set<string>,
    deps: ConfigSyncTabDeps,
): Promise<void> {
    el.createEl("div", {
        text: "── Remote unavailable — showing local ──",
        cls: "cs-suggest-header",
    });

    const commonFiles = deps.configSync.getCommonConfigPaths();
    for (const path of commonFiles) {
        if (currentPaths.has(path)) continue;
        createSuggestionItem(el, path, deps);
    }

    try {
        const pluginFolders = await deps.configSync.listPluginFolders();
        for (const folder of pluginFolders) {
            if (currentPaths.has(folder)) continue;
            createSuggestionItem(el, folder, deps);
        }
    } catch { /* ignore */ }
}

function createSuggestionItem(container: HTMLElement, path: string, deps: ConfigSyncTabDeps): void {
    const item = container.createDiv({ cls: "cs-suggest-item", text: path });
    item.addEventListener("click", async () => {
        const current = deps.getSettings().configSyncPaths;
        if (!current.includes(path)) {
            await deps.updateSettings({ configSyncPaths: [...current, path] });
            deps.refresh();
        }
    });
}

function filterSuggestions(suggestionsEl: HTMLElement, filter: string): void {
    const items = suggestionsEl.querySelectorAll(".cs-suggest-item");
    const lower = filter.toLowerCase();
    for (let i = 0; i < items.length; i++) {
        const el = items[i] as HTMLElement;
        el.style.display = el.textContent?.toLowerCase().includes(lower) ? "" : "none";
    }
}
