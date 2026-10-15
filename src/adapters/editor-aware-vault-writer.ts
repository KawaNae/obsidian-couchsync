/**
 * Production VaultWriter — applies remote content to the vault without
 * losing what an open note holds.
 *
 * **Postcondition (disk-write truth):** when a write returns
 * `applied: true`, the disk holds the doc's version (the bytes of
 * `content`, or no file). This invariant lets `lastSynced.chunks` always
 * reflect the true vault state, which the classifier in
 * `src/sync/classify-sync-relation.ts` relies on.
 *
 * **The writer writes the disk only.** An open note shows the new version
 * because Obsidian reloads it on the modify event: a pane with nothing
 * unsaved takes the disk's text as it is, keeping the cursor and the
 * scroll. Changing the editor's text from here would count as typing:
 * Obsidian would mark the pane unsaved, and on the modify event merge
 * that "typing" into the disk's text a second time. On a file with CRLF
 * line breaks, where the editor's LF text never equals the disk's, the
 * merge doubled every changed line.
 *
 * **Open notes.** Obsidian saves what is typed in a note about two
 * seconds later. Until then the disk still matches what was last synced,
 * so the caller's check (`VaultSync.unsyncedVaultChange`) cannot see the
 * input, and Obsidian would merge it with the written version instead of
 * the user choosing in the conflict dialog. So a write goes ahead only
 * while every Markdown pane on the path holds what the disk holds (line
 * endings and BOM aside; see `sameText`):
 *   - A pane differs: it holds input not yet saved. The write is declined
 *     (`UNSAVED_EDITOR_CHANGE`) and nothing is touched; after the save,
 *     the reconcile offers the declined version as a conflict.
 *   - A pane is in IME composition: Obsidian's reload would break the
 *     composition, so the write waits in the CompositionGate and is
 *     decided again on compositionend (or timeout). By then the disk must
 *     still hold what it held when the write was first decided; a save in
 *     between means the input was committed (`UNSYNCED_VAULT_CHANGE`).
 *     A composition still going on then is declined like unsaved input.
 *   - Otherwise the disk is written, and the modify event the write
 *     causes is marked via `IWriteIgnore`. Input typed between the check
 *     and the write is not lost: Obsidian merges it into the version it
 *     reloads and saves the result, which is pushed as an edit. A deletion
 *     detaches the panes right after the check, before anything is
 *     awaited, so no input can reach them; the file is then removed.
 *
 * With no pane open on the path, the disk is written straight away.
 */

import type { App, WorkspaceLeaf } from "obsidian";
import type { IVaultIO } from "../types/vault-io.ts";
import type { HistoryCapture } from "../history/history-capture.ts";
import type { CompositionGate } from "../sync/composition-gate.ts";
import {
    UNSAVED_EDITOR_CHANGE,
    UNSYNCED_VAULT_CHANGE,
    type VaultWriter,
    type WriteResult,
} from "../sync/vault-writer.ts";
import type { IWriteIgnore } from "../sync/vault-sync.ts";
import { logDebug } from "../ui/log.ts";

/**
 * The bits of a Markdown view the writer reads. `getViewData` is what the
 * view would save: the editor's text, or in reading view the text it last
 * rendered (the hidden editor is refreshed only when the user switches
 * back). `editor.cm` is CodeMirror's EditorView, which Obsidian does not
 * type; it tells whether an IME composition is going on.
 */
export interface MarkdownPaneView {
    readonly file: { readonly path: string } | null;
    getViewData(): string;
    readonly editor?: { readonly cm?: { readonly composing: boolean } };
}

interface Pane {
    leaf: WorkspaceLeaf;
    view: MarkdownPaneView;
}

/**
 * Text as a pane and the disk can both hold it: CodeMirror keeps line
 * breaks as LF and Obsidian drops a BOM, while the file keeps CRLF or a
 * BOM. Comparing without them keeps a file with CRLF from being declined
 * on every write while its pane holds nothing unsaved.
 */
