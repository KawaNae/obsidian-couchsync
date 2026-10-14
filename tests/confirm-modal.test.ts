import { describe, it, expect } from "vitest";
import { ConfirmModal, TypeToConfirmModal } from "../src/ui/confirm-modal.ts";
import { ConfigOverwriteModal } from "../src/ui/config-overwrite-modal.ts";
import type { FakeElement } from "./helpers/obsidian-stub.ts";

const app = {} as any;

function buttons(modal: { modalEl: unknown }): FakeElement[] {
    return [...(modal.modalEl as FakeElement).walk()].filter((el) => el.tagName === "BUTTON");
}
const focused = (modal: { modalEl: unknown }) => (modal.modalEl as FakeElement).ownerDocument.activeElement;
const button = (modal: { modalEl: unknown }, text: string) => buttons(modal).find((b) => b.text === text)!;

describe("initial focus of confirmation dialogs", () => {
    it("a destructive confirm opens with the focus on Cancel, so Enter does not confirm", async () => {
        const modal = new ConfirmModal(app, "Delete", "Delete it?", "Delete", true);
        const result = modal.waitForResult();
        expect(buttons(modal).map((b) => b.text)).toEqual(["Delete", "Cancel"]);
        expect(focused(modal)).toBe(button(modal, "Cancel"));

        // Enter presses the focused button.
        focused(modal)!.onclick!();
        expect(await result).toBe(false);
    });

    it("a safe confirm keeps Obsidian's focus on the confirm button", () => {
        const modal = new ConfirmModal(app, "Restore", "Restore?", "Restore");
        modal.open();
        expect(focused(modal)).toBe(button(modal, "Restore"));
    });

    it("Pull & Overwrite opens with the focus on Cancel", async () => {
        const modal = new ConfigOverwriteModal(app, {
            writes: [{ path: ".obsidian/app.json", created: false }],
            deletes: [".obsidian/snippets/a.css"],
            keptKeys: 1,
            skipped: [],
        });
        const result = modal.waitForResult();
        expect(focused(modal)).toBe(button(modal, "Cancel"));
        button(modal, "Overwrite").onclick!();
        expect(await result).toBe(true);
    });

    it("typing the database name has the focus; Delete starts disabled", () => {
        const modal = new TypeToConfirmModal(app, "vault-db");
        modal.open();
        expect(focused(modal)?.tagName).toBe("INPUT");
        expect(button(modal, "Delete").disabled).toBe(true);
    });

    it("gives no focus when Obsidian gives none (no physical keyboard)", () => {
        const modal = new ConfirmModal(app, "Delete", "Delete it?", "Delete", true);
        (modal as any).hasInitialInputFocus = false;
        modal.open();
        expect(focused(modal)).toBe(null);
    });

    it("closing without choosing is a no", async () => {
        const modal = new ConfirmModal(app, "Delete", "Delete it?", "Delete", true);
        const result = modal.waitForResult();
        modal.close();
        expect(await result).toBe(false);
    });
});
