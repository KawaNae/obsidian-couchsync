import { App, Modal, Setting } from "obsidian";

export class PassphraseModal extends Modal {
    private resolved = false;
    private resolve: (value: string | null) => void = () => {};
    private inputValue = "";
    private errorEl: HTMLElement | null = null;

    constructor(
        app: App,
        private isFirstSetup: boolean,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl("h3", {
            text: this.isFirstSetup
                ? "CouchSync: Set Encryption Passphrase"
                : "CouchSync: Enter Passphrase",
        });
        contentEl.createEl("p", {
            text: this.isFirstSetup
                ? "Choose a passphrase to encrypt your vault data. You will need this on every device."
                : "Enter the passphrase to decrypt your vault data.",
        });

        new Setting(contentEl)
            .setName("Passphrase")
            .addText((text) => {
                text.inputEl.type = "password";
                text.inputEl.style.width = "100%";
                text.onChange((v) => { this.inputValue = v; });
                text.inputEl.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") this.submit();
                });
                setTimeout(() => text.inputEl.focus(), 50);
            });

        this.errorEl = contentEl.createEl("p", {
            cls: "mod-warning",
            attr: { style: "display:none; color: var(--text-error);" },
        });

        new Setting(contentEl)
            .addButton((btn) =>
                btn.setButtonText("Unlock").setCta().onClick(() => this.submit()))
            .addButton((btn) =>
                btn.setButtonText("Cancel").onClick(() => {
                    this.resolved = true;
                    this.resolve(null);
                    this.close();
                }));
    }

    showError(msg: string): void {
        if (this.errorEl) {
            this.errorEl.setText(msg);
            this.errorEl.style.display = "block";
        }
    }

    private submit(): void {
        if (!this.inputValue.trim()) {
            this.showError("Passphrase cannot be empty.");
            return;
        }
        this.resolved = true;
        this.resolve(this.inputValue);
        this.close();
    }

    onClose(): void {
        if (!this.resolved) this.resolve(null);
        this.contentEl.empty();
    }

    waitForResult(): Promise<string | null> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }
}
