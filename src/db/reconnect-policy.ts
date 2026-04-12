/**
 * Reconnect gateway policy — pure decision logic, no PouchDB.
 *
 * Replicator's `requestReconnect()` is the single entry point for every
 * reconnect attempt (window.online, periodic tick, mobile foreground,
 * manual user action, sync stall detection). It centralises the policy
 * here so adding a new trigger doesn't risk skipping the auth latch or
 * the cool-down or some state-specific guard.
 *
 * The policy itself is a pure function so it can be unit-tested without
 * spinning up a Replicator instance (which would drag in pouchdb-browser
 * and break in node tests). Replicator just plumbs its current state
 * into `decideReconnect()` and acts on the returned `ReconnectDecision`.
 */

/**
 * Connection state owned by Replicator. Defined here (rather than in
 * replicator.ts) so this module is the single import target for tests
 * that don't want pouchdb-browser pulled in.
 */
export type SyncState = "disconnected" | "connected" | "syncing" | "reconnecting" | "error";

/**
 * Classification of an error that caused a hard state=error transition.
 * Surfaces in the status bar as `Error (<code>)` / `Error (<kind>)` so
 * the user can tell at a glance whether it's an auth problem, a network
 * blip, a catchup timeout, etc., without having to catch the Notice.
 */
export type SyncErrorKind =
    | "auth"      // 401 / 403
    | "network"   // unreachable, DNS, connection refused, fetch failed
    | "timeout"   // catchup idle timeout, request timeout
    | "server"    // 5xx
    | "denied"    // per-doc permission rejection (warning-only, does not promote state)
    | "unknown";

export interface SyncErrorDetail {
    kind: SyncErrorKind;
    /** HTTP status or similar numeric code, if known. Preferred for display. */
    code?: number;
    /** Full human-readable message, suitable for Notice and log. */
    message: string;
}

/**
 * Why a reconnect is being requested. Each value corresponds to a
 * distinct trigger entry point in the codebase:
 *
 *   - "network-online": browser fired window.online (handleOnline)
 *   - "app-foreground": Obsidian visibilitychange → visible (mobile resume)
 *   - "periodic-tick":  30s health check, called when state is dead/unhealthy
 *   - "stalled":        30s health check detected an active-but-silent sync
 *   - "manual":         user-triggered (Command Palette / Maintenance button)
 *   - "app-resume":     long background or mobile foreground — the sync
 *                        socket may have been silently killed by the OS
 */
export type ReconnectReason =
    | "network-online"
    | "app-foreground"
    | "app-resume"
    | "periodic-tick"
    | "stalled"
    | "manual"
    /** Dedicated backoff retry tick from the hard-error recovery timer.
     *  Bypasses the 5s cool-down because the backoff schedule itself
     *  controls cadence — the cool-down would block the fast first
     *  retries (2s, 5s) that make transient failures feel transparent. */
    | "retry-backoff";

/**
 * What the gateway decided. Replicator interprets the value:
 *
 *   - "skip":                do nothing (latched, cool-down, healthy session, etc.)
 *   - "restart-now":         immediately stop+start the sync session
 *   - "verify-then-restart": verify the server is reachable first, only
 *                            restart if it is. Used for blind periodic
 *                            ticks against a possibly-still-down server.
 */
export type ReconnectDecision = "skip" | "restart-now" | "verify-then-restart";

export interface ReconnectInput {
    state: SyncState;
    reason: ReconnectReason;
    /** True if the auth latch is currently set (401/403 received). */
    authError: boolean;
    /** True if the last restart happened within the cool-down window. */
    coolDownActive: boolean;
}

/**
 * Decide what to do with a reconnect request.
 *
 * Priority:
 *   1. authError → never reconnect (resolved only by user updating creds)
 *   2. coolDownActive → never reconnect (avoid restart storms)
 *   3. state-aware:
 *        - syncing/connected: only restart on stalled/manual; ignore other hints
 *        - disconnected/error: restart on any explicit hint; verify first for blind ticks
 */
export function decideReconnect(input: ReconnectInput): ReconnectDecision {
    if (input.authError) return "skip";

    // retry-backoff bypasses cool-down: the backoff schedule is the
    // cadence control, and the cool-down would swallow the 2s first
    // retry that lets transient blips recover quickly.
    if (input.reason === "retry-backoff") return "verify-then-restart";

    if (input.coolDownActive) return "skip";

    // Mobile foreground or long desktop background — the socket may have
    // been silently killed. Verify reachability regardless of current
    // state, because the state itself may be stale.
    if (input.reason === "app-resume") return "verify-then-restart";

    switch (input.state) {
        case "syncing":
        case "connected":
            // A healthy session shouldn't be torn down by network/foreground/tick
            // hints — those are noise once we're already running. The only
            // valid reasons to restart a healthy session are an explicit
            // user request or stall detection by checkHealth.
            if (input.reason === "stalled" || input.reason === "manual") {
                return "restart-now";
            }
            return "skip";

        case "disconnected":
        case "reconnecting":
        case "error":
            // The session is dead or unhealthy — we want to recover.
            // For periodic-tick we have no fresh signal, so we verify
            // reachability first. The other reasons all carry their own
            // implicit signal (browser network up, app resumed, user click,
            // stall detector said something is wrong) so we restart
            // immediately and let the sync session itself sort it out.
            if (input.reason === "periodic-tick") {
                return "verify-then-restart";
            }
            return "restart-now";
    }
}
