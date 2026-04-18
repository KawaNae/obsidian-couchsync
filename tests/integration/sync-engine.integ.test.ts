/**
 * SyncEngine integration tests — Phase 4 migration.
 *
 * Drives a real SyncEngine via the SyncHarness (real LocalDB + shared
 * FakeCouchClient via clientFactory). Verifies state transitions,
 * catchup pull, live sync, and stall detection through public observable
 * effects (state events, paused, lastHealthyAt, docs landing in couch
 * or DB).
 *
 * Replaces the legacy tests/sync-engine.test.ts which used hand-rolled
 * makeMockClient / makeMockLocalDb mocks. A handful of scenarios use
 * `vi.spyOn` on the FakeCouchClient for fault injection (catchup
 * error, info() failure, sequencing for restart() ordering); the rest
 * exercise the engine end-to-end with no per-call mocks.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { createSyncHarness, type SyncHarness, type DeviceHarness } from "../harness/sync-harness.ts";
import { expectCouch } from "../harness/assertions.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { SyncState } from "../../src/db/reconnect-policy.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";

// ── Stub browser globals before SyncEngine.start() ───────
// SyncEngine.start() calls EnvListeners.attach() which uses
// window/document. Node test runtime doesn't have these by default.

const noop = () => {};
beforeAll(() => {
    (globalThis as any).self = (globalThis as any).self ?? globalThis;
    (globalThis as any).window = (globalThis as any).window ?? {
        addEventListener: noop,
        removeEventListener: noop,
    };
    (globalThis as any).document = (globalThis as any).document ?? {
        addEventListener: noop,
        removeEventListener: noop,
        visibilityState: "visible",
    };
});

// ── helpers ──────────────────────────────────────────────

/** Push docs+chunks for `path` from device A through the shared couch
 *  so a future pull on B sees them. Helper for "B pulls" scenarios. */
async function seedRemoteVia(
    h: SyncHarness,
    a: DeviceHarness,
    path: string,
    content: string,
): Promise<FileDoc> {
    a.vault.addFile(path, content);
    await a.vs.fileToDb(path);
    const doc = (await a.db.get(makeFileId(path))) as FileDoc;
    const chunks = await a.db.getChunks(doc.chunks);
    await h.couch.bulkDocs([
        doc as unknown as CouchSyncDoc,
        ...(chunks as unknown as CouchSyncDoc[]),
    ]);
    return doc;
}

/** Poll until `pred()` returns true or timeout fires. */
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await pred()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

// ── tests ────────────────────────────────────────────────

