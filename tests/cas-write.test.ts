import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PouchDB from "pouchdb";
import memoryAdapter from "pouchdb-adapter-memory";
import type { FileDoc, ChunkDoc, CouchSyncDoc } from "../src/types.ts";
import { makeFileId, makeChunkId } from "../src/types/doc-id.ts";

PouchDB.plugin(memoryAdapter);

function uniqueName() {
    return `cas-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
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

/**
 * Mirrors LocalDB.update() and LocalDB.bulkPut() logic exactly,
 * using raw PouchDB to avoid the pouchdb-browser import problem in Node.
 */
function wrapDb(pouch: PouchDB.Database<CouchSyncDoc>) {
    async function get<T extends CouchSyncDoc>(id: string): Promise<T | null> {
        try { return (await pouch.get(id)) as T; }
        catch (e: any) { if (e.status === 404) return null; throw e; }
    }

    async function update<T extends CouchSyncDoc>(
        id: string,
        fn: (existing: T | null) => T | null,
        maxRetries = 3,
    ): Promise<PouchDB.Core.Response | null> {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const existing = await get<T>(id);
            const updated = fn(existing);
            if (!updated) return null;
            if (existing?._rev) updated._rev = existing._rev;
            try {
                return await pouch.put(updated);
            } catch (e: any) {
                if (e?.status === 409 && attempt < maxRetries) continue;
                throw e;
            }
        }
        throw new Error(`update failed: exhausted retries for ${id}`);
    }

    async function bulkPut(docs: CouchSyncDoc[]): Promise<PouchDB.Core.Response[]> {
        const ids = docs.map((d) => d._id);
        const existing = await pouch.allDocs({ keys: ids });
        const revMap = new Map<string, string>();
        for (const row of existing.rows) {
            if ("value" in row && row.value && !("deleted" in row.value)) {
                revMap.set(row.id, row.value.rev);
            }
        }
        for (const doc of docs) {
            const rev = revMap.get(doc._id);
            if (rev) doc._rev = rev;
        }
        const results = await pouch.bulkDocs(docs);
        const errors = results.filter(
            (r, i): r is PouchDB.Core.Error => {
                if (!("error" in r && r.error)) return false;
                if ((r as any).status === 409 && docs[i].type === "chunk") return false;
                return true;
            }
        );
        if (errors.length > 0) {
            const summary = errors
                .map((e) => `${(e as any).id ?? "?"}: ${e.message}`)
                .join("; ");
            throw new Error(`bulkPut partial failure (${errors.length}/${docs.length}): ${summary}`);
        }
        return results as PouchDB.Core.Response[];
    }

    return { get, update, bulkPut, pouch };
}

describe("CAS write primitives", () => {
    let pouch: PouchDB.Database<CouchSyncDoc>;
    let db: ReturnType<typeof wrapDb>;

    beforeEach(() => {
        pouch = new PouchDB<CouchSyncDoc>(uniqueName(), { adapter: "memory" });
        db = wrapDb(pouch);
    });

    afterEach(async () => {
        await pouch.destroy().catch(() => {});
    });

    describe("update (CAS)", () => {
        it("creates a new doc when none exists", async () => {
            await db.update<FileDoc>(makeFileId("new.md"), (existing) => {
                expect(existing).toBeNull();
                return makeFile("new.md");
            });
            const got = await db.get<FileDoc>(makeFileId("new.md"));
            expect(got!.vclock).toEqual({ A: 1 });
        });

        it("reads existing and applies update", async () => {
            await pouch.put(makeFile("a.md", { A: 1 }));
            await db.update<FileDoc>(makeFileId("a.md"), (existing) => ({
                ...existing!,
                vclock: { A: 2 },
            }));
            const got = await db.get<FileDoc>(makeFileId("a.md"));
            expect(got!.vclock).toEqual({ A: 2 });
        });

        it("skips write when fn returns null", async () => {
            await pouch.put(makeFile("a.md", { A: 1 }));
            const result = await db.update<FileDoc>(makeFileId("a.md"), () => null);
            expect(result).toBeNull();
        });

        it("retries on 409 from concurrent write", async () => {
            await pouch.put(makeFile("a.md", { A: 1 }));
            let callCount = 0;

            await db.update<FileDoc>(makeFileId("a.md"), (existing) => {
                callCount++;
                if (callCount === 1) {
                    pouch.put({ ...existing!, vclock: { A: 99 } });
                }
                return { ...existing!, vclock: { A: callCount * 10 } };
            });

            expect(callCount).toBe(2);
            const got = await db.get<FileDoc>(makeFileId("a.md"));
            expect(got!.vclock).toEqual({ A: 20 });
        });

        it("throws after exhausting retries", async () => {
            await pouch.put(makeFile("a.md", { A: 1 }));
            let callCount = 0;

            await expect(
                db.update<FileDoc>(makeFileId("a.md"), (existing) => {
                    callCount++;
                    pouch.put({ ...existing!, vclock: { A: callCount * 100 } });
                    return { ...existing!, vclock: { A: callCount } };
                }, 2),
            ).rejects.toThrow(/conflict/i);

            expect(callCount).toBe(3);
        });
    });

    describe("bulkPut error detection", () => {
        it("succeeds for valid docs", async () => {
            const chunks: ChunkDoc[] = [
                { _id: makeChunkId("aaa"), type: "chunk", data: "AAAA" },
                { _id: makeChunkId("bbb"), type: "chunk", data: "BBBB" },
            ];
            const results = await db.bulkPut(chunks);
            expect(results).toHaveLength(2);
        });

        it("tolerates 409 on content-addressed chunks", async () => {
            const chunk: ChunkDoc = { _id: makeChunkId("ccc"), type: "chunk", data: "CCCC" };
            await pouch.put(chunk);
            await expect(db.bulkPut([{ ...chunk }])).resolves.toBeDefined();
        });

        it("throws on non-chunk error in bulkDocs result", async () => {
            const file = makeFile("x.md");
            await pouch.put(file);
            // Intercept bulkDocs to inject an error for the FileDoc
            const origBulkDocs = pouch.bulkDocs.bind(pouch);
            pouch.bulkDocs = async (docs: any) => {
                // Let it run for real, then swap the result with an error
                await origBulkDocs(docs);
                return [{ id: file._id, error: true, status: 409, name: "conflict", message: "Document update conflict" } as any];
            };
            await expect(db.bulkPut([{ ...file }])).rejects.toThrow(/bulkPut partial failure/);
        });
    });
});
