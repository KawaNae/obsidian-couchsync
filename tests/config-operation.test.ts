/**
 * Tests for ConfigOperation — the lifecycle wrapper for one-shot
 * Config Sync HTTP work. Focuses on the gating/abort/error-routing
 * behaviour; body-side allDocs/bulk semantics are exercised via the
 * higher-level config-sync tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuthGate } from "../src/db/sync/auth-gate.ts";
import { ALWAYS_VISIBLE, type VisibilityGate } from "../src/db/visibility-gate.ts";
import { NoopReconnectBridge, type ReconnectBridge } from "../src/sync/reconnect-bridge.ts";
import { ConfigOperation, CONFIG_TIMEOUTS } from "../src/sync/config-operation.ts";
import type { CouchClient } from "../src/db/couch-client.ts";

/** Build a minimal fake CouchClient sufficient for ConfigOperation. */
function makeFakeClient(opts: {
    info?: (signal?: AbortSignal) => Promise<unknown>;
    onProbe?: () => void;
} = {}) {
    const info = opts.info ?? (async () => ({ db_name: "fake", doc_count: 0, update_seq: 0 }));
    const fake: any = {
        info: vi.fn(async (signal?: AbortSignal) => {
            opts.onProbe?.();
            return info(signal);
        }),
        withTimeout: vi.fn(() => fake),
        allDocs: vi.fn(async () => ({ rows: [], total_rows: 0, offset: 0 })),
    };
    return fake as CouchClient & {
        info: ReturnType<typeof vi.fn>;
        withTimeout: ReturnType<typeof vi.fn>;
        allDocs: ReturnType<typeof vi.fn>;
    };
}

/** A controllable VisibilityGate for hidden→visible scenarios. */
class TestVisibilityGate implements VisibilityGate {
    private hidden = false;
    private waiters: Array<() => void> = [];
    private hiddenAbortListeners = new Set<() => void>();
    setHidden(h: boolean) {
        const wasHidden = this.hidden;
        this.hidden = h;
        if (!h) this.flush();
        if (h && !wasHidden) {
            const snap = [...this.hiddenAbortListeners];
            this.hiddenAbortListeners.clear();
            for (const fn of snap) fn();
        }
    }
    isHidden() { return this.hidden; }
    waitVisible(signal: AbortSignal): Promise<void> {
        if (!this.hidden || signal.aborted) return Promise.resolve();
        return new Promise((resolve) => {
            const done = () => {
                signal.removeEventListener("abort", done);
                const idx = this.waiters.indexOf(done);
                if (idx >= 0) this.waiters.splice(idx, 1);
                resolve();
            };
            this.waiters.push(done);
            signal.addEventListener("abort", done, { once: true });
        });
    }
    linkedAbortOnHidden(externalSignal: AbortSignal) {
        const c = new AbortController();
        if (externalSignal.aborted || this.hidden) {
            c.abort();
            return { signal: c.signal, release: () => {} };
        }
        let released = false;
        const trigger = () => {
            if (released) return;
            released = true;
            externalSignal.removeEventListener("abort", trigger);
            this.hiddenAbortListeners.delete(trigger);
            c.abort();
        };
        externalSignal.addEventListener("abort", trigger, { once: true });
        this.hiddenAbortListeners.add(trigger);
        return {
            signal: c.signal,
            release: () => {
                if (released) return;
                released = true;
                externalSignal.removeEventListener("abort", trigger);
                this.hiddenAbortListeners.delete(trigger);
            },
        };
    }
    private flush() { const ws = this.waiters; this.waiters = []; for (const w of ws) w(); }
}

class SpyBridge implements ReconnectBridge {
    public errors: unknown[] = [];
    notifyTransient(err: unknown): void { this.errors.push(err); }
}

