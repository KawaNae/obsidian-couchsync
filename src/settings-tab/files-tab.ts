import { type App, Notice, Setting } from "obsidian";
import type { CouchSyncSettings } from "../settings.ts";
import type { ConfigSync } from "../sync/config-sync.ts";
import type { LocalDB } from "../db/local-db.ts";

interface FilesTabDeps {
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    configSync: ConfigSync;
    localDb: LocalDB;
    app: App;
    refresh: () => void;
}

export function renderFilesTab(el: HTMLElement, deps: FilesTabDeps): void {
    const settings = deps.getSettings();

    // ── File Filtering ──────────────────────────────────────
    el.createEl("h3", { text: "File Filtering" });

    new Setting(el)
        .setName("Sync filter (RegExp)")
        .setDesc("Only sync files matching this pattern. Leave empty to sync all.")
        .addText((text) =>
            text
                .setPlaceholder(".*\\.md$")
                .setValue(settings.syncFilter)
                .onChange(async (value) => {
                    await deps.updateSettings({ syncFilter: value });
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
                    await deps.updateSettings({ syncIgnore: value });
                })
        );

    new Setting(el)
        .setName("Max file size (MB)")
        .setDesc("Files larger than this will not be synced. Set to 0 to skip all files (useful for testing).")
        .addText((text) =>
            text
                .setValue(String(settings.maxFileSizeMB))
                .onChange(async (value) => {
                    // parseFloat so fractional values like 0.5 work, and
                    // accept 0 as a valid "skip everything" setting.
                    const num = parseFloat(value);
                    if (!isNaN(num) && num >= 0) {
                        await deps.updateSettings({ maxFileSizeMB: num });
                    }
                })
        );

    // ── Skipped large files ─────────────────────────────────
    renderSkippedFiles(el, deps);

    // ── Config Sync ─────────────────────────────────────────
    el.createEl("h3", { text: "Config Sync" });

    // ── Send: Init & Push (all .obsidian/) ──
    el.createEl("p", {
        text: "Sends all .obsidian/ config to remote.",
        cls: "setting-item-description",
    });

    new Setting(el)
        .setName("Init & Push")
        .setDesc("Delete old config, re-scan .obsidian/, push to remote.")
        .addButton((btn) =>
            btn.setButtonText("Init & Push").setWarning().onClick(async () => {
                btn.setButtonText("Initializing...");
                btn.setDisabled(true);
                // configSync.init() owns its own progress/done/fail
                // notices — success and failure are both surfaced there.
                try { await deps.configSync.init(); } catch { /* handled */ }
                btn.setButtonText("Init & Push");
                btn.setDisabled(false);
            })
        );

    new Setting(el)
        .setName("Push")
        .setDesc("Scan .obsidian/ and push changes to remote.")
        .addButton((btn) =>
            btn.setButtonText("Push ↑").onClick(async () => {
                btn.setButtonText("Pushing...");
                btn.setDisabled(true);
                try { await deps.configSync.push(); } catch { /* handled in ProgressNotice */ }
                btn.setButtonText("Push ↑");
                btn.setDisabled(false);
            })
        );

    // ── Receive: Pull (configSyncPaths only) ──
    el.createEl("h4", { text: "Receive filter" });
    el.createEl("p", {
        text: "Pull writes only the paths below to this device.",
        cls: "setting-item-description",
    });

    const paths = settings.configSyncPaths;
    for (const path of paths) {
        new Setting(el)
            .setName(path)
            .addButton((btn) =>
                btn
                    .setButtonText("×")
                    .setWarning()
                    .onClick(async () => {
                        const updated = settings.configSyncPaths.filter((p) => p !== path);
                        await deps.updateSettings({ configSyncPaths: updated });
                        deps.refresh();
                    })
            );
    }

    // Add path with suggestions
    const addPathContainer = el.createDiv();
    const addSetting = new Setting(addPathContainer).setName("Add path");

    let inputValue = "";
    const suggestionsEl = addPathContainer.createDiv({ cls: "cs-suggest-list" });
    suggestionsEl.style.display = "none";

    addSetting.addText((text) => {
        text.setPlaceholder(".obsidian/plugins/my-plugin/");
        text.inputEl.addEventListener("focus", () => loadSuggestions(suggestionsEl, deps));
        text.inputEl.addEventListener("input", () => {
            inputValue = text.inputEl.value;
            filterSuggestions(suggestionsEl, inputValue);
        });
        text.onChange((value) => {
            inputValue = value;
        });
    });

    addSetting.addButton((btn) =>
        btn.setButtonText("+ Add").onClick(async () => {
            if (!inputValue.trim()) return;
            const trimmed = inputValue.trim();
            if (settings.configSyncPaths.includes(trimmed)) {
                new Notice("Path already added.");
                return;
            }
            const updated = [...settings.configSyncPaths, trimmed];
            await deps.updateSettings({ configSyncPaths: updated });
            deps.refresh();
        })
    );

    new Setting(el)
        .setName("Pull & Reload")
        .setDesc(`Pull config from remote, write ${paths.length} path(s), then reload Obsidian.`)
        .addButton((btn) =>
            btn.setButtonText("Pull & Reload ↓").onClick(async () => {
                btn.setButtonText("Pulling...");
                btn.setDisabled(true);
                try {
                    // configSync.pull() owns its own progress/done/fail.
                    // The "reloading" hint is unique to this code path.
                    await deps.configSync.pull();
                    new Notice("CouchSync: Reloading Obsidian...");
                    setTimeout(() => {
                        (deps.app as any).commands.executeCommandById("app:reload");
                    }, 500);
                } catch {
                    btn.setButtonText("Pull & Reload ↓");
                    btn.setDisabled(false);
                }
            })
        );
}

