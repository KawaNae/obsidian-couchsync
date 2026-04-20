/**
 * Self-healing tests for LocalDB.
 *
 * The production concern being exercised: in real browsers, IndexedDB
 * handles can be silently invalidated (OS suspend, tab reclaim). The
 * sync engine used to get stuck in an infinite retry loop because no
 * layer re-opened the handle. LocalDB is now expected to absorb a
 * transient handle failure via HandleGuard.
 */

import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { LocalDB } from "../src/db/local-db.ts";
import { makeFileId } from "../src/types/doc-id.ts";
import type { FileDoc } from "../src/types.ts";

function makeFile(path: string, size = 1): FileDoc {
    return {
        _id: makeFileId(path),
        type: "file",
        chunks: [],
        mtime: 1,
        ctime: 1,
        size,
        vclock: { A: 1 },
    };
}

let n = 0;
function freshDb(): LocalDB {
    const db = new LocalDB(`localdb-heal-${Date.now()}-${n++}`);
    db.open();
    return db;
}

describe("LocalDB self-healing (HandleGuard)", () => {
    it("exposes runDocsOp / runMetaOp as the canonical access point", async () => {
        const db = freshDb();
        try {
            const info = await db.runDocsOp((s) => s.info(), "probe");
            expect(info).toHaveProperty("updateSeq");
        } finally {
            await db.close();
        }
    });

    it("reopens the docs handle after an explicit close and keeps data intact", async () => {
        const db = freshDb();
        try {
            const f = makeFile("foo.md");
            await db.runWriteTx({ docs: [{ doc: f }] });

            await db.__closeDocsHandleForTest();

            const got = await db.get<FileDoc>(f._id);
            expect(got).not.toBeNull();
            expect(got!._id).toBe(f._id);
        } finally {
            await db.close();
        }
    });

    it("reopens the meta handle after an explicit close and keeps data intact", async () => {
        const db = freshDb();
        try {
            await db.putScanCursor({ lastScanStartedAt: 1, lastScanCompletedAt: 2 });

            await db.__closeMetaHandleForTest();

            const cur = await db.getScanCursor();
            expect(cur?.lastScanCompletedAt).toBe(2);
        } finally {
            await db.close();
        }
    });

    it("ensureHealthy() succeeds on a fresh db and after a forced close", async () => {
        const db = freshDb();
        try {
            await db.ensureHealthy();
            await db.__closeDocsHandleForTest();
            await db.ensureHealthy();
            // If ensureHealthy threw, the test would fail; reaching here
            // is the assertion.
            expect(true).toBe(true);
        } finally {
            await db.close();
        }
    });
});
