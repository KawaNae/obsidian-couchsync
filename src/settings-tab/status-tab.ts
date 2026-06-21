/**
 * CouchDB tab — server connection + dashboard.
 *
 * Owns the shared server credentials (URI / username / password) used by
 * both vault and config sync. Moved to the first tab position in v0.30.0
 * to make the setup flow natural: connect to server first, then configure
 * individual sync targets.
 *
 * Also renders the existing server info + database list dashboard (read
 * from the live server state via raw fetch, not CouchClient).
 */
import { type App, Modal, Notice, Setting, type ButtonComponent } from "obsidian";
import type { CouchSyncSettings, ConnectionState } from "../settings.ts";
import type { SyncEngine } from "../db/sync-engine.ts";
import type { AuthGate } from "../db/sync/auth-gate.ts";
import { ConfirmModal } from "../ui/confirm-modal.ts";
import {
    AuthError, fetchJson, deleteDb, formatBytes, formatTimestamp,
    type ServerInfo, type DbInfo,
} from "./couch-fetch.ts";
import { addPasswordToggle } from "./vault-sync-tab.ts";

class TypeToConfirmModal extends Modal {
    private resolved = false;
    private resolve: (value: boolean) => void = () => {};

    constructor(app: App, private expectedName: string) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: "Type database name to confirm" });
        contentEl.createEl("p", {
            text: `Type "${this.expectedName}" to permanently delete this database.`,
        });

        let deleteBtnComponent: ButtonComponent;
        const setting = new Setting(contentEl)
            .addText((text) => {
                text.setPlaceholder(this.expectedName);
                text.onChange((value) => {
                    const matches = value === this.expectedName;
                    deleteBtnComponent.setDisabled(!matches);
                    deleteBtnComponent.buttonEl.toggleClass("mod-warning", matches);
                });
            })
            .addButton((btn) => {
                deleteBtnComponent = btn;
                btn.setButtonText("Delete").setDisabled(true);
                btn.onClick(() => {
                    this.resolved = true;
                    this.resolve(true);
                    this.close();
                });
            })
            .addButton((btn) =>
                btn.setButtonText("Cancel").onClick(() => {
                    this.resolved = true;
                    this.resolve(false);
                    this.close();
                }),
            );
        // Prevent Obsidian from auto-focusing the delete button.
        const input = setting.controlEl.querySelector("input");
        if (input) setTimeout(() => input.focus(), 0);
    }

    onClose(): void {
        if (!this.resolved) this.resolve(false);
        this.contentEl.empty();
    }

    waitForResult(): Promise<boolean> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }
}

// ── Public interface ──────────────────────────────────────────────────

export interface CouchDbTabDeps {
    app: App;
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    replicator: SyncEngine;
    auth: AuthGate;
    refresh: () => void;
}

interface Draft {
    uri: string;
    user: string;
    pass: string;
}

export class CouchDbTab {
    private draft: Draft;
    private testPassed = false;
    private pencils = new Map<keyof Draft, HTMLSpanElement>();
    private applyBtn: ButtonComponent | null = null;
    private applyDesc: HTMLElement | null = null;

    constructor(private deps: CouchDbTabDeps) {
        this.draft = this.savedToDraft();
    }

    updateDeps(deps: CouchDbTabDeps): void {
        this.deps = deps;
    }

    resetDraft(): void {
        this.draft = this.savedToDraft();
        this.testPassed = false;
    }

