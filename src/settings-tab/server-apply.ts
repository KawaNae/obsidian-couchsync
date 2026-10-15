/**
 * server-apply.ts — the ordering of the CouchDB tab's Apply against the
 * config binding. Kept out of `status-tab.ts` (which is UI) so the ordering
 * is testable with a real `ConfigSync`.
 *
 * The config binding is keyed by (server, config DB). A server change must
 * switch it, and the settings must change together with it — never before
 * (invariant on `ConfigSync.rebind`). So the settings are saved INSIDE the
 * switch (`commit`), and a switch refused because a config op is running
 * saves nothing.
 */
import { BusyError } from "../ui/describe-error.ts";

/** What the CouchDB tab needs from config sync (ConfigSync, via index.ts). */
export interface ConfigServerSwitch {
    /** Why the server cannot be changed now (a config op is running), or
     *  null. Same check as the Config Sync tab's Apply. */
    changeBlocker(): string | null;
    /** Switch the config binding to `serverUri` and run `commit` (which
     *  saves the settings) inside the switch, so settings and binding
     *  change together. Throws `BusyError` WITHOUT running `commit` when
     *  an op is running (`ConfigSync.rebind`). */
    switchServer(serverUri: string, commit: () => Promise<void>): Promise<void>;
}

export type ServerApplyResult =
    /** Settings saved; the config binding (if any) follows them. */
    | { kind: "saved" }
    /** Settings saved, but the new server's config store failed to open:
     *  config sync is unbound (its next op reports it). */
    | { kind: "saved-config-unbound"; error: unknown }
    /** A config op is running: NOTHING was saved. `error` says what runs. */
    | { kind: "refused"; error: BusyError };

/**
 * Save the CouchDB tab's settings (`save`). When the server URI changes and
 * config sync is wired, the save runs inside the config binding switch.
 */
export async function applyServerSettings(opts: {
    configBinding?: ConfigServerSwitch;
    oldUri: string;
    newUri: string;
    save: () => Promise<void>;
}): Promise<ServerApplyResult> {
    const cfg = opts.configBinding;
    if (!cfg || opts.newUri === opts.oldUri) {
        await opts.save();
        return { kind: "saved" };
    }
    let saving = false;
    let committed = false;
    try {
        await cfg.switchServer(opts.newUri, async () => {
            saving = true;
            await opts.save();
            committed = true;
        });
        return { kind: "saved" };
    } catch (e) {
        // Refused only when the switch itself refused: a save that throws
        // runs after the binding was switched.
        if (e instanceof BusyError && !saving) return { kind: "refused", error: e };
        if (committed) return { kind: "saved-config-unbound", error: e };
        throw e;
    }
}
