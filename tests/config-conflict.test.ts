/**
 * Tests that ConflictResolver handles ConfigDoc conflicts the same way
 * it handles FileDoc conflicts. Same VC discipline, same callback shape,
 * but the path passed to callbacks is the `.obsidian/...` path extracted
 * from the `config:` prefix.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PouchDB from "pouchdb";
import memoryAdapter from "pouchdb-adapter-memory";
import { ConflictResolver } from "../src/conflict/conflict-resolver.ts";
import type { ConfigDoc, CouchSyncDoc } from "../src/types.ts";
import { makeConfigId } from "../src/types/doc-id.ts";

PouchDB.plugin(memoryAdapter);

/** Adapt a raw PouchDB into an ILocalStore-shaped object for ConflictResolver tests. */
function wrapAsStore(db: PouchDB.Database<CouchSyncDoc>) {
    return {
        get: async (id: string) => {
            try { return await db.get(id) as unknown; }
            catch (e: any) { if (e.status === 404) return null; throw e; }
        },
        getByRev: async (id: string, rev: string) => {
            try { return await db.get(id, { rev }) as unknown; }
            catch (e: any) { if (e.status === 404) return null; throw e; }
        },
        put: async (doc: CouchSyncDoc) => db.put(doc),
        removeRev: async (id: string, rev: string) => { await db.remove(id, rev); },
        allDocs: async (opts?: any) => db.allDocs(opts) as any,
    };
}

function uniqueName(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

async function createConflict(
    db: PouchDB.Database<CouchSyncDoc>,
    vaultPath: string,
    localAttrs: Partial<ConfigDoc>,
    remoteAttrs: Partial<ConfigDoc>,
): Promise<ConfigDoc> {
    const id = makeConfigId(vaultPath);
    const baseDoc: ConfigDoc = {
        _id: id,
        type: "config",
        data: "YmFzZQ==", // "base"
        mtime: 1000,
        size: 4,
        vclock: {},
    };
    const { rev: baseRev } = await db.put(baseDoc);

    const localDoc: ConfigDoc = {
        ...baseDoc,
        _rev: baseRev,
        data: "bG9jYWw=", // "local"
        ...localAttrs,
    };
    await db.put(localDoc);

    const remoteDoc: ConfigDoc = {
        ...baseDoc,
        data: "cmVtb3Rl", // "remote"
        ...remoteAttrs,
    };
    await db.bulkDocs(
        [{ ...remoteDoc, _rev: `2-remote${Date.now()}${Math.random()}` }],
        { new_edits: false },
    );

    const result = await db.get(id, { conflicts: true });
    return result as unknown as ConfigDoc;
}

describe("ConflictResolver — ConfigDoc support", () => {
    let db: PouchDB.Database<CouchSyncDoc>;

    beforeEach(() => {
        db = new PouchDB<CouchSyncDoc>(uniqueName("cfg-conflict"), { adapter: "memory" });
    });

    afterEach(async () => {
        await db.destroy().catch(() => {});
    });

    it("auto-resolves a ConfigDoc conflict where one VC dominates", async () => {
        const doc = await createConflict(
            db,
            ".obsidian/appearance.json",
            { vclock: { A: 2, B: 1 } },
            { vclock: { A: 1, B: 1 } },
        );
        expect(doc._conflicts?.length).toBeGreaterThan(0);

        const resolver = new ConflictResolver(wrapAsStore(db) as any);
        const onConcurrent = vi.fn();
        const onAuto = vi.fn();
        resolver.setOnConcurrent(onConcurrent);
        resolver.setOnAutoResolved(onAuto);

        const resolved = await resolver.resolveIfConflicted(doc);
        expect(resolved).toBe(true);
        expect(onConcurrent).not.toHaveBeenCalled();
        expect(onAuto).toHaveBeenCalled();
        // The callback should receive the bare .obsidian path, not the config: prefixed id
        expect(onAuto.mock.calls[0][0]).toBe(".obsidian/appearance.json");
    });

    it("raises onConcurrent for ConfigDoc when VCs are incomparable", async () => {
        const doc = await createConflict(
            db,
            ".obsidian/hotkeys.json",
            { vclock: { mobile: 1, desktop: 0 } },
            { vclock: { mobile: 0, desktop: 1 } },
        );

        const resolver = new ConflictResolver(wrapAsStore(db) as any);
        const onConcurrent = vi.fn();
        resolver.setOnConcurrent(onConcurrent);

        const resolved = await resolver.resolveIfConflicted(doc);
        expect(resolved).toBe(false);
        expect(onConcurrent).toHaveBeenCalledTimes(1);
        // Path should be the .obsidian path
        expect(onConcurrent.mock.calls[0][0]).toBe(".obsidian/hotkeys.json");
        // Should receive every revision in the conflict tree
        expect(onConcurrent.mock.calls[0][1].length).toBe(2);
    });

    it("scanConflicts finds ConfigDoc conflicts (not just FileDoc)", async () => {
        await createConflict(
            db,
            ".obsidian/app.json",
            { vclock: { A: 2 } },
            { vclock: { A: 1 } },
        );

        const resolver = new ConflictResolver(wrapAsStore(db) as any);
        const resolvedCount = await resolver.scanConflicts();
        expect(resolvedCount).toBe(1);
    });

    it("does not consult mtime when VCs decide the winner", async () => {
        // Hostile case: the VC says local wins, but mtime says remote
        // is newer. Pure mtime-LWW would pick remote — VC must not.
        const doc = await createConflict(
            db,
            ".obsidian/community-plugins.json",
            { vclock: { A: 5 }, mtime: 1, data: "d2lubmVy" }, // "winner", old mtime
            { vclock: { A: 3 }, mtime: 999999, data: "bG9zZXI=" }, // "loser", new mtime
        );

        const resolver = new ConflictResolver(wrapAsStore(db) as any);
        const resolved = await resolver.resolveIfConflicted(doc);
        expect(resolved).toBe(true);

        const final = (await db.get(makeConfigId(".obsidian/community-plugins.json"))) as unknown as ConfigDoc;
        expect(final.vclock).toEqual({ A: 5 });
        expect(final.data).toBe("d2lubmVy");
    });
});
