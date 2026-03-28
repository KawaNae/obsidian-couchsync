import type { App } from "obsidian";
import type { LocalDB } from "../db/local-db.ts";
import type { PluginConfigDoc } from "../types.ts";
import { DOC_PREFIX } from "../types.ts";
import type { CouchSyncSettings } from "../settings.ts";

export class PluginSync {
    constructor(
        private app: App,
        private db: LocalDB,
        private getSettings: () => CouchSyncSettings
    ) {}

    /**
     * Scan local plugin configs and store them in DB with this device's name.
     */
    async scanAndSync(): Promise<number> {
        const settings = this.getSettings();
        if (!settings.enablePluginSync || !settings.deviceName) return 0;

        const adapter = this.app.vault.adapter;
        const pluginsDir = ".obsidian/plugins";
        let synced = 0;

        try {
            const listing = await adapter.list(pluginsDir);
            for (const folder of listing.folders) {
                const pluginId = folder.split("/").pop();
                if (!pluginId) continue;

                // Sync manifest.json, main.js, styles.css, data.json
                const configFiles = ["manifest.json", "data.json", "styles.css"];
                for (const fileName of configFiles) {
                    const filePath = `${folder}/${fileName}`;
                    try {
                        if (!(await adapter.exists(filePath))) continue;
                        const stat = await adapter.stat(filePath);
                        if (!stat) continue;

                        const docId = `${DOC_PREFIX.PLUGIN}${pluginId}/${fileName}`;
                        const existing = await this.db.get<PluginConfigDoc>(docId);

                        if (!existing || existing.mtime < stat.mtime) {
                            const data = await adapter.read(filePath);
                            const doc: PluginConfigDoc = {
                                _id: docId,
                                type: "plugin-config",
                                data: data,
                                mtime: stat.mtime,
                                deviceName: settings.deviceName,
                            };
                            await this.db.put(doc);
                            synced++;
                        }
                    } catch (e) {
                        // File might not exist, skip
                    }
                }
            }
        } catch (e) {
            console.error("CouchSync: Failed to scan plugins:", e);
        }
        return synced;
    }

    /**
     * Apply a remote plugin config to local filesystem.
     */
    async applyRemoteConfig(doc: PluginConfigDoc): Promise<void> {
        const settings = this.getSettings();
        if (!settings.enablePluginSync) return;

        // Don't apply our own configs back
        if (doc.deviceName === settings.deviceName) return;

        if (doc.deleted) return;

        // Extract plugin ID and filename from _id
        // Format: "plugin:<pluginId>/<filename>"
        const idWithoutPrefix = doc._id.slice(DOC_PREFIX.PLUGIN.length);
        const slashIndex = idWithoutPrefix.indexOf("/");
        if (slashIndex === -1) return;

        const pluginId = idWithoutPrefix.slice(0, slashIndex);
        const fileName = idWithoutPrefix.slice(slashIndex + 1);

        // Only sync data.json (settings), not main.js or manifest.json
        if (fileName !== "data.json") return;

        const filePath = `.obsidian/plugins/${pluginId}/${fileName}`;
        const adapter = this.app.vault.adapter;

        try {
            const dir = `.obsidian/plugins/${pluginId}`;
            if (!(await adapter.exists(dir))) {
                // Don't create plugin directories that don't exist locally
                return;
            }
            await adapter.write(filePath, doc.data);
            console.log(`CouchSync: Applied plugin config for ${pluginId} from ${doc.deviceName}`);
        } catch (e) {
            console.error(`CouchSync: Failed to apply plugin config ${pluginId}:`, e);
        }
    }
}
