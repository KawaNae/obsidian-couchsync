/**
 * ReconnectBridge — one-way notification from ConfigSync to SyncEngine.
 *
 * Why an interface instead of a direct SyncEngine reference: keeps
 * ConfigSync free of replicator imports (and of the test-time setup
 * burden that would imply). main.ts wires the production binding in
 * one place, tests pass `NoopReconnectBridge`.
 *
 * Semantic contract:
 *   - notifyTransient: a transient error (network/timeout/5xx) was
 *     observed during a Config Sync op. The bridge may, at its
 *     discretion, request a vault reconnect. It MUST NOT throw.
 *
 * Auth (401/403) does NOT route through this bridge — those are
 * handled by AuthGate.raise() which both ConfigSync and SyncEngine
 * already share.
 */
export interface ReconnectBridge {
    notifyTransient(err: unknown): void;
}

/** No-op bridge for tests and for the "config sync is the only sync"
 *  scenario where there is no live vault session to bother. */
export const NoopReconnectBridge: ReconnectBridge = {
    notifyTransient: () => {},
};
