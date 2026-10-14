/**
 * The Push list: what a Push is about to send, item by item, and what the
 * user's selection makes of it. Pure — no I/O, no store, no settings.
 *
 * One item per difference between the disk and the base:
 *   - a key of a settings JSON file (its JSON Pointer)
 *   - a plugin enabled or disabled in community-plugins.json
 *   - a whole file (not merged key by key, not valid JSON, or new to the
 *     shared state)
 *
 * Every item starts selected, except the keys declared this device's own,
 * which start left out. Sending is what makes a value shared, so leaving an
 * item out is the declaration: a key or plugin left out is added to
 * `deviceOnlyKeys`, a whole file left out stops taking part in sharing on
 * this device (`overrides` false). Selecting a declared key sends it and
 * removes its declaration.
 */

import type { ConfigSyncPolicy } from "./config-policy/policy.ts";
import { classifyConfigPath } from "./config-policy/classify.ts";
import { changePointer, pointerCovers, valueAt, type JsonChange, type JsonValue } from "./config-merge.ts";
import type { PushPlanEntry } from "./config-reconcile.ts";

/** How an item differs from the shared version. */
export type PushItemChange =
    | "changed" //      a key with another value
    | "added" //        a key the shared version does not have
    | "removed" //      a key this device removed
    | "enabled" //      a plugin this device enabled (community-plugins.json)
    | "disabled" //     a plugin this device disabled
    | "file" //         the file differs as a whole
    | "new-file"; //    the shared state does not have the file

export interface PushItem {
    /** Unique within one Push. */
    id: string;
    path: string;
    /** JSON Pointer of the key (`/<plugin id>` for a plugin); null for a
     *  whole file. */
    pointer: string | null;
    change: PushItemChange;
    /** The shared value and this device's value, as JSON text, cut to
     *  `VALUE_TEXT_MAX`. Undefined where there is none (an added or removed
     *  key) and for plugins and whole files. */
    sharedText?: string;
    localText?: string;
    /** The values come from a plugin's data.json, which may hold API keys
     *  or tokens: the list shows them only on request. */
    hideValues: boolean;
    /** Declared this device's own before this Push: starts left out. */
    deviceOnly: boolean;
}

export interface PushReview {
    items: PushItem[];
    /** Files held back (not current here) — not in the list. */
    held: number;
}

export const VALUE_TEXT_MAX = 200;

function valueText(v: JsonValue | undefined): string | undefined {
    if (v === undefined) return undefined;
    const s = JSON.stringify(v);
    return s.length > VALUE_TEXT_MAX ? `${s.slice(0, VALUE_TEXT_MAX)}…` : s;
}

function declaredIn(policy: ConfigSyncPolicy, path: string): readonly string[] {
    return policy.deviceOnlyKeys[path] ?? [];
}

function itemId(path: string, pointer: string | null): string {
    return pointer === null ? path : `${path}#${pointer}`;
}

function keyChange(c: JsonChange): PushItemChange {
    switch (c.kind) {
        case "set-add": return "enabled";
        case "set-remove": return "disabled";
        case "remove": return "removed";
        case "set": return c.added ? "added" : "changed";
    }
}

/** The items of `entries` (the files about to be sent), in path order. */
export function buildPushReview(
    entries: readonly PushPlanEntry[],
    policy: ConfigSyncPolicy,
    held: number,
): PushReview {
    const items: PushItem[] = [];
    const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
    for (const e of sorted) {
        const hideValues = classifyConfigPath(e.path).unit === "community-settings";
        if (e.diff.kind !== "json") {
            items.push({
                id: itemId(e.path, null),
                path: e.path,
                pointer: null,
                change: e.diff.kind === "new" ? "new-file" : "file",
                hideValues,
                deviceOnly: false,
            });
            continue;
        }
        const declared = declaredIn(policy, e.path);
        for (const c of e.diff.changes) {
            const pointer = changePointer(c);
            const isSet = c.kind === "set-add" || c.kind === "set-remove";
            items.push({
                id: itemId(e.path, pointer),
                path: e.path,
                pointer,
                change: keyChange(c),
                ...(isSet ? {} : {
                    sharedText: valueText(valueAt(e.diff.base.value, pointer)),
                    localText: valueText(valueAt(e.diff.local.value, pointer)),
                }),
                hideValues,
                deviceOnly: declared.some((d) => pointerCovers(d, pointer)),
            });
        }
    }
    return { items, held };
}