/**
 * Render the "Skipped large files" section. Async — it fetches the
 * `_local/skipped-files` doc and populates a container inline so it doesn't
 * block the rest of the tab render.
 */
function renderSkippedFiles(el: HTMLElement, deps: FilesTabDeps): void {
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

/** Group raw paths into selectable files and folders at all hierarchy levels */
function groupPaths(paths: string[]): { files: string[]; folders: string[] } {
    const files: string[] = [];
    const folderSet = new Set<string>();

    for (const path of paths) {
        const segments = path.split("/");
        for (let depth = 1; depth < segments.length; depth++) {
            folderSet.add(segments.slice(0, depth).join("/") + "/");
        }
        if (segments.length <= 2) {
            files.push(path);
        }
    }

    return { files: files.sort(), folders: [...folderSet].sort() };
}

let cachedRemotePaths: { files: string[]; folders: string[] } | null = null;

async function loadSuggestions(suggestionsEl: HTMLElement, deps: FilesTabDeps): Promise<void> {
    suggestionsEl.empty();
    suggestionsEl.style.display = "block";
    const currentPaths = new Set(deps.getSettings().configSyncPaths);

    if (!cachedRemotePaths) {
        try {
            const rawPaths = await deps.configSync.listRemotePaths();
            cachedRemotePaths = groupPaths(rawPaths);
        } catch {
            cachedRemotePaths = null;
        }
    }

    if (cachedRemotePaths) {
        renderRemoteSuggestions(suggestionsEl, cachedRemotePaths, currentPaths, deps);
    } else {
        await renderLocalFallback(suggestionsEl, currentPaths, deps);
    }
}

function renderRemoteSuggestions(
    el: HTMLElement,
    remote: { files: string[]; folders: string[] },
    currentPaths: Set<string>,
    deps: FilesTabDeps,
): void {
    if (remote.files.length === 0 && remote.folders.length === 0) {
        el.createEl("div", {
            text: "No config found on remote. Run Init & Push first.",
            cls: "cs-suggest-header",
        });
        return;
    }

    if (remote.files.length > 0) {
        el.createEl("div", { text: "── Config files ──", cls: "cs-suggest-header" });
        for (const file of remote.files) {
            if (currentPaths.has(file)) continue;
            createSuggestionItem(el, file, deps);
        }
    }

    if (remote.folders.length > 0) {
        el.createEl("div", { text: "── Folders ──", cls: "cs-suggest-header" });
        for (const folder of remote.folders) {
            if (currentPaths.has(folder)) continue;
            createSuggestionItem(el, folder, deps);
        }
    }
}

async function renderLocalFallback(
    el: HTMLElement,
    currentPaths: Set<string>,
    deps: FilesTabDeps,
): void {
    el.createEl("div", {
        text: "── Remote unavailable — showing local ──",
        cls: "cs-suggest-header",
    });

    const commonFiles = deps.configSync.getCommonConfigPaths();
    for (const path of commonFiles) {
        if (currentPaths.has(path)) continue;
        createSuggestionItem(el, path, deps);
    }

    try {
        const pluginFolders = await deps.configSync.listPluginFolders();
        for (const folder of pluginFolders) {
            if (currentPaths.has(folder)) continue;
            createSuggestionItem(el, folder, deps);
        }
    } catch { /* ignore */ }
}

function createSuggestionItem(container: HTMLElement, path: string, deps: FilesTabDeps): void {
    const item = container.createDiv({ cls: "cs-suggest-item", text: path });
    item.addEventListener("click", async () => {
        const current = deps.getSettings().configSyncPaths;
        if (!current.includes(path)) {
            await deps.updateSettings({ configSyncPaths: [...current, path] });
            deps.refresh();
        }
    });
}

function filterSuggestions(suggestionsEl: HTMLElement, filter: string): void {
    const items = suggestionsEl.querySelectorAll(".cs-suggest-item");
    const lower = filter.toLowerCase();
    for (const item of items) {
        const el = item as HTMLElement;
        el.style.display = el.textContent?.toLowerCase().includes(lower) ? "" : "none";
    }
}
