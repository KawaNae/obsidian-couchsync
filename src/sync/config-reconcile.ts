/**
 * Per-path comparison of the three versions of a config file, and the Pull
 * and Push plans built from it.
 *
 *   - shared: the config DB doc — only what the server accepted (written by
 *     Pull's copy step and by a successful Push)
 *   - base:   lastSynced — the shared version the disk last took in
 *     (written by Pull's merge and by a successful Push)
 *   - local:  the disk
 *
 * A local change is the difference between the disk and the base; it is
 * computed on demand and stored nowhere. Planning reads the disk and the
 * store but writes neither: ConfigSync carries out a plan.
 */

import type { ChunkDoc, ConfigDoc } from "../types.ts";
import type { IVaultIO } from "../types/vault-io.ts";
import type { ConfigLocalDB } from "../db/config-local-db.ts";
import type {
    ConfigLastSynced,
    ConfigLastSyncedValue,
} from "../db/sync/config-last-synced.ts";
import { splitIntoChunks, joinChunks, MAX_CHUNK_BYTES_CONFIG, type ChunkHasher } from "../db/chunker.ts";
import { configPathFromId, makeConfigId } from "../types/doc-id.ts";
import { chunkListsEqual } from "./chunk-equality.ts";
import { compareVC } from "./vector-clock.ts";
import { classifyConfigPath, type ConfigUnit } from "./config-policy/classify.ts";
import { unsafeVaultPathReason } from "../utils/path.ts";
import { logDebug, logWarn } from "../ui/log.ts";
import {
    applyJsonChanges,
    detectJsonFormat,
    diffJson,
    jsonEqual,
    mergeJson,
    orderLike,
    parseJsonBytes,
    pinPointers,
    pointerCovers,
    pointerTokens,
    sameAtPointer,
    serializeJson,
    valueAt,
    type JsonChange,
    type JsonValue,
    type NoBaseRule,
    type ParsedJson,
} from "./config-merge.ts";

// ── What is merged key by key ────────────────────────────

/** Units whose `.json` files hold settings, merged key by key. Plugin
 *  code and metadata, themes and snippets are compared as whole files. */
const KEYED_UNITS: ReadonlySet<ConfigUnit> = new Set<ConfigUnit>([
    "app-behavior",
    "core-settings",
    "enabled-list",
    "community-settings",
]);

/** The enabled community plugins: a list of unique ids, merged as a set. */
const SET_FILE = ".obsidian/community-plugins.json";

