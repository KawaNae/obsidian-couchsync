import { App, Modal, Setting } from "obsidian";
import type { PushItem, PushItemChange, PushReview } from "../sync/config-push-review.ts";

const CHANGE_LABELS: Record<PushItemChange, string> = {
    changed: "changed",
    added: "new key",
    removed: "removed",
    enabled: "enabled here",
    disabled: "disabled here",
    file: "file changed",
    "new-file": "new file",
};

/**
 * The config Push list: every change Push is about to send, grouped by
 * file, each with a checkbox. Everything starts checked except the keys
 * kept on this device. One button sends the checked items.
 *
 * Values are shown as JSON next to each key: the shared value and this
 * device's. A plugin's data.json may hold API keys or tokens, so its values
 * are shown only after "Show values" for that file. Closing the dialog
 * sends nothing.
 */
export class ConfigPushModal extends Modal {
    private resolved = false;
    private resolve: (value: string[] | null) => void = () => {};
    private readonly selected: Set<string>;
    private sendBtn: { setButtonText(t: string): unknown; setDisabled(d: boolean): unknown } | null = null;

    constructor(app: App, private review: PushReview) {
        super(app);
        this.selected = new Set(review.items.filter((i) => !i.deviceOnly).map((i) => i.id));
    }

    onOpen(): void {
        const { contentEl, modalEl } = this;
        modalEl.addClass("cs-push-modal");
        contentEl.createEl("h3", { text: "Push config changes" });
        contentEl.createEl("p", {
            cls: "setting-item-description",
            text:
                "These are the changes on this device since it last took the shared config. " +
                "Unchecked items are not sent and stay this device's own: an unchecked key is " +
                "kept on this device (later Pulls do not change it), an unchecked file stops " +
                "syncing on this device (turn it back on in the Filter). Check a key marked " +
                "\"kept on this device\" to share it again.",
        });
        if (this.review.held > 0) {
            contentEl.createEl("p", {
                cls: "setting-item-description",
                text: `${this.review.held} file(s) are not listed: run Pull & Reload first, then Push again.`,
            });
        }

        const list = contentEl.createDiv({ cls: "cs-push-list" });
        const byPath = new Map<string, PushItem[]>();
        for (const it of this.review.items) {
            const arr = byPath.get(it.path) ?? [];
            arr.push(it);
            byPath.set(it.path, arr);
        }
        for (const [path, items] of byPath) this.renderFile(list, path, items);

        new Setting(contentEl)
            .addButton((btn) => {
                this.sendBtn = btn;
                btn.setCta().onClick(() => this.finish([...this.selected]));
                this.paintSendButton();
            })
            .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.finish(null)));
    }

    private renderFile(parent: HTMLElement, path: string, items: PushItem[]): void {
        const file = parent.createDiv({ cls: "cs-push-file" });
        const head = file.createDiv({ cls: "cs-push-file-head" });
        const whole = items.length === 1 && items[0].pointer === null;
        const boxes: Array<{ item: PushItem; cb: HTMLInputElement }> = [];

        const fileCb = head.createEl("input") as HTMLInputElement;
        fileCb.type = "checkbox";
        head.createSpan({ text: ` ${path.replace(/^\.obsidian\//, "")}` });
        if (whole) head.createSpan({ cls: "cs-push-tag", text: CHANGE_LABELS[items[0].change] });

        const hidden = items.some((i) => i.hideValues && (i.sharedText !== undefined || i.localText !== undefined));
        const valueEls: HTMLElement[] = [];
        if (hidden) {
            const show = head.createEl("button", { cls: "cs-push-show", text: "Show values" });
            show.addEventListener("click", () => {
                show.remove();
                for (const el of valueEls) el.style.display = "";
            });
        }

        const paintFile = () => {
            const on = boxes.filter((b) => b.cb.checked).length;
            fileCb.checked = on === boxes.length;
            fileCb.indeterminate = on > 0 && on < boxes.length;
        };
        fileCb.addEventListener("change", () => {
            for (const b of boxes) {
                b.cb.checked = fileCb.checked;
                this.toggle(b.item.id, fileCb.checked);
            }
            paintFile();
        });

        if (whole) {
            boxes.push({ item: items[0], cb: fileCb });
            fileCb.checked = this.selected.has(items[0].id);
            return;
        }
        const rows = file.createDiv({ cls: "cs-push-keys" });
        for (const it of items) {
            const row = rows.createDiv({ cls: "cs-push-key" });
            const cb = row.createEl("input") as HTMLInputElement;
            cb.type = "checkbox";
            cb.checked = this.selected.has(it.id);
            cb.addEventListener("change", () => {
                this.toggle(it.id, cb.checked);
                paintFile();
            });
            boxes.push({ item: it, cb });
            row.createSpan({ text: ` ${it.pointer === "" ? "(whole value)" : keyLabel(it)}` });
            row.createSpan({ cls: "cs-push-tag", text: CHANGE_LABELS[it.change] });
            if (it.deviceOnly) row.createSpan({ cls: "cs-push-tag", text: "kept on this device" });
            if (it.sharedText !== undefined || it.localText !== undefined) {
                const v = row.createDiv({ cls: "cs-push-values" });
                v.createDiv({ text: `shared: ${it.sharedText ?? "(none)"}` });
                v.createDiv({ text: `this device: ${it.localText ?? "(none)"}` });
                if (it.hideValues) {
                    v.style.display = "none";
                    valueEls.push(v);
                }
            }
        }
        paintFile();
    }

    private toggle(id: string, on: boolean): void {
        if (on) this.selected.add(id);
        else this.selected.delete(id);
        this.paintSendButton();
    }

    private paintSendButton(): void {
        const n = this.selected.size;
        this.sendBtn?.setButtonText(n > 0 ? `Push ${n} selected` : "Push (keep all on this device)");
    }

    private finish(result: string[] | null): void {
        this.resolved = true;
        this.resolve(result);
        this.close();
    }

    onClose(): void {
        if (!this.resolved) this.resolve(null);
        this.contentEl.empty();
    }

    waitForResult(): Promise<string[] | null> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }
}

/** A key's pointer, or the plugin id of a community-plugins.json member. */
function keyLabel(it: PushItem): string {
    if (it.change === "enabled" || it.change === "disabled") {
        return (it.pointer ?? "").slice(1).replace(/~1/g, "/").replace(/~0/g, "~");
    }
    return it.pointer ?? "";
}
