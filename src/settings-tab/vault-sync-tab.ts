/**
 * Vault Sync settings tab.
 *
 * Renamed from `connection-tab.ts` in v0.11.0 as part of splitting config
 * sync into its own tab. Owns the vault-side connection (URI / user /
 * password / vault DB name), the Init/Clone setup actions, the live sync
 * toggle, and (Step 4) the vault file filters that used to live in the
 * standalone Files tab.
 *
 * Why merge filters into this tab? They control which vault files are
 * eligible for sync — they're a property of vault sync, not a separate
 * concept. Putting them under Vault Sync's Step 4 keeps the mental model
 * tight: "everything that controls vault sync lives here".
 */
import { type App, Notice, Setting, type ButtonComponent } from "obsidian";
import type { ConnectionState, CouchSyncSettings } from "../settings.ts";
import type { SyncEngine } from "../db/sync-engine.ts";
import type { LocalDB } from "../db/local-db.ts";

export interface VaultSyncTabDeps {
    app: App;
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    replicator: SyncEngine;
    localDb: LocalDB;
    initVault: () => Promise<void>;
    cloneFromRemote: () => Promise<void>;
    startSync: () => Promise<void>;
    stopSync: () => void;
    refresh: () => void;
}

interface Draft {
    uri: string;
    user: string;
    pass: string;
    db: string;
}

export class VaultSyncTab {
    private draft: Draft;
    private testPassed = false;

    // DOM references for in-place updates (no full re-render on keystroke)
    private pencils = new Map<keyof Draft, HTMLSpanElement>();
    private applyBtn: ButtonComponent | null = null;
    private applyDesc: HTMLElement | null = null;

    constructor(private deps: VaultSyncTabDeps) {
        this.draft = this.savedToDraft();
    }

    /** Reset draft to match saved settings (call on settings tab hide) */
    resetDraft(): void {
        this.draft = this.savedToDraft();
        this.testPassed = false;
    }

    private savedToDraft(): Draft {
        const s = this.deps.getSettings();
        return {
            uri: s.couchdbUri,
            user: s.couchdbUser,
            pass: s.couchdbPassword,
            db: s.couchdbDbName,
        };
    }

    private isFieldDirty(field: keyof Draft): boolean {
        const saved = this.savedToDraft();
        return this.draft[field] !== saved[field];
    }

    /** Update pencil + apply button in-place without full re-render */
    private updateDirtyState(): void {
        for (const [field, pencilEl] of this.pencils) {
            pencilEl.style.display = this.isFieldDirty(field) ? "inline" : "none";
        }
        if (this.applyBtn) {
            this.applyBtn.setDisabled(!this.testPassed);
        }
        if (this.applyDesc) {
            this.applyDesc.textContent = this.testPassed
                ? "Save connection settings."
                : "Test connection first.";
        }
    }

