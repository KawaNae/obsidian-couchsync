import { describe, it, expect } from "vitest";
import type { FileDoc } from "../src/types.ts";
import {
    PendingApply,
    type EnsureChunksResult,
    PENDING_APPLY_KEY_PREFIX,
    loadAllPendingApply,
    pendingApplyIdFromKey,
    pendingApplyKey,
    type PendingApplyEntry,
} from "../src/db/sync/pending-apply.ts";

function makeReader(rows: Array<{ key: string; value: unknown }>) {
    return {
        getMetaByPrefix: async (prefix: string) =>
            rows.filter((r) => r.key.startsWith(prefix)),
    };
}

describe("pending-apply helpers", () => {
    it("pendingApplyKey / pendingApplyIdFromKey are round-trip", () => {
        const id = "file:notes/foo.md";
        const k = pendingApplyKey(id);
        expect(k).toBe(PENDING_APPLY_KEY_PREFIX + id);
        expect(pendingApplyIdFromKey(k)).toBe(id);
    });

    it("pendingApplyIdFromKey rejects keys outside the namespace", () => {
        expect(pendingApplyIdFromKey("_sync/remote-seq")).toBeNull();
        expect(pendingApplyIdFromKey("_sync/unpushed/file:a.md")).toBeNull();
    });

    it("loadAllPendingApply returns rows with parsed entries", async () => {
        const entry1: PendingApplyEntry = { addedAt: 100, reason: "missing-chunks", missingChunks: ["chunk:x"] };
        const entry2: PendingApplyEntry = { addedAt: 200, reason: "missing-chunks" };
        const reader = makeReader([
            { key: pendingApplyKey("file:a.md"), value: entry1 },
            { key: pendingApplyKey("file:b.md"), value: entry2 },
            { key: "_sync/remote-seq", value: 99 },
        ]);
        const rows = await loadAllPendingApply(reader);
        expect(rows).toEqual([
            { id: "file:a.md", entry: entry1 },
            { id: "file:b.md", entry: entry2 },
        ]);
    });

    it("loadAllPendingApply drops malformed entries silently", async () => {
        const good: PendingApplyEntry = { addedAt: 1, reason: "missing-chunks" };
        const reader = makeReader([
            { key: pendingApplyKey("file:good.md"), value: good },
            { key: pendingApplyKey("file:bad-reason.md"), value: { reason: "bogus" } },
            { key: pendingApplyKey("file:null.md"), value: null },
            { key: pendingApplyKey("file:string.md"), value: "not-an-entry" },
        ]);
        const rows = await loadAllPendingApply(reader);
        expect(rows.map((r) => r.id)).toEqual(["file:good.md"]);
    });

    it("loadAllPendingApply defaults a missing addedAt to 0 and drops unknown fields", async () => {
        const reader = makeReader([
            { key: pendingApplyKey("file:partial.md"), value: { reason: "missing-chunks", attempts: 4 } },
        ]);
        const rows = await loadAllPendingApply(reader);
        expect(rows[0]?.entry).toEqual({ reason: "missing-chunks", addedAt: 0 });
    });
});

function memDb(docs: Record<string, FileDoc> = {}) {
    const meta = new Map<string, unknown>();
    const txs: unknown[] = [];
    return {
        meta, txs, docs,
        async get(id: string) { return docs[id] ?? null; },
        async getMetaByPrefix(prefix: string) {
            return [...meta].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }));
        },
        async runWriteTx(tx: { meta?: Array<{ op: "put" | "delete"; key: string; value?: unknown }> }) {
            txs.push(tx);
            for (const m of tx.meta ?? []) {
                if (m.op === "put") meta.set(m.key, m.value);
                else meta.delete(m.key);
            }
        },
    };
}

function liveDoc(id: string, deleted = false): FileDoc {
    return {
        _id: id, type: "file", chunks: ["chunk:x64:a"], mtime: 1, ctime: 1, size: 1,
        vclock: { other: 1 }, ...(deleted ? { deleted: true } : {}),
    } as FileDoc;
}

