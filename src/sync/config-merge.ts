/**
 * JSON three-way merge, diff and patch for config files. Pure functions —
 * no I/O, no store.
 *
 * The three versions of a config file:
 *   - base:   the shared version the disk last took in (lastSynced)
 *   - local:  the disk
 *   - remote: the shared version now in the config DB
 *
 * Objects are walked key by key; a key is addressed by its JSON Pointer
 * (`/editor/tabSize`). Arrays are one value, except where the caller asks
 * for set semantics (`community-plugins.json`: a list of unique plugin
 * ids whose order carries no meaning). Comparison is by content: key order
 * and whitespace are not changes.
 */

export type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

/** Marks a key that is absent in one version. */
const MISSING: unique symbol = Symbol("missing");
type Slot = JsonValue | typeof MISSING;

/**
 * How a key that differs is settled when there is no base:
 *   - "remote-first": the remote value wins; keys only local has are kept.
 *     No conflict is reported (the base is unknown, so a difference is not
 *     evidence that both sides changed it).
 *   - "local-first": the local value wins and the key is reported as a
 *     conflict; keys only one side has are kept.
 */
export type NoBaseRule = "remote-first" | "local-first";

export interface MergeOptions {
    /** Treat a root array of unique strings as a set. */
    set?: boolean;
    /** Rule when `base` is undefined. Ignored when a base is given. */
    noBase?: NoBaseRule;
}

export interface MergeResult {
    value: JsonValue;
    /** JSON Pointers of keys both sides changed to different values. The
     *  local value is kept at each. */
    conflicts: string[];
}

// ── Equality ─────────────────────────────────────────────

function isObject(v: Slot): v is JsonObject {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Content equality: object key order is ignored, array order is not. */
export function jsonEqual(a: Slot, b: Slot): boolean {
    if (a === b) return true;
    if (a === MISSING || b === MISSING) return false;
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!jsonEqual(a[i], b[i])) return false;
        }
        return true;
    }
    if (isObject(a)) {
        if (!isObject(b)) return false;
        const ka = Object.keys(a);
        if (ka.length !== Object.keys(b).length) return false;
        for (const k of ka) {
            if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
            if (!jsonEqual(a[k], b[k])) return false;
        }
        return true;
    }
    return false;
}

// ── Pointers ─────────────────────────────────────────────

