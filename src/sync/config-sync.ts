import type { App } from "obsidian";
import type { LocalDB } from "../db/local-db.ts";
import type { Replicator } from "../db/replicator.ts";
import type { ConfigDoc } from "../types.ts";
import { DOC_PREFIX } from "../types.ts";
import type { CouchSyncSettings } from "../settings.ts";
import { ProgressNotice } from "../ui/notices.ts";

export class ConfigSync {
    constructor(
        private app: App,
        private db: LocalDB,
        private replicator: Replicator,
        private getSettings: () => CouchSyncSettings
    ) {}

    /** Push: configured paths (files or folders) → DB → remote */
    async push(): Promise<number> {
        const paths = this.getSettings().configSyncPaths;
        if (paths.length === 0) return 0;

        const progress = new ProgressNotice("Config Push");
        let pushed = 0;
        for (const path of paths) {
            progress.update(`Pushing: ${path}`);
            pushed += await this.pushPath(path);
        }

        if (pushed > 0) {
            progress.update("Sending to remote...");
            await this.replicator.pushToRemote();
        }
        progress.done(`Pushed ${pushed} config file(s).`);
        return pushed;
    }

    /** Pull: remote → DB → write configured paths to filesystem */
    async pull(): Promise<number> {
        const progress = new ProgressNotice("Config Pull");
        progress.update("Pulling from remote...");
        await this.replicator.pullFromRemote();

        const paths = this.getSettings().configSyncPaths;
        if (paths.length === 0) {
            progress.done("No config paths configured.");
            return 0;
        }

        let pulled = 0;
        for (const path of paths) {
            progress.update(`Writing: ${path}`);
            pulled += await this.pullPath(path);
        }
        progress.done(`Pulled ${pulled} config file(s).`);
        return pulled;
    }

    /** List installed plugin folder paths */
    async listPluginFolders(): Promise<string[]> {
        const adapter = this.app.vault.adapter;
        const folders: string[] = [];

        try {
            const listing = await adapter.list(".obsidian/plugins");
            for (const folder of listing.folders) {
                folders.push(folder + "/");
            }
        } catch (e) {
            // plugins dir might not exist
        }
        return folders.sort();
    }

    /** List common .obsidian config file paths */
    getCommonConfigPaths(): string[] {
        return [
            ".obsidian/app.json",
            ".obsidian/appearance.json",
            ".obsidian/hotkeys.json",
            ".obsidian/community-plugins.json",
            ".obsidian/core-plugins.json",
            ".obsidian/core-plugins-migration.json",
        ];
    }

    // ── Internal ────────────────────────────────────────

    private async pushPath(path: string): Promise<number> {
        const adapter = this.app.vault.adapter;

        // Folder path: push all files inside
        if (path.endsWith("/")) {
            return this.pushFolder(path);
        }

        // Single file
        try {
            if (!(await adapter.exists(path))) return 0;
            const stat = await adapter.stat(path);
            if (!stat || stat.type === "folder") {
                return this.pushFolder(path + "/");
            }

            const data = await adapter.read(path);
            const doc: ConfigDoc = {
                _id: `${DOC_PREFIX.CONFIG}${path}`,
                type: "config",
                data,
                mtime: stat.mtime,
                size: stat.size,
            };
            await this.db.put(doc);
            return 1;
        } catch (e) {
            console.error(`CouchSync: Failed to push config ${path}:`, e);
            return 0;
        }
    }

    private async pushFolder(folderPath: string): Promise<number> {
        const dir = folderPath.replace(/\/$/, "");
        const files: string[] = [];
        await this.listFilesRecursive(dir, files);

        let pushed = 0;
        const adapter = this.app.vault.adapter;
        for (const file of files) {
            try {
                const stat = await adapter.stat(file);
                if (!stat) continue;
                const data = await adapter.read(file);
                const doc: ConfigDoc = {
                    _id: `${DOC_PREFIX.CONFIG}${file}`,
                    type: "config",
                    data,
                    mtime: stat.mtime,
                    size: stat.size,
                };
                await this.db.put(doc);
                pushed++;
            } catch (e) {
                console.error(`CouchSync: Failed to push config ${file}:`, e);
            }
        }
        return pushed;
    }

    private async pullPath(path: string): Promise<number> {
        // Folder path: pull all config docs with this prefix
        if (path.endsWith("/")) {
            return this.pullFolder(path);
        }

        // Single file
        try {
            const docId = `${DOC_PREFIX.CONFIG}${path}`;
            const doc = await this.db.get<ConfigDoc>(docId);
            if (!doc) return 0;

            await this.ensureDir(path);
            await this.app.vault.adapter.write(path, doc.data);
            return 1;
        } catch (e) {
            console.error(`CouchSync: Failed to pull config ${path}:`, e);
            return 0;
        }
    }

    private async pullFolder(folderPath: string): Promise<number> {
        const prefix = `${DOC_PREFIX.CONFIG}${folderPath.replace(/\/$/, "")}/`;
        const db = this.db.getDb();

        // Find all config docs with matching prefix
        const result = await db.allDocs({
            startkey: prefix,
            endkey: prefix + "\ufff0",
            include_docs: true,
        });

        let pulled = 0;
        for (const row of result.rows) {
            if (!("doc" in row) || !row.doc) continue;
            const doc = row.doc as unknown as ConfigDoc;
            if (doc.type !== "config") continue;

            const filePath = doc._id.slice(DOC_PREFIX.CONFIG.length);
            try {
                await this.ensureDir(filePath);
                await this.app.vault.adapter.write(filePath, doc.data);
                pulled++;
            } catch (e) {
                console.error(`CouchSync: Failed to pull config ${filePath}:`, e);
            }
        }
        return pulled;
    }

    private async ensureDir(filePath: string): Promise<void> {
        const dir = filePath.split("/").slice(0, -1).join("/");
        if (dir && !(await this.app.vault.adapter.exists(dir))) {
            await this.app.vault.adapter.mkdir(dir);
        }
    }

    private async listFilesRecursive(dir: string, result: string[]): Promise<void> {
        try {
            const listing = await this.app.vault.adapter.list(dir);
            for (const file of listing.files) {
                result.push(file);
            }
            for (const folder of listing.folders) {
                await this.listFilesRecursive(folder, result);
            }
        } catch (e) {
            // skip inaccessible dirs
        }
    }
}
