/**
 * Tests for the reconnect policy gateway.
 *
 * The policy is intentionally extracted as a pure function (no PouchDB,
 * no Replicator instance) so it's trivially testable from node tests.
 * Replicator's `requestReconnect()` method is a thin layer that reads
 * its current state, calls `decideReconnect()`, and acts on the
 * returned decision.
 *
 * This file pins the policy as a table — adding a new ReconnectReason
 * or changing how a state is handled requires updating this table,
 * which makes the behavior auditable at a glance.
 */

import { describe, it, expect } from "vitest";
import {
    decideReconnect,
    type ReconnectReason,
    type ReconnectDecision,
    type SyncState,
} from "../src/db/reconnect-policy.ts";

interface PolicyCase {
    state: SyncState;
    reason: ReconnectReason;
    authError: boolean;
    coolDownActive: boolean;
    expected: ReconnectDecision;
    note?: string;
}

const cases: PolicyCase[] = [
    // ── Auth latch is the highest priority — always skips ─────────
    { state: "disconnected", reason: "manual",         authError: true,  coolDownActive: false, expected: "skip", note: "auth latch beats manual" },
    { state: "syncing",      reason: "manual",         authError: true,  coolDownActive: false, expected: "skip" },
    { state: "error",        reason: "network-online", authError: true,  coolDownActive: false, expected: "skip" },

    // ── Cool-down is second priority — beats everything except auth ─
    { state: "disconnected", reason: "manual",         authError: false, coolDownActive: true,  expected: "skip", note: "cool-down beats manual" },
    { state: "syncing",      reason: "stalled",        authError: false, coolDownActive: true,  expected: "skip" },
    { state: "disconnected", reason: "periodic-tick",  authError: false, coolDownActive: true,  expected: "skip" },

    // ── Healthy session (syncing/connected) ──────────────────────
    { state: "syncing",   reason: "manual",         authError: false, coolDownActive: false, expected: "restart-now",       note: "manual always restarts even when healthy" },
    { state: "connected", reason: "manual",         authError: false, coolDownActive: false, expected: "restart-now" },
    { state: "syncing",   reason: "stalled",        authError: false, coolDownActive: false, expected: "restart-now",       note: "stall detection forces a restart" },
    { state: "connected", reason: "stalled",        authError: false, coolDownActive: false, expected: "restart-now" },
    { state: "syncing",   reason: "network-online", authError: false, coolDownActive: false, expected: "skip",               note: "healthy session ignores network hint" },
    { state: "syncing",   reason: "app-foreground", authError: false, coolDownActive: false, expected: "skip" },
    { state: "syncing",   reason: "periodic-tick",  authError: false, coolDownActive: false, expected: "skip",               note: "active session has its own stall logic" },
    { state: "connected", reason: "network-online", authError: false, coolDownActive: false, expected: "skip" },
    { state: "connected", reason: "app-foreground", authError: false, coolDownActive: false, expected: "skip" },
    { state: "connected", reason: "periodic-tick",  authError: false, coolDownActive: false, expected: "skip" },

    // ── app-resume: socket may be silently dead (mobile / long bg) ─
    { state: "syncing",      reason: "app-resume",     authError: false, coolDownActive: false, expected: "verify-then-restart", note: "mobile resume — don't trust healthy state" },
    { state: "connected",    reason: "app-resume",     authError: false, coolDownActive: false, expected: "verify-then-restart" },
    { state: "disconnected", reason: "app-resume",     authError: false, coolDownActive: false, expected: "verify-then-restart" },
    { state: "error",        reason: "app-resume",     authError: false, coolDownActive: false, expected: "verify-then-restart" },
    { state: "syncing",      reason: "app-resume",     authError: true,  coolDownActive: false, expected: "skip",                note: "auth latch beats app-resume" },
    { state: "disconnected", reason: "app-resume",     authError: false, coolDownActive: true,  expected: "skip",                note: "cool-down beats app-resume" },

    // ── Reconnecting (same as disconnected — restart already in progress) ─
    { state: "reconnecting", reason: "manual",         authError: false, coolDownActive: false, expected: "restart-now",         note: "manual overrides in-progress reconnect" },
    { state: "reconnecting", reason: "network-online", authError: false, coolDownActive: false, expected: "restart-now" },
    { state: "reconnecting", reason: "periodic-tick",  authError: false, coolDownActive: false, expected: "verify-then-restart" },
    { state: "reconnecting", reason: "app-resume",     authError: false, coolDownActive: false, expected: "verify-then-restart" },

    // ── Dead/unhealthy session (disconnected/error) ──────────────
    { state: "disconnected", reason: "manual",         authError: false, coolDownActive: false, expected: "restart-now",         note: "manual restarts dead session immediately" },
    { state: "disconnected", reason: "network-online", authError: false, coolDownActive: false, expected: "restart-now",         note: "browser network up — strong hint" },
    { state: "disconnected", reason: "app-foreground", authError: false, coolDownActive: false, expected: "restart-now",         note: "mobile resume — strong hint" },
    { state: "disconnected", reason: "periodic-tick",  authError: false, coolDownActive: false, expected: "verify-then-restart", note: "blind tick — verify first to avoid restart storm against down server" },
    { state: "error",        reason: "manual",         authError: false, coolDownActive: false, expected: "restart-now" },
    { state: "error",        reason: "network-online", authError: false, coolDownActive: false, expected: "restart-now" },
    { state: "error",        reason: "app-foreground", authError: false, coolDownActive: false, expected: "restart-now" },
    { state: "error",        reason: "periodic-tick",  authError: false, coolDownActive: false, expected: "verify-then-restart" },
    { state: "error",        reason: "stalled",        authError: false, coolDownActive: false, expected: "restart-now",         note: "stalled-while-error: somebody marked us as stalled in error, treat as a strong hint to retry" },

    // ── retry-backoff: dedicated hard-error recovery ticks ────────
    { state: "error",        reason: "retry-backoff",  authError: false, coolDownActive: false, expected: "verify-then-restart", note: "backoff tick uses verify-then-restart" },
    { state: "error",        reason: "retry-backoff",  authError: false, coolDownActive: true,  expected: "verify-then-restart", note: "backoff tick bypasses the 5s cool-down — the backoff schedule IS the cadence control" },
    { state: "error",        reason: "retry-backoff",  authError: true,  coolDownActive: false, expected: "skip",                note: "auth latch still beats retry-backoff" },
    { state: "disconnected", reason: "retry-backoff",  authError: false, coolDownActive: false, expected: "verify-then-restart" },
];

