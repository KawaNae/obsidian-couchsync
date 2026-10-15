import { App, Modal, Setting } from "obsidian";

export class PassphraseModal extends Modal {
    private resolved = false;
    private resolve: (value: string | null) => void = () => {};
    private inputValue = "";
    private errorEl: HTMLElement | null = null;
    /** An answer is being checked by `validate`. */
    private busy = false;

    constructor(
        app: App,
        private isFirstSetup: boolean,
        /** Replaces the default prompt text (e.g. for the config DB). */
        private description?: string,
        private opts: {
            /** Check an answer before accepting it: null accepts, a string
             *  is shown as the error and the modal stays open for another
             *  try. */
            validate?: (passphrase: string) => Promise<string | null>;
        } = {},
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
            text: this.description ?? (this.isFirstSetup
                ? "Choose a passphrase to encrypt your vault data. You will need this on every device."
                : "Enter the passphrase to decrypt your vault data."),
        });

        new Setting(contentEl)
            .setName("Passphrase")
            .addText((text) => {
                text.inputEl.type = "password";
                text.inputEl.style.width = "100%";
                text.onChange((v) => { this.inputValue = v; });
                text.inputEl.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") void this.submit();
                });
                setTimeout(() => text.inputEl.focus(), 50);
            });

        this.errorEl = contentEl.createEl("p", {
            cls: "mod-warning",
            attr: { style: "display:none; color: var(--text-error);" },
        });

        new Setting(contentEl)
            .addButton((btn) =>
                btn.setButtonText("Unlock").setCta().onClick(() => void this.submit()))
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

    private async submit(): Promise<void> {
        if (this.busy || this.resolved) return;
        if (!this.inputValue.trim()) {
            this.showError("Passphrase cannot be empty.");
            return;
        }
        const value = this.inputValue;
        if (this.opts.validate) {
            this.busy = true;
            this.showError("Checking...");
            let error: string | null;
            try {
                error = await this.opts.validate(value);
            } catch (e: any) {
                error = `Could not check the passphrase: ${e?.message ?? e}`;
            } finally {
                this.busy = false;
            }
            // Cancelled or closed while checking: the answer is moot.
            if (this.resolved) return;
            if (error !== null) {
                this.showError(error);
                return;
            }
        }
        this.resolved = true;
        this.resolve(value);
        this.close();
    }

    onClose(): void {
        if (!this.resolved) {
            this.resolved = true;
            this.resolve(null);
        }
        this.contentEl.empty();
    }

    waitForResult(): Promise<string | null> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }
}