    render(el: HTMLElement): void {
        const state = this.deps.getSettings().connectionState;
        const locked = state === "syncing";
        const initCloneEnabled = state === "tested" || state === "setupDone";
        const syncToggleEnabled = state === "setupDone" || state === "syncing";

        // Reset DOM references
        this.pencils.clear();
        this.applyBtn = null;
        this.applyDesc = null;

        // ── Device Identity ────────────────────────────────────
        this.renderDeviceIdentity(el, locked);

        // ── Step 1: Connection ──────────────────────────────────
        el.createEl("h3", { text: "Step 1: Connection" });

        if (locked) {
            el.createEl("p", {
                text: "Disable sync to change connection.",
                cls: "setting-item-description",
            });
        }

        this.renderField(el, "Server URI", "uri", "https://localhost:5984", locked);
        this.renderField(el, "Username", "user", "admin", locked);
        this.renderField(el, "Password", "pass", "password", locked, true);
        this.renderField(el, "Vault Database Name", "db", "obsidian", locked);

        new Setting(el)
            .setName("Test Connection")
            .setDesc("Verify connection with current values")
            .addButton((btn) =>
                btn
                    .setButtonText("Test")
                    .setDisabled(locked)
                    .onClick(async () => this.handleTest(btn))
            );

        const applySetting = new Setting(el)
            .setName("Apply")
            .setDesc(
                this.testPassed
                    ? "Save connection settings."
                    : "Test connection first."
            )
            .addButton((btn) => {
                this.applyBtn = btn;
                btn
                    .setButtonText("Apply")
                    .setDisabled(locked || !this.testPassed)
                    .onClick(async () => this.handleApply());
            });
        this.applyDesc = applySetting.settingEl.querySelector(
            ".setting-item-description",
        ) as HTMLElement;

        // ── Step 2: Setup ───────────────────────────────────────
        el.createEl("h3", { text: "Step 2: Setup" });

        const setupDesc =
            state === "editing"
                ? "Complete Step 1 first."
                : state === "tested"
                    ? "Choose how to initialize this vault."
                    : state === "setupDone"
                        ? "Setup complete. You can re-run if needed."
                        : "Disable sync to re-run setup.";

        el.createEl("p", { text: setupDesc, cls: "setting-item-description" });

        new Setting(el)
            .setName("Init")
            .setDesc("Push local vault to empty remote database (1st device)")
            .addButton((btn) =>
                btn
                    .setButtonText("Init")
                    .setDisabled(!initCloneEnabled)
                    .onClick(async () => {
                        btn.setButtonText("Pushing...");
                        btn.setDisabled(true);
                        try {
                            // initVault() owns the full notice lifecycle —
                            // progress, done, and fail — so this catch just
                            // re-enables the button.
                            await this.deps.initVault();
                            this.deps.refresh();
                        } catch {
                            btn.setButtonText("Init");
                            btn.setDisabled(false);
                        }
                    })
            );

        new Setting(el)
            .setName("Clone")
            .setDesc("Pull remote database to local vault (2nd+ device)")
            .addButton((btn) =>
                btn
                    .setButtonText("Clone")
                    .setDisabled(!initCloneEnabled)
                    .onClick(async () => {
                        btn.setButtonText("Pulling...");
                        btn.setDisabled(true);
                        try {
                            await this.deps.cloneFromRemote();
                            this.deps.refresh();
                        } catch {
                            btn.setButtonText("Clone");
                            btn.setDisabled(false);
                        }
                    })
            );

        // ── Step 3: Sync ────────────────────────────────────────
        el.createEl("h3", { text: "Step 3: Sync" });

        new Setting(el)
            .setName("Live Sync")
            .setDesc(
                state === "syncing"
                    ? "Bidirectional live sync is active."
                    : state === "setupDone"
                        ? "Enable to start live bidirectional sync."
                        : "Complete Init or Clone first."
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(state === "syncing")
                    .setDisabled(!syncToggleEnabled)
                    .onChange(async (value) => {
                        // Sync start/stop is visible in the status bar dot and
                        // label — no toast needed.
                        if (value) {
                            await this.deps.updateSettings({ connectionState: "syncing" });
                            await this.deps.startSync();
                        } else {
                            this.deps.stopSync();
                            await this.deps.updateSettings({ connectionState: "setupDone" });
                        }
                        this.deps.refresh();
                    })
            );

        // ── Step 4: Filters (vault file inclusion / exclusion) ─
        el.createEl("h3", { text: "Step 4: Filters" });
        el.createEl("p", {
            text:
                "Control which vault files are eligible for sync. " +
                "These settings only affect this device — peers may have different filters.",
            cls: "setting-item-description",
        });

        const settings = this.deps.getSettings();

        new Setting(el)
            .setName("Sync filter (RegExp)")
            .setDesc("Only sync files matching this pattern. Leave empty to sync all.")
            .addText((text) =>
                text
                    .setPlaceholder(".*\\.md$")
                    .setValue(settings.syncFilter)
                    .onChange(async (value) => {
                        await this.deps.updateSettings({ syncFilter: value });
                    })
            );

        new Setting(el)
            .setName("Ignore filter (RegExp)")
            .setDesc("Skip files matching this pattern.")
            .addText((text) =>
                text
                    .setPlaceholder("node_modules|^\\.trash")
                    .setValue(settings.syncIgnore)
                    .onChange(async (value) => {
                        await this.deps.updateSettings({ syncIgnore: value });
                    })
            );

        new Setting(el)
            .setName("Max file size (MB)")
            .setDesc("Files larger than this will not be synced. Set to 0 to skip all files (useful for testing).")
            .addText((text) =>
                text
                    .setValue(String(settings.maxFileSizeMB))
                    .onChange(async (value) => {
                        const num = parseFloat(value);
                        if (!isNaN(num) && num >= 0) {
                            await this.deps.updateSettings({ maxFileSizeMB: num });
                        }
                    })
            );

        // ── Skipped large files ─────────────────────────────────
        renderSkippedFiles(el, this.deps);
    }