describe("decideReconnect — gateway policy table", () => {
    for (const c of cases) {
        const label =
            `${c.state.padEnd(13)} + ${c.reason.padEnd(15)} ` +
            `(auth=${c.authError ? "Y" : "."} cool=${c.coolDownActive ? "Y" : "."}) ` +
            `→ ${c.expected}` +
            (c.note ? ` // ${c.note}` : "");

        it(label, () => {
            const got = decideReconnect({
                state: c.state,
                reason: c.reason,
                authError: c.authError,
                coolDownActive: c.coolDownActive,
            });
            expect(got).toBe(c.expected);
        });
    }
});

describe("decideReconnect — invariants", () => {
    it("auth latch is absolute — beats every reason in every state", () => {
        const reasons: ReconnectReason[] = [
            "network-online",
            "app-foreground",
            "app-resume",
            "periodic-tick",
            "stalled",
            "manual",
            "retry-backoff",
        ];
        const states: SyncState[] = ["disconnected", "connected", "syncing", "reconnecting", "error"];
        for (const state of states) {
            for (const reason of reasons) {
                const got = decideReconnect({ state, reason, authError: true, coolDownActive: false });
                expect(got).toBe("skip");
            }
        }
    });

    it("cool-down is absolute (after auth) — beats every reason in every non-auth state", () => {
        const reasons: ReconnectReason[] = [
            "network-online",
            "app-foreground",
            "app-resume",
            "periodic-tick",
            "stalled",
            "manual",
        ];
        const states: SyncState[] = ["disconnected", "connected", "syncing", "reconnecting", "error"];
        for (const state of states) {
            for (const reason of reasons) {
                const got = decideReconnect({ state, reason, authError: false, coolDownActive: true });
                expect(got).toBe("skip");
            }
        }
    });

    it("manual always succeeds when no latch (auth + cool-down clear)", () => {
        const states: SyncState[] = ["disconnected", "connected", "syncing", "reconnecting", "error"];
        for (const state of states) {
            const got = decideReconnect({
                state,
                reason: "manual",
                authError: false,
                coolDownActive: false,
            });
            expect(got).toBe("restart-now");
        }
    });

    it("app-resume always verifies when no latch (auth + cool-down clear)", () => {
        const states: SyncState[] = ["disconnected", "connected", "syncing", "reconnecting", "error"];
        for (const state of states) {
            const got = decideReconnect({
                state,
                reason: "app-resume",
                authError: false,
                coolDownActive: false,
            });
            expect(got).toBe("verify-then-restart");
        }
    });

    it("periodic-tick from disconnected/error always verifies first", () => {
        const got1 = decideReconnect({
            state: "disconnected",
            reason: "periodic-tick",
            authError: false,
            coolDownActive: false,
        });
        const got2 = decideReconnect({
            state: "error",
            reason: "periodic-tick",
            authError: false,
            coolDownActive: false,
        });
        expect(got1).toBe("verify-then-restart");
        expect(got2).toBe("verify-then-restart");
    });
});
