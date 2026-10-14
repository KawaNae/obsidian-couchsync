/**
 * reload-guard.ts — keeps an app reload away from the operations it would
 * break.
 *
 * Config sync and vault setup each serialize their own operations (the
 * config op lock, the vault setup lock). They share one hazard the two
 * locks cannot see: an operation that reloads Obsidian stops every other
 * running operation where it stands. That is harmless for most of them,
 * but not for an operation that destroys something before it rebuilds it:
 * stopped in between, it leaves the destroyed state behind (a vault DB
 * sent only in part, an emptied local DB, a config DB without its root)
 * until it is run again from the start.
 *
 * So every operation that may reload the app takes the role `reloads`,
 * and every operation that destroys before it rebuilds takes the role
 * `uninterruptible`. An operation is refused while one of the other role
 * runs. Two operations of the same role do not stop each other, and are
 * left to their own lock. Operations of neither role do not enter.
 *
 * A reload is not over when the operation that asked for it returns: the
 * host reloads a moment later. Until then the lease stays held
 * (`holdForReload`) and is never released; the reload ends the plugin,
 * and with it the guard.
 */
import { logWarn } from "../ui/log.ts";

export type ReloadRole = "reloads" | "uninterruptible";

export interface ReloadLease {
    /** The operation ended without a reload. */
    release(): void;
    /** The operation ended and the app is about to reload: keep refusing
     *  the other role until it does. */
    holdForReload(): void;
}

interface Entry {
    label: string;
    role: ReloadRole;
    reloading: boolean;
}

export class ReloadGuard {
    private readonly entries = new Set<Entry>();
    private readonly listeners = new Set<() => void>();

    /** Why an operation of `role` cannot start now, worded for the Notice,
     *  or null. */
    blocker(role: ReloadRole): string | null {
        for (const e of this.entries) {
            if (e.role === role) continue;
            return e.reloading
                ? `Obsidian is about to reload after ${e.label} — wait for it to restart.`
                : `${e.label} is running — wait for it to finish.`;
        }
        return null;
    }

    /** Take a lease for the operation `label` of `role`. The caller checks
     *  `blocker(role)` first and refuses on its own terms; entering while
     *  blocked is a bug. */
    enter(label: string, role: ReloadRole): ReloadLease {
        const blocked = this.blocker(role);
        if (blocked) throw new Error(`ReloadGuard: ${label} entered while blocked: ${blocked}`);
        const entry: Entry = { label, role, reloading: false };
        this.entries.add(entry);
        this.changed();
        let open = true;
        return {
            release: () => {
                if (!open) return;
                open = false;
                this.entries.delete(entry);
                this.changed();
            },
            holdForReload: () => {
                if (!open) return;
                open = false;
                entry.reloading = true;
                this.changed();
            },
        };
    }

    /** Subscribe to changes of `blocker`. Returns the unsubscribe
     *  function. */
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private changed(): void {
        for (const l of this.listeners) {
            try {
                l();
            } catch (e: any) {
                logWarn(`reload guard listener failed: ${e?.message ?? e}`);
            }
        }
    }
}