    private renderField(
        el: HTMLElement,
        name: string,
        field: keyof Draft,
        placeholder: string,
        locked: boolean,
        isPassword = false,
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
            if (isPassword) text.inputEl.type = "password";
            text.setDisabled(locked);
        });
    }

    private async handleTest(btn: ButtonComponent): Promise<void> {
        btn.setButtonText("Testing...");
        btn.setDisabled(true);
        const error = await this.deps.replicator.testConnectionWith(
            this.draft.uri,
            this.draft.user,
            this.draft.pass,
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
            couchdbUri: this.draft.uri,
            couchdbUser: this.draft.user,
            couchdbPassword: this.draft.pass,
            couchdbDbName: this.draft.db,
            connectionState: "tested",
        });
        this.testPassed = false;
        this.deps.refresh();
    }

    private renderDeviceIdentity(el: HTMLElement, locked: boolean): void {
        const settings = this.deps.getSettings();
        const isLegacy = /^[0-9a-f]{8}-/.test(settings.deviceId);
        const isEmpty = !settings.deviceId;

        el.createEl("h3", { text: "Device Name" });
        el.createEl("p", {
            text: "Unique name for this vault copy (e.g. desktop, iphone). " +
                "Each device must have a different name. " +
                "Using the same name on two devices will cause data corruption.",
            cls: "setting-item-description",
        });

        let inputValue = isLegacy ? "" : settings.deviceId;
        let validationMsg: HTMLElement | null = null;

        const setting = new Setting(el).setName("Device name");

        setting.addText((text) => {
            text.setPlaceholder("desktop")
                .setValue(inputValue)
                .onChange((value) => {
                    inputValue = value;
                    if (validationMsg) {
                        const error = validateDeviceName(value);
                        validationMsg.textContent = error ?? "";
                        validationMsg.style.display = error ? "block" : "none";
                    }
                });
            text.setDisabled(locked);
        });

        setting.addButton((btn) =>
            btn
                .setButtonText("Apply")
                .setCta()
                .setDisabled(locked)
                .onClick(async () => {
                    const error = validateDeviceName(inputValue);
                    if (error) {
                        new Notice(error);
                        return;
                    }
                    if (inputValue === settings.deviceId) {
                        new Notice("Device name unchanged.");
                        return;
                    }
                    if (settings.deviceId) {
                        const prev = [...(settings.previousDeviceIds ?? [])];
                        if (!prev.includes(settings.deviceId)) {
                            prev.push(settings.deviceId);
                        }
                        await this.deps.updateSettings({
                            deviceId: inputValue,
                            previousDeviceIds: prev,
                        });
                    } else {
                        await this.deps.updateSettings({ deviceId: inputValue });
                    }
                    new Notice(`Device name set to "${inputValue}". Restart sync to apply.`);
                    this.deps.refresh();
                }),
        );

        validationMsg = el.createEl("p", {
            cls: "setting-item-description mod-warning",
        });
        validationMsg.style.display = "none";

        if (isEmpty) {
            el.createEl("p", {
                text: "Device name is required before sync can start.",
                cls: "setting-item-description mod-warning",
            });
        } else if (isLegacy) {
            el.createEl("p", {
                text: "Currently using an auto-generated ID. Set a name for stable sync.",
                cls: "setting-item-description mod-warning",
            });
        }

        if (isLegacy) {
            const detail = el.createEl("details");
            detail.createEl("summary", { text: "Current auto-generated ID" });
            detail.createEl("code", { text: settings.deviceId });
        }
    }
}

const DEVICE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/;

function validateDeviceName(name: string): string | null {
    if (!name) return "Device name is required.";
    if (name.length < 2) return "Device name must be at least 2 characters.";
    if (name.length > 30) return "Device name must be 30 characters or fewer.";
    if (!DEVICE_NAME_RE.test(name)) {
        return "Use lowercase letters, numbers, and hyphens only (e.g. desktop, iphone-pro).";
    }
    return null;
}

/**
 * Render the "Skipped large files" section. Async — fetches the
 * `_local/skipped-files` doc and populates a container inline so it
 * doesn't block the rest of the tab render. Migrated from files-tab.ts
 * unchanged in v0.11.0.
 */
function renderSkippedFiles(el: HTMLElement, deps: VaultSyncTabDeps): void {
    const container = el.createDiv();
    container.createEl("h3", { text: "Skipped large files" });
    container.createEl("p", {
        text:
            "These files exceeded the size limit and were not synced. " +
            "Raise the limit above, then edit or save the file to re-sync it.",
        cls: "setting-item-description",
    });

    const list = container.createDiv();
    list.createEl("div", { text: "Loading...", cls: "setting-item-description" });

    void (async () => {
        const doc = await deps.localDb.getSkippedFiles();
        const entries = Object.entries(doc.files).sort((a, b) => b[1].sizeMB - a[1].sizeMB);
        list.empty();

        if (entries.length === 0) {
            list.createEl("div", {
                text: "No skipped files.",
                cls: "setting-item-description",
            });
            return;
        }

        for (const [path, info] of entries) {
            new Setting(list)
                .setName(path)
                .setDesc(`${info.sizeMB} MB — skipped ${formatAge(info.skippedAt)}`)
                .addButton((btn) =>
                    btn
                        .setButtonText("Forget")
                        .setTooltip("Remove from this list without syncing")
                        .onClick(async () => {
                            const current = await deps.localDb.getSkippedFiles();
                            delete current.files[path];
                            await deps.localDb.putSkippedFiles(current);
                            deps.refresh();
                        }),
                );
        }
    })();
}

function formatAge(timestamp: number): string {
    const diffSec = Math.floor((Date.now() - timestamp) / 1000);
    if (diffSec < 60) return "just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
}