describe("ConfigOperation", () => {
    let auth: AuthGate;
    let bridge: SpyBridge;

    beforeEach(() => {
        auth = new AuthGate();
        bridge = new SpyBridge();
    });

    describe("preconditions", () => {
        it("rejects when auth is blocked", async () => {
            auth.raise(401, "bad creds");
            const client = makeFakeClient();
            const op = new ConfigOperation({
                auth, visibility: ALWAYS_VISIBLE, reconnectBridge: bridge,
                makeClient: () => client,
            });
            await expect(op.run(async () => "never")).rejects.toThrow(/Auth blocked/);
            expect(client.info).not.toHaveBeenCalled();
        });

        it("rejects when makeClient returns null (config not configured)", async () => {
            const op = new ConfigOperation({
                auth, visibility: ALWAYS_VISIBLE, reconnectBridge: bridge,
                makeClient: () => null,
            });
            await expect(op.run(async () => "never")).rejects.toThrow(/not configured/);
        });
    });

    describe("reachability probe", () => {
        it("uses withTimeout(15s) for the probe", async () => {
            const client = makeFakeClient();
            const op = new ConfigOperation({
                auth, visibility: ALWAYS_VISIBLE, reconnectBridge: bridge,
                makeClient: () => client,
            });
            await op.run(async () => "ok");
            expect(client.withTimeout).toHaveBeenCalledWith(CONFIG_TIMEOUTS.reachability);
            expect(client.info).toHaveBeenCalledTimes(1);
        });

        it("body runs only after the probe resolves", async () => {
            const events: string[] = [];
            const client = makeFakeClient({
                info: async () => { events.push("probe"); return { db_name: "fake", doc_count: 0, update_seq: 0 }; },
            });
            const op = new ConfigOperation({
                auth, visibility: ALWAYS_VISIBLE, reconnectBridge: bridge,
                makeClient: () => client,
            });
            await op.run(async () => { events.push("body"); return null; });
            expect(events).toEqual(["probe", "body"]);
        });
    });

    describe("error routing", () => {
        it("401 from probe routes to auth.raise (not bridge)", async () => {
            const client = makeFakeClient({
                info: async () => { const e: any = new Error("forbidden"); e.status = 401; throw e; },
            });
            const op = new ConfigOperation({
                auth, visibility: ALWAYS_VISIBLE, reconnectBridge: bridge,
                makeClient: () => client,
            });
            await expect(op.run(async () => "never")).rejects.toThrow(/forbidden/);
            expect(auth.isBlocked()).toBe(true);
            expect(bridge.errors).toEqual([]);
        });

        it("timeout from probe routes to bridge.notifyTransient", async () => {
            const client = makeFakeClient({
                info: async () => { throw new Error("CouchDB request timed out after 15000ms"); },
            });
            const op = new ConfigOperation({
                auth, visibility: ALWAYS_VISIBLE, reconnectBridge: bridge,
                makeClient: () => client,
            });
            await expect(op.run(async () => "never")).rejects.toThrow(/timed out/);
            expect(bridge.errors).toHaveLength(1);
            expect(auth.isBlocked()).toBe(false);
        });

        it("network error from body routes to bridge.notifyTransient", async () => {
            const client = makeFakeClient();
            const op = new ConfigOperation({
                auth, visibility: ALWAYS_VISIBLE, reconnectBridge: bridge,
                makeClient: () => client,
            });
            await expect(
                op.run(async () => { throw new Error("Failed to fetch"); }),
            ).rejects.toThrow(/Failed to fetch/);
            expect(bridge.errors).toHaveLength(1);
        });

        it("500 from body routes to bridge.notifyTransient", async () => {
            const client = makeFakeClient();
            const op = new ConfigOperation({
                auth, visibility: ALWAYS_VISIBLE, reconnectBridge: bridge,
                makeClient: () => client,
            });
            await expect(
                op.run(async () => { const e: any = new Error("server boom"); e.status = 503; throw e; }),
            ).rejects.toMatchObject({ message: "server boom" });
            expect(bridge.errors).toHaveLength(1);
        });

        it("AbortError from cancel does NOT notify bridge", async () => {
            const client = makeFakeClient();
            const op = new ConfigOperation({
                auth, visibility: ALWAYS_VISIBLE, reconnectBridge: bridge,
                makeClient: () => client,
            });
            const run = op.run(async (ctx) => {
                await new Promise<void>((_, reject) => {
                    ctx.signal.addEventListener("abort", () => {
                        const e: any = new Error("aborted"); e.name = "AbortError"; reject(e);
                    });
                });
                return "never";
            });
            op.cancel();
            await expect(run).rejects.toMatchObject({ name: "AbortError" });
            expect(bridge.errors).toEqual([]);
        });
    });

    describe("visibility gating", () => {
        it("waits for visible before running probe", async () => {
            const gate = new TestVisibilityGate();
            gate.setHidden(true);
            const client = makeFakeClient();
            const op = new ConfigOperation({
                auth, visibility: gate, reconnectBridge: bridge,
                makeClient: () => client,
            });
            const events: string[] = [];
            const run = op.run(async () => { events.push("body"); return null; });

            // Yield a few ticks; probe should NOT have run yet.
            await Promise.resolve(); await Promise.resolve();
            expect(client.info).not.toHaveBeenCalled();
            expect(events).toEqual([]);

            // Become visible — probe + body should now run.
            gate.setHidden(false);
            await run;
            expect(client.info).toHaveBeenCalledTimes(1);
            expect(events).toEqual(["body"]);
        });

        it("cancel during waitVisible unblocks with AbortError", async () => {
            const gate = new TestVisibilityGate();
            gate.setHidden(true);
            const client = makeFakeClient();
            const op = new ConfigOperation({
                auth, visibility: gate, reconnectBridge: bridge,
                makeClient: () => client,
            });
            const run = op.run(async () => "never");
            op.cancel();
            await expect(run).rejects.toMatchObject({ name: "AbortError" });
            expect(client.info).not.toHaveBeenCalled();
        });
    });

    describe("body context", () => {
        it("body receives the un-narrowed client and the signal", async () => {
            const client = makeFakeClient();
            const op = new ConfigOperation({
                auth, visibility: ALWAYS_VISIBLE, reconnectBridge: bridge,
                makeClient: () => client,
            });
            let observed: { client: unknown; signal: AbortSignal } | null = null;
            await op.run(async (ctx) => {
                observed = { client: ctx.client, signal: ctx.signal };
                return null;
            });
            expect(observed!.client).toBe(client);
            expect(observed!.signal).toBe(op.signal);
        });
    });

    describe("settled lifecycle", () => {
        it("rejects re-running an already-settled op", async () => {
            const client = makeFakeClient();
            const op = new ConfigOperation({
                auth, visibility: ALWAYS_VISIBLE, reconnectBridge: bridge,
                makeClient: () => client,
            });
            await op.run(async () => "ok");
            await expect(op.run(async () => "ok")).rejects.toThrow(/already settled/);
        });
    });
});

// Suppress TS unused import warnings for explicit re-exports referenced
// only by the type system above.
void NoopReconnectBridge;
