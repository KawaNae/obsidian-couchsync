/**
 * Tests for VisibilityGate — gates the sync loops while the page is
 * hidden, so iOS Safari doesn't kill in-flight IndexedDB transactions.
 */

import { describe, it, expect } from "vitest";
import {
    BrowserVisibilityGate,
    ALWAYS_VISIBLE,
} from "../src/db/visibility-gate.ts";

/** Test seam: simulate `document.visibilityState` + dispatch events. */
class FakeDocument {
    state: "visible" | "hidden" = "visible";
    private listeners = new Set<() => void>();

    get visibilityState(): "visible" | "hidden" { return this.state; }

    addEventListener(type: string, fn: () => void): void {
        if (type !== "visibilitychange") return;
        this.listeners.add(fn);
    }

    removeEventListener(type: string, fn: () => void): void {
        if (type !== "visibilitychange") return;
        this.listeners.delete(fn);
    }

    setVisible(visible: boolean): void {
        this.state = visible ? "visible" : "hidden";
        for (const fn of this.listeners) fn();
    }
}

describe("ALWAYS_VISIBLE", () => {
    it("never reports hidden", () => {
        expect(ALWAYS_VISIBLE.isHidden()).toBe(false);
    });

    it("waitVisible resolves immediately", async () => {
        const ctl = new AbortController();
        await expect(ALWAYS_VISIBLE.waitVisible(ctl.signal)).resolves.toBeUndefined();
    });

    it("linkedAbortOnHidden returns the external signal unchanged (no hidden source)", () => {
        const ctl = new AbortController();
        const cycle = ALWAYS_VISIBLE.linkedAbortOnHidden(ctl.signal);
        expect(cycle.signal).toBe(ctl.signal);
        expect(cycle.signal.aborted).toBe(false);
        ctl.abort();
        expect(cycle.signal.aborted).toBe(true);
        cycle.release(); // no-op
    });
});

