import type { App } from "obsidian";
import type { LocalDB } from "../db/local-db.ts";
import type { Replicator } from "../db/replicator.ts";
import type { ConfigDoc } from "../types.ts";
import { DOC_PREFIX } from "../types.ts";
import type { CouchSyncSettings } from "../settings.ts";
import { ProgressNotice } from "../ui/notices.ts";
import { arrayBufferToBase64, base64ToArrayBuffer } from "../db/chunker.ts";

export class ConfigSync {
    private static readonly SKIP_DIRS = new Set(["node_modules", ".git"]);
    private static readonly SKIP_FILES = new Set(["workspace.json", "workspace-mobile.json"]);
    private static readonly MAX_CONFIG_SIZE = 5 * 1024 * 1024; // 5MB

    constructor(
        private app: App,
        private db: LocalDB,
        private replicator: Replicator,
        private getSettings: () => CouchSyncSettings
    ) {}

    // ── High-level operations ──────────────────────────

    /** Init: delete all config docs → scan .obsidian/ → push to remote */
    async init(): Promise<number> {
        const progress = new ProgressNotice("Config Init");
        try {
            progress.update("Deleting old config docs...");
            const deletedIds = await this.db.deleteByPrefix(DOC_PREFIX.CONFIG);

            const scanned = await this.scan((path, i, total) => {
                progress.update(`Scanning: ${path} (${i}/${total})`);
            });

            const currentIds = await this.allDocIds();
            const affectedIds = [...new Set([...deletedIds, ...currentIds])];

            if (affectedIds.length > 0) {
                await this.replicator.pushDocs(affectedIds, (docId, n) => {
                    progress.update(`Pushing: ${docId} (${n}/${affectedIds.length})`);
                });
            }

            progress.done(`Config init: deleted ${deletedIds.length}, pushed ${scanned} file(s).`);
            return scanned;
        } catch (e: any) {
            progress.fail(`Config init failed: ${e?.message ?? e}`);
            throw e;
        }
    }

    /** Push: scan .obsidian/ → push config docs to remote */
    async push(): Promise<number> {
        const progress = new ProgressNotice("Config Push");
        try {
            const scanned = await this.scan((path, i, total) => {
                progress.update(`Scanning: ${path} (${i}/${total})`);
            });

            const docIds = await this.allDocIds();
            if (docIds.length > 0) {
                await this.replicator.pushDocs(docIds, (docId, n) => {
                    progress.update(`Pushing: ${docId} (${n}/${docIds.length})`);
                });
            }

            progress.done(`Pushed ${scanned} config file(s).`);
            return scanned;
        } catch (e: any) {
            progress.fail(`Config push failed: ${e?.message ?? e}`);
            throw e;
        }
    }

    /** Pull: pull config docs from remote → write configSyncPaths to filesystem */
    async pull(): Promise<number> {
        const progress = new ProgressNotice("Config Pull");
        try {
            progress.update("Pulling config from remote...");
            await this.replicator.pullByPrefix(DOC_PREFIX.CONFIG);

            const written = await this.write((path, i, total) => {
                progress.update(`Writing: ${path} (${i}/${total})`);
            });

            progress.done(`Pulled ${written} config file(s).`);
            return written;
        } catch (e: any) {
            progress.fail(`Config pull failed: ${e?.message ?? e}`);
            throw e;
        }
    }

    // ── Low-level operations ───────────────────────────

    /** Scan entire .obsidian/ directory to local DB */
    async scan(onProgress?: (path: string, index: number, total: number) => void): Promise<number> {
        const files: string[] = [];
        await this.listFilesRecursive(".obsidian", files);

        let count = 0;
        const adapter = this.app.vault.adapter;
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fileName = file.split("/").pop() ?? "";
            if (ConfigSync.SKIP_FILES.has(fileName)) continue;

            try {
                onProgress?.(file, i + 1, files.length);
                const stat = await adapter.stat(file);
                if (!stat || stat.size > ConfigSync.MAX_CONFIG_SIZE) continue;

                const buf = await adapter.readBinary(file);
                const data = arrayBufferToBase64(buf);

                const doc: ConfigDoc = {
                    _id: `${DOC_PREFIX.CONFIG}${file}`,
                    type: "config",
                    data,
                    binary: true,
                    mtime: stat.mtime,
                    size: stat.size,
                };
                await this.db.put(doc);
                count++;
            } catch (e) {
                console.error(`CouchSync: Failed to scan config ${file}:`, e);
            }
        }
        return count;
    }

    /** Write config docs to filesystem, filtered by configSyncPaths */
    async write(onProgress?: (path: string, index: number, total: number) => void): Promise<number> {
        const paths = this.getSettings().configSyncPaths;
        if (paths.length === 0) return 0;

        const entries: { path: string; data: string; binary: boolean }[] = [];
        for (const p of paths) {
            if (p.endsWith("/")) {
                const prefix = `${DOC_PREFIX.CONFIG}${p.replace(/\/$/, "")}/`;
                const result = await this.db.getDb().allDocs({
                    startkey: prefix,
                    endkey: prefix + "\ufff0",
                    include_docs: true,
                });
                for (const row of result.rows) {
                    if (!("doc" in row) || !row.doc) continue;
                    const doc = row.doc as unknown as ConfigDoc;
                    if (doc.type !== "config") continue;
                    entries.push({
                        path: doc._id.slice(DOC_PREFIX.CONFIG.length),
                        data: doc.data,
                        binary: doc.binary ?? false,
                    });
                }
            } else {
                const doc = await this.db.get<ConfigDoc>(`${DOC_PREFIX.CONFIG}${p}`);
                if (doc) entries.push({ path: p, data: doc.data, binary: doc.binary ?? false });
            }
        }

        let count = 0;
        for (let i = 0; i < entries.length; i++) {
            const { path, data, binary } = entries[i];
            try {
                onProgress?.(path, i + 1, entries.length);
                await this.ensureDir(path);
                // Legacy docs (binary === false) stored UTF-8 text directly; re-encode.
                const buf = binary
                    ? base64ToArrayBuffer(data)
                    : new TextEncoder().encode(data).buffer;
                await this.app.vault.adapter.writeBinary(path, buf);
                count++;
            } catch (e) {
                console.error(`CouchSync: Failed to write config ${path}:`, e);
            }
        }
        return count;
    }

    // ── Utilities (public for settings UI) ─────────────

    /** List config file paths available on remote */
    async listRemotePaths(): Promise<string[]> {
        const docIds = await this.replicator.listRemoteByPrefix(DOC_PREFIX.CONFIG);
        return docIds.map((id) => id.slice(DOC_PREFIX.CONFIG.length));
    }

    /** List installed plugin folder paths (fallback when remote unavailable) */
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

    // ── Private ────────────────────────────────────────

    private async allDocIds(): Promise<string[]> {
        const result = await this.db.getDb().allDocs({
            startkey: DOC_PREFIX.CONFIG,
            endkey: DOC_PREFIX.CONFIG + "\ufff0",
        });
        return result.rows.map((row) => row.id);
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
                const folderName = folder.split("/").pop() ?? "";
                if (ConfigSync.SKIP_DIRS.has(folderName)) continue;
                await this.listFilesRecursive(folder, result);
            }
        } catch (e) {
            // skip inaccessible dirs
        }
    }
}
