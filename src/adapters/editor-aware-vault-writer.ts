/**
 * Production VaultWriter — applies remote content while preserving
 * open-editor session state.
 *
 * **Postcondition (PR1 invariant — disk-write truth):** when
 * `applyRemoteContent` returns `applied: true`, the bytes on disk equal
 * `content`. The CM dispatch is a UX overlay (cursor / scroll preservation),
 * never the system's persistence. This invariant lets `lastSynced.chunks`
 * always reflect the true vault state, which the classifier in
 * `src/sync/classify-sync-relation.ts` relies on.
 *
 * Strategy:
 *   1. Find every `MarkdownView` leaf with `path` open and grab their
 *      CodeMirror EditorView (`view.editor.cm`).
 *   2. If any has `composing === true`, defer through the
 *      CompositionGate. The deferred op re-runs the strategy on
 *      compositionend (or timeout).
 *   3. With no editors open, write straight to disk via `IVaultIO.writeBinary`.
 *      The modify event is suppressed via `ignoreNextModify` so the echo
 *      doesn't redundantly schedule a fileToDb (which would short-circuit
 *      anyway via `chunksEqual`, but suppressing saves the debounce timer
 *      and avoids history double-capture).
 *   4. With editors open and none composing, write disk first then dispatch
 *      a CodeMirror transaction on every pane. Disk and editor both end
 *      with the new content; the suppressed modify event keeps the push
 *      pipeline quiet.
 *
 * Editor-divergence guard: when an op is deferred, the pre-composition
 * doc is captured. At drain time, if the doc has diverged (user
 * committed text mid-IME), the op is skipped and the caller is told
 * `applied: false`. Reconciler picks up the divergence on its next
 * pass and routes it through the conflict orchestrator if needed.
 */

import type { App, MarkdownView, WorkspaceLeaf } from "obsidian";
import type { IVaultIO } from "../types/vault-io.ts";
import type { HistoryCapture } from "../history/history-capture.ts";
import type { CompositionGate } from "../sync/composition-gate.ts";
import type { VaultWriter, WriteResult } from "../sync/vault-writer.ts";
import type { IWriteIgnore } from "../sync/vault-sync.ts";
import { logDebug } from "../ui/log.ts";

/**
 * Structural type for the bits of CM6 EditorView we touch. Lets the
 * unit tests mock without pulling in @codemirror/view.
 */
export interface CMLike {
    readonly composing: boolean;
    readonly state: { readonly doc: { readonly length: number; toString(): string } };
    dispatch(spec: { changes: { from: number; to: number; insert: string } }): void;
}

interface EditorLeaf {
    leaf: WorkspaceLeaf;
    cm: CMLike;
}

export class EditorAwareVaultWriter implements VaultWriter {
    constructor(
        private app: App,
        private io: IVaultIO,
        private gate: CompositionGate,
        private writeIgnore: IWriteIgnore | null,
        private historyCapture: HistoryCapture | null,
    ) {}

    /**
     * Late-binding setter for `writeIgnore`. Used to break the
     * construction-time cycle between ChangeTracker (which depends
     * on VaultSync) and EditorAwareVaultWriter (which would
     * otherwise want ChangeTracker at construction time).
     */
    setWriteIgnore(wi: IWriteIgnore): void {
        this.writeIgnore = wi;
    }

    async applyRemoteContent(path: string, content: ArrayBuffer): Promise<WriteResult> {
        const editors = this.findEditors(path);

        if (editors.length === 0) {
            // No live editor session — write straight to disk. Suppress
            // the resulting modify event so the echo doesn't roundtrip
            // through ChangeTracker.
            this.writeIgnore?.ignoreNextModify(path);
            await this.io.writeBinary(path, content);
            await this.captureHistoryFromBytes(path, content);
            return { applied: true };
        }

        const composing = editors.some((e) => e.cm.composing);
        if (composing) {
            logDebug(`VaultWriter: defer ${path} (composing, editors=${editors.length})`);
            const expected = editors[0].cm.state.doc.toString();
            return this.gate.defer(path, () =>
                this.applyAfterDefer(path, content, expected),
            );
        }

        return this.dispatchAndCapture(path, content, editors);
    }

