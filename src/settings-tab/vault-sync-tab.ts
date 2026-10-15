/**
 * Vault Sync settings tab.
 *
 * Owns the vault-side database selection (Step 2), the Init/Clone setup
 * actions (Step 3), the live sync toggle (Step 4), and the vault file
 * filters. Server connection (URI / user / password) lives in the CouchDB
 * tab since v0.30.0 — this tab reads them from saved settings.
 */
import { type App, Setting, type ButtonComponent } from "obsidian";
import { MAX_PREVIOUS_DEVICE_IDS, type ConnectionState, type CouchSyncSettings } from "../settings.ts";
import type { SyncEngine } from "../db/sync-engine.ts";
import type { AuthGate } from "../db/sync/auth-gate.ts";
import { describeDbFound, type DbCheckResult } from "../db/sync/vault-remote-ops.ts";
import type { LocalDB } from "../db/local-db.ts";
import { validateDeviceName } from "../utils/device-name.ts";
import { setupGating } from "./setup-gating.ts";
import { reportError, showNotice } from "../ui/notices.ts";
import { describeError } from "../ui/describe-error.ts";
import type { VaultBinding, VaultRelation } from "../sync/vault-binding.ts";
import { cloneDescription, encryptionChangedElsewhere, vaultRelationView } from "./vault-relation-view.ts";

export interface VaultSyncTabDeps {
    app: App;
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    replicator: SyncEngine;
    auth: AuthGate;
    localDb: LocalDB;
    /** Owner of the vault setup: Init, Clone and every change of the setup
     *  state go through it. */
    vault: VaultBinding;
    refresh: () => void;
}

interface Draft {
    db: string;
}

export class VaultSyncTab {
    private draft: Draft;
    private testPassed = false;
    private pencils = new Map<keyof Draft, HTMLSpanElement>();
    private applyBtn: ButtonComponent | null = null;
    private applyDesc: HTMLElement | null = null;

    constructor(private deps: VaultSyncTabDeps) {
        this.draft = this.savedToDraft();
    }

    updateDeps(deps: VaultSyncTabDeps): void {
        this.deps = deps;
    }

    resetDraft(): void {
        this.draft = this.savedToDraft();
        this.testPassed = false;
    }

    private savedToDraft(): Draft {
        const s = this.deps.getSettings();
        return { db: s.couchdbDbName };
    }

    private isFieldDirty(field: keyof Draft): boolean {
        const saved = this.savedToDraft();
        return this.draft[field] !== saved[field];
    }

    private updateDirtyState(): void {
        for (const [field, pencilEl] of this.pencils) {
            pencilEl.style.display = this.isFieldDirty(field) ? "inline" : "none";
        }
        if (this.applyBtn) {
            this.applyBtn.setDisabled(!this.testPassed);
        }
        if (this.applyDesc) {
            this.applyDesc.textContent = this.testPassed
                ? "Save database selection."
                : "Check database first.";
        }
    }