/** Does `entry` have a change that is not declared this device's own? */
export function hasUndeclaredChange(entry: PushPlanEntry, policy: ConfigSyncPolicy): boolean {
    if (entry.diff.kind !== "json") return true;
    const declared = declaredIn(policy, entry.path);
    return entry.diff.changes.some(
        (c) => !declared.some((d) => pointerCovers(d, changePointer(c))),
    );
}

/** The ids a Push selects when the user changes nothing. */
export function defaultSelection(review: PushReview): string[] {
    return review.items.filter((i) => !i.deviceOnly).map((i) => i.id);
}

export interface PushSend {
    entry: PushPlanEntry;
    /** The selected changes ("all" for a whole file). */
    selected: readonly JsonChange[] | "all";
    /** This device's own keys of the file after the selection. */
    deviceOnly: readonly string[];
}

export interface AppliedSelection {
    sends: PushSend[];
    /** The policy with the declarations the selection made. */
    policy: ConfigSyncPolicy;
    /** Keys newly declared this device's own, and declarations removed,
     *  per file. Whole files left out are in `filesLeftOut`. */
    declared: Array<{ path: string; pointer: string }>;
    released: Array<{ path: string; pointer: string }>;
    filesLeftOut: string[];
}

/**
 * What the selection `selectedIds` over `entries` sends, and the policy it
 * leaves behind. Entries with nothing selected are not sent.
 */
export function applyPushSelection(
    entries: readonly PushPlanEntry[],
    policy: ConfigSyncPolicy,
    selectedIds: ReadonlySet<string>,
): AppliedSelection {
    const deviceOnlyKeys: Record<string, string[]> = { ...policy.deviceOnlyKeys };
    const overrides: Record<string, boolean> = { ...policy.overrides };
    const out: AppliedSelection = {
        sends: [], policy, declared: [], released: [], filesLeftOut: [],
    };

    for (const e of entries) {
        if (e.diff.kind !== "json") {
            if (selectedIds.has(itemId(e.path, null))) {
                out.sends.push({ entry: e, selected: "all", deviceOnly: [] });
                continue;
            }
            // The file was taking part, so its selection is on: turning it
            // off takes an override unless the unit is off by default.
            const unit = classifyConfigPath(e.path).unit;
            if (policy.unitDefaults[unit] === false) delete overrides[e.path];
            else overrides[e.path] = false;
            out.filesLeftOut.push(e.path);
            continue;
        }
        const old = declaredIn(policy, e.path);
        const pointers = e.diff.changes.map(changePointer);
        const isSelected = pointers.map((p) => selectedIds.has(itemId(e.path, p)));
        // A declaration covering a selected change is released; a change
        // left out that no remaining declaration covers is declared.
        const kept = old.filter((d) => !pointers.some((p, i) => isSelected[i] && pointerCovers(d, p)));
        for (const d of old) if (!kept.includes(d)) out.released.push({ path: e.path, pointer: d });
        const next = [...kept];
        pointers.forEach((p, i) => {
            if (isSelected[i] || next.some((d) => pointerCovers(d, p))) return;
            next.push(p);
            out.declared.push({ path: e.path, pointer: p });
        });
        if (next.length > 0) deviceOnlyKeys[e.path] = next;
        else delete deviceOnlyKeys[e.path];

        const selected = e.diff.changes.filter((_, i) => isSelected[i]);
        if (selected.length > 0) out.sends.push({ entry: e, selected, deviceOnly: next });
    }

    out.policy = { ...policy, deviceOnlyKeys, overrides };
    return out;
}