function sameText(text: string): string {
    return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
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
        await this.capturePreSync(path);
        return this.whilePanesHoldDisk(path, null, () => this.writeContent(path, content));
    }

    applyRemoteDeletion(path: string): Promise<WriteResult> {
        return this.whilePanesHoldDisk(path, null, (panes) => this.removeFile(path, panes));
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

    /**
     * Run `apply` with the panes open on `path`, only while each holds what
     * the disk holds and none is composing (see the module comment).
     * `decidedDisk` is the disk text when the write was first decided; it is
     * set when a composition deferred the write, and the disk must still
     * hold it. `apply` is called right after the check, with no await in
     * between.
     */
    private async whilePanesHoldDisk(
        path: string,
        decidedDisk: string | null,
        apply: (panes: Pane[]) => Promise<WriteResult>,
    ): Promise<WriteResult> {
        if (decidedDisk === null && this.findPanes(path).length === 0) return apply([]);

        const disk = await this.readDiskText(path);
        if (decidedDisk !== null && disk !== decidedDisk) {
            logDebug(`VaultWriter: skipped ${path} — the file changed while the write waited for composition`);
            return { applied: false, reason: UNSYNCED_VAULT_CHANGE };
        }
        // Nothing on disk to compare with: a deletion has nothing to
        // remove, and a content write fails in the vault as before.
        if (disk === null) return apply([]);

        const panes = this.findPanes(path);
        if (panes.some((p) => sameText(p.view.getViewData()) !== disk)) {
            logDebug(`VaultWriter: skipped ${path} — an open note holds input not yet saved`);
            return { applied: false, reason: UNSAVED_EDITOR_CHANGE };
        }
        if (panes.some((p) => p.view.editor?.cm?.composing === true)) {
            // Waited once already: a composition that is still (or again)
            // going on is input in progress, as unsaved text is. Waiting
            // again could loop when the gate drains by timeout.
            if (decidedDisk !== null) {
                logDebug(`VaultWriter: skipped ${path} — composing again after the wait`);
                return { applied: false, reason: UNSAVED_EDITOR_CHANGE };
            }
            logDebug(`VaultWriter: defer ${path} (composing, panes=${panes.length})`);
            return this.gate.defer(path, () => this.whilePanesHoldDisk(path, disk, apply));
        }
        return apply(panes);
    }

    private async writeContent(path: string, content: ArrayBuffer): Promise<WriteResult> {
        this.writeIgnore?.ignoreModifyTo(path, content);
        await this.io.writeBinary(path, content);
        await this.captureHistoryFromBytes(path, content);
        return { applied: true };
    }

    private async removeFile(path: string, panes: Pane[]): Promise<WriteResult> {
        // Detach the panes first so a pane doesn't outlive the file
        // (Obsidian would show a stale buffer until the user clicks away).
        for (const { leaf } of panes) leaf.detach();
        if (await this.io.exists(path)) {
            this.writeIgnore?.ignoreDelete(path);
            await this.io.delete(path);
        }
        return { applied: true };
    }

    /** The file's text as a pane would hold it, or null when it is gone. */
    private async readDiskText(path: string): Promise<string | null> {
        if (!(await this.io.exists(path))) return null;
        return sameText(new TextDecoder("utf-8").decode(await this.io.readBinary(path)));
    }

    /** The Markdown panes showing `path`. */
    private findPanes(path: string): Pane[] {
        const out: Pane[] = [];
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            const view = leaf.view as unknown as MarkdownPaneView | undefined;
            if (view?.file?.path !== path || typeof view.getViewData !== "function") continue;
            out.push({ leaf, view });
        }
        return out;
    }

    private async capturePreSync(path: string): Promise<void> {
        if (!this.historyCapture) return;
        try {
            await this.historyCapture.capturePreSyncState(path);
        } catch {
            // best-effort — failure must not block the sync write
        }
    }

    private async captureHistoryFromBytes(path: string, content: ArrayBuffer): Promise<void> {
        if (!this.historyCapture) return;
        const text = new TextDecoder("utf-8").decode(content);
        try {
            await this.historyCapture.captureSyncWrite(path, text);
        } catch (e) {
            logDebug(`captureSyncWrite failed: ${path} ${(e as Error)?.message ?? e}`);
        }
    }
}
