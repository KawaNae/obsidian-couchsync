/**
 * In-memory IModalPresenter for tests. Responses are queued and
 * returned in order.
 */

import type {
    IModalPresenter,
    ConflictChoice,
    ConflictModalResult,
} from "../../src/types/modal-presenter.ts";

export class FakeModalPresenter implements IModalPresenter {
    /** Queue of responses for showConflictModal. */
    conflictResponses: ConflictModalResult[] = [];
    /** Queue of responses for showConfirmModal. */
    confirmResponses: boolean[] = [];

    /** Record of all conflict modals shown (for assertions). */
    conflictCalls: Array<{ filePath: string; localText: string; remoteText: string }> = [];
    /** Record of all confirm modals shown (for assertions). */
    confirmCalls: Array<{ title: string; message: string }> = [];

    /** Dismiss callbacks for currently open conflict modals. */
    private openDismiss = new Map<string, () => void>();

    showConflictModal(
        filePath: string,
        localText: string,
        remoteText: string,
    ): { result: Promise<ConflictModalResult>; dismiss: () => void } {
        this.conflictCalls.push({ filePath, localText, remoteText });

        let resolveFn!: (value: ConflictModalResult) => void;
        const result = new Promise<ConflictModalResult>((resolve) => {
            resolveFn = resolve;
        });

        const response = this.conflictResponses.shift();
        const dismiss = () => {
            this.openDismiss.delete(filePath);
            resolveFn({ choice: "keep-local", dismissed: true });
        };

        this.openDismiss.set(filePath, dismiss);

        if (response && !response.dismissed) {
            // Resolve async to mimic real modal timing.
            Promise.resolve().then(() => {
                this.openDismiss.delete(filePath);
                resolveFn(response);
            });
        }

        return { result, dismiss };
    }

    async showConfirmModal(
        title: string,
        message: string,
        _confirmLabel: string,
        _danger?: boolean,
    ): Promise<boolean> {
        this.confirmCalls.push({ title, message });
        return this.confirmResponses.shift() ?? false;
    }

    /** Dismiss the open conflict modal for the given path (simulates auto-resolve). */
    dismissConflict(filePath: string): void {
        const dismiss = this.openDismiss.get(filePath);
        if (dismiss) dismiss();
    }
}