describe("BrowserVisibilityGate", () => {
    it("isHidden reflects document.visibilityState=visible", () => {
        const doc = new FakeDocument();
        const gate = new BrowserVisibilityGate(doc as any);
        gate.attach();
        expect(gate.isHidden()).toBe(false);
    });

    it("isHidden reflects document.visibilityState=hidden", () => {
        const doc = new FakeDocument();
        doc.state = "hidden";
        const gate = new BrowserVisibilityGate(doc as any);
        gate.attach();
        expect(gate.isHidden()).toBe(true);
    });

    it("waitVisible resolves immediately when already visible", async () => {
        const doc = new FakeDocument();
        const gate = new BrowserVisibilityGate(doc as any);
        gate.attach();
        const ctl = new AbortController();
        await expect(gate.waitVisible(ctl.signal)).resolves.toBeUndefined();
    });

    it("waitVisible resolves on visibilitychange to visible", async () => {
        const doc = new FakeDocument();
        doc.state = "hidden";
        const gate = new BrowserVisibilityGate(doc as any);
        gate.attach();
        const ctl = new AbortController();

        const p = gate.waitVisible(ctl.signal);
        // Verify we're really pending — give the microtask queue a tick.
        let settled = false;
        p.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);

        doc.setVisible(true);
        await p;
        expect(settled).toBe(true);
    });

    it("waitVisible resolves immediately when signal is already aborted", async () => {
        const doc = new FakeDocument();
        doc.state = "hidden";
        const gate = new BrowserVisibilityGate(doc as any);
        gate.attach();
        const ctl = new AbortController();
        ctl.abort();
        await expect(gate.waitVisible(ctl.signal)).resolves.toBeUndefined();
    });

    it("waitVisible resolves when signal aborts mid-wait", async () => {
        const doc = new FakeDocument();
        doc.state = "hidden";
        const gate = new BrowserVisibilityGate(doc as any);
        gate.attach();
        const ctl = new AbortController();

        const p = gate.waitVisible(ctl.signal);
        let settled = false;
        p.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);

        ctl.abort();
        await p;
        expect(settled).toBe(true);
    });

    it("supports multiple concurrent waiters; all resolve on visible", async () => {
        const doc = new FakeDocument();
        doc.state = "hidden";
        const gate = new BrowserVisibilityGate(doc as any);
        gate.attach();
        const ctl = new AbortController();

        const a = gate.waitVisible(ctl.signal);
        const b = gate.waitVisible(ctl.signal);
        const c = gate.waitVisible(ctl.signal);

        doc.setVisible(true);
        await Promise.all([a, b, c]);
    });

    it("detach() removes the visibilitychange listener and cancels pending waiters", async () => {
        const doc = new FakeDocument();
        doc.state = "hidden";
        const gate = new BrowserVisibilityGate(doc as any);
        gate.attach();
        const ctl = new AbortController();

        const p = gate.waitVisible(ctl.signal);
        gate.detach();
        await expect(p).resolves.toBeUndefined();
    });

    // ── linkedAbortOnHidden ────────────────────────────────

    it("linkedAbortOnHidden: aborts on visibility:hidden transition", () => {
        const doc = new FakeDocument();
        const gate = new BrowserVisibilityGate(doc as any);
        gate.attach();
        const ext = new AbortController();
        const cycle = gate.linkedAbortOnHidden(ext.signal);
        expect(cycle.signal.aborted).toBe(false);

        doc.setVisible(false); // hidden transition fires hiddenListeners
        expect(cycle.signal.aborted).toBe(true);

        // release after abort is idempotent.
        cycle.release();
    });

    it("linkedAbortOnHidden: aborts on external signal", () => {
        const doc = new FakeDocument();
        const gate = new BrowserVisibilityGate(doc as any);
        gate.attach();
        const ext = new AbortController();
        const cycle = gate.linkedAbortOnHidden(ext.signal);
        expect(cycle.signal.aborted).toBe(false);

        ext.abort();
        expect(cycle.signal.aborted).toBe(true);
    });

    it("linkedAbortOnHidden: returns an immediately-aborted signal when external is already aborted", () => {
        const doc = new FakeDocument();
        const gate = new BrowserVisibilityGate(doc as any);
        gate.attach();
        const ext = new AbortController();
        ext.abort();
        const cycle = gate.linkedAbortOnHidden(ext.signal);
        expect(cycle.signal.aborted).toBe(true);
    });

    it("linkedAbortOnHidden: returns an immediately-aborted signal when already hidden", () => {
        const doc = new FakeDocument();
        doc.state = "hidden";
        const gate = new BrowserVisibilityGate(doc as any);
        gate.attach();
        const cycle = gate.linkedAbortOnHidden(new AbortController().signal);
        expect(cycle.signal.aborted).toBe(true);
    });

    it("linkedAbortOnHidden: release() removes listeners (no leak across cycles)", () => {
        const doc = new FakeDocument();
        const gate = new BrowserVisibilityGate(doc as any);
        gate.attach();

        for (let i = 0; i < 1000; i++) {
            const c = gate.linkedAbortOnHidden(new AbortController().signal);
            c.release();
        }
        // hiddenListeners must drain back to empty after release().
        expect((gate as any).hiddenListeners.size).toBe(0);
    });

    it("linkedAbortOnHidden: ignores subsequent visibility:hidden after release()", () => {
        const doc = new FakeDocument();
        const gate = new BrowserVisibilityGate(doc as any);
        gate.attach();
        const ext = new AbortController();
        const cycle = gate.linkedAbortOnHidden(ext.signal);
        cycle.release();
        // After release, hidden transitions don't abort the (already
        // released) signal.
        doc.setVisible(false);
        expect(cycle.signal.aborted).toBe(false);
    });

    it("linkedAbortOnHidden: hidden listeners do not leak when external aborts first", () => {
        const doc = new FakeDocument();
        const gate = new BrowserVisibilityGate(doc as any);
        gate.attach();
        const ext = new AbortController();
        gate.linkedAbortOnHidden(ext.signal);
        ext.abort();
        // External-side abort should remove the entry from hiddenListeners.
        expect((gate as any).hiddenListeners.size).toBe(0);
    });
});