describe("PendingApply", () => {
    function rig(docs: Record<string, FileDoc>, ensure: () => EnsureChunksResult) {
        const db = memDb(docs);
        const writes: string[] = [];
        const notices: string[] = [];
        const recovered: string[] = [];
        const pa = new PendingApply({
            localDb: db as any,
            ensureChunks: async () => ensure(),
            write: async (doc) => { writes.push(doc._id); return { applied: true }; },
            notify: (m) => notices.push(m),
            onRecovered: (p) => recovered.push(p),
        });
        return { db, pa, writes, notices, recovered };
    }

    it("a doc that stays broken is rewritten and announced only once", async () => {
        const r = rig({ "file:a.md": liveDoc("file:a.md") },
            () => ({ stillMissing: ["chunk:x64:a"], remoteConsulted: true }));
        expect(await r.pa.apply(r.db.docs["file:a.md"])).toBe("quarantined");
        await r.pa.drain();
        await r.pa.drain();
        expect(r.db.txs).toHaveLength(1);
        expect(r.notices).toHaveLength(1);
        expect(r.db.meta.get(pendingApplyKey("file:a.md"))).toMatchObject({
            reason: "missing-chunks", missingChunks: ["chunk:x64:a"],
        });
    });

    it("an offline miss is recorded without the chunk ids and without a notice", async () => {
        const r = rig({ "file:a.md": liveDoc("file:a.md") },
            () => ({ stillMissing: ["chunk:x64:a"], remoteConsulted: false }));
        expect(await r.pa.apply(r.db.docs["file:a.md"])).toBe("skipped");
        expect(r.db.meta.get(pendingApplyKey("file:a.md"))).toEqual({
            reason: "missing-chunks", addedAt: expect.any(Number),
        });
        expect(r.notices).toEqual([]);
    });

    it("the drain writes a recovered doc, drops it, and reports it", async () => {
        let missing = ["chunk:x64:a"];
        const r = rig({ "file:a.md": liveDoc("file:a.md") },
            () => ({ stillMissing: missing, remoteConsulted: true }));
        await r.pa.apply(r.db.docs["file:a.md"]);
        missing = [];
        const report = await r.pa.drain();
        expect(report.applied).toEqual(["a.md"]);
        expect(r.writes).toEqual(["file:a.md"]);
        expect(r.recovered).toEqual(["a.md"]);
        expect(r.db.meta.size).toBe(0);
    });

    it("a doc applied without a record costs no meta write", async () => {
        const r = rig({ "file:a.md": liveDoc("file:a.md") },
            () => ({ stillMissing: [], remoteConsulted: true }));
        expect(await r.pa.apply(r.db.docs["file:a.md"])).toBe("applied");
        expect(r.db.txs).toEqual([]);
        expect(r.recovered).toEqual([]);
    });

    it("drops entries whose doc is gone or no longer matches the reason", async () => {
        const r = rig({ "file:dead.md": liveDoc("file:dead.md", true), "file:alive.md": liveDoc("file:alive.md") },
            () => ({ stillMissing: [], remoteConsulted: true }));
        r.db.meta.set(pendingApplyKey("file:gone.md"), { reason: "missing-chunks", addedAt: 1 });
        r.db.meta.set(pendingApplyKey("file:dead.md"), { reason: "missing-chunks", addedAt: 1 });
        r.db.meta.set(pendingApplyKey("file:alive.md"), { reason: "pending-deletion", addedAt: 1 });
        await r.pa.drain();
        expect(r.writes).toEqual([]);
        expect(r.db.meta.size).toBe(0);
    });

    it("concurrent drains share one run", async () => {
        let calls = 0;
        const r = rig({ "file:a.md": liveDoc("file:a.md") }, () => {
            calls++;
            return { stillMissing: ["chunk:x64:a"], remoteConsulted: true };
        });
        await r.pa.apply(r.db.docs["file:a.md"]);
        calls = 0;
        await Promise.all([r.pa.drain(), r.pa.drain()]);
        expect(calls).toBe(1);
    });

    it("resolving an id that is not recorded writes nothing", async () => {
        const r = rig({}, () => ({ stillMissing: [], remoteConsulted: true }));
        await r.pa.resolve(["file:never.md"]);
        expect(r.db.txs).toEqual([]);
    });
});