export function isKeyedJsonPath(path: string): boolean {
    return path.endsWith(".json") && KEYED_UNITS.has(classifyConfigPath(path).unit);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

const encoder = new TextEncoder();

/** Same shared version: equal vclocks and equal content. */
export function sameVersion(
    a: { vclock: ConfigDoc["vclock"]; chunks: readonly string[] },
    b: { vclock: ConfigDoc["vclock"]; chunks: readonly string[] },
): boolean {
    return compareVC(a.vclock ?? {}, b.vclock ?? {}) === "equal" && chunkListsEqual(a.chunks, b.chunks);
}

// ── Pull decision ────────────────────────────────────────

/** Positions of one file that a Pull fixes, as JSON Pointers. */
export interface PullPins {
    /** Declared this device's own: keep the disk's value (or stay
     *  absent). */
    deviceOnly?: readonly string[];
    /** Taken from the shared version (or removed when it has none),
     *  even where the disk changed them: the user chose to take the
     *  shared value. Wins over `deviceOnly` at the positions it covers. */
    takeShared?: readonly string[];
}

export interface PullDecision {
    /** Bytes to write to the disk, or null to leave the disk as it is. */
    write: Uint8Array | null;
    /** JSON Pointers where both sides changed and the local value was
     *  kept. "" is the whole file (compared as a file). */
    conflicts: string[];
    /** This device's own keys whose shared value changed and was not
     *  taken in. */
    deviceOnlyKept: number;
}

/**
 * Decide what the disk becomes after taking in `shared`.
 *
 * `base` is null when no base is at hand; `noBase` then decides. A missing
 * local file takes the shared content: deleting a config file is not a
 * change that is shared.
 *
 * `pins` fix positions of a settings JSON file whatever the merge says;
 * neither kind is reported as a conflict.
 */
export function decidePull(
    path: string,
    base: Uint8Array | null,
    local: Uint8Array | null,
    shared: Uint8Array,
    noBase: NoBaseRule,
    pins: PullPins = {},
): PullDecision {
    if (!local) return { write: shared, conflicts: [], deviceOnlyKept: 0 };
    if (bytesEqual(local, shared)) return { write: null, conflicts: [], deviceOnlyKept: 0 };

    if (isKeyedJsonPath(path)) {
        const l = parseJsonBytes(local);
        const r = parseJsonBytes(shared);
        const b = base ? parseJsonBytes(base) : undefined;
        if (l && r && b !== null) {
            const set = path === SET_FILE;
            const taken = pins.takeShared ?? [];
            const kept = (pins.deviceOnly ?? []).filter((d) => !taken.some((t) => pointerCovers(t, d)));
            const merged = mergeJson(b?.value, l.value, r.value, { set, noBase });
            // Declared keys the shared version changed to a value the disk
            // does not have.
            const deviceOnlyKept = kept.filter((p) =>
                !sameAtPointer(r.value, l.value, p, { set })
                && (!b || !sameAtPointer(r.value, b.value, p, { set }))).length;
            const pinned = pinPointers(
                pinPointers(merged.value, l.value, kept, { set }), r.value, taken, { set },
            );
            const value = orderLike(pinned, l.value);
            const conflicts = merged.conflicts.filter(
                (c) => ![...kept, ...taken].some((d) => pointerCovers(d, c)),
            );
            if (jsonEqual(value, l.value)) return { write: null, conflicts, deviceOnlyKept };
            return {
                write: encoder.encode(serializeJson(value, detectJsonFormat(l.text))),
                conflicts,
                deviceOnlyKept,
            };
        }
        // One of the versions is not JSON: compared as a file below.
    }

    const file = (write: Uint8Array | null, conflict: boolean): PullDecision =>
        ({ write, conflicts: conflict ? [""] : [], deviceOnlyKept: 0 });
    if (base) {
        if (bytesEqual(local, base)) return file(shared, false);
        if (bytesEqual(shared, base)) return file(null, false);
        return file(null, true);
    }
    return noBase === "local-first" ? file(null, true) : file(shared, false);
}

// ── Push difference ──────────────────────────────────────

/** What the disk changed against the base.
 *   - new:  no base — the whole file is new to the shared state
 *   - file: the file differs (compared as a file)
 *   - json: the keys that differ */
export type PushDiff =
    | { kind: "new" }
    | { kind: "file" }
    | { kind: "json"; changes: JsonChange[]; base: ParsedJson; local: ParsedJson };

/** The disk's change against `base`, or null when there is none. */
export function diffForPush(path: string, base: Uint8Array | null, local: Uint8Array): PushDiff | null {
    if (!base) return { kind: "new" };
    if (bytesEqual(base, local)) return null;
    if (isKeyedJsonPath(path)) {
        const b = parseJsonBytes(base);
        const l = parseJsonBytes(local);
        if (b && l) {
            const changes = diffJson(b.value, l.value, { set: path === SET_FILE });
            return changes.length === 0 ? null : { kind: "json", changes, base: b, local: l };
        }
    }
    return { kind: "file" };
}

/**
 * Content to send: the base with the `selected` changes applied, written in
 * the disk's format. Positions in `deviceOnly` (this device's own keys)
 * keep the base's value even where a selected change covers them, so they
 * never reach the shared state. With every change selected (or a
 * whole-file diff) and nothing held back, that is the disk itself, sent
 * byte for byte.
 */
export function pushContent(
    path: string,
    diff: PushDiff,
    local: Uint8Array,
    selected: readonly JsonChange[] | "all" = "all",
    deviceOnly: readonly string[] = [],
): Uint8Array {
    if (diff.kind !== "json") return local;
    const changes = selected === "all" ? diff.changes : selected;
    if (changes.length === diff.changes.length && deviceOnly.length === 0) return local;
    const set = path === SET_FILE;
    const applied = pinPointers(applyJsonChanges(diff.base.value, changes), diff.base.value, deviceOnly, { set });
    if (jsonEqual(applied, diff.local.value)) return local;
    const value = orderLike(applied, diff.local.value);
    return encoder.encode(serializeJson(value, detectJsonFormat(diff.local.text)));
}

// ── Planning over the store and the disk ─────────────────

export interface ReconcileDeps {
    vault: IVaultIO;
    store: ConfigLocalDB;
    lastSynced: ConfigLastSynced;
    /** Chunk hasher of the op (the key space the config DB uses). */
    hasher: ChunkHasher;
    maxSize: number;
    /** Does `path` take part in sharing on this device? Push sends and
     *  Pull writes only such paths; the others are this device's own. */
    participates: (path: string) => boolean;
    /** Fetch chunks of `doc` the store lacks. */
    fetchChunks?: (doc: ConfigDoc) => Promise<void>;
    /** Paths whose missing base is settled keeping the local value. */
    localFirst: ReadonlySet<string>;
    /** JSON Pointers declared this device's own in `path`: not sent, not
     *  taken in. Omitted: none. */
    deviceOnly?: (path: string) => readonly string[];
    /** JSON Pointers of `path` whose shared value a Pull writes, even where
     *  the disk changed them (`PullPins.takeShared`). Omitted: none. */
    takeShared?: (path: string) => readonly string[];
}

export interface PullPlanEntry {
    path: string;
    shared: ConfigDoc;
    /** The disk before the Pull (null: no file). */
    local: Uint8Array | null;
    decision: PullDecision;
}

/** A file the Pull deletes, with its content before the Pull. */
export interface PullPlanDelete {
    path: string;
    local: Uint8Array;
}

export interface PullPlan {
    entries: PullPlanEntry[];
    /** Files to delete. Only an overwriting Pull deletes: a merging Pull
     *  never removes a file. */
    deletes: PullPlanDelete[];
    /** Paths left alone because their content (shared or on disk) is not
     *  available or too large. */
    unavailable: string[];
}

/** Bytes of `chunkIds` from the store, or null when any is missing. */
async function readChunks(store: ConfigLocalDB, chunkIds: readonly string[]): Promise<Uint8Array | null> {
    const got = await store.getChunks([...chunkIds]);
    const byId = new Map<string, ChunkDoc>();
    for (const c of got) if (c.content instanceof Uint8Array) byId.set(c._id, c);
    const ordered: ChunkDoc[] = [];
    for (const id of chunkIds) {
        const c = byId.get(id);
        if (!c) return null;
        ordered.push(c);
    }
    return new Uint8Array(joinChunks(ordered));
}

async function readDisk(vault: IVaultIO, path: string, maxSize: number): Promise<Uint8Array | null | "too-large"> {
    const stat = await vault.stat(path);
    if (!stat) return null;
    if (stat.size > maxSize) return "too-large";
    return new Uint8Array(await vault.readBinary(path));
}

/** The base bytes of `path`, or null when there is no usable base. */
async function readBase(deps: ReconcileDeps, path: string): Promise<{ value: ConfigLastSyncedValue; bytes: Uint8Array } | null> {
    const value = deps.lastSynced.get(path);
    if (!value) return null;
    const bytes = await readChunks(deps.store, value.chunks);
    if (!bytes) {
        logDebug(`config base of ${path} has missing chunks; compared without a base`);
        return null;
    }
    return { value, bytes };
}

/** The live shared docs that take part in sharing here. Unsafe remote
 *  paths are rejected. */
async function participatingSharedDocs(deps: ReconcileDeps): Promise<ConfigDoc[]> {
    const docs = (await deps.store.allConfigDocs()).filter((d) => !d.deleted);
    const out: ConfigDoc[] = [];
    for (const doc of docs) {
        const path = configPathFromId(doc._id);
        const violation = unsafeVaultPathReason(path);
        if (violation) {
            logWarn(`rejecting unsafe remote config path "${path}" — ${violation}`);
            continue;
        }
        if (deps.participates(path)) out.push(doc);
    }
    return out;
}

/** The shared content of `shared` and the disk of its path, or null when
 *  either is not available (logged). */
async function readSharedAndDisk(
    deps: ReconcileDeps,
    path: string,
    shared: ConfigDoc,
): Promise<{ sharedBytes: Uint8Array; local: Uint8Array | null } | null> {
    if (shared.size > deps.maxSize) {
        logWarn(`Skipping config ${path} — ${shared.size} bytes exceeds the config size limit`);
        return null;
    }
    let sharedBytes = await readChunks(deps.store, shared.chunks);
    if (!sharedBytes && deps.fetchChunks) {
        await deps.fetchChunks(shared);
        sharedBytes = await readChunks(deps.store, shared.chunks);
    }
    if (!sharedBytes) {
        logWarn(`Skipping config ${path} — its content is not available locally (missing chunks)`);
        return null;
    }
    const local = await readDisk(deps.vault, path, deps.maxSize);
    if (local === "too-large") {
        logWarn(`Skipping config ${path} — the file on disk exceeds the config size limit`);
        return null;
    }
    return { sharedBytes, local };
}

/**
 * Plan a Pull: for every shared doc that takes part in sharing here and
 * whose version the disk has not taken in yet, decide what the disk
 * becomes. Paths whose base already is the shared version are not read,
 * unless some of their positions take the shared value (`takeShared`):
 * the disk may differ there from a base that is current.
 */
export async function planPull(
    deps: ReconcileDeps,
    onProgress?: (path: string, index: number, total: number) => void,
): Promise<PullPlan> {
    await deps.lastSynced.ensureLoaded();
    const candidates = (await participatingSharedDocs(deps)).filter((doc) => {
        const path = configPathFromId(doc._id);
        if ((deps.takeShared?.(path) ?? []).length > 0) return true;
        const base = deps.lastSynced.get(path);
        return !(base && sameVersion(base, doc));
    });

    const entries: PullPlanEntry[] = [];
    const unavailable: string[] = [];
    for (let i = 0; i < candidates.length; i++) {
        const shared = candidates[i];
        const path = configPathFromId(shared._id);
        onProgress?.(path, i + 1, candidates.length);
        try {
            const got = await readSharedAndDisk(deps, path, shared);
            if (!got) {
                unavailable.push(path);
                continue;
            }
            const base = await readBase(deps, path);
            const noBase: NoBaseRule = deps.localFirst.has(path) ? "local-first" : "remote-first";
            entries.push({
                path, shared, local: got.local,
                decision: decidePull(path, base?.bytes ?? null, got.local, got.sharedBytes, noBase, {
                    deviceOnly: deps.deviceOnly?.(path) ?? [],
                    takeShared: deps.takeShared?.(path) ?? [],
                }),
            });
        } catch (e: any) {
            logWarn(`Failed to compare config ${path}: ${e?.message ?? e}`);
            unavailable.push(path);
        }
    }
    return { entries, deletes: [], unavailable };
}

/**
 * Plan an overwriting Pull: make the disk the shared state. Every shared
 * doc that takes part in sharing here is written as it is where the disk
 * differs: no merge, no base, and this device's own keys are not kept.
 * Every file of `deletable` that takes part in sharing here and that the
 * shared state does not have is deleted.
 *
 * A path whose shared content is not available is left alone, and never
 * deleted: the shared state has it. Files that do not take part in sharing
 * here are neither written nor deleted.
 */
export async function planOverwrite(
    deps: ReconcileDeps,
    deletable: readonly string[],
    onProgress?: (path: string, index: number, total: number) => void,
): Promise<PullPlan> {
    const docs = await participatingSharedDocs(deps);
    const sharedPaths = new Set(docs.map((d) => configPathFromId(d._id)));
    const extra = deletable.filter((p) => deps.participates(p) && !sharedPaths.has(p));
    const total = docs.length + extra.length;

    const entries: PullPlanEntry[] = [];
    const unavailable: string[] = [];
    for (let i = 0; i < docs.length; i++) {
        const shared = docs[i];
        const path = configPathFromId(shared._id);
        onProgress?.(path, i + 1, total);
        try {
            const got = await readSharedAndDisk(deps, path, shared);
            if (!got) {
                unavailable.push(path);
                continue;
            }
            const same = got.local !== null && bytesEqual(got.local, got.sharedBytes);
            entries.push({
                path, shared, local: got.local,
                decision: { write: same ? null : got.sharedBytes, conflicts: [], deviceOnlyKept: 0 },
            });
        } catch (e: any) {
            logWarn(`Failed to compare config ${path}: ${e?.message ?? e}`);
            unavailable.push(path);
        }
    }

    const deletes: PullPlanDelete[] = [];
    for (let i = 0; i < extra.length; i++) {
        const path = extra[i];
        onProgress?.(path, docs.length + i + 1, total);
        try {
            const local = await readDisk(deps.vault, path, deps.maxSize);
            if (local === "too-large") {
                logWarn(`Skipping config ${path} — the file on disk exceeds the config size limit`);
                unavailable.push(path);
                continue;
            }
            if (local) deletes.push({ path, local });
        } catch (e: any) {
            logWarn(`Failed to read config ${path}: ${e?.message ?? e}`);
            unavailable.push(path);
        }
    }
    return { entries, deletes, unavailable };
}

/** The shared value at one position, as the config DB has it now. */
export type SharedAtPointer =
    | { kind: "value"; value: JsonValue }
    /** The shared version has the file but not the key (for
     *  community-plugins.json: the plugin is not enabled). */
    | { kind: "absent" }
    /** community-plugins.json: the plugin is enabled. */
    | { kind: "member" }
    /** The shared state has no such file. */
    | { kind: "no-file" }
    /** The content is not here yet (chunks missing) or is not JSON. */
    | { kind: "unknown" };

/** The shared value of `pointer` in `path` from the config DB, without
 *  fetching anything: what is known before a Pull takes in the server. */
export async function readSharedAt(store: ConfigLocalDB, path: string, pointer: string): Promise<SharedAtPointer> {
    const doc = await store.get(makeConfigId(path));
    if (!doc || doc.deleted) return { kind: "no-file" };
    const bytes = await readChunks(store, doc.chunks);
    const parsed = bytes ? parseJsonBytes(bytes) : null;
    if (!parsed) return { kind: "unknown" };
    if (path === SET_FILE) {
        const tokens = pointerTokens(pointer);
        if (tokens.length !== 1 || !Array.isArray(parsed.value)) return { kind: "unknown" };
        return parsed.value.includes(tokens[0]) ? { kind: "member" } : { kind: "absent" };
    }
    const value = valueAt(parsed.value, pointer);
    return value === undefined ? { kind: "absent" } : { kind: "value", value };
}

export interface PushPlanEntry {
    path: string;
    diff: PushDiff;
    /** The disk content and its chunks. */
    local: Uint8Array;
    chunks: ChunkDoc[];
    size: number;
    mtime: number;
    /** The base the change was computed against (null: none usable). */
    base: ConfigLastSyncedValue | null;
}

/**
 * Plan a Push: every file that takes part in sharing here whose disk
 * content differs from its base. Files whose chunks equal the base are not
 * parsed. A file missing on disk is not a change (deletions are not
 * shared).
 */
export async function planPush(
    deps: ReconcileDeps,
    files: readonly string[],
    onProgress?: (path: string, index: number, total: number) => void,
): Promise<PushPlanEntry[]> {
    await deps.lastSynced.ensureLoaded();
    const out: PushPlanEntry[] = [];
    for (let i = 0; i < files.length; i++) {
        const path = files[i];
        if (!deps.participates(path)) continue;
        onProgress?.(path, i + 1, files.length);
        try {
            const stat = await deps.vault.stat(path);
            if (!stat || stat.size > deps.maxSize) continue;
            const local = new Uint8Array(await deps.vault.readBinary(path));
            const chunks = await splitIntoChunks(
                local.buffer.slice(local.byteOffset, local.byteOffset + local.byteLength) as ArrayBuffer,
                { hasher: deps.hasher, chunkBytes: MAX_CHUNK_BYTES_CONFIG },
            );
            const cached = deps.lastSynced.get(path);
            if (cached && cached.size === local.byteLength
                && chunkListsEqual(cached.chunks, chunks.map((c) => c._id))) {
                continue;
            }
            const base = await readBase(deps, path);
            const diff = diffForPush(path, base?.bytes ?? null, local);
            if (!diff) continue;
            out.push({
                path, diff, local, chunks,
                size: local.byteLength, mtime: stat.mtime,
                base: base?.value ?? null,
            });
        } catch (e: any) {
            logWarn(`Failed to compare config ${path}: ${e?.message ?? e}`);
        }
    }
    return out;
}
