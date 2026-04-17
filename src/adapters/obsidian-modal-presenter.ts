/**
 * Production IModalPresenter backed by Obsidian modal classes.
 *
 * The ONLY file that imports `ConflictModal` / `ConfirmModal` for
 * construction. Everything else receives an `IModalPresenter` and is
 * testable with `FakeModalPresenter`.
 */

import type { App } from "obsidian";
import type {
    IModalPresenter,
    ConflictModalResult,
} from "../types/modal-presenter.ts";
import { ConflictModal } from "../ui/conflict-modal.ts";
import { ConfirmModal } from "../ui/confirm-modal.ts";

export class ObsidianModalPresenter implements IModalPresenter {
    constructor(private app: App) {}

    showConflictModal(
        filePath: string,
        localText: string,
        remoteText: string,
    ): { result: Promise<ConflictModalResult>; dismiss: () => void } {
        const modal = new ConflictModal(this.app, filePath, localText, remoteText);
        const result = modal.waitForResult().then((choice) => ({
            choice,
            dismissed: modal.wasDismissed,
        }));
        return {
            result,
            dismiss: () => modal.dismiss(),
        };
    }

    async showConfirmModal(
        title: string,
        message: string,
        confirmLabel: string,
        danger = false,
    ): Promise<boolean> {
        const modal = new ConfirmModal(
            this.app, title, message, confirmLabel, danger,
        );
        return modal.waitForResult();
    }
}
