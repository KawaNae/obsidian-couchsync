import { App, Modal, Setting } from "obsidian";

export class ConfirmModal extends Modal {
    private resolved = false;
    private resolve: (value: boolean) => void = () => {};

    constructor(app: App, private title: string, private message: string) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: this.title });
        contentEl.createEl("p", { text: this.message });

        new Setting(contentEl)
            .addButton((btn) => btn.setButtonText("Restore").setCta().onClick(() => {
                this.resolved = true;
                this.resolve(true);
                this.close();
            }))
            .addButton((btn) => btn.setButtonText("Cancel").onClick(() => {
                this.resolved = true;
                this.resolve(false);
                this.close();
            }));
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
