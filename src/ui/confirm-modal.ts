import { App, Modal, Setting, type ButtonComponent } from "obsidian";

/**
 * A dialog that ends in a yes or a no. Closing it any other way (×, Esc,
 * a click outside) is a no.
 *
 * Obsidian focuses the first focusable element of a dialog when it opens,
 * which is the confirm button when the dialog has no input before it. Enter
 * would then confirm a destructive action unread, so a dialog whose confirm
 * is destructive opens with the focus on Cancel instead.
 */
export abstract class ConfirmationModal extends Modal {
    private resolved = false;
    private resolve: (value: boolean) => void = () => {};
    private cancelBtn: ButtonComponent | null = null;
    private danger = false;

    /** Add the confirm button and Cancel to `setting`. `kind` is how the
     *  confirm is drawn: "cta" for a safe action, which keeps the initial
     *  focus; "warning" for a destructive one; "plain" for a destructive
     *  one the dialog draws itself. Returns the confirm button. */
    protected addActions(
        setting: Setting,
        confirmText: string,
        kind: "cta" | "warning" | "plain",
    ): ButtonComponent {
        this.danger = kind !== "cta";
        let confirm!: ButtonComponent;
        setting
            .addButton((btn) => {
                confirm = btn;
                btn.setButtonText(confirmText);
                if (kind === "cta") btn.setCta();
                else if (kind === "warning") btn.setWarning();
                btn.onClick(() => this.finish(true));
            })
            .addButton((btn) => {
                this.cancelBtn = btn;
                btn.setButtonText("Cancel").onClick(() => this.finish(false));
            });
        return confirm;
    }

    /** The element that takes the focus when the dialog opens, or null to
     *  keep Obsidian's choice. */
    protected initialFocus(): HTMLElement | null {
        return this.danger ? this.cancelBtn?.buttonEl ?? null : null;
    }

    open(): void {
        super.open();
        // Obsidian focuses only when the device has a physical keyboard;
        // without one, nothing in the dialog has the focus and none is given.
        const target = this.initialFocus();
        if (target && this.modalEl.contains(this.modalEl.ownerDocument.activeElement)) {
            target.focus();
        }
    }

    protected finish(value: boolean): void {
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

export class ConfirmModal extends ConfirmationModal {
    constructor(
        app: App,
        private title: string,
        private message: string,
        private confirmText = "Confirm",
        private dangerous = false,
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
        this.addActions(new Setting(contentEl), this.confirmText, this.dangerous ? "warning" : "cta");
    }
}

/**
 * The second confirmation of deleting a server database: the name must be
 * typed before Delete is enabled. The name field has the focus.
 */
export class TypeToConfirmModal extends ConfirmationModal {
    private inputEl: HTMLElement | null = null;

    constructor(app: App, private expectedName: string) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: "Type database name to confirm" });
        contentEl.createEl("p", {
            text: `Type "${this.expectedName}" to permanently delete this database.`,
        });

        let deleteBtn!: ButtonComponent;
        const setting = new Setting(contentEl).addText((text) => {
            this.inputEl = text.inputEl;
            text.setPlaceholder(this.expectedName);
            text.onChange((value) => {
                const matches = value === this.expectedName;
                deleteBtn.setDisabled(!matches);
                deleteBtn.buttonEl.toggleClass("mod-warning", matches);
            });
        });
        // Drawn as a warning only once the name matches.
        deleteBtn = this.addActions(setting, "Delete", "plain");
        deleteBtn.setDisabled(true);
    }

    protected initialFocus(): HTMLElement | null {
        return this.inputEl;
    }
}
