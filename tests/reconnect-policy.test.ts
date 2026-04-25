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
    { state: "disconnected", reason: "manual",         authError: true,  coolDownActive: false, expected: "skip", note: "auth latch beats manual — retrying with bad creds risks CouchDB lockout" },
    { state: "syncing",      reason: "manual",         authError: true,  coolDownActive: false, expected: "skip", note: "same: auth latch is absolute, even mid-sync" },
    { state: "error",        reason: "network-online", authError: true,  coolDownActive: false, expected: "skip", note: "network coming back can't fix bad credentials" },

    // ── Cool-down is second priority — beats everything except auth ─
    { state: "disconnected", reason: "manual",         authError: false, coolDownActive: true,  expected: "skip", note: "cool-down prevents reconnect storms from rapid user clicks" },
    { state: "syncing",      reason: "stalled",        authError: false, coolDownActive: true,  expected: "skip", note: "stall during cool-down: wait for cool-down to expire first" },
    { state: "disconnected", reason: "periodic-tick",  authError: false, coolDownActive: true,  expected: "skip", note: "blind tick during cool-down is redundant" },

    // ── Healthy session (syncing/connected) ──────────────────────
    { state: "syncing",   reason: "manual",         authError: false, coolDownActive: false, expected: "restart-now",       note: "manual always restarts — user explicitly wants a fresh session" },
    { state: "connected", reason: "manual",         authError: false, coolDownActive: false, expected: "restart-now",       note: "same: user intent overrides healthy state" },
    { state: "syncing",   reason: "stalled",        authError: false, coolDownActive: false, expected: "restart-now",       note: "stall detection forces restart — pull loop is stuck" },
    { state: "connected", reason: "stalled",        authError: false, coolDownActive: false, expected: "restart-now",       note: "same: stalled pull must be replaced" },
    { state: "syncing",   reason: "network-online", authError: false, coolDownActive: false, expected: "skip",               note: "healthy session has a working connection — network hint is noise" },
    { state: "syncing",   reason: "app-foreground", authError: false, coolDownActive: false, expected: "skip",               note: "tab focus doesn't invalidate an active longpoll" },
    { state: "syncing",   reason: "periodic-tick",  authError: false, coolDownActive: false, expected: "skip",               note: "active session has its own stall logic via checkHealth" },
    { state: "connected", reason: "network-online", authError: false, coolDownActive: false, expected: "skip",               note: "connected + network hint = already fine" },
    { state: "connected", reason: "app-foreground", authError: false, coolDownActive: false, expected: "skip",               note: "same: longpoll is alive, no action needed" },
    { state: "connected", reason: "periodic-tick",  authError: false, coolDownActive: false, expected: "skip",               note: "same: healthy session handles its own health checks" },

    // ── app-resume: socket may be silently dead (mobile / long bg) ─
    { state: "syncing",      reason: "app-resume",     authError: false, coolDownActive: false, expected: "verify-then-restart", note: "mobile resume — OS may have killed the socket in background" },
    { state: "connected",    reason: "app-resume",     authError: false, coolDownActive: false, expected: "verify-then-restart", note: "same: can't trust socket liveness after long background" },
    { state: "disconnected", reason: "app-resume",     authError: false, coolDownActive: false, expected: "verify-then-restart", note: "waking from dead state: verify server is reachable first" },
    { state: "error",        reason: "app-resume",     authError: false, coolDownActive: false, expected: "verify-then-restart", note: "same: app-resume always verifies before restart" },
    { state: "syncing",      reason: "app-resume",     authError: true,  coolDownActive: false, expected: "skip",                note: "auth latch beats app-resume — verifying with bad creds is pointless" },
    { state: "disconnected", reason: "app-resume",     authError: false, coolDownActive: true,  expected: "skip",                note: "cool-down beats app-resume — recent restart is still settling" },

    // ── Reconnecting (restart already in progress) ───────────────
    { state: "reconnecting", reason: "manual",         authError: false, coolDownActive: false, expected: "restart-now",         note: "manual overrides in-progress reconnect — user wants a clean restart" },
    { state: "reconnecting", reason: "network-online", authError: false, coolDownActive: false, expected: "restart-now",         note: "network just came up — restart immediately with fresh connection" },
    { state: "reconnecting", reason: "periodic-tick",  authError: false, coolDownActive: false, expected: "verify-then-restart", note: "blind tick during reconnect — verify first, don't pile on" },
    { state: "reconnecting", reason: "app-resume",     authError: false, coolDownActive: false, expected: "verify-then-restart", note: "same: app-resume always verifies" },

    // ── Dead/unhealthy session (disconnected/error) ──────────────
    { state: "disconnected", reason: "manual",         authError: false, coolDownActive: false, expected: "restart-now",         note: "manual restarts dead session immediately — user intent" },
    { state: "disconnected", reason: "network-online", authError: false, coolDownActive: false, expected: "restart-now",         note: "browser network up — strong hint, restart immediately" },
    { state: "disconnected", reason: "app-foreground", authError: false, coolDownActive: false, expected: "restart-now",         note: "tab/app visible — user is active, restore sync" },
    { state: "disconnected", reason: "periodic-tick",  authError: false, coolDownActive: false, expected: "verify-then-restart", note: "blind tick — verify first to avoid restart storm against down server" },
    { state: "error",        reason: "manual",         authError: false, coolDownActive: false, expected: "restart-now",         note: "user explicitly retrying after error — honour immediately" },
    { state: "error",        reason: "network-online", authError: false, coolDownActive: false, expected: "restart-now",         note: "network restored after error — strong signal to retry" },
    { state: "error",        reason: "app-foreground", authError: false, coolDownActive: false, expected: "restart-now",         note: "user returned to app during error — try again" },
    { state: "error",        reason: "periodic-tick",  authError: false, coolDownActive: false, expected: "verify-then-restart", note: "blind tick in error — verify first, server may still be down" },
    { state: "error",        reason: "stalled",        authError: false, coolDownActive: false, expected: "restart-now",         note: "stalled-while-error: strong hint to retry (shouldn't normally happen)" },

    // ── config-failure: ConfigSync transient error ───────────────
    { state: "syncing",      reason: "config-failure", authError: false, coolDownActive: false, expected: "skip",                note: "vault sync is fine — don't restart for a config DB hiccup" },
    { state: "connected",    reason: "config-failure", authError: false, coolDownActive: false, expected: "skip",                note: "same: healthy vault should not be torn down for config-only failure" },
    { state: "disconnected", reason: "config-failure", authError: false, coolDownActive: false, expected: "verify-then-restart", note: "vault dead too — config failure is the same network blip; verify and recover together" },
    { state: "error",        reason: "config-failure", authError: false, coolDownActive: false, expected: "verify-then-restart", note: "vault errored — piggyback on the config-failure signal to retry verifying" },
    { state: "reconnecting", reason: "config-failure", authError: false, coolDownActive: false, expected: "verify-then-restart", note: "already reconnecting — config-failure adds another verify, harmless" },
    { state: "syncing",      reason: "config-failure", authError: true,  coolDownActive: false, expected: "skip",                note: "auth latch beats config-failure — bad creds are bad creds" },
    { state: "disconnected", reason: "config-failure", authError: false, coolDownActive: true,  expected: "skip",                note: "cool-down beats config-failure" },

    // ── retry-backoff: dedicated hard-error recovery ticks ────────
    { state: "error",        reason: "retry-backoff",  authError: false, coolDownActive: false, expected: "verify-then-restart", note: "backoff tick — verify first, don't blindly reconnect to a down server" },
    { state: "error",        reason: "retry-backoff",  authError: false, coolDownActive: true,  expected: "verify-then-restart", note: "backoff bypasses 5s cool-down — the backoff schedule IS the cadence control" },
    { state: "error",        reason: "retry-backoff",  authError: true,  coolDownActive: false, expected: "skip",                note: "auth latch still beats retry-backoff — no point retrying bad creds" },
    { state: "disconnected", reason: "retry-backoff",  authError: false, coolDownActive: false, expected: "verify-then-restart", note: "backoff from disconnected — same verify-first approach" },
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
            "config-failure",
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
            "config-failure",
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