function escapeToken(key: string): string {
    return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapeToken(token: string): string {
    return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function childPointer(parent: string, key: string): string {
    return `${parent}/${escapeToken(key)}`;
}

function pointerTokens(pointer: string): string[] {
    if (pointer === "") return [];
    return pointer.slice(1).split("/").map(unescapeToken);
}

/** Keys of `first` in its order, then keys only `second` has, in its order. */
function orderedKeys(first: Slot, second: Slot, third: Slot = MISSING): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const sources: Slot[] = [first, second, third];
    for (const src of sources) {
        if (!isObject(src)) continue;
        for (const k of Object.keys(src)) {
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(k);
        }
    }
    return out;
}

function slotOf(obj: Slot, key: string): Slot {
    if (!isObject(obj)) return MISSING;
    return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : MISSING;
}

// ── Sets ─────────────────────────────────────────────────

function isStringSet(v: Slot | undefined): v is string[] {
    if (!Array.isArray(v)) return false;
    const seen = new Set<string>();
    for (const e of v) {
        if (typeof e !== "string" || seen.has(e)) return false;
        seen.add(e);
    }
    return true;
}

/** Order the members of `members` like `local`, then like `remote`. */
function orderSet(members: Set<string>, local: string[], remote: string[]): string[] {
    const out: string[] = [];
    for (const e of local) if (members.has(e)) out.push(e);
    for (const e of remote) if (members.has(e) && !local.includes(e)) out.push(e);
    return out;
}

function mergeSet(base: string[] | undefined, local: string[], remote: string[]): string[] {
    const result = new Set(remote);
    if (base) {
        for (const e of base) if (!local.includes(e)) result.delete(e);
        for (const e of local) if (!base.includes(e)) result.add(e);
    } else {
        for (const e of local) result.add(e);
    }
    return orderSet(result, local, remote);
}

// ── Merge ────────────────────────────────────────────────

function merge3(base: Slot, local: Slot, remote: Slot, ptr: string, conflicts: string[]): Slot {
    if (jsonEqual(local, remote)) return local;
    if (jsonEqual(base, local)) return remote;
    if (jsonEqual(base, remote)) return local;
    // Both sides changed this position, to different values.
    if (isObject(local) && isObject(remote)) {
        const out: JsonObject = {};
        const b = isObject(base) ? base : MISSING;
        for (const k of orderedKeys(local, remote)) {
            const v = merge3(slotOf(b, k), slotOf(local, k), slotOf(remote, k), childPointer(ptr, k), conflicts);
            if (v !== MISSING) out[k] = v;
        }
        return out;
    }
    conflicts.push(ptr);
    return local;
}

function merge2(local: Slot, remote: Slot, rule: NoBaseRule, ptr: string, conflicts: string[]): Slot {
    if (local === MISSING) return remote;
    if (remote === MISSING) return local;
    if (jsonEqual(local, remote)) return local;
    if (isObject(local) && isObject(remote)) {
        const out: JsonObject = {};
        for (const k of orderedKeys(local, remote)) {
            const v = merge2(slotOf(local, k), slotOf(remote, k), rule, childPointer(ptr, k), conflicts);
            if (v !== MISSING) out[k] = v;
        }
        return out;
    }
    if (rule === "local-first") {
        conflicts.push(ptr);
        return local;
    }
    return remote;
}

/**
 * Merge `local` and `remote` against `base`.
 *
 * With a base: a key only remote changed takes the remote value, a key
 * only local changed keeps the local value, a key both changed to the same
 * value is agreed, and a key both changed differently keeps the local value
 * and is reported in `conflicts`. Without a base, `opts.noBase` decides.
 *
 * The result keeps the local key order; keys remote added follow.
 */
export function mergeJson(
    base: JsonValue | undefined,
    local: JsonValue,
    remote: JsonValue,
    opts: MergeOptions = {},
): MergeResult {
    const conflicts: string[] = [];
    if (opts.set && isStringSet(local) && isStringSet(remote)
        && (base === undefined || isStringSet(base))) {
        return { value: mergeSet(base as string[] | undefined, local, remote), conflicts };
    }
    const value = base === undefined
        ? merge2(local, remote, opts.noBase ?? "remote-first", "", conflicts)
        : merge3(base, local, remote, "", conflicts);
    // merge3 takes a whole remote subtree where only remote changed it; the
    // order is set here so it does not depend on which side changed.
    return { value: orderLike(value as JsonValue, local), conflicts };
}

// ── Diff and patch ───────────────────────────────────────

/** One change from base to local. `added` marks a key the base did not
 *  have (a default a plugin wrote is typically one). */
export type JsonChange =
    | { kind: "set"; pointer: string; value: JsonValue; added: boolean }
    | { kind: "remove"; pointer: string }
    | { kind: "set-add"; element: string }
    | { kind: "set-remove"; element: string };

/** Changes that turn `base` into `local`, key by key. */
export function diffJson(base: JsonValue, local: JsonValue, opts: { set?: boolean } = {}): JsonChange[] {
    if (opts.set && isStringSet(base) && isStringSet(local)) {
        const out: JsonChange[] = [];
        for (const e of local) if (!base.includes(e)) out.push({ kind: "set-add", element: e });
        for (const e of base) if (!local.includes(e)) out.push({ kind: "set-remove", element: e });
        return out;
    }
    const out: JsonChange[] = [];
    diffInto(base, local, "", out);
    return out;
}

function diffInto(base: Slot, local: Slot, ptr: string, out: JsonChange[]): void {
    if (jsonEqual(base, local)) return;
    if (local === MISSING) {
        out.push({ kind: "remove", pointer: ptr });
        return;
    }
    if (isObject(base) && isObject(local)) {
        for (const k of orderedKeys(local, base)) {
            diffInto(slotOf(base, k), slotOf(local, k), childPointer(ptr, k), out);
        }
        return;
    }
    out.push({ kind: "set", pointer: ptr, value: local, added: base === MISSING });
}

function clone(v: JsonValue): JsonValue {
    return JSON.parse(JSON.stringify(v)) as JsonValue;
}

/** Apply `changes` to a copy of `base`. Missing parent objects are created. */
export function applyJsonChanges(base: JsonValue, changes: readonly JsonChange[]): JsonValue {
    let root = clone(base);
    for (const c of changes) {
        if (c.kind === "set-add" || c.kind === "set-remove") {
            const arr = Array.isArray(root) ? (root as JsonValue[]) : [];
            if (c.kind === "set-add") {
                if (!arr.includes(c.element)) arr.push(c.element);
            } else {
                const i = arr.indexOf(c.element);
                if (i >= 0) arr.splice(i, 1);
            }
            root = arr;
            continue;
        }
        const tokens = pointerTokens(c.pointer);
        if (tokens.length === 0) {
            if (c.kind === "set") root = clone(c.value);
            continue;
        }
        if (!isObject(root)) root = {};
        let parent = root as JsonObject;
        for (const t of tokens.slice(0, -1)) {
            if (!isObject(parent[t] ?? MISSING)) parent[t] = {};
            parent = parent[t] as JsonObject;
        }
        const last = tokens[tokens.length - 1];
        if (c.kind === "set") parent[last] = clone(c.value);
        else delete parent[last];
    }
    return root;
}

/** Reorder object keys in `value` to follow `reference` where both have
 *  them; keys only `value` has follow in their own order. */
export function orderLike(value: JsonValue, reference: JsonValue | undefined): JsonValue {
    if (!isObject(value)) return value;
    const ref = reference !== undefined && isObject(reference) ? reference : undefined;
    const out: JsonObject = {};
    const keys = ref
        ? [...Object.keys(ref).filter((k) => k in value), ...Object.keys(value).filter((k) => !(k in ref))]
        : Object.keys(value);
    for (const k of keys) out[k] = orderLike(value[k], ref ? ref[k] : undefined);
    return out;
}

// ── Text ─────────────────────────────────────────────────

export interface ParsedJson {
    value: JsonValue;
    text: string;
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Parse UTF-8 JSON bytes, or null when they are not JSON. */
export function parseJsonBytes(bytes: Uint8Array): ParsedJson | null {
    try {
        const text = STRICT_UTF8.decode(bytes);
        return { value: JSON.parse(text) as JsonValue, text };
    } catch {
        return null;
    }
}

export interface JsonFormat {
    /** One indent step; "" means a single line. */
    indent: string;
    eol: "\n" | "\r\n";
    finalNewline: boolean;
}

/** The indent, line ending and trailing newline `text` was written with. */
export function detectJsonFormat(text: string): JsonFormat {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const m = /\n([ \t]+)\S/.exec(text);
    return {
        indent: m ? m[1] : "",
        eol,
        finalNewline: /\n$/.test(text),
    };
}

export function serializeJson(value: JsonValue, fmt: JsonFormat): string {
    let s = fmt.indent ? JSON.stringify(value, null, fmt.indent) : JSON.stringify(value);
    if (fmt.eol === "\r\n") s = s.replace(/\n/g, "\r\n");
    if (fmt.finalNewline) s += fmt.eol;
    return s;
}
