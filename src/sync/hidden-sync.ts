import type { App } from "obsidian";
import type { LocalDB } from "../db/local-db.ts";
import type { HiddenFileDoc } from "../types.ts";
import { DOC_PREFIX } from "../types.ts";
import type { CouchSyncSettings } from "../settings.ts";

export class HiddenSync {
    constructor(
        private app: App,
        private db: LocalDB,
        private getSettings: () => CouchSyncSettings
    ) {}

    /**
     * Scan .obsidian/ directory and sync hidden files to DB.
     */
    async scanAndSync(): Promise<number> {
        const settings = this.getSettings();
        if (settings.hiddenSyncMode !== "push" && settings.hiddenSyncMode !== "sync") return 0;

        const adapter = this.app.vault.adapter;
        const files = await this.listHiddenFiles(".obsidian");
        let synced = 0;

        for (const path of files) {
            if (this.shouldIgnore(path)) continue;
            try {
                const stat = await adapter.stat(path);
                if (!stat) continue;

                const docId = `${DOC_PREFIX.HIDDEN}${path}`;
                const existing = await this.db.get<HiddenFileDoc>(docId);

                if (!existing || existing.mtime < stat.mtime) {
                    const data = await adapter.read(path);
                    const doc: HiddenFileDoc = {
                        _id: docId,
                        type: "hidden",
                        data: data,
                        mtime: stat.mtime,
                        size: stat.size,
                    };
                    await this.db.put(doc);
                    synced++;
                }
            } catch (e) {
                console.error(`CouchSync: Failed to sync hidden file ${path}:`, e);
            }
        }
        return synced;
    }

    /**
     * Write a hidden file doc from DB back to the filesystem.
     */
    async dbToFile(doc: HiddenFileDoc): Promise<void> {
        const settings = this.getSettings();
        if (settings.hiddenSyncMode !== "pull" && settings.hiddenSyncMode !== "sync") return;

        const path = doc._id.slice(DOC_PREFIX.HIDDEN.length);

        if (doc.deleted) {
            try {
                if (await this.app.vault.adapter.exists(path)) {
                    await this.app.vault.adapter.remove(path);
                }
            } catch (e) {
                console.error(`CouchSync: Failed to delete hidden file ${path}:`, e);
            }
            return;
        }

        try {
            // Ensure parent directory exists
            const dir = path.split("/").slice(0, -1).join("/");
            if (dir && !(await this.app.vault.adapter.exists(dir))) {
                await this.app.vault.adapter.mkdir(dir);
            }
            await this.app.vault.adapter.write(path, doc.data);
        } catch (e) {
            console.error(`CouchSync: Failed to write hidden file ${path}:`, e);
        }
    }

    /**
     * Store a single hidden file to DB.
     */
    async fileToDb(path: string): Promise<void> {
        const settings = this.getSettings();
        if (settings.hiddenSyncMode !== "push" && settings.hiddenSyncMode !== "sync") return;
        if (this.shouldIgnore(path)) return;

        try {
            const adapter = this.app.vault.adapter;
            const stat = await adapter.stat(path);
            if (!stat) return;

            const data = await adapter.read(path);
            const doc: HiddenFileDoc = {
                _id: `${DOC_PREFIX.HIDDEN}${path}`,
                type: "hidden",
                data: data,
                mtime: stat.mtime,
                size: stat.size,
            };
            await this.db.put(doc);
        } catch (e) {
            console.error(`CouchSync: Failed to store hidden file ${path}:`, e);
        }
    }

    private shouldIgnore(path: string): boolean {
        const settings = this.getSettings();
        if (settings.hiddenSyncIgnore) {
            try {
                const re = new RegExp(settings.hiddenSyncIgnore);
                if (re.test(path)) return true;
            } catch { /* invalid regex */ }
        }
        return false;
    }

    private async listHiddenFiles(dir: string): Promise<string[]> {
        const adapter = this.app.vault.adapter;
        const result: string[] = [];

        try {
            const listing = await adapter.list(dir);
            for (const file of listing.files) {
                result.push(file);
            }
            for (const folder of listing.folders) {
                const subFiles = await this.listHiddenFiles(folder);
                result.push(...subFiles);
            }
        } catch (e) {
            console.error(`CouchSync: Failed to list ${dir}:`, e);
        }
        return result;
    }
}
