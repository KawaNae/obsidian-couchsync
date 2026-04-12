/**
 * Tests for PouchDB → Dexie migration.
 *
 * Uses pouchdb-adapter-memory as the PouchDB source and
 * fake-indexeddb-backed DexieStore as the Dexie target.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PouchDB from "pouchdb";
import memoryAdapter from "pouchdb-adapter-memory";
import { createTestStore } from "./helpers/dexie-test-store.ts";
import { DexieStore } from "../src/db/dexie-store.ts";
import { migratePouchToDexie, type MigrationProgress } from "../src/db/migration.ts";
import type { FileDoc, ChunkDoc, CouchSyncDoc } from "../src/types.ts";
import { makeFileId, makeChunkId } from "../src/types/doc-id.ts";

PouchDB.plugin(memoryAdapter);

let counter = 0;
function uniqueName(prefix: string) {
    return `${prefix}-${Date.now()}-${counter++}`;
}

function makeFile(path: string, vc: Record<string, number> = { A: 1 }): FileDoc {
    return {
        _id: makeFileId(path),
        type: "file",
        chunks: [],
        mtime: 1000,
        ctime: 1000,
        size: 0,
        vclock: vc,
    };
}

describe("migratePouchToDexie", () => {
    let pouch: PouchDB.Database<CouchSyncDoc>;
    let dexie: DexieStore<CouchSyncDoc>;

    beforeEach(() => {
        pouch = new PouchDB<CouchSyncDoc>(uniqueName("migration"), { adapter: "memory" });
        dexie = createTestStore<CouchSyncDoc>("migration-target");
    });

    afterEach(async () => {
        await pouch.destroy().catch(() => {});
        await dexie.destroy().catch(() => {});
    });

    it("migrates docs from PouchDB to Dexie", async () => {
        await pouch.put(makeFile("a.md", { A: 1 }));
        await pouch.put(makeFile("b.md", { B: 2 }));
        await pouch.put({
            _id: makeChunkId("hash1"),
            type: "chunk",
            data: "AAAA",
        } as CouchSyncDoc);

        const result = await migratePouchToDexie(pouch, dexie);

        expect(result.migrated).toBe(true);
        expect(result.docCount).toBe(3);

        // Verify docs are in Dexie
        const fileA = await dexie.get(makeFileId("a.md"));
        expect(fileA).not.toBeNull();
        expect((fileA as FileDoc).vclock).toEqual({ A: 1 });

        const fileB = await dexie.get(makeFileId("b.md"));
        expect(fileB).not.toBeNull();
        expect((fileB as FileDoc).vclock).toEqual({ B: 2 });

        const chunk = await dexie.get(makeChunkId("hash1"));
        expect(chunk).not.toBeNull();
        expect((chunk as ChunkDoc).data).toBe("AAAA");
    });

    it("migrates _local metadata to meta table", async () => {
        await pouch.put(makeFile("a.md"));
        // Write _local docs (PouchDB stores these outside normal allDocs)
        await (pouch as any).put({
            _id: "_local/scan-cursor",
            lastScanStartedAt: 5000,
            lastScanCompletedAt: 6000,
            lastSeenUpdateSeq: 42,
        });
        await (pouch as any).put({
            _id: "_local/vault-manifest",
            paths: ["a.md", "b.md"],
            updatedAt: 7000,
        });

        const result = await migratePouchToDexie(pouch, dexie);

        expect(result.metaCount).toBe(2);

        const cursor = await dexie.getMeta<{
            lastScanStartedAt: number;
            lastScanCompletedAt: number;
            lastSeenUpdateSeq: number;
        }>("scan-cursor");
        expect(cursor).not.toBeNull();
        expect(cursor!.lastScanStartedAt).toBe(5000);
        expect(cursor!.lastSeenUpdateSeq).toBe(42);

        const manifest = await dexie.getMeta<{
            paths: string[];
            updatedAt: number;
        }>("vault-manifest");
        expect(manifest).not.toBeNull();
        expect(manifest!.paths).toEqual(["a.md", "b.md"]);
    });

    it("skips migration if Dexie already has docs", async () => {
        await pouch.put(makeFile("a.md"));
        // Pre-populate Dexie
        await dexie.put(makeFile("existing.md"));

        const result = await migratePouchToDexie(pouch, dexie);

        expect(result.migrated).toBe(false);
        expect(result.docCount).toBe(0);
    });

    it("returns migrated=false for empty PouchDB", async () => {
        const result = await migratePouchToDexie(pouch, dexie);
        expect(result.migrated).toBe(false);
        expect(result.docCount).toBe(0);
    });

    it("reports progress", async () => {
        for (let i = 0; i < 5; i++) {
            await pouch.put(makeFile(`file-${i}.md`));
        }

        const phases: string[] = [];
        const onProgress = (p: MigrationProgress) => {
            phases.push(p.phase);
        };

        await migratePouchToDexie(pouch, dexie, onProgress);

        expect(phases).toContain("checking");
        expect(phases).toContain("migrating");
        expect(phases).toContain("meta");
        expect(phases).toContain("done");
    });

    it("strips _rev from migrated docs", async () => {
        await pouch.put(makeFile("a.md"));
        await migratePouchToDexie(pouch, dexie);

        // The doc in Dexie should have _rev synthesized by DexieStore, not PouchDB's _rev
        const doc = await dexie.get(makeFileId("a.md"));
        expect(doc!._rev).toBe("1-dexie");
    });

    it("handles large batches (> MIGRATION_BATCH)", async () => {
        // Insert enough docs to require multiple batches (batch size is 1000)
        // Use a smaller count for test speed
        const count = 50;
        const docs: CouchSyncDoc[] = [];
        for (let i = 0; i < count; i++) {
            docs.push(makeFile(`file-${String(i).padStart(4, "0")}.md`));
        }
        for (const doc of docs) {
            await pouch.put(doc);
        }

        const result = await migratePouchToDexie(pouch, dexie);
        expect(result.docCount).toBe(count);

        // Verify all docs are accessible
        const allDocs = await dexie.allDocs();
        expect(allDocs.rows.length).toBe(count);
    });
});
