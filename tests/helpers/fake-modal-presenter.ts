/**
 * In-memory IModalPresenter for tests. Responses are queued and
 * returned in order.
 */

import type {
    IModalPresenter,
    ConflictChoice,
    ConflictModalResult,
    ConflictContent,
    ConflictBatchItem,
    BatchDecision,
    ConfigOverwritePreview,
    ConfigShareAgainPreview,
} from "../../src/types/modal-presenter.ts";
import { defaultSelection, type PushReview } from "../../src/sync/config-push-review.ts";
import type { ConfigCreateConfirm } from "../../src/sync/config-create-preview.ts";

export class FakeModalPresenter implements IModalPresenter {
    /** Queue of responses for showConflictModal. */
    conflictResponses: ConflictModalResult[] = [];
    /** Queue of responses for showConfirmModal. */
    confirmResponses: boolean[] = [];
    /** Queue of responses for showConflictBatchModal. */
    batchResponses: BatchDecision[] = [];

    /** Record of all conflict modals shown (for assertions). */
    conflictCalls: Array<{ filePath: string; content: ConflictContent }> = [];
    /** Record of all confirm modals shown (for assertions). */
    confirmCalls: Array<{ title: string; message: string }> = [];
    /** Record of all batch modals shown (for assertions). */
    batchCalls: ConflictBatchItem[][] = [];
    /** Answers the config Push list. Default: send what the list selects
     *  at the start. Return null to cancel. */
    pushResponder: (review: PushReview) => string[] | null = defaultSelection;
    /** Record of all config Push lists shown (for assertions). */
    pushCalls: PushReview[] = [];

    /** Answers the overwrite confirmation. Default: cancel. */
    overwriteResponses: boolean[] = [];
    /** Record of all overwrite confirmations shown (for assertions). */
    overwriteCalls: ConfigOverwritePreview[] = [];

    /** Answers the Share again confirmation. Default: cancel. */
    shareAgainResponses: boolean[] = [];
    /** Record of all Share again confirmations shown (for assertions). */
    shareAgainCalls: ConfigShareAgainPreview[] = [];

    /** Answers the config Create confirmation. Default: go ahead. */
    createResponder: (confirm: ConfigCreateConfirm) => boolean | Promise<boolean> = () => true;
    /** Record of all Create confirmations shown (for assertions). */
    createCalls: ConfigCreateConfirm[] = [];

    /** Dismiss callbacks for currently open conflict modals. */
    private openDismiss = new Map<string, () => void>();
    /** Answer callbacks for conflict modals left open (no queued response). */
    private openAnswer = new Map<string, (choice: ConflictChoice) => void>();

    showConflictModal(
        filePath: string,
        content: ConflictContent,
    ): { result: Promise<ConflictModalResult>; dismiss: () => void } {
        this.conflictCalls.push({ filePath, content });

        let resolveFn!: (value: ConflictModalResult) => void;
        const result = new Promise<ConflictModalResult>((resolve) => {
            resolveFn = resolve;
        });

        const response = this.conflictResponses.shift();
        const dismiss = () => {
            this.openDismiss.delete(filePath);
            this.openAnswer.delete(filePath);
            resolveFn({ choice: "keep-local", dismissed: true });
        };

        this.openDismiss.set(filePath, dismiss);
        this.openAnswer.set(filePath, (choice) => {
            this.openDismiss.delete(filePath);
            this.openAnswer.delete(filePath);
            resolveFn({ choice, dismissed: false });
        });

        if (response && !response.dismissed) {
            // Resolve async to mimic real modal timing.
            Promise.resolve().then(() => {
                this.openDismiss.delete(filePath);
                resolveFn(response);
            });
        }

        return { result, dismiss };
    }

    async showConflictBatchModal(items: ConflictBatchItem[]): Promise<BatchDecision> {
        this.batchCalls.push(items);
        return this.batchResponses.shift() ?? { kind: "dismissed" };
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

    async showConfigPushModal(review: PushReview): Promise<string[] | null> {
        this.pushCalls.push(review);
        return this.pushResponder(review);
    }

    async showConfigOverwriteModal(preview: ConfigOverwritePreview): Promise<boolean> {
        this.overwriteCalls.push(preview);
        return this.overwriteResponses.shift() ?? false;
    }

    async showConfigShareAgainModal(preview: ConfigShareAgainPreview): Promise<boolean> {
        this.shareAgainCalls.push(preview);
        return this.shareAgainResponses.shift() ?? false;
    }

    async showConfigCreateModal(confirm: ConfigCreateConfirm): Promise<boolean> {
        this.createCalls.push(confirm);
        return this.createResponder(confirm);
    }

    /** Answer the open conflict modal for the given path with a choice. */
    answerConflict(filePath: string, choice: ConflictChoice): void {
        const answer = this.openAnswer.get(filePath);
        if (!answer) throw new Error(`no open conflict modal for ${filePath}`);
        answer(choice);
    }

    /** Dismiss the open conflict modal for the given path (simulates auto-resolve). */
    dismissConflict(filePath: string): void {
        const dismiss = this.openDismiss.get(filePath);
        if (dismiss) dismiss();
    }
}
