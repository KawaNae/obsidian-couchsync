/**
 * Integration test: folder-structure operations (Phase 1).
 *
 * Drives the real VaultSync + LocalDB + chunker with a faked, CASE-SENSITIVE
 * vault I/O (FakeVaultIO keys by exact path, like Android's ext4). Covers:
 *   - folder delete desugars to per-child tombstones (invariant S1)
 *   - dbToFile refuses to create a case-colliding file rather than throwing
 *     "File already exists" / minting a duplicate (invariant S3/S5)
 */
import "fake-indexeddb/auto";
import { describe, it, expect, afterEach } from "vitest";
import { VaultSync } from "../../src/sync/vault-sync.ts";
import { FilesystemVaultWriter } from "../../src/sync/vault-writer.ts";
import { LocalDB } from "../../src/db/local-db.ts";
import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { makeSettings } from "../helpers/settings-factory.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc } from "../../src/types.ts";

let counter = 0;
function uniqueDbName(label: string) {
    return `folder-struct-${label}-${Date.now()}-${counter++}`;
}

/**
 * FakeVaultIO models a flat file map and can't represent an EMPTY folder
 * (the exact thing empty-folder prune targets). This subclass tracks
 * explicitly-created folders so a folder can outlive its last file — letting
 * us assert that prune removes it.
 */
class FolderAwareVaultIO extends FakeVaultIO {
    folderSet = new Set<string>();
    async createFolder(path: string): Promise<void> { this.folderSet.add(path); }
    async delete(path: string): Promise<void> {
        this.files.delete(path);
        this.folderSet.delete(path);
    }
    async exists(path: string): Promise<boolean> {
        return this.files.has(path) || this.folderSet.has(path);
    }
    async list(path: string): Promise<{ files: string[]; folders: string[] }> {
        const base = await super.list(path);
        const prefix = path.endsWith("/") ? path : path + "/";
        const folders = new Set(base.folders);
        for (const f of this.folderSet) {
            if (!f.startsWith(prefix)) continue;
            const rest = f.slice(prefix.length);
            if (rest && !rest.includes("/")) folders.add(f);
        }
        return { files: base.files, folders: [...folders] };
    }
    getFolders(): string[] {
        return [...new Set([...super.getFolders(), ...this.folderSet])];
    }
    async abstractType(path: string): Promise<"file" | "folder" | null> {
        const base = await super.abstractType(path);
        if (base) return base;
        if (this.folderSet.has(path)) return "folder";
        return null;
    }
}