    render(el: HTMLElement): void {
        const settings = this.deps.getSettings();
        const state = settings.connectionState;
        const { locked, initEnabled, cloneEnabled, syncToggleEnabled } =
            setupGating(state, settings.serverTested);
        const relation = this.deps.vault.relation();
        const idle = relation.busy === null;
        // A config Pull reloads Obsidian when it writes files, which would
        // stop an Init or Clone half-way.
        const reloadFree = this.deps.vault.reloadConflict() === null;

        this.pencils.clear();
        this.applyBtn = null;
        this.applyDesc = null;

        // ── Device Identity ────────────────────────────────────
        this.renderDeviceIdentity(el, locked);

        // ── Step 1: Encryption ─────────────────────────────────
        this.renderEncryptionStep(el, relation);

        // ── Step 2: Database ───────────────────────────────────
        el.createEl("h3", { text: "Step 2: Database" });

        if (!settings.serverTested) {
            el.createEl("p", {
                text: "Complete server connection in the CouchDB tab first.",
                cls: "setting-item-description",
            });
        } else if (locked) {
            el.createEl("p", {
                text: "Disable sync to change database.",
                cls: "setting-item-description",
            });
        }

        const dbEditable = settings.serverTested && !locked;

        this.renderDbField(el, "Vault Database Name", "db", "obsidian", !dbEditable);

        new Setting(el)
            .setName("Check Database")
            .setDesc("Verify the database exists or create it")
            .addButton((btn) =>
                btn
                    .setButtonText("Check")
                    .setDisabled(!dbEditable)
                    .onClick(async () => this.handleCheck(btn))
            );

        const draftCheck = this.deps.vault.dbCheckFor(this.draft.db);
        if (draftCheck) this.renderCheckResult(el, draftCheck.result);

        const applySetting = new Setting(el)
            .setName("Apply")
            .setDesc(
                this.testPassed
                    ? "Save database selection."
                    : "Check database first."
            )
            .addButton((btn) => {
                this.applyBtn = btn;
                btn
                    .setButtonText("Apply")
                    .setDisabled(!dbEditable || !this.testPassed)
                    .onClick(async () => this.handleApply());
            });
        this.applyDesc = applySetting.settingEl.querySelector(
            ".setting-item-description",
        ) as HTMLElement;

        // ── Step 3: Setup ───────────────────────────────────────
        el.createEl("h3", { text: "Step 3: Setup" });

        const auth = this.deps.auth;
        const view = vaultRelationView(relation, auth.isBlocked() ? auth.blockedError() : null);
        const stateLine = el.createEl("p", {
            text: view.text,
            cls: view.tone === "error" ? "setting-item-description mod-warning" : "setting-item-description",
        });
        stateLine.style.color = view.tone === "ok" ? "var(--text-success)"
            : view.tone === "error" ? "var(--text-error)" : "";

        new Setting(el)
            .setName("Init")
            .setDesc("Push local vault to empty remote database (1st device)")
            .addButton((btn) =>
                btn
                    .setButtonText("Init")
                    .setDisabled(!initEnabled || !idle || !reloadFree)
                    .onClick(async () => {
                        btn.setButtonText("Pushing...");
                        btn.setDisabled(true);
                        // The binding reports and records a failure, and
                        // announces each change, which redraws the tab.
                        await this.deps.vault.init().catch(() => {});
                    })
            );

        new Setting(el)
            .setName("Clone")
            .setDesc(cloneDescription(relation.dbCheck))
            .addButton((btn) =>
                btn
                    .setButtonText("Clone")
                    .setDisabled(!cloneEnabled || !idle || !reloadFree)
                    .onClick(async () => {
                        btn.setButtonText("Pulling...");
                        btn.setDisabled(true);
                        // The binding reports and records a failure, and
                        // announces each change, which redraws the tab.
                        await this.deps.vault.clone().catch(() => {});
                    })
            );

        // ── Step 4: Sync ────────────────────────────────────────
        el.createEl("h3", { text: "Step 4: Sync" });

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
                    .setDisabled(!syncToggleEnabled || !idle)
                    .onChange(async (value) => {
                        await this.changeSetup("Live Sync change", () => this.deps.vault.setLiveSync(value));
                    })
            );