describe("SyncEngine integration", () => {
    let h: SyncHarness;

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    // ── State machine ───────────────────────────────────

    describe("state machine", () => {
        it("start() transitions: disconnected → reconnecting → syncing → connected", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");

            const states: SyncState[] = [];
            a.engine.events.on("state-change", ({ state }) => states.push(state));

            expect(a.engine.getState()).toBe("disconnected");
            await a.engine.start();

            expect(states).toEqual(["reconnecting", "syncing", "connected"]);
            expect(a.engine.getState()).toBe("connected");
            a.engine.stop();
        });

        it("stop() sets state to disconnected", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");

            await a.engine.start();
            a.engine.stop();
            expect(a.engine.getState()).toBe("disconnected");
        });

        it("concurrent start() calls dedup (only one catchup runs)", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");

            const spy = vi.spyOn(h.couch, "changes");
            await Promise.all([a.engine.start(), a.engine.start(), a.engine.start()]);

            // openSession early-returns when this.session is set; the
            // other two start() calls observe a non-null session and skip.
            expect(spy.mock.calls.length).toBe(1);
            spy.mockRestore();
            a.engine.stop();
        });

        it("paused event fires immediately after catchup completes", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");

            const pausedCount = { value: 0 };
            a.engine.events.on("paused", () => { pausedCount.value++; });

            await a.engine.start();

            // firePausedCallbacks → emits paused once on connected.
            expect(pausedCount.value).toBeGreaterThanOrEqual(1);
            expect(a.engine.getState()).toBe("connected");
            a.engine.stop();
        });

        it("onceIdle fires immediately after catchup completes", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");

            const idleCount = { value: 0 };
            a.engine.events.onceIdle(() => { idleCount.value++; });

            await a.engine.start();
            expect(idleCount.value).toBe(1);
            a.engine.stop();
        });

        it("pullLoop transitions through paused after a pulled batch", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const b = h.addDevice("dev-B");

            const pausedCount = { value: 0 };
            b.engine.events.on("paused", () => { pausedCount.value++; });

            await b.engine.start();
            // Catchup paused already fired (count >= 1). Push a doc through
            // the shared couch and wait for the live longpoll to deliver it.
            const before = pausedCount.value;
            await seedRemoteVia(h, a, "live-a.md", "live");

            await waitFor(() => pausedCount.value > before, 2000);
            // The doc landed on B's local DB via the live pull writer.
            await waitFor(async () => (await b.db.get(makeFileId("live-a.md"))) !== null);
            b.engine.stop();
            a.engine.stop();
        });

        it("restart() awaits old session settled before opening a new one", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");

            let resolveFirst: (v: any) => void = () => {};
            let firstCalled = false;
            let secondCalled = false;
            const spy = vi.spyOn(h.couch, "changes").mockImplementation(async () => {
                if (!firstCalled) {
                    firstCalled = true;
                    return new Promise((r) => { resolveFirst = r; });
                }
                secondCalled = true;
                return { results: [], last_seq: "0" };
            });

            const startP = a.engine.start();
            await waitFor(() => firstCalled);

            const restartP = (a.engine as any).restart() as Promise<void>;
            // Give restart a beat — it must NOT have started a new catchup
            // until the first session's catchup completes.
            await new Promise((r) => setTimeout(r, 30));
            expect(secondCalled).toBe(false);

            resolveFirst({ results: [], last_seq: "0" });
            await restartP;
            expect(secondCalled).toBe(true);

            await startP.catch(() => {});
            spy.mockRestore();
            a.engine.stop();
        });

        it("empty longpoll result does not change state", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");

            const states: SyncState[] = [];
            a.engine.events.on("state-change", ({ state }) => states.push(state));

            await a.engine.start();
            // Allow a few longpoll cycles (FakeCouchClient.changesLongpoll
            // returns immediately, so 50ms is plenty for several iterations).
            await new Promise((r) => setTimeout(r, 50));

            expect(states).toEqual(["reconnecting", "syncing", "connected"]);
            a.engine.stop();
        });
    });

    // ── Error integration ───────────────────────────────

    describe("error integration", () => {
        it("start() clears the auth latch", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");

            a.engine.auth.raise(401, "test");
            expect(a.engine.auth.isBlocked()).toBe(true);

            await a.engine.start();
            expect(a.engine.auth.isBlocked()).toBe(false);
            a.engine.stop();
        });

        it("catchup error from changes() enters hard error with classification", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");

            const spy = vi.spyOn(h.couch, "changes").mockRejectedValue(new Error("ECONNREFUSED"));

            await a.engine.start();

            expect(a.engine.getState()).toBe("error");
            expect(a.engine.getLastErrorDetail()?.kind).toBe("network");
            spy.mockRestore();
            a.engine.stop();
        });
    });

    // ── Catchup pull ────────────────────────────────────

    describe("catchup pull", () => {
        it("drains remote changes into B's local DB", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const b = h.addDevice("dev-B");

            await seedRemoteVia(h, a, "notes/a.md", "a");
            await seedRemoteVia(h, a, "notes/b.md", "b");
            await seedRemoteVia(h, a, "notes/c.md", "c");

            await b.engine.start();

            // All three FileDocs are now on B's DB after catchup.
            expect(await b.db.get(makeFileId("notes/a.md"))).not.toBeNull();
            expect(await b.db.get(makeFileId("notes/b.md"))).not.toBeNull();
            expect(await b.db.get(makeFileId("notes/c.md"))).not.toBeNull();
            b.engine.stop();
            a.engine.stop();
        });

        it("sets lastHealthyAt on catchup completion", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");

            expect(a.engine.getLastHealthyAt()).toBe(0);
            const before = Date.now();
            await a.engine.start();
            const after = Date.now();

            expect(a.engine.getLastHealthyAt()).toBeGreaterThanOrEqual(before);
            expect(a.engine.getLastHealthyAt()).toBeLessThanOrEqual(after);
            a.engine.stop();
        });
    });

    // ── Live sync ───────────────────────────────────────

    describe("live sync", () => {
        it("pull loop fires paused for pulled docs", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const b = h.addDevice("dev-B");

            const pausedCount = { value: 0 };
            b.engine.events.on("paused", () => { pausedCount.value++; });

            await b.engine.start();
            const before = pausedCount.value;

            await seedRemoteVia(h, a, "live-pulled.md", "p");

            await waitFor(() => pausedCount.value > before, 2000);
            b.engine.stop();
            a.engine.stop();
        });

        it("push loop detects local changes and pushes to remote", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");

            // Pre-stage the file so the push loop's first iteration sees it.
            a.vault.addFile("notes/test.md", "x");
            await a.vs.fileToDb("notes/test.md");

            await a.engine.start();

            // Push pipeline runs the first iteration before its 2s delay.
            await waitFor(async () => {
                const doc = await h.couch.getDoc(makeFileId("notes/test.md"));
                return doc !== null;
            }, 2000);

            await expectCouch(h.couch).toHaveDoc(makeFileId("notes/test.md"));
            a.engine.stop();
        });

        it("push loop skips non-replicated doc IDs (_local/*)", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");

            await a.db.runWriteTx({
                docs: [{
                    doc: {
                        _id: "_local/something",
                        type: "file",
                        chunks: [],
                        vclock: {},
                        mtime: 1,
                        ctime: 1,
                        size: 0,
                    } as unknown as CouchSyncDoc,
                }],
            });

            await a.engine.start();
            // Wait long enough that, if the push loop wanted to send it,
            // the first iteration would have completed.
            await new Promise((r) => setTimeout(r, 100));

            await expectCouch(h.couch).toNotHaveDoc("_local/something");
            a.engine.stop();
        });

        it("pull updates lastHealthyAt after applying live changes", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const b = h.addDevice("dev-B");

            await b.engine.start();
            // Reset lastHealthyAt so we can prove pullLoop bumps it.
            (b.engine as any).lastHealthyAt = 0;

            const before = Date.now();
            await seedRemoteVia(h, a, "live-h.md", "h");
            await waitFor(() => b.engine.getLastHealthyAt() > 0, 2000);
            const after = Date.now();

            expect(b.engine.getLastHealthyAt()).toBeGreaterThanOrEqual(before);
            expect(b.engine.getLastHealthyAt()).toBeLessThanOrEqual(after);
            b.engine.stop();
            a.engine.stop();
        });

        it("push updates lastHealthyAt after a successful push", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");

            a.vault.addFile("push-h.md", "x");
            await a.vs.fileToDb("push-h.md");

            const before = Date.now();
            await a.engine.start();
            await waitFor(async () => (await h.couch.getDoc(makeFileId("push-h.md"))) !== null, 2000);
            const after = Date.now();

            expect(a.engine.getLastHealthyAt()).toBeGreaterThanOrEqual(before);
            expect(a.engine.getLastHealthyAt()).toBeLessThanOrEqual(after);
            a.engine.stop();
        });
    });

    // ── Stall detection (checkHealth) ───────────────────

    describe("stall detection (checkHealth)", () => {
        it("seq match → no stall, updates lastHealthyAt", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            await a.engine.start();
            (a.engine as any).checkpoints.setRemoteSeq("42");
            const spy = vi.spyOn(h.couch, "info").mockResolvedValue({
                db_name: "x", doc_count: 0, update_seq: "42",
            });

            const before = Date.now();
            await (a.engine as any).checkHealth();
            const after = Date.now();

            expect(a.engine.getState()).toBe("connected");
            expect(a.engine.getLastHealthyAt()).toBeGreaterThanOrEqual(before);
            expect(a.engine.getLastHealthyAt()).toBeLessThanOrEqual(after);
            spy.mockRestore();
            a.engine.stop();
        });

        it("seq mismatch persists across two checks → stall → reconnect", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            await a.engine.start();
            (a.engine as any).checkpoints.setRemoteSeq("40");
            const spy = vi.spyOn(h.couch, "info").mockResolvedValue({
                db_name: "x", doc_count: 0, update_seq: "50",
            });
            // Mock the actual reconnect so checkHealth's stall path doesn't
            // teardown + restart a fresh session (which would spawn new live
            // loops and confuse the rest of the test).
            const reconnectSpy = vi
                .spyOn(a.engine as any, "requestReconnect")
                .mockResolvedValue(undefined);

            // First check: records the remote seq, no reconnect requested.
            await (a.engine as any).checkHealth();
            expect(reconnectSpy.mock.calls.length).toBe(0);

            // Second check: same remote seq, still not consumed → stall.
            await (a.engine as any).checkHealth();
            expect(reconnectSpy.mock.calls.length).toBe(1);
            expect(reconnectSpy.mock.calls[0][0]).toBe("stalled");

            reconnectSpy.mockRestore();
            spy.mockRestore();
            a.engine.stop();
        });

        it("CouchDB 3.x opaque seq: same numeric prefix → no stall", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            await a.engine.start();
            (a.engine as any).checkpoints.setRemoteSeq("1771-OPAQUE_FROM_CHANGES");
            const spy = vi.spyOn(h.couch, "info").mockResolvedValue({
                db_name: "x", doc_count: 0, update_seq: "1771-OPAQUE_FROM_INFO",
            });
            const reconnectSpy = vi
                .spyOn(a.engine as any, "requestReconnect")
                .mockResolvedValue(undefined);

            await (a.engine as any).checkHealth();
            await (a.engine as any).checkHealth();

            // Same numeric prefix (1771) → not a stall.
            expect(reconnectSpy.mock.calls.length).toBe(0);
            reconnectSpy.mockRestore();
            spy.mockRestore();
            a.engine.stop();
        });

        it("info() failure → hard error", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            await a.engine.start();
            const spy = vi.spyOn(h.couch, "info").mockRejectedValue(new Error("ECONNREFUSED"));

            await (a.engine as any).checkHealth();

            expect(a.engine.getState()).toBe("error");
            expect(a.engine.getLastErrorDetail()?.kind).toBe("network");
            spy.mockRestore();
            a.engine.stop();
        });

        it("auth latch → checkHealth skipped entirely", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            await a.engine.start();
            const spy = vi.spyOn(h.couch, "info");
            const baselineCalls = spy.mock.calls.length;

            a.engine.auth.raise(401, "blocked");
            // raise() triggers the auth.onChange handler that sets state=error
            // and tears down the session. Reset state for this assertion.
            (a.engine as any).setState("connected");

            await (a.engine as any).checkHealth();
            expect(spy.mock.calls.length).toBe(baselineCalls);
            spy.mockRestore();
            a.engine.stop();
        });

        it("checkHealth skips in reconnecting/error states", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            await a.engine.start();

            const spy = vi.spyOn(h.couch, "info");
            const baseline = spy.mock.calls.length;

            (a.engine as any).setState("reconnecting");
            await (a.engine as any).checkHealth();
            expect(spy.mock.calls.length).toBe(baseline);

            (a.engine as any).errorRecovery.enterHardError({ kind: "network", message: "down" });
            const baselineAfter = spy.mock.calls.length;
            await (a.engine as any).checkHealth();
            expect(spy.mock.calls.length).toBe(baselineAfter);
            spy.mockRestore();
            a.engine.stop();
        });

        it("checkHealth in disconnected state triggers reconnect", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            await a.engine.start();

            const reconnectSpy = vi
                .spyOn(a.engine as any, "requestReconnect")
                .mockResolvedValue(undefined);

            (a.engine as any).setState("disconnected");
            await (a.engine as any).checkHealth();

            expect(reconnectSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
            expect(reconnectSpy.mock.calls[0][0]).toBe("periodic-tick");
            reconnectSpy.mockRestore();
            a.engine.stop();
        });
    });
});
