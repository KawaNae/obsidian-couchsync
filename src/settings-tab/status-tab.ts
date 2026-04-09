import { type App, Modal, Notice, Setting } from "obsidian";
import type { CouchSyncSettings } from "../settings.ts";
import type { Replicator } from "../db/replicator.ts";
import { ConfirmModal } from "../ui/confirm-modal.ts";

/** Thrown internally when a fetch gets 401/403, so callers can abort. */
class AuthError extends Error {
    constructor(public status: number, reason: string) {
        super(reason);
    }
}

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

        let deleteBtnComponent: import("obsidian").ButtonComponent;
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
                })
            );

        // Focus the text input
        const input = setting.controlEl.querySelector("input");
        if (input) input.focus();
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

interface StatusTabDeps {
    getSettings: () => CouchSyncSettings;
    replicator: Replicator;
    app: App;
    refresh: () => void;
}

interface ServerInfo {
    version: string;
    uuid: string;
    features: string[];
}

interface DbInfo {
    db_name: string;
    doc_count: number;
    sizes: { file: number; active: number; external: number };
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const val = bytes / Math.pow(1024, i);
    return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatTimestamp(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function getLastUpdateTime(
    baseUri: string, user: string, pass: string, dbName: string,
): Promise<number | null> {
    const url = `${baseUri}/${encodeURIComponent(dbName)}/_changes?descending=true&limit=20&include_docs=true`;
    let data: any;
    try {
        data = await fetchJson(url, user, pass);
    } catch (e) {
        // Let AuthError bubble up so callers can latch and abort.
        if (e instanceof AuthError) throw e;
        return null;
    }
    let fallbackMtime: number | null = null;
    for (const result of data.results ?? []) {
        const doc = result.doc;
        if (!doc) continue;
        // CouchSync FileDoc — mtime is the recorded file timestamp at the
        // last sync point (ordering lives in vclock, not consulted here).
        if (doc.type === "file" && !doc.deleted) {
            return doc.mtime ?? null;
        }
        // Fallback: any doc with mtime (e.g. LiveSync "plain"/"leaf")
        if (!fallbackMtime && typeof doc.mtime === "number") {
            fallbackMtime = doc.mtime;
        }
    }
    return fallbackMtime;
}

async function fetchJson(url: string, user: string, pass: string): Promise<any> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (user) {
        headers["Authorization"] = "Basic " + btoa(`${user}:${pass}`);
    }
    const res = await fetch(url, { headers });
    if (res.status === 401 || res.status === 403) {
        // Parse the CouchDB reason body if present so the latch message is
        // actionable ("Account is temporarily locked..." etc.).
        let reason = res.statusText;
        try {
            const body = await res.json();
            if (body?.reason) reason = body.reason;
        } catch { /* ignore */ }
        throw new AuthError(res.status, reason);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
}

async function deleteDb(baseUri: string, user: string, pass: string, dbName: string): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (user) {
        headers["Authorization"] = "Basic " + btoa(`${user}:${pass}`);
    }
    const res = await fetch(`${baseUri}/${encodeURIComponent(dbName)}`, {
        method: "DELETE",
        headers,
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.reason || `HTTP ${res.status}`);
    }
}

export function renderStatusTab(el: HTMLElement, deps: StatusTabDeps): void {
    const settings = deps.getSettings();
    const baseUri = settings.couchdbUri.replace(/\/$/, "");

    if (!baseUri) {
        el.createEl("p", { text: "No CouchDB URI configured.", cls: "setting-item-description" });
        return;
    }

    // Bail out early if a prior 401/403 latched the auth-blocked flag.
    // Otherwise opening this tab fires a dozen parallel fetches that each
    // add a failed-login strike and trip CouchDB's brute-force lockout.
    if (deps.replicator.isAuthBlocked()) {
        renderAuthBlocked(el, deps);
        return;
    }

    el.createEl("h3", { text: "Server" });
    const serverSection = el.createDiv();
    serverSection.createEl("p", { text: "Loading...", cls: "setting-item-description" });

    el.createEl("h3", { text: "Databases" });
    const dbSection = el.createDiv();
    dbSection.createEl("p", { text: "Loading...", cls: "setting-item-description" });

    const { couchdbUser: user, couchdbPassword: pass, couchdbDbName } = settings;

    // Serialize: server info first. If auth fails there, abort before
    // triggering loadDatabases' N-way fetch burst.
    (async () => {
        const ok = await loadServerInfo(serverSection, baseUri, user, pass, deps);
        if (!ok) {
            dbSection.empty();
            dbSection.createEl("p", {
                text: "Skipped — authentication failed.",
                cls: "setting-item-description mod-warning",
            });
            return;
        }
        await loadDatabases(dbSection, baseUri, user, pass, couchdbDbName, deps);
    })();
}

function renderAuthBlocked(el: HTMLElement, deps: StatusTabDeps): void {
    el.createEl("h3", { text: "Authentication error" });
    el.createEl("p", {
        text:
            "CouchSync stopped contacting the server because credentials were " +
            "rejected. Update them in the Connection tab, then retry here.",
        cls: "setting-item-description mod-warning",
    });
    new Setting(el)
        .setName("Retry")
        .setDesc("Clear the auth-blocked flag and try loading server info again.")
        .addButton((btn) =>
            btn.setButtonText("Retry").onClick(() => {
                deps.replicator.clearAuthError();
                deps.refresh();
            }),
        );
}

/** @returns true on success, false if the request failed (auth or other). */
async function loadServerInfo(
    el: HTMLElement, baseUri: string, user: string, pass: string, deps: StatusTabDeps,
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
            deps.replicator.markAuthError(e.status, e.message);
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

async function loadDatabases(
    el: HTMLElement, baseUri: string, user: string, pass: string,
    currentDb: string, deps: StatusTabDeps,
): Promise<void> {
    try {
        const allDbs: string[] = await fetchJson(`${baseUri}/_all_dbs`, user, pass);
        const userDbs = allDbs.filter((name) => !name.startsWith("_"));

        // Serialize per-db fetches. If any one of them hits 401/403 we stop
        // immediately — otherwise a stale-credential state would burst out
        // N*2 failing requests and trip the server's brute-force lockout.
        const infos: (DbInfo | null)[] = [];
        const lastUpdates: (number | null)[] = [];
        for (const name of userDbs) {
            try {
                infos.push(await fetchJson(`${baseUri}/${encodeURIComponent(name)}`, user, pass));
            } catch (e) {
                if (e instanceof AuthError) {
                    deps.replicator.markAuthError(e.status, e.message);
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
                    deps.replicator.markAuthError(e.status, e.message);
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
            const isCurrent = name === currentDb;
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
                        .onClick(() => confirmAndDelete(deps, baseUri, user, pass, name, info))
                );
            }
        }
    } catch (e: any) {
        el.empty();
        if (e instanceof AuthError) {
            deps.replicator.markAuthError(e.status, e.message);
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

async function confirmAndDelete(
    deps: StatusTabDeps, baseUri: string, user: string, pass: string,
    dbName: string, info: DbInfo | null,
): Promise<void> {
    const sizeDesc = info
        ? `${info.doc_count.toLocaleString()} docs, ${formatBytes(info.sizes.file)}`
        : "unknown size";

    // Confirmation 1: intent
    const first = await new ConfirmModal(
        deps.app,
        `Delete "${dbName}"?`,
        `This will permanently delete the database "${dbName}" (${sizeDesc}) from the CouchDB server. This action cannot be undone.`,
        "Delete",
        true,
    ).waitForResult();
    if (!first) return;

    // Confirmation 2: type database name to confirm
    const typed = await new TypeToConfirmModal(deps.app, dbName).waitForResult();
    if (!typed) return;

    try {
        await deleteDb(baseUri, user, pass, dbName);
        new Notice(`CouchSync: Database "${dbName}" deleted.`);
        deps.refresh();
    } catch (e: any) {
        new Notice(`CouchSync: Failed to delete "${dbName}": ${e.message}`);
    }
}
