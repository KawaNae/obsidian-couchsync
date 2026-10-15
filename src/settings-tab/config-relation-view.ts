/**
 * config-relation-view.ts — the Config Sync tab's Step 3 status line, as a
 * pure function of this device's relation to the config DB.
 *
 * The line says what is in the way first, then what is known:
 *
 *   1. config sync disabled (no DB name applied)
 *   2. the local config store could not be opened (no binding)
 *   3. the server rejects the credentials (the auth latch) — nothing else
 *      can be checked until that is fixed
 *   4. a Create of this device did not finish
 *   5. a failure, judged against the attachment in place now — also when
 *      the device is not joined, so a Join that failed (a wrong passphrase,
 *      an unreachable server) says why. The last user operation and the
 *      last check are kept apart (see `ConfigBinding.record`); when both
 *      failed, the one that started later is shown
 *   6. not joined yet
 *   7. no failure, and an operation or check succeeded: ready
 *   8. joined, but nothing has run since the plugin loaded
 */
import type { ConfigOpName, ConfigOutcome, ConfigRelation } from "../sync/config-binding.ts";
import { configNotReady } from "../sync/config-errors.ts";
import { describeError } from "../ui/describe-error.ts";

export interface ConfigRelationViewInput {
    /** A config DB name is applied. */
    enabled: boolean;
    /** The binding's relation, or null when the local store could not be
     *  opened. Ignored when not `enabled`. */
    relation: ConfigRelation | null;
}

export interface ConfigRelationView {
    text: string;
    /** "ok": ready; "error": something is in the way; null: neutral. */
    tone: "ok" | "error" | null;
}

const OP_NAMES: Record<ConfigOpName, string> = {
    push: "Push",
    pull: "Pull",
    join: "Join",
    create: "Create",
    check: "check",
};

/**
 * @param authError the error the auth latch refuses requests with
 *   (`AuthGate.blockedError()`), or null when the latch is clear.
 */
export function configRelationView(
    input: ConfigRelationViewInput,
    authError: unknown | null,
): ConfigRelationView {
    if (!input.enabled) {
        return { text: "Apply a config database name in Step 2 first.", tone: null };
    }
    const rel = input.relation;
    if (!rel) {
        return {
            text: "The local config store could not be opened — see the log, then " +
                "Apply the database name again.",
            tone: "error",
        };
    }
    if (authError) return { text: describeError(authError).text, tone: "error" };
    if (rel.settingUp) {
        return { text: configNotReady("setup-interrupted", { db: rel.dbName }).message, tone: "error" };
    }
    const failed = [rel.lastOp, rel.lastCheck]
        .filter((o): o is ConfigOutcome => o !== null && o.error !== null)
        .sort((a, b) => b.at - a.at)[0];
    if (failed) {
        return {
            text: `Last ${OP_NAMES[failed.op]}: ${describeError(failed.error).text}`,
            tone: "error",
        };
    }
    if (!rel.attachment) {
        return { text: "Not joined yet. First device: Create. Other devices: Join.", tone: null };
    }
    if (rel.lastOp || rel.lastCheck) {
        return { text: `Joined "${rel.dbName}" — ready to Push and Pull.`, tone: "ok" };
    }
    return {
        text: `Joined "${rel.dbName}". The server has not been checked since Obsidian ` +
            "started; it is checked when this tab lists it and on every Push or Pull.",
        tone: null,
    };
}
