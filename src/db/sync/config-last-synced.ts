/**
 * ConfigLastSynced — per-config-path integration baseline.
 *
 * Records, for each `.obsidian/...` path, the `{vclock, chunks, size}` at
 * the moment the local DB and vault file were last reconciled. Loaded on
 * first use into an in-memory map keyed by config path; persisted to the
 * ConfigLocalDB meta store under `_local/config-last-synced/<path>`.
 *
 * v0.26 (ConfigSync chunking) aligns this shape with vault's `LastSynced`:
 * `chunks: string[]` replaces the old `dataHash: string` because ConfigDoc
 * is now chunked just like FileDoc. The cheap-equality check in
 * `ConfigSync.scan()` becomes the same `chunksEqual` test the vault scan
 * uses — a true symmetry rather than a stand-in.
 *
 * Persistence layer: `WriteTransaction.meta` (`{op:"put",key,value}`)
 * lands the meta write atomically with the doc upsert, so the in-memory
 * cache update in `onCommit` always reflects committed state.
 */

import type { VectorClock } from "../../sync/vector-clock.ts";
import type { ConfigLocalDB } from "../config-local-db.ts";

export interface ConfigLastSyncedValue {
    vclock: VectorClock;
    /** Ordered chunk id list at integration. Same fingerprint the vault
     *  scanner uses; `chunksEqual` against the freshly-chunked disk
     *  produces the scan() short-circuit. */
    chunks: string[];
    size: number;
}

export const CONFIG_LAST_SYNCED_PREFIX = "_local/config-last-synced/";

/** Meta key for a given config path. Keep colocated with the prefix so
 *  consumers can build the same key shape for explicit `tx.meta` writes. */
export function configLastSyncedKey(path: string): string {
    return CONFIG_LAST_SYNCED_PREFIX + path;
}

export class ConfigLastSynced {
    private cache = new Map<string, ConfigLastSyncedValue>();
    private loaded = false;

    constructor(private db: ConfigLocalDB) {}

    /** Lazy-load the on-disk meta into the in-memory cache. Idempotent —
     *  subsequent calls are no-ops. Called from ConfigSync.scan() / push()
     *  / pull() before any read of the cache.
     *
     *  v0.25 → v0.26 legacy entries carry a `dataHash: string` field
     *  instead of `chunks`. Such entries are silently dropped during
     *  load — the scan() short-circuit will simply re-derive on first
     *  scan, and the migration guard (`findLegacyConfigDoc`) ensures
     *  the DB rebuild path runs before live sync resumes anyway. */
    async ensureLoaded(): Promise<void> {
        if (this.loaded) return;
        const rows = await this.db.getMetaByPrefix<unknown>(
            CONFIG_LAST_SYNCED_PREFIX,
        );
        this.cache.clear();
        for (const { key, value } of rows) {
            const parsed = parseConfigLastSyncedValue(value);
            if (!parsed) continue;
            const path = key.slice(CONFIG_LAST_SYNCED_PREFIX.length);
            this.cache.set(path, parsed);
        }
        this.loaded = true;
    }

    /** Force re-load (used after init() destroys + rebuilds the DB). */
    async reload(): Promise<void> {
        this.loaded = false;
        await this.ensureLoaded();
    }

    get(path: string): ConfigLastSyncedValue | undefined {
        return this.cache.get(path);
    }

    /** Update the in-memory cache. Persistence is the caller's job —
     *  emit a `tx.meta` write in the same WriteTransaction and call
     *  `set()` from `onCommit` so the cache only advances on success. */
    set(path: string, value: ConfigLastSyncedValue): void {
        this.cache.set(path, value);
    }

    delete(path: string): void {
        this.cache.delete(path);
    }

    /** Drop entire cache (called from init() before DB destroy). */
    clear(): void {
        this.cache.clear();
        this.loaded = false;
    }
}

function parseConfigLastSyncedValue(value: unknown): ConfigLastSyncedValue | null {
    if (!value || typeof value !== "object") return null;
    const v = value as Partial<ConfigLastSyncedValue> & { dataHash?: unknown };
    if (!Array.isArray(v.chunks)) return null;
    if (typeof v.size !== "number") return null;
    if (!v.vclock || typeof v.vclock !== "object") return null;
    return { vclock: v.vclock as VectorClock, chunks: v.chunks as string[], size: v.size };
}