        // ── Filters (vault file inclusion / exclusion) ──────────
        this.renderFilters(el, settings);
    }

    // ── Step 2 helpers ────────────────────────────────────────────

    private renderDbField(
        el: HTMLElement,
        name: string,
        field: keyof Draft,
        placeholder: string,
        disabled: boolean,
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
            text.setDisabled(disabled);
        });
    }

    private async handleCheck(btn: ButtonComponent): Promise<void> {
        btn.setButtonText("Checking...");
        btn.setDisabled(true);
        const result = await this.deps.vault.checkDatabase(this.draft.db);
        this.testPassed = result.status !== "error";
        this.deps.refresh();
    }

    private renderCheckResult(el: HTMLElement, r: DbCheckResult): void {
        // An empty DB's next step (Init) is on Clone's description.
        const text = r.status === "error"
            ? `Error: ${describeError(r.error).text}`
            : `Database ${describeDbFound(r)}`;
        const p = el.createEl("p", {
            text,
            cls: r.status === "error" ? "setting-item-description mod-warning" : "setting-item-description",
        });
        p.style.color = r.status === "error" ? "var(--text-error)" : "var(--text-success)";
    }

    private async handleApply(): Promise<void> {
        await this.changeSetup("Database change", async () => {
            await this.deps.vault.applyDatabase(this.draft.db);
            this.testPassed = false;
        });
    }

    /** Run `label`, a change of the vault setup; a refusal (Init or Clone
     *  runs) or a failure is reported under `label`. The tab is redrawn
     *  either way, which puts back the saved value of a refused change. */
    private async changeSetup(label: string, change: () => Promise<void>): Promise<void> {
        try {
            await change();
        } catch (e) {
            reportError(label, e);
        }
        this.deps.refresh();
    }

    // ── Device Identity ───────────────────────────────────────────

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
                        showNotice(error);
                        return;
                    }
                    if (inputValue === settings.deviceId) {
                        showNotice("Device name unchanged.");
                        return;
                    }
                    if (settings.deviceId) {
                        const prev = [...(settings.previousDeviceIds ?? [])];
                        if (!prev.includes(settings.deviceId)) {
                            prev.push(settings.deviceId);
                        }
                        await this.deps.updateSettings({
                            deviceId: inputValue,
                            previousDeviceIds: prev.slice(-MAX_PREVIOUS_DEVICE_IDS),
                        });
                    } else {
                        await this.deps.updateSettings({ deviceId: inputValue });
                    }
                    showNotice(`Device name set to "${inputValue}". Restart sync to apply.`);
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

    // ── Step 1: Encryption ────────────────────────────────────────

    private renderEncryptionStep(el: HTMLElement, relation: VaultRelation): void {
        const settings = this.deps.getSettings();
        const state = settings.connectionState;
        const editable = state !== "syncing";

        el.createEl("h3", { text: "Step 1: Encryption" });
        el.createEl("p", {
            text: "End-to-end encrypt vault content before sending to the server. " +
                "All devices sharing this vault must use the same passphrase.",
            cls: "setting-item-description",
        });

        if (encryptionChangedElsewhere(relation)) {
            const warn = el.createEl("p", {
                text: "Encryption state was changed by another device. " +
                    "Adjust settings here, then re-run Init or Clone in Step 3.",
                cls: "setting-item-description mod-warning",
            });
            warn.style.color = "var(--text-error)";
        }

        new Setting(el)
            .setName("E2E encryption")
            .setDesc(
                editable
                    ? "For Init: choose a new passphrase. For Clone: the remote state is auto-detected."
                    : settings.encryptionEnabled
                        ? "Enabled — to change, disable sync first."
                        : "Disabled — to change, disable sync first."
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(settings.encryptionEnabled)
                    .setDisabled(!editable)
                    .onChange(async (value) => {
                        await this.changeSetup("Encryption change", () => this.deps.vault.changeCodecSetting(
                            value ? { encryptionEnabled: true } : { encryptionEnabled: false, encryptionPassphrase: "" },
                        ));
                    })
            );

        if (settings.encryptionEnabled) {
            const passphraseSetting = new Setting(el)
                .setName("Passphrase")
                .setDesc(
                    editable
                        ? "Required for Init. For Clone, you will be prompted if needed."
                        : "Stored passphrase for this vault."
                )
                .addText((text) => {
                    text.setPlaceholder("Enter passphrase")
                        .setValue(settings.encryptionPassphrase)
                        .onChange(async (value) => {
                            await this.deps.updateSettings({ encryptionPassphrase: value });
                        });
                    text.inputEl.type = "password";
                    text.setDisabled(!editable);
                });
            addPasswordToggle(passphraseSetting);
        }

        new Setting(el)
            .setName("Compress chunks (gzip)")
            .setDesc(
                editable
                    ? "Recommended. Gzip attachment bodies before transport. " +
                      "Cuts wire bytes substantially on text-heavy vaults. Disabling can " +
                      "reduce CPU on tiny vaults or for theoretical-best safety under " +
                      "exotic threat models."
                    : settings.compressionEnabled
                        ? "Enabled — to change, disable sync first."
                        : "Disabled — to change, disable sync first."
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(settings.compressionEnabled)
                    .setDisabled(!editable)
                    .onChange(async (value) => {
                        await this.changeSetup("Compression change", () => this.deps.vault.changeCodecSetting({ compressionEnabled: value }));
                    })
            );
    }

    // ── Filters ───────────────────────────────────────────────────

    private renderFilters(el: HTMLElement, settings: CouchSyncSettings): void {
        el.createEl("h3", { text: "Filters" });
        el.createEl("p", {
            text:
                "Control which vault files are eligible for sync. " +
                "These settings only affect this device — peers may have different filters.",
            cls: "setting-item-description",
        });

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

        renderSkippedFiles(el, this.deps);
    }
}


/**
 * Render the "Skipped large files" section. Async — fetches the
 * `_local/skipped-files` doc and populates a container inline so it
 * doesn't block the rest of the tab render.
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

export function addPasswordToggle(setting: Setting): void {
    const input = setting.controlEl.querySelector(
        'input[type="password"], input[type="text"]',
    ) as HTMLInputElement | null;
    if (!input) return;
    const btn = createEl("button", {
        cls: "cs-password-toggle clickable-icon",
        attr: { "aria-label": "Toggle visibility", tabindex: "-1" },
    });
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        const isHidden = input.type === "password";
        input.type = isHidden ? "text" : "password";
        btn.toggleClass("is-active", isHidden);
    });
    setting.controlEl.insertBefore(btn, input);
}
