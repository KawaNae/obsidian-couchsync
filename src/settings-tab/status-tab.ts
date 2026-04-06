import { Setting } from "obsidian";
import type { CouchSyncSettings } from "../settings.ts";

interface StatusTabDeps {
    getSettings: () => CouchSyncSettings;
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

async function fetchJson(url: string, user: string, pass: string): Promise<any> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (user) {
        headers["Authorization"] = "Basic " + btoa(`${user}:${pass}`);
    }
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
}

export function renderStatusTab(el: HTMLElement, deps: StatusTabDeps): void {
    const settings = deps.getSettings();
    const baseUri = settings.couchdbUri.replace(/\/$/, "");

    if (!baseUri) {
        el.createEl("p", { text: "No CouchDB URI configured.", cls: "setting-item-description" });
        return;
    }

    el.createEl("h3", { text: "Server" });
    const serverSection = el.createDiv();
    serverSection.createEl("p", { text: "Loading...", cls: "setting-item-description" });

    el.createEl("h3", { text: "Databases" });
    const dbSection = el.createDiv();
    dbSection.createEl("p", { text: "Loading...", cls: "setting-item-description" });

    const { couchdbUser: user, couchdbPassword: pass, couchdbDbName } = settings;

    loadServerInfo(serverSection, baseUri, user, pass);
    loadDatabases(dbSection, baseUri, user, pass, couchdbDbName);
}

async function loadServerInfo(
    el: HTMLElement, baseUri: string, user: string, pass: string,
): Promise<void> {
    try {
        const info: ServerInfo = await fetchJson(baseUri, user, pass);
        el.empty();

        new Setting(el).setName("Version").setDesc(info.version);
        new Setting(el).setName("UUID").setDesc(info.uuid);

        if (info.features?.length > 0) {
            new Setting(el).setName("Features").setDesc(info.features.join(", "));
        }
    } catch (e: any) {
        el.empty();
        el.createEl("p", {
            text: `Failed to connect: ${e.message}`,
            cls: "setting-item-description mod-warning",
        });
    }
}

async function loadDatabases(
    el: HTMLElement, baseUri: string, user: string, pass: string, currentDb: string,
): Promise<void> {
    try {
        const allDbs: string[] = await fetchJson(`${baseUri}/_all_dbs`, user, pass);
        const userDbs = allDbs.filter((name) => !name.startsWith("_"));

        const infos = await Promise.all(
            userDbs.map(async (name): Promise<DbInfo | null> => {
                try {
                    return await fetchJson(`${baseUri}/${encodeURIComponent(name)}`, user, pass);
                } catch {
                    return null;
                }
            }),
        );

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

            if (info) {
                const desc = [
                    `${info.doc_count.toLocaleString()} docs`,
                    `disk: ${formatBytes(info.sizes.file)}`,
                    `active: ${formatBytes(info.sizes.active)}`,
                ].join(" — ");

                const setting = new Setting(el).setName(label).setDesc(desc);
                if (isCurrent) {
                    setting.nameEl.addClass("mod-warning");
                }
            } else {
                new Setting(el).setName(label).setDesc("(unable to read)");
            }
        }
    } catch (e: any) {
        el.empty();
        el.createEl("p", {
            text: `Failed to list databases: ${e.message}`,
            cls: "setting-item-description mod-warning",
        });
    }
}
