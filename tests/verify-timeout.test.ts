/**
 * Tests for verifyTimeoutMs — picks a verify-reachable timeout
 * appropriate for the reconnect reason.
 *
 * Mobile app-resume often takes >5s for the network stack to come back.
 * The 2026-04-22 main-vault log showed verify aborts at 5001ms then
 * recovery via retry-backoff (10s+18s wasted). For app-resume /
 * network-online we use a longer ceiling; everything else stays at 5s.
 */

import { describe, it, expect } from "vitest";
import { verifyTimeoutMs } from "../src/db/sync-engine.ts";

describe("verifyTimeoutMs", () => {
    it("returns 15s for app-resume", () => {
        expect(verifyTimeoutMs("app-resume")).toBe(15_000);
    });

    it("returns 15s for network-online", () => {
        expect(verifyTimeoutMs("network-online")).toBe(15_000);
    });

    it("returns 5s for retry-backoff", () => {
        expect(verifyTimeoutMs("retry-backoff")).toBe(5_000);
    });

    it("returns 5s for periodic-tick", () => {
        expect(verifyTimeoutMs("periodic-tick")).toBe(5_000);
    });

    it("returns 5s for stalled", () => {
        expect(verifyTimeoutMs("stalled")).toBe(5_000);
    });

    it("returns 5s for app-foreground", () => {
        expect(verifyTimeoutMs("app-foreground")).toBe(5_000);
    });

    it("returns 5s for manual", () => {
        expect(verifyTimeoutMs("manual")).toBe(5_000);
    });
});
