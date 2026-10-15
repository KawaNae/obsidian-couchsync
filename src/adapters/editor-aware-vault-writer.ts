/**
 * Production VaultWriter — applies remote content while preserving
 * open-editor session state.
 *
 * **Postcondition (disk-write truth):** when a write returns
 * `applied: true`, the disk holds the doc's version (the bytes of
 * `content`, or no file). The CM dispatch is a UX overlay (cursor / scroll
 * preservation), never the system's persistence. This invariant lets
 * `lastSynced.chunks` always reflect the true vault state, which the
 * classifier in `src/sync/classify-sync-relation.ts` relies on.
 *
 * **Open editors.** Obsidian saves what is typed in an editor about two
 * seconds later. Until then the disk still matches what was last synced,
 * so the caller's check (`VaultSync.unsyncedVaultChange`) cannot see the
 * input, and replacing the editor's text would discard it. So a write
 * goes ahead only while every Markdown pane on the path holds what the
 * disk holds (line endings and BOM aside; see `sameText`):
 *   - A pane differs: the editor holds input not yet saved. The write is
 *     declined (`UNSAVED_EDITOR_CHANGE`) and nothing is touched; after
 *     the save, the reconcile offers the declined version as a conflict.
 *   - A pane is in IME composition: replacing its text would break the
 *     composition, so the write waits in the CompositionGate and is
 *     decided again on compositionend (or timeout). By then the disk must
 *     still hold what it held when the write was first decided; a save in
 *     between means the input was committed (`UNSYNCED_VAULT_CHANGE`).
 *     A composition still going on then is declined like unsaved input.
 *   - Otherwise the panes are replaced (or detached, for a deletion)
 *     before anything is awaited, so input cannot arrive between the
 *     check and the replacement; input that arrives later lands on top
 *     of the new content. The disk is then written (or the file removed),
 *     with the echo modify/delete event suppressed via `IWriteIgnore`.
 *
 * With no pane open on the path, the disk is written straight away.
 */

import type { App, MarkdownView, WorkspaceLeaf } from "obsidian";
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

/**
 * Text as an editor and the disk can both hold it: CodeMirror keeps line
 * breaks as LF and Obsidian may drop a BOM, while the file keeps CRLF or a
 * BOM. Comparing without them keeps a file with CRLF from being declined
 * on every write while its editor holds nothing unsaved.
 */
function sameText(text: string): string {
    return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
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
        return this.whileEditorsHoldDisk(path, null, (editors) =>
            this.replaceContent(path, content, editors),
        );
    }

    applyRemoteDeletion(path: string): Promise<WriteResult> {
        return this.whileEditorsHoldDisk(path, null, (editors) =>
            this.removeFile(path, editors),
        );
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
     * hold it.
     *
     * `apply` must touch the panes before its first `await`.
     */
    private async whileEditorsHoldDisk(
        path: string,
        decidedDisk: string | null,
        apply: (editors: EditorLeaf[]) => Promise<WriteResult>,
    ): Promise<WriteResult> {
        if (decidedDisk === null && this.findEditors(path).length === 0) return apply([]);

        const disk = await this.readDiskText(path);
        if (decidedDisk !== null && disk !== decidedDisk) {
            logDebug(`VaultWriter: skipped ${path} — the file changed while the write waited for composition`);
            return { applied: false, reason: UNSYNCED_VAULT_CHANGE };
        }
        // Nothing on disk to compare with: a deletion has nothing to
        // remove, and a content write fails in the vault as before.
        if (disk === null) return apply([]);

        // No await from here until `apply` has replaced the panes.
        const editors = this.findEditors(path);
        if (editors.some((e) => sameText(e.cm.state.doc.toString()) !== disk)) {
            logDebug(`VaultWriter: skipped ${path} — an open editor holds input not yet saved`);
            return { applied: false, reason: UNSAVED_EDITOR_CHANGE };
        }
        if (editors.some((e) => e.cm.composing)) {
            // Waited once already: a composition that is still (or again)
            // going on is input in progress, as unsaved text is. Waiting
            // again could loop when the gate drains by timeout.
            if (decidedDisk !== null) {
                logDebug(`VaultWriter: skipped ${path} — composing again after the wait`);
                return { applied: false, reason: UNSAVED_EDITOR_CHANGE };
            }
            logDebug(`VaultWriter: defer ${path} (composing, editors=${editors.length})`);
            return this.gate.defer(path, () => this.whileEditorsHoldDisk(path, disk, apply));
        }
        return apply(editors);
    }

    private async replaceContent(
        path: string,
        content: ArrayBuffer,
        editors: EditorLeaf[],
    ): Promise<WriteResult> {
        const text = new TextDecoder("utf-8").decode(content);
        if (editors.length > 0) logDebug(`VaultWriter: dispatch ${path} (editors=${editors.length})`);
        for (const { cm } of editors) {
            cm.dispatch({
                changes: { from: 0, to: cm.state.doc.length, insert: text },
            });
        }
        this.writeIgnore?.ignoreNextModify(path);
        await this.io.writeBinary(path, content);
        await this.captureHistoryFromText(path, text);
        return { applied: true };
    }

    private async removeFile(path: string, editors: EditorLeaf[]): Promise<WriteResult> {
        // Detach the panes first so an editor doesn't outlive the file
        // (Obsidian would show a stale buffer until the user clicks away).
        for (const { leaf } of editors) leaf.detach();
        if (await this.io.exists(path)) {
            this.writeIgnore?.ignoreDelete(path);
            await this.io.delete(path);
        }
        return { applied: true };
    }

    /** The file's text as an editor would hold it, or null when it is gone. */
    private async readDiskText(path: string): Promise<string | null> {
        if (!(await this.io.exists(path))) return null;
        return sameText(new TextDecoder("utf-8").decode(await this.io.readBinary(path)));
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

    private async capturePreSync(path: string): Promise<void> {
        if (!this.historyCapture) return;
        try {
            await this.historyCapture.capturePreSyncState(path);
        } catch {
            // best-effort — failure must not block the sync write
        }
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

