import { App, Setting } from "obsidian";
import { ConfirmationModal } from "./confirm-modal.ts";
import { valueText } from "../sync/config-push-review.ts";
import type { ConfigShareAgainPreview } from "../types/modal-presenter.ts";

/**
 * Confirmation of Share again: the key kept on this device takes the
 * shared value through a Pull & Reload. Shows the key, the shared value
 * the Pull writes, and that Obsidian reloads. Closing the dialog leaves
 * the disk and the key's declaration as they were.
 */
export class ConfigShareAgainModal extends ConfirmationModal {
    constructor(app: App, private preview: ConfigShareAgainPreview) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        const p = this.preview;
        const plugin = p.path === ".obsidian/community-plugins.json";
        const key = plugin ? p.pointer.slice(1).replace(/~1/g, "/").replace(/~0/g, "~") : p.pointer;

        contentEl.createEl("h3", { text: "Take the shared value?" });
        contentEl.createEl("p", {
            cls: "setting-item-description",
            text:
                "This key stops being kept on this device and takes the shared value: this device's " +
                "value is replaced. This runs Pull & Reload: other files and keys are pulled as usual, " +
                "every file about to change is backed up first in the plugin's backups folder, and " +
                "Obsidian reloads when a file changes.",
        });

        const box = contentEl.createDiv({ cls: "cs-push-list" });
        box.createDiv({ text: p.path.replace(/^\.obsidian\//, "") });
        box.createDiv({ text: plugin ? `plugin: ${key}` : key === "" ? "(whole value)" : key });
        const value = box.createDiv({ cls: "cs-push-values" });
        value.createDiv({ text: `shared: ${this.sharedText(plugin)}` });
        if (p.hideValue && p.shared.kind === "value") {
            value.style.display = "none";
            const show = box.createEl("button", { cls: "cs-push-show", text: "Show value" });
            show.addEventListener("click", () => {
                show.remove();
                value.style.display = "";
            });
        }

        this.addActions(new Setting(contentEl), "Take shared value", "warning");
    }

    private sharedText(plugin: boolean): string {
        const s = this.preview.shared;
        switch (s.kind) {
            case "value": return valueText(s.value) ?? "";
            case "member": return "enabled";
            case "absent": return plugin
                ? "not enabled (the plugin is disabled here)"
                : "(none; the key is removed here)";
            case "no-file": return "(the shared config has no such file; nothing is written to it)";
            case "unknown": return "(cannot be read as a JSON key; see log)";
        }
    }
}