    async applyRemoteDeletion(path: string): Promise<void> {
        // Detach any open leaves first so the editor doesn't outlive
        // the file (otherwise Obsidian shows a stale buffer until the
        // user clicks away).
        for (const { leaf } of this.findEditors(path)) {
            leaf.detach();
        }
        if (await this.io.exists(path)) {
            this.writeIgnore?.ignoreDelete(path);
            await this.io.delete(path);
        }
    }

    async createFile(path: string, content: ArrayBuffer): Promise<void> {
        // New files have no preexisting editor session.
        await this.io.createBinary(path, content);
        await this.captureHistoryFromBytes(path, content);
    }

    flushAll(): void {
        this.gate.flushAll();
    }

    // ── internals ──────────────────────────────────────────

    private async applyAfterDefer(
        path: string,
        content: ArrayBuffer,
        expectedDoc: string,
    ): Promise<WriteResult> {
        const editors = this.findEditors(path);
        if (editors.length === 0) {
            // All editors closed during the defer window — fall back
            // to disk write.
            this.writeIgnore?.ignoreNextModify(path);
            await this.io.writeBinary(path, content);
            await this.captureHistoryFromBytes(path, content);
            return { applied: true };
        }

        const currentDoc = editors[0].cm.state.doc.toString();
        if (currentDoc !== expectedDoc) {
            // The user committed text via IME during the deferral
            // window. Abandon this remote application; Reconciler
            // will pick up the divergence on its next pass and route
            // through ConflictOrchestrator if needed.
            logDebug(
                `EditorAwareVaultWriter: skipped ${path} — local doc changed during composition`,
            );
            return { applied: false, reason: "local-changed-during-composition" };
        }

        if (editors.some((e) => e.cm.composing)) {
            logDebug(`VaultWriter: re-defer ${path} (composition resumed)`);
            return this.gate.defer(path, () =>
                this.applyAfterDefer(path, content, expectedDoc),
            );
        }

        return this.dispatchAndCapture(path, content, editors);
    }

    private async dispatchAndCapture(
        path: string,
        content: ArrayBuffer,
        editors: EditorLeaf[],
    ): Promise<WriteResult> {
        const text = new TextDecoder("utf-8").decode(content);
        const anyComposing = editors.some((e) => e.cm.composing);
        logDebug(`VaultWriter: dispatch ${path} (editors=${editors.length}, composing=${anyComposing})`);

        this.writeIgnore?.ignoreNextModify(path);
        await this.io.writeBinary(path, content);

        for (const { cm } of editors) {
            cm.dispatch({
                changes: { from: 0, to: cm.state.doc.length, insert: text },
            });
        }

        await this.captureHistoryFromText(path, text);
        return { applied: true };
    }

    /**
     * Enumerate Markdown leaves whose view is showing `path` and
     * whose underlying view exposes a CM6 EditorView.
     */
    private findEditors(path: string): EditorLeaf[] {
        const out: EditorLeaf[] = [];
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            const view = leaf.view as MarkdownView | undefined;
            const file = view?.file;
            if (!file || file.path !== path) continue;
            const cm = (view as unknown as { editor?: { cm?: CMLike } })
                ?.editor?.cm;
            if (!cm) continue;
            out.push({ leaf, cm });
        }
        return out;
    }

    private async captureHistoryFromText(path: string, text: string): Promise<void> {
        if (!this.historyCapture) return;
        try {
            await this.historyCapture.captureSyncWrite(path, text);
        } catch (e) {
            logDebug(`captureSyncWrite failed: ${path} ${(e as Error)?.message ?? e}`);
        }
    }

    private async captureHistoryFromBytes(path: string, content: ArrayBuffer): Promise<void> {
        if (!this.historyCapture) return;
        return this.captureHistoryFromText(path, new TextDecoder("utf-8").decode(content));
    }
}

