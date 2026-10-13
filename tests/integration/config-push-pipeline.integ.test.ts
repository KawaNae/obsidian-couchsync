/**
 * ConfigPushPipeline integration tests.
 *
 * Drives the pipeline against a real ConfigLocalDB + FakeCouchClient with
 * hand-built plan entries and asserts: a path is sent only when the server
 * doc is the shared version held locally and the disk took that version in
 * (or the path is new everywhere); the sent doc's vclock advances the
 * base; the config DB doc and lastSynced change only for what the server
 * accepted.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigLocalDB } from "../../src/db/config-local-db.ts";
import {
    ConfigLastSynced,
    configLastSyncedKey,
    type ConfigLastSyncedValue,
} from "../../src/db/sync/config-last-synced.ts";
import { ConfigPushPipeline } from "../../src/db/sync/config-push-pipeline.ts";
import { diffForPush, type PushPlanEntry } from "../../src/sync/config-reconcile.ts";
import { FakeCouchClient } from "../helpers/fake-couch-client.ts";
import { makeConfigFixture, type ConfigFixture } from "../helpers/config-fixture.ts";
import type { ConfigDoc, CouchSyncDoc } from "../../src/types.ts";
import { computeHash, joinChunks } from "../../src/db/chunker.ts";

let counter = 0;
function uniqueName(): string {
    return `cfg-push-${Date.now()}-${counter++}`;
}

const PATH = ".obsidian/app.json";
const enc = (s: string) => new TextEncoder().encode(s);

function baseOf(f: ConfigFixture): ConfigLastSyncedValue {
    return { vclock: f.doc.vclock, size: f.doc.size, chunks: f.doc.chunks };
}

describe("ConfigPushPipeline", () => {
    let db: ConfigLocalDB;
    let remote: FakeCouchClient;
    let last: ConfigLastSynced;
    let pipeline: ConfigPushPipeline;

    beforeEach(async () => {
        db = new ConfigLocalDB(uniqueName());
        db.open();
        remote = new FakeCouchClient();
        last = new ConfigLastSynced(db);
        await last.ensureLoaded();
        pipeline = new ConfigPushPipeline({
            db,
            client: remote as any,
            lastSynced: last,
            hasher: { alg: "x64", hash: computeHash },
            getDeviceId: () => "dev-A",
            signal: new AbortController().signal,
        });
    });

    afterEach(async () => {
        await db.destroy();
    });

    /** The shared version `f`, held in the config DB (and on the server
     *  when `onServer`). */
    async function share(f: ConfigFixture, onServer = true): Promise<void> {
        await db.runWriteTx({
            docs: [{ doc: f.doc as unknown as CouchSyncDoc }],
            chunks: f.chunks as unknown as CouchSyncDoc[],
        });
        if (onServer) await remote.bulkDocs([{ ...f.doc }]);
    }

    async function setBase(f: ConfigFixture): Promise<void> {
        const value = baseOf(f);
        await db.runWriteTx({
            docs: [],
            chunks: f.chunks as unknown as CouchSyncDoc[],
            meta: [{ op: "put", key: configLastSyncedKey(PATH), value }],
        });
        last.set(PATH, value);
    }

    /** A plan entry for the disk content `body` against `base`. */
    async function entry(body: string, base: ConfigFixture | null): Promise<PushPlanEntry> {
        const disk = await makeConfigFixture(PATH, body);
        const local = enc(body);
        const baseBytes = base ? new Uint8Array(joinChunks(base.chunks)) : null;
        return {
            path: PATH,
            diff: diffForPush(PATH, baseBytes, local)!,
            local,
            chunks: disk.chunks,
            size: local.byteLength,
            mtime: 1,
            base: base ? baseOf(base) : null,
        };
    }

    it("a file new everywhere is sent and becomes the shared version and the base", async () => {
        const result = await pipeline.run([await entry(`{"a":1}`, null)]);

        expect(result).toEqual({ pushed: [PATH], held: [], failed: [] });
        const onServer = await remote.getDoc<ConfigDoc>(`config:${PATH}`);
        expect(onServer!.vclock).toEqual({ "dev-A": 1 });
        const shared = await db.get(`config:${PATH}`);
        expect(shared!.chunks).toEqual(onServer!.chunks);
        expect(last.get(PATH)).toEqual({
            vclock: { "dev-A": 1 }, size: onServer!.size, chunks: onServer!.chunks,
        });
        expect(await db.getMeta(configLastSyncedKey(PATH))).toEqual(last.get(PATH));
        // The chunks went to the server too.
        const chunkOnServer = await remote.getAttachment(onServer!.chunks[0], "c");
        expect(chunkOnServer).not.toBeNull();
    });

    it("a change on the current shared version advances the base's vclock", async () => {
        const v1 = await makeConfigFixture(PATH, `{"a":1}`, { vclock: { "dev-B": 3 } });
        await share(v1);
        await setBase(v1);

        const result = await pipeline.run([await entry(`{"a":2}`, v1)]);

        expect(result.pushed).toEqual([PATH]);
        const onServer = await remote.getDoc<ConfigDoc>(`config:${PATH}`);
        expect(onServer!.vclock).toEqual({ "dev-B": 3, "dev-A": 1 });
        expect(last.get(PATH)!.vclock).toEqual({ "dev-B": 3, "dev-A": 1 });
    });

    it("holds a path whose server doc moved past the shared version held here", async () => {
        const v1 = await makeConfigFixture(PATH, `{"a":1}`, { vclock: { "dev-B": 1 } });
        await share(v1);
        await setBase(v1);
        const v2 = await makeConfigFixture(PATH, `{"a":1,"m":1}`, { vclock: { "dev-B": 2 } });
        await remote.bulkDocs([{ ...v2.doc }]);

        const result = await pipeline.run([await entry(`{"a":2}`, v1)]);

        expect(result).toEqual({ pushed: [], held: [{ path: PATH, reason: "remote-changed" }], failed: [] });
        expect((await remote.getDoc<ConfigDoc>(`config:${PATH}`))!.vclock).toEqual({ "dev-B": 2 });
        expect(last.get(PATH)!.vclock).toEqual({ "dev-B": 1 });
    });

    it("holds a path whose disk has no base while a shared version exists", async () => {
        const v1 = await makeConfigFixture(PATH, `{"a":1}`, { vclock: { "dev-B": 1 } });
        await share(v1);

        const result = await pipeline.run([await entry(`{"a":2}`, null)]);

        expect(result.held).toEqual([{ path: PATH, reason: "not-merged" }]);
        expect((await remote.getDoc<ConfigDoc>(`config:${PATH}`))!.vclock).toEqual({ "dev-B": 1 });
    });

    it("holds a path whose base is older than the shared version", async () => {
        const v1 = await makeConfigFixture(PATH, `{"a":1}`, { vclock: { "dev-B": 1 } });
        const v2 = await makeConfigFixture(PATH, `{"a":1,"m":1}`, { vclock: { "dev-B": 2 } });
        await setBase(v1);
        await share(v2);

        const result = await pipeline.run([await entry(`{"a":2}`, v1)]);

        expect(result.held).toEqual([{ path: PATH, reason: "not-merged" }]);
    });

    it("a doc the server rejects as a conflict is held; nothing local moves", async () => {
        remote.bulkDocs = async (docs: any[]) =>
            docs.map((d) => ({ id: d._id, error: "conflict" as const, reason: "synthetic" }));

        const result = await pipeline.run([await entry(`{"a":1}`, null)]);

        expect(result.held).toEqual([{ path: PATH, reason: "remote-changed" }]);
        expect(await db.get(`config:${PATH}`)).toBeNull();
        expect(last.get(PATH)).toBeUndefined();
    });

    it("a doc whose chunk the server rejected is not sent", async () => {
        remote.bulkDocsWithAttachments = async (items: any[]) =>
            items.map((i) => ({ id: i.doc._id, error: "forbidden", reason: "synthetic" }));

        const result = await pipeline.run([await entry(`{"a":1}`, null)]);

        expect(result).toEqual({ pushed: [], held: [], failed: [PATH] });
        expect(await remote.getDoc(`config:${PATH}`)).toBeNull();
    });
});
