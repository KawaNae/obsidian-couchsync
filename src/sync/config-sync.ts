import type { App } from "obsidian";
import type { LocalDB } from "../db/local-db.ts";
import type { Replicator } from "../db/replicator.ts";
import type { ConfigDoc } from "../types.ts";
import { DOC_PREFIX } from "../types.ts";
import type { CouchSyncSettings } from "../settings.ts";

export class ConfigSync {
    constructor(
        private app: App,
        private db: LocalDB,
        private replicator: Replicator,
        private getSettings: () => CouchSyncSettings
    ) {}

    /** Push: read configured paths from local filesystem → DB → remote */
    async push(): Promise<number> {
        const paths = this.getSettings().configSyncPaths;
        if (paths.length === 0) return 0;

        const adapter = this.app.vault.adapter;
        let pushed = 0;

        for (const path of paths) {
            try {
                if (!(await adapter.exists(path))) continue;
                const stat = await adapter.stat(path);
                if (!stat) continue;

                const data = await adapter.read(path);
                const doc: ConfigDoc = {
                    _id: `${DOC_PREFIX.CONFIG}${path}`,
                    type: "config",
                    data,
                    mtime: stat.mtime,
                    size: stat.size,
                };
                await this.db.put(doc);
                pushed++;
            } catch (e) {
                console.error(`CouchSync: Failed to push config ${path}:`, e);
            }
        }

        if (pushed > 0) {
            // One-shot push to remote
            await this.replicator.pushToRemote();
        }
        return pushed;
    }

    /** Pull: fetch ConfigDocs from remote → DB → write to local filesystem */
    async pull(): Promise<number> {
        // Pull all from remote first
        await this.replicator.pullFromRemote();

        const paths = this.getSettings().configSyncPaths;
        if (paths.length === 0) return 0;

        const adapter = this.app.vault.adapter;
        let pulled = 0;

        for (const path of paths) {
            try {
                const docId = `${DOC_PREFIX.CONFIG}${path}`;
                const doc = await this.db.get<ConfigDoc>(docId);
                if (!doc) continue;

                // Ensure parent directory exists
                const dir = path.split("/").slice(0, -1).join("/");
                if (dir && !(await adapter.exists(dir))) {
                    await adapter.mkdir(dir);
                }
                await adapter.write(path, doc.data);
                pulled++;
            } catch (e) {
                console.error(`CouchSync: Failed to pull config ${path}:`, e);
            }
        }
        return pulled;
    }

    /** List all files under .obsidian/ for path suggestions */
    async listConfigFiles(): Promise<string[]> {
        const result: string[] = [];
        await this.listFilesRecursive(".obsidian", result);
        return result.sort();
    }

    /** List plugin data.json paths for quick selection */
    async listPluginDataPaths(): Promise<string[]> {
        const adapter = this.app.vault.adapter;
        const paths: string[] = [];

        try {
            const listing = await adapter.list(".obsidian/plugins");
            for (const folder of listing.folders) {
                const dataPath = `${folder}/data.json`;
                if (await adapter.exists(dataPath)) {
                    paths.push(dataPath);
                }
            }
        } catch (e) {
            // plugins dir might not exist
        }
        return paths.sort();
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