describe("Integration: folder structure (Phase 1)", () => {
    const cleanups: Array<() => Promise<void>> = [];

    function createDevice(deviceId: string, vaultIO?: FakeVaultIO) {
        const vault = vaultIO ?? new FakeVaultIO();
        const db = new LocalDB(uniqueDbName(deviceId));
        db.open();
        const settings = makeSettings({ deviceId });
        const writer = new FilesystemVaultWriter(vault);
        const vs = new VaultSync(vault, db, () => settings, writer);
        cleanups.push(async () => { await db.destroy(); });
        return { vault, db, vs, settings };
    }

    afterEach(async () => {
        for (const fn of cleanups.splice(0)) await fn();
    });

    it("folder delete desugars into per-child tombstones, leaving siblings alone", async () => {
        const dev = createDevice("dev-A");
        dev.vault.addFile("scripts/a.js", "a");
        dev.vault.addFile("scripts/sub/b.js", "b");
        dev.vault.addFile("scriptsX/c.js", "c"); // sibling folder, must NOT match
        dev.vault.addFile("notes/keep.md", "keep");
        for (const p of ["scripts/a.js", "scripts/sub/b.js", "scriptsX/c.js", "notes/keep.md"]) {
            await dev.vs.fileToDb(p);
        }

        // User deletes the "scripts" folder: children vanish from the FS, then
        // Obsidian fires a single folder-delete (here we call the handler).
        dev.vault.files.delete("scripts/a.js");
        dev.vault.files.delete("scripts/sub/b.js");
        await dev.vs.handleFolderDelete("scripts");

        const a = await dev.db.get(makeFileId("scripts/a.js")) as FileDoc;
        const b = await dev.db.get(makeFileId("scripts/sub/b.js")) as FileDoc;
        const c = await dev.db.get(makeFileId("scriptsX/c.js")) as FileDoc;
        const keep = await dev.db.get(makeFileId("notes/keep.md")) as FileDoc;

        expect(a.deleted).toBe(true);
        expect(b.deleted).toBe(true);
        expect(c.deleted).toBeFalsy();    // prefix "scripts/" must not match "scriptsX/"
        expect(keep.deleted).toBeFalsy(); // unrelated sibling untouched
    });

    it("dbToFile refuses a case-colliding create instead of throwing or duplicating", async () => {
        const dev = createDevice("dev-A");
        dev.vault.addFile("Scripts/X.md", "canonical");
        await dev.vs.fileToDb("Scripts/X.md");
        const upperDoc = await dev.db.get(makeFileId("Scripts/X.md")) as FileDoc;

        // A different-case sibling doc arrives (the scripts/Scripts incident).
        const lowerDoc: FileDoc = {
            ...upperDoc,
            _id: makeFileId("scripts/X.md"),
        };

        const result = await dev.vs.dbToFile(lowerDoc);

        // No throw; the write is declined and deferred to reconcile Case F.
        expect(result.applied).toBe(false);
        expect((result as { reason: string }).reason).toBe("path-key-collision");
        // No duplicate physical file was created; the canonical stays intact.
        expect(dev.vault.files.has("scripts/X.md")).toBe(false);
        expect(dev.vault.files.has("Scripts/X.md")).toBe(true);
        expect(dev.vault.readText("Scripts/X.md")).toBe("canonical");
    });

    it("dbToFile case-dedup tombstone does NOT delete the different-case canonical", async () => {
        // Models a case-insensitive FS where 'scripts/X.md' and 'Scripts/X.md'
        // are ONE physical file: a tombstone pulled for the non-canonical case
        // must not nuke the surviving canonical (invariant S3/S5).
        const dev = createDevice("dev-A");
        dev.vault.addFile("Scripts/X.md", "canonical");
        await dev.vs.fileToDb("Scripts/X.md");

        const tombstone: FileDoc = {
            ...(await dev.db.get(makeFileId("Scripts/X.md")) as FileDoc),
            _id: makeFileId("scripts/X.md"),
            deleted: true,
        };

        const result = await dev.vs.dbToFile(tombstone);

        expect(result.applied).toBe(true); // integrated, but disk untouched
        expect(dev.vault.files.has("Scripts/X.md")).toBe(true);
        expect(dev.vault.readText("Scripts/X.md")).toBe("canonical");
    });

    it("prunes the parent folder that becomes empty after pull-applied deletions", async () => {
        // The Attachments2→Attachments3 scenario on the RECEIVING device: the
        // folder's files arrive as per-file tombstones; once the last file is
        // deleted, the now-empty folder must be pruned (invariant S1 §C.3).
        const vault = new FolderAwareVaultIO();
        const dev = createDevice("dev-recv", vault);
        await vault.createFolder("Box");
        vault.addFile("Box/a.md", "a");
        vault.addFile("Box/b.md", "b");
        await dev.vs.fileToDb("Box/a.md");
        await dev.vs.fileToDb("Box/b.md");

        const tomb = async (path: string): Promise<FileDoc> => ({
            ...(await dev.db.getFileDoc(path))!,
            deleted: true,
        });

        // First tombstone: Box still has b.md → folder must remain.
        await dev.vs.dbToFile(await tomb("Box/a.md"));
        expect(await vault.exists("Box")).toBe(true);

        // Last tombstone: Box now empty → pruned.
        await dev.vs.dbToFile(await tomb("Box/b.md"));
        expect(await vault.exists("Box/b.md")).toBe(false);
        expect(await vault.exists("Box")).toBe(false);
    });

    it("does NOT prune a parent that still holds sibling files", async () => {
        const vault = new FolderAwareVaultIO();
        const dev = createDevice("dev-recv2", vault);
        await vault.createFolder("Keep");
        vault.addFile("Keep/gone.md", "gone");
        vault.addFile("Keep/stay.md", "stay");
        await dev.vs.fileToDb("Keep/gone.md");
        await dev.vs.fileToDb("Keep/stay.md");

        await dev.vs.dbToFile({ ...(await dev.db.getFileDoc("Keep/gone.md"))!, deleted: true });

        expect(await vault.exists("Keep/gone.md")).toBe(false);
        expect(await vault.exists("Keep/stay.md")).toBe(true);
        expect(await vault.exists("Keep")).toBe(true); // sibling keeps the folder alive
    });

    it("reuses an existing folder's case instead of minting a duplicate-case folder (M-1)", async () => {
        // Case-sensitive FS: 'Notes/' already holds a file. A doc whose parent
        // dir differs ONLY in case ('notes/') is pulled. ensureParentDir must
        // place the child under the existing 'Notes/', not create a second
        // 'notes/' folder (the duplicate-folder divergence).
        const dev = createDevice("dev-A");
        dev.vault.addFile("Notes/real.md", "hi");
        await dev.vs.fileToDb("Notes/real.md");
        // Seed chunks for the incoming file via a temp source, then re-point.
        dev.vault.addFile("Notes/_src", "x content");
        await dev.vs.fileToDb("Notes/_src");
        const lowerDoc: FileDoc = {
            ...(await dev.db.get(makeFileId("Notes/_src")) as FileDoc),
            _id: makeFileId("notes/x.md"), // lowercase parent
        };

        const result = await dev.vs.dbToFile(lowerDoc);

        expect(result.applied).toBe(true);
        expect(dev.vault.files.has("Notes/x.md")).toBe(true);  // landed in existing folder
        expect(dev.vault.files.has("notes/x.md")).toBe(false); // no lowercase variant
        const notesFolders = dev.vault.getFolders().filter((f) => f.toLowerCase() === "notes");
        expect(notesFolders).toEqual(["Notes"]); // exactly one folder folds to this PathKey
    });

    it("declines a file create whose path is occupied by a folder, instead of throwing (M-2)", async () => {
        const vault = new FolderAwareVaultIO();
        const dev = createDevice("dev-A", vault);
        await vault.createFolder("archive");        // a FOLDER holds 'archive'
        vault.addFile("archive/note.md", "inside");
        vault.addFile("_arc_src", "file body");     // seed chunks for an extensionless file doc
        await dev.vs.fileToDb("_arc_src");
        const fileDoc: FileDoc = {
            ...(await dev.db.get(makeFileId("_arc_src")) as FileDoc),
            _id: makeFileId("archive"),             // file shares the folder's path
        };

        const result = await dev.vs.dbToFile(fileDoc);

        expect(result.applied).toBe(false);
        expect((result as { reason: string }).reason).toBe("file-folder-collision");
        expect(await vault.abstractType("archive")).toBe("folder"); // folder untouched
    });

    it("empty-folder prune does not delete a file occupying the parent's path (M-2 type guard)", async () => {
        const vault = new FolderAwareVaultIO();
        const dev = createDevice("dev-A", vault);
        vault.addFile("P/only.md", "child");
        vault.addFile("P", "i am a file, not a folder"); // shares the parent path
        await dev.vs.fileToDb("P/only.md");
        await dev.vs.fileToDb("P");

        // Delete the child → prune walks up to "P", which resolves to a FILE.
        await dev.vs.dbToFile({ ...(await dev.db.getFileDoc("P/only.md"))!, deleted: true });

        expect(await vault.exists("P/only.md")).toBe(false);
        expect(vault.files.has("P")).toBe(true); // the file survived the prune
    });
});