    private savedToDraft(): Draft {
        const s = this.deps.getSettings();
        return { uri: s.couchdbUri, user: s.couchdbUser, pass: s.couchdbPassword };
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
                ? "Save server connection."
                : "Test connection first.";
        }
    }

    render(el: HTMLElement): void {
        const settings = this.deps.getSettings();
        const locked = settings.connectionState === "syncing";

        this.pencils.clear();
        this.applyBtn = null;
        this.applyDesc = null;

        // ── Server Connection ──────────────────────────────────────
        el.createEl("h3", { text: "Server Connection" });

        if (locked) {
            el.createEl("p", {
                text: "Disable sync to change server connection.",
                cls: "setting-item-description",
            });
        }

        this.renderField(el, "Server URI", "uri", "https://localhost:5984", locked);
        this.renderField(el, "Username", "user", "admin", locked);
        this.renderField(el, "Password", "pass", "password", locked, true, true);

        new Setting(el)
            .setName("Test Connection")
            .setDesc("Verify server is reachable with these credentials")
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
                    ? "Save server connection."
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

        // ── Server Info + Database List (dashboard) ────────────────
        this.renderDashboard(el, settings);
    }

    private renderField(
        el: HTMLElement,
        name: string,
        field: keyof Draft,
        placeholder: string,
        locked: boolean,
        isPassword = false,
        showToggle = false,
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
            if (isPassword) text.inputEl.type = "password";
            text.setDisabled(locked);
        });
        if (showToggle) addPasswordToggle(setting);
    }

    private async handleTest(btn: ButtonComponent): Promise<void> {
        btn.setButtonText("Testing...");
        btn.setDisabled(true);

        const baseUri = this.draft.uri.replace(/\/+$/, "");
        if (!baseUri) {
            this.testPassed = false;
            new Notice("Server URI is required.", 5000);
            this.deps.refresh();
            return;
        }

        try {
            await fetchJson(baseUri, this.draft.user, this.draft.pass);
            this.testPassed = true;
            this.deps.auth.clear();
            new Notice("Server connection successful!", 3000);
        } catch (e: any) {
            this.testPassed = false;
            if (e instanceof AuthError) {
                this.deps.auth.raise(e.status, e.message);
                new Notice(`Authentication failed (${e.status}): ${e.message}`, 8000);
            } else {
                new Notice(`Connection failed: ${e.message}`, 8000);
            }
        }
        this.deps.refresh();
    }

    private async handleApply(): Promise<void> {
        const saved = this.savedToDraft();
        const credentialsChanged =
            this.draft.uri !== saved.uri
            || this.draft.user !== saved.user
            || this.draft.pass !== saved.pass;

        const patch: Partial<CouchSyncSettings> = {
            couchdbUri: this.draft.uri,
            couchdbUser: this.draft.user,
            couchdbPassword: this.draft.pass,
            serverTested: true,
        };

        if (credentialsChanged) {
            patch.connectionState = "editing";
        }

        await this.deps.updateSettings(patch);
        this.testPassed = false;
        this.deps.refresh();
    }

    // ── Dashboard (server info + database list) ───────────────────

    private renderDashboard(el: HTMLElement, settings: CouchSyncSettings): void {
        const baseUri = settings.couchdbUri.replace(/\/$/, "");

        if (!baseUri || !settings.serverTested) {
            el.createEl("h3", { text: "Server Info" });
            el.createEl("p", {
                text: "Test and apply server connection first.",
                cls: "setting-item-description",
            });
            return;
        }

        if (this.deps.auth.isBlocked()) {
            this.renderAuthBlocked(el);
            return;
        }

        el.createEl("h3", { text: "Server Info" });
        const serverSection = el.createDiv();
        serverSection.createEl("p", { text: "Loading...", cls: "setting-item-description" });

        el.createEl("h3", { text: "Databases" });
        const dbSection = el.createDiv();
        dbSection.createEl("p", { text: "Loading...", cls: "setting-item-description" });

        const { couchdbUser: user, couchdbPassword: pass, couchdbDbName, couchdbConfigDbName } = settings;
        const connectedDbs = new Set<string>([couchdbDbName]);
        if (couchdbConfigDbName) connectedDbs.add(couchdbConfigDbName);

        (async () => {
            const ok = await this.loadServerInfo(serverSection, baseUri, user, pass);
            if (!ok) {
                dbSection.empty();
                dbSection.createEl("p", {
                    text: "Skipped — authentication failed.",
                    cls: "setting-item-description mod-warning",
                });
                return;
            }
            await this.loadDatabases(dbSection, baseUri, user, pass, connectedDbs);
        })();
    }

    private renderAuthBlocked(el: HTMLElement): void {
        el.createEl("h3", { text: "Authentication error" });
        el.createEl("p", {
            text:
                "CouchSync stopped contacting the server because credentials were " +
                "rejected. Update the server connection above, then retry.",
            cls: "setting-item-description mod-warning",
        });
        new Setting(el)
            .setName("Retry")
            .setDesc("Clear the auth-blocked flag and try loading server info again.")
            .addButton((btn) =>
                btn.setButtonText("Retry").onClick(() => {
                    this.deps.auth.clear();
                    this.deps.refresh();
                }),
            );
    }

    private async loadServerInfo(
        el: HTMLElement, baseUri: string, user: string, pass: string,
    ): Promise<boolean> {
        try {
            const info: ServerInfo = await fetchJson(baseUri, user, pass);
            el.empty();
            new Setting(el).setName("Version").setDesc(info.version);
            new Setting(el).setName("UUID").setDesc(info.uuid);
            if (info.features?.length > 0) {
                new Setting(el).setName("Features").setDesc(info.features.join(", "));
            }
            return true;
        } catch (e: any) {
            el.empty();
            if (e instanceof AuthError) {
                this.deps.auth.raise(e.status, e.message);
                el.createEl("p", {
                    text: `Authentication failed (${e.status}): ${e.message}`,
                    cls: "setting-item-description mod-warning",
                });
            } else {
                el.createEl("p", {
                    text: `Failed to connect: ${e.message}`,
                    cls: "setting-item-description mod-warning",
                });
            }
            return false;
        }
    }

    private async loadDatabases(
        el: HTMLElement, baseUri: string, user: string, pass: string,
        connectedDbs: Set<string>,
    ): Promise<void> {
        try {
            const allDbs: string[] = await fetchJson(`${baseUri}/_all_dbs`, user, pass);
            const userDbs = allDbs.filter((name) => !name.startsWith("_"));

            const infos: (DbInfo | null)[] = [];
            const lastUpdates: (number | null)[] = [];
            for (const name of userDbs) {
                try {
                    infos.push(await fetchJson(`${baseUri}/${encodeURIComponent(name)}`, user, pass));
                } catch (e) {
                    if (e instanceof AuthError) {
                        this.deps.auth.raise(e.status, e.message);
                        el.empty();
                        el.createEl("p", {
                            text: `Authentication failed (${e.status}): ${e.message}`,
                            cls: "setting-item-description mod-warning",
                        });
                        return;
                    }
                    infos.push(null);
                }
                try {
                    lastUpdates.push(await getLastUpdateTime(baseUri, user, pass, name));
                } catch (e) {
                    if (e instanceof AuthError) {
                        this.deps.auth.raise(e.status, e.message);
                        el.empty();
                        el.createEl("p", {
                            text: `Authentication failed (${e.status}): ${e.message}`,
                            cls: "setting-item-description mod-warning",
                        });
                        return;
                    }
                    lastUpdates.push(null);
                }
            }

            el.empty();

            if (userDbs.length === 0) {
                el.createEl("p", { text: "No databases found.", cls: "setting-item-description" });
                return;
            }

            const totalDocs = infos.reduce((sum, i) => sum + (i?.doc_count ?? 0), 0);
            const totalSize = infos.reduce((sum, i) => sum + (i?.sizes?.file ?? 0), 0);
            el.createEl("p", {
                text: `${userDbs.length} database(s) — ${totalDocs.toLocaleString()} docs — ${formatBytes(totalSize)} on disk`,
                cls: "setting-item-description",
            });

            for (let idx = 0; idx < userDbs.length; idx++) {
                const name = userDbs[idx];
                const info = infos[idx];
                const isCurrent = connectedDbs.has(name);
                const label = isCurrent ? `${name} (connected)` : name;

                const lastUpdate = lastUpdates[idx];
                const desc = info
                    ? [
                        `${info.doc_count.toLocaleString()} docs`,
                        `disk: ${formatBytes(info.sizes.file)}`,
                        `active: ${formatBytes(info.sizes.active)}`,
                        lastUpdate ? `updated: ${formatTimestamp(lastUpdate)}` : "",
                    ].filter(Boolean).join(" — ")
                    : "(unable to read)";

                const setting = new Setting(el).setName(label).setDesc(desc);

                if (isCurrent) {
                    setting.nameEl.addClass("mod-warning");
                } else {
                    setting.addButton((btn) =>
                        btn
                            .setButtonText("Delete")
                            .setWarning()
                            .onClick(() => this.confirmAndDelete(baseUri, user, pass, name, info))
                    );
                }
            }
        } catch (e: any) {
            el.empty();
            if (e instanceof AuthError) {
                this.deps.auth.raise(e.status, e.message);
                el.createEl("p", {
                    text: `Authentication failed (${e.status}): ${e.message}`,
                    cls: "setting-item-description mod-warning",
                });
            } else {
                el.createEl("p", {
                    text: `Failed to list databases: ${e.message}`,
                    cls: "setting-item-description mod-warning",
                });
            }
        }
    }

    private async confirmAndDelete(
        baseUri: string, user: string, pass: string,
        dbName: string, info: DbInfo | null,
    ): Promise<void> {
        const sizeDesc = info
            ? `${info.doc_count.toLocaleString()} docs, ${formatBytes(info.sizes.file)}`
            : "unknown size";

        const first = await new ConfirmModal(
            this.deps.app,
            `Delete "${dbName}"?`,
            `This will permanently delete the database "${dbName}" (${sizeDesc}) from the CouchDB server. This action cannot be undone.`,
            "Delete",
            true,
        ).waitForResult();
        if (!first) return;

        const typed = await new TypeToConfirmModal(this.deps.app, dbName).waitForResult();
        if (!typed) return;

        try {
            await deleteDb(baseUri, user, pass, dbName);
            new Notice(`CouchSync: Database "${dbName}" deleted.`);
            this.deps.refresh();
        } catch (e: any) {
            new Notice(`CouchSync: Failed to delete "${dbName}": ${e.message}`);
        }
    }
}

// ── Private helpers ───────────────────────────────────────────────────

async function getLastUpdateTime(
    baseUri: string, user: string, pass: string, dbName: string,
): Promise<number | null> {
    const url = `${baseUri}/${encodeURIComponent(dbName)}/_changes?descending=true&limit=20&include_docs=true`;
    let data: any;
    try {
        data = await fetchJson(url, user, pass);
    } catch (e) {
        if (e instanceof AuthError) throw e;
        return null;
    }
    let fallbackMtime: number | null = null;
    for (const result of data.results ?? []) {
        const doc = result.doc;
        if (!doc) continue;
        if (doc.type === "file" && !doc.deleted) {
            return doc.mtime ?? null;
        }
        if (!fallbackMtime && typeof doc.mtime === "number") {
            fallbackMtime = doc.mtime;
        }
    }
    return fallbackMtime;
}
