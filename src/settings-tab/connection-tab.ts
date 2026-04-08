import { Notice, Setting, type ButtonComponent } from "obsidian";
import type { ConnectionState, CouchSyncSettings } from "../settings.ts";
import type { Replicator } from "../db/replicator.ts";

export interface ConnectionTabDeps {
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    replicator: Replicator;
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

export class ConnectionTab {
    private draft: Draft;
    private testPassed = false;

    // DOM references for in-place updates (no full re-render on keystroke)
    private pencils = new Map<keyof Draft, HTMLSpanElement>();
    private applyBtn: ButtonComponent | null = null;
    private applyDesc: HTMLElement | null = null;

    constructor(private deps: ConnectionTabDeps) {
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
        this.renderField(el, "Database Name", "db", "obsidian", locked);

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

        // Pencil icon — always created, visibility toggled in-place
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
            // A successful Test means the draft credentials work — clear
            // any latched auth-blocked flag so Status / Files tabs resume
            // auto-fetch once these credentials are applied.
            this.deps.replicator.clearAuthError();
            new Notice("Connection successful!", 3000);
        }
        this.deps.refresh();
    }

    private async handleApply(): Promise<void> {
        // Silent save — the Apply button disappearing and the tab re-rendering
        // into its "tested" state is feedback enough.
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
}
