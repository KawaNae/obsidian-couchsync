/**
 * Deleting the local config store of the layout before config bindings —
 * the storage half of the config-binding migration. Exactly ONE name is
 * deleted: `couchsync-<vault>-config-<applied config DB>`. Never a pattern:
 * a pattern could hit another vault's own store (a vault named
 * `<vault>-config-<x>`).
 */
import "fake-indexeddb/auto";
import { describe, it, expect, afterEach } from "vitest";
import Dexie from "dexie";
import {
    deleteLegacyConfigStore,
    legacyConfigStoreName,
} from "../src/settings-migration.ts";
import { configStoreName } from "../src/sync/config-binding-record.ts";

const created: string[] = [];
async function make(name: string): Promise<void> {
    const db = new Dexie(name);
    db.version(1).stores({ t: "k" });
    await db.open();
    db.close();
    created.push(name);
}
async function existing(): Promise<string[]> {
    return (await indexedDB.databases()).map((d) => d.name!).filter(Boolean);
}

afterEach(async () => {
    for (const n of created.splice(0)) await Dexie.delete(n).catch(() => {});
});

describe("legacyConfigStoreName", () => {
    it("is the one old-layout name of the applied config DB, or null without one", () => {
        expect(legacyConfigStoreName("V", "cfg")).toBe("couchsync-V-config-cfg");
        expect(legacyConfigStoreName("V", "")).toBeNull();
    });
});

describe("deleteLegacyConfigStore (fake-indexeddb)", () => {
    it("deletes exactly the matching name; every other store stays", async () => {
        const V = `v${Date.now()}`;
        const current = await configStoreName(V, "http://h:5984", "cfg");
        const keep = [
            `couchsync-${V}`,
            `couchsync-history-${V}`,
            current,                             // current layout of the same DB
            `couchsync-${V}-config-mobile-cfg`,  // an earlier DB name: out of scope
        ];
        for (const n of [...keep, `couchsync-${V}-config-cfg`]) await make(n);

        expect(await deleteLegacyConfigStore(V, "cfg")).toBe(`couchsync-${V}-config-cfg`);
        const after = await existing();
        expect(after).not.toContain(`couchsync-${V}-config-cfg`);
        for (const n of keep) expect(after).toContain(n);
    });

    it("never touches another vault named `<vault>-config-<x>`", async () => {
        const V = `v${Date.now()}`;
        const W = `${V}-config-work`; // another vault's name
        const others = [`couchsync-${W}`, `couchsync-history-${W}`, `couchsync-${W}-config-cfg`];
        for (const n of others) await make(n);
        await make(`couchsync-${V}-config-cfg`);

        await deleteLegacyConfigStore(V, "cfg");
        const after = await existing();
        for (const n of others) expect(after).toContain(n);
        expect(after).not.toContain(`couchsync-${V}-config-cfg`);
    });

    it("does nothing when no config DB is applied", async () => {
        const calls: string[] = [];
        expect(await deleteLegacyConfigStore("V", "", async (n) => { calls.push(n); })).toBeNull();
        expect(calls).toEqual([]);
    });

    it("an absent store is a no-op success (Dexie.delete over deleteDatabase), and a re-run is idempotent", async () => {
        const V = `v${Date.now()}`;
        await make(`couchsync-${V}`);
        const before = await existing();
        await expect(deleteLegacyConfigStore(V, "never-existed")).resolves.toBe(
            `couchsync-${V}-config-never-existed`,
        );
        await expect(deleteLegacyConfigStore(V, "never-existed")).resolves.toBeTruthy();
        expect((await existing()).sort()).toEqual(before.sort());
        // Directly: Dexie.delete of an unknown name resolves.
        await expect(Dexie.delete(`nope-${Date.now()}`)).resolves.toBeUndefined();
    });
});
