/**
 * vault-relation-view.ts — the Vault Sync tab's Step 3 status line and the
 * Clone button's state, as pure functions of this device's setup of the
 * vault DB (`VaultBinding.relation()`).
 *
 * The status line says what is in the way first, then what is known:
 *
 *   1. the server is not set up (CouchDB tab), or no DB is applied (Step 2)
 *   2. an Init or Clone is running
 *   3. the server rejects the credentials (the auth latch)
 *   4. live sync is on — setup is locked
 *   5. a failure: the last Init / Clone, or the agreement pause (it says
 *      why sync stopped); when both are known, the one that started later.
 *      A setup left unfinished says so too
 *   6. a setup that did not finish (no failure known since the load)
 *   7. not set up yet
 *   8. set up
 */
import type { VaultDbCheck, VaultRelation } from "../sync/vault-binding.ts";
import { describeError } from "../ui/describe-error.ts";

export interface VaultRelationView {
    text: string;
    /** "ok": set up or syncing; "error": something is in the way; null:
     *  neutral. */
    tone: "ok" | "error" | null;
}

const UNFINISHED = "Setup did not finish — re-run Init or Clone. Sync stays disabled until it completes.";

/**
 * @param authError the error the auth latch refuses requests with
 *   (`AuthGate.blockedError()`), or null when the latch is clear.
 */
export function vaultRelationView(rel: VaultRelation, authError: unknown | null): VaultRelationView {
    if (!rel.serverTested) return { text: "Complete the CouchDB tab and Step 2 first.", tone: null };
    if (rel.state === "editing") return { text: "Complete Step 2 first.", tone: null };
    if (rel.busy) return { text: `${rel.busy === "init" ? "Init" : "Clone"} is running…`, tone: null };
    if (authError) return { text: describeError(authError).text, tone: "error" };
    if (rel.state === "syncing") {
        return { text: "Live sync is on. Turn it off in Step 4 to re-run setup.", tone: "ok" };
    }
    const failures: { at: number; label: string; error: unknown }[] = [];
    if (rel.lastOp?.error) {
        failures.push({
            at: rel.lastOp.at,
            label: rel.lastOp.op === "init" ? "Init" : "Clone",
            error: rel.lastOp.error,
        });
    }
    if (rel.pause) failures.push({ at: rel.pause.at, label: "server check", error: rel.pause.error });
    const failed = failures.sort((a, b) => b.at - a.at)[0];
    if (failed) {
        const text = `Last ${failed.label}: ${describeError(failed.error).text}`;
        return { text: rel.state === "settingUp" ? `${text} ${UNFINISHED}` : text, tone: "error" };
    }
    if (rel.state === "settingUp") return { text: UNFINISHED, tone: "error" };
    if (rel.state === "tested") return { text: "Choose how to initialize this vault.", tone: null };
    return { text: "Setup complete. You can re-run if needed.", tone: "ok" };
}

export interface CloneAvailability {
    enabled: boolean;
    desc: string;
}

/**
 * Whether Clone can run, from what the applied DB was last found to hold
 * (Step 2's Check, or the read-back after an Init): Clone needs a DB that
 * holds data. Without a check since the plugin loaded, nothing is
 * known about the DB, so the user is asked to check it rather than told it
 * is empty.
 *
 * @param setupAllowed the setup state allows Init / Clone (`setupGating`).
 */
export function cloneAvailability(dbCheck: VaultDbCheck | null, setupAllowed: boolean): CloneAvailability {
    const ready = "Pull remote database to local vault (2nd+ device)";
    if (!setupAllowed) return { enabled: false, desc: ready };
    const r = dbCheck?.result;
    if (!r) {
        return { enabled: false, desc: "Press Check in Step 2 to see whether the database holds a vault." };
    }
    if (r.status === "error") {
        return { enabled: false, desc: "The database check failed (see Step 2) — fix it and Check again." };
    }
    if (r.status === "created" || r.docCount === 0) {
        return { enabled: false, desc: "Database is empty — use Init to push your vault." };
    }
    return { enabled: true, desc: ready };
}

/** Sync is paused because another device turned vault encryption on or
 *  off — Step 1 has to be matched before Init / Clone. */
export function encryptionChangedElsewhere(rel: VaultRelation): boolean {
    return rel.pause?.error.reason === "encryption-changed";
}
