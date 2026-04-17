/**
 * In-memory IVaultEvents for tests. Tests call `emit()` to fire
 * events directly, avoiding any Obsidian dependency.
 */

import type { IVaultEvents, VaultEventRef } from "../../src/types/vault-events.ts";
import type { FileStat } from "../../src/types/vault-io.ts";

type ModifyCreateCb = (path: string, stat: FileStat) => void;
type DeleteCb = (path: string) => void;
type RenameCb = (path: string, oldPath: string, stat: FileStat | undefined) => void;

interface Subscription {
    event: string;
    cb: Function;
}

let refCounter = 0;

export class FakeVaultEvents implements IVaultEvents {
    private subs = new Map<number, Subscription>();

    on(event: "modify", cb: ModifyCreateCb): VaultEventRef;
    on(event: "create", cb: ModifyCreateCb): VaultEventRef;
    on(event: "delete", cb: DeleteCb): VaultEventRef;
    on(event: "rename", cb: RenameCb): VaultEventRef;
    on(event: string, cb: Function): VaultEventRef {
        const id = ++refCounter;
        this.subs.set(id, { event, cb });
        return { _brand: "VaultEventRef", _id: id } as unknown as VaultEventRef;
    }

    offref(ref: VaultEventRef): void {
        const id = (ref as any)._id;
        this.subs.delete(id);
    }

    // ── test helpers ────────────────────────────────────

    emit(event: "modify" | "create", path: string, stat: FileStat): void;
    emit(event: "delete", path: string): void;
    emit(event: "rename", path: string, oldPath: string, stat?: FileStat): void;
    emit(event: string, ...args: any[]): void {
        for (const sub of this.subs.values()) {
            if (sub.event === event) {
                sub.cb(...args);
            }
        }
    }

    /** Number of active subscriptions (useful in lifecycle tests). */
    get subscriberCount(): number {
        return this.subs.size;
    }
}
