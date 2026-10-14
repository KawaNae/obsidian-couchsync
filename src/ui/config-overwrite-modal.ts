import { App, Modal, Setting } from "obsidian";
import type { ConfigOverwritePreview } from "../types/modal-presenter.ts";

/**
 * Confirmation of an overwriting config Pull: the files it deletes and the
 * files it writes, each as a list, and the keys kept on this device that
 * it stops keeping. Closing the dialog changes nothing.
 */
export class ConfigOverwriteModal extends Modal {
    private resolved = false;
    private resolve: (value: boolean) => void = () => {};

    constructor(app: App, private preview: ConfigOverwritePreview) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        const p = this.preview;
        contentEl.createEl("h3", { text: "Overwrite this device's config?" });
        contentEl.createEl("p", {
            cls: "setting-item-description",
            text:
                "This device's selected config becomes exactly the shared config. Changes not " +
                "pushed are lost. Every file below is backed up first in the plugin's " +
                "backups folder, then Obsidian reloads. Files the Filter leaves out are not touched.",
        });
        if (p.keptKeys > 0) {
            contentEl.createEl("p", {
                text:
                    `⚠ ${p.keptKeys} key(s) kept on this device take the shared value and are ` +
                    "shared again from now on.",
            }).style.color = "var(--text-error)";
        }

        this.renderList(contentEl, `Delete (${p.deletes.length})`, p.deletes);
        this.renderList(
            contentEl,
            `Write (${p.writes.length})`,
            p.writes.map((w) => (w.created ? `${w.path} (new)` : w.path)),
        );
        if (p.skipped.length > 0) {
            contentEl.createEl("p", {
                cls: "setting-item-description",
                text: `${p.skipped.length} file(s) are left as they are: their content is not available (see log).`,
            });
        }

        new Setting(contentEl)
            .addButton((btn) =>
                btn.setButtonText("Overwrite").setWarning().onClick(() => this.finish(true)))
            .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.finish(false)));
    }

    private renderList(parent: HTMLElement, title: string, paths: string[]): void {
        if (paths.length === 0) return;
        parent.createEl("h4", { text: title });
        const list = parent.createDiv({ cls: "cs-push-list" });
        for (const path of paths) list.createDiv({ text: path });
    }

    private finish(value: boolean): void {
        this.resolved = true;
        this.resolve(value);
        this.close();
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
