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
import { configPathFromId } from "../types/doc-id.ts";
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
    serializeJson,
    type JsonChange,
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

export interface PullDecision {
    /** Bytes to write to the disk, or null to leave the disk as it is. */
    write: Uint8Array | null;
    /** JSON Pointers where both sides changed and the local value was
     *  kept. "" is the whole file (compared as a file). */
    conflicts: string[];
}

/**
 * Decide what the disk becomes after taking in `shared`.
 *
 * `base` is null when no base is at hand; `noBase` then decides. A missing
 * local file takes the shared content: deleting a config file is not a
 * change that is shared.
 */
export function decidePull(
    path: string,
    base: Uint8Array | null,
    local: Uint8Array | null,
    shared: Uint8Array,
    noBase: NoBaseRule,
): PullDecision {
    if (!local) return { write: shared, conflicts: [] };
    if (bytesEqual(local, shared)) return { write: null, conflicts: [] };

    if (isKeyedJsonPath(path)) {
        const l = parseJsonBytes(local);
        const r = parseJsonBytes(shared);
        const b = base ? parseJsonBytes(base) : undefined;
        if (l && r && b !== null) {
            const { value, conflicts } = mergeJson(b?.value, l.value, r.value, {
                set: path === SET_FILE, noBase,
            });
            if (jsonEqual(value, l.value)) return { write: null, conflicts };
            return {
                write: encoder.encode(serializeJson(value, detectJsonFormat(l.text))),
                conflicts,
            };
        }
        // One of the versions is not JSON: compared as a file below.
    }

    if (base) {
        if (bytesEqual(local, base)) return { write: shared, conflicts: [] };
        if (bytesEqual(shared, base)) return { write: null, conflicts: [] };
        return { write: null, conflicts: [""] };
    }
    return noBase === "local-first"
        ? { write: null, conflicts: [""] }
        : { write: shared, conflicts: [] };
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
 * the disk's format. With every change selected (or a whole-file diff) that
 * is the disk itself, sent byte for byte.
 */
export function pushContent(
    diff: PushDiff,
    local: Uint8Array,
    selected?: readonly JsonChange[],
): Uint8Array {
    if (diff.kind !== "json" || !selected || selected.length === diff.changes.length) return local;
    const value = orderLike(applyJsonChanges(diff.base.value, selected), diff.local.value);
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
    /** Physically excluded paths (own data.json, backups, layout files). */
    isExcluded: (path: string) => boolean;
    /** Policy SEND projection. */
    sends: (path: string) => boolean;
    /** Policy RECEIVE projection. */
    receives: (path: string) => boolean;
    /** Fetch chunks of `doc` the store lacks. */
    fetchChunks?: (doc: ConfigDoc) => Promise<void>;
    /** Paths whose missing base is settled keeping the local value. */
    localFirst: ReadonlySet<string>;
}

export interface PullPlanEntry {
    path: string;
    shared: ConfigDoc;
    /** The disk before the Pull (null: no file). */
    local: Uint8Array | null;
    decision: PullDecision;
}

export interface PullPlan {
    entries: PullPlanEntry[];
    /** Paths left alone because their shared content is not available. */
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

/**
 * Plan a Pull: for every shared doc the policy lets this device receive and
 * whose version the disk has not taken in yet, decide what the disk
 * becomes. Paths whose base already is the shared version are not read.
 */
export async function planPull(
    deps: ReconcileDeps,
    onProgress?: (path: string, index: number, total: number) => void,
): Promise<PullPlan> {
    await deps.lastSynced.ensureLoaded();
    const docs = (await deps.store.allConfigDocs()).filter((d) => !d.deleted);
    const candidates: ConfigDoc[] = [];
    for (const doc of docs) {
        const path = configPathFromId(doc._id);
        const violation = unsafeVaultPathReason(path);
        if (violation) {
            logWarn(`rejecting unsafe remote config path "${path}" — ${violation}`);
            continue;
        }
        if (deps.isExcluded(path) || !deps.receives(path)) continue;
        const base = deps.lastSynced.get(path);
        if (base && sameVersion(base, doc)) continue;
        candidates.push(doc);
    }

    const entries: PullPlanEntry[] = [];
    const unavailable: string[] = [];
    for (let i = 0; i < candidates.length; i++) {
        const shared = candidates[i];
        const path = configPathFromId(shared._id);
        onProgress?.(path, i + 1, candidates.length);
        try {
            if (shared.size > deps.maxSize) {
                logWarn(`Skipping config ${path} — ${shared.size} bytes exceeds the config size limit`);
                unavailable.push(path);
                continue;
            }
            let sharedBytes = await readChunks(deps.store, shared.chunks);
            if (!sharedBytes && deps.fetchChunks) {
                await deps.fetchChunks(shared);
                sharedBytes = await readChunks(deps.store, shared.chunks);
            }
            if (!sharedBytes) {
                logWarn(`Skipping config ${path} — its content is not available locally (missing chunks)`);
                unavailable.push(path);
                continue;
            }
            const local = await readDisk(deps.vault, path, deps.maxSize);
            if (local === "too-large") {
                logWarn(`Skipping config ${path} — the file on disk exceeds the config size limit`);
                unavailable.push(path);
                continue;
            }
            const base = await readBase(deps, path);
            const noBase: NoBaseRule = deps.localFirst.has(path) ? "local-first" : "remote-first";
            entries.push({
                path, shared, local,
                decision: decidePull(path, base?.bytes ?? null, local, sharedBytes, noBase),
            });
        } catch (e: any) {
            logWarn(`Failed to compare config ${path}: ${e?.message ?? e}`);
            unavailable.push(path);
        }
    }
    return { entries, unavailable };
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
 * Plan a Push: every file the policy lets this device send whose disk
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
        if (deps.isExcluded(path) || !deps.sends(path)) continue;
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
