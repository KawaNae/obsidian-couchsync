import { App, Modal, Setting } from "obsidian";

export class ConfirmModal extends Modal {
    private resolved = false;
    private resolve: (value: boolean) => void = () => {};

    constructor(
        app: App,
        private title: string,
        private message: string,
        private confirmText = "Confirm",
        private danger = false,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: this.title });
        // A blank line in the message starts a new paragraph. A paragraph
        // that starts with "⚠" is a warning and is emphasised.
        for (const para of this.message.split(/\n\s*\n/)) {
            const p = contentEl.createEl("p", { text: para });
            if (para.startsWith("⚠")) {
                p.style.color = "var(--text-error)";
                p.style.fontWeight = "var(--font-bold)";
            }
        }

        new Setting(contentEl)
            .addButton((btn) => {
                btn.setButtonText(this.confirmText);
                if (this.danger) btn.setWarning(); else btn.setCta();
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
