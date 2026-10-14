/**
 * ConfigLastSynced — the base of each config path: the shared version
 * (`{vclock, chunks, size}` of a config DB doc) that the disk last took in.
 *
 * Written only when the disk takes in a shared version: by Pull's merge
 * (after writing the file, or finding it needs no write) and by a
 * successful Push (the sent content is the disk's). The chunks are the
 * shared version's, not the disk's, and stay in the config DB as long as
 * this names them (`gcOrphanConfigChunks` counts them as referenced). A
 * local change is the difference between the disk and this base.
 *
 * Loaded on first use into an in-memory map keyed by config path;
 * persisted to the ConfigLocalDB meta store under
 * `_local/config-last-synced/<path>`. Writers put the meta entry in their
 * WriteTransaction and update the cache from `onCommit`.
 */

import type { VectorClock } from "../../sync/vector-clock.ts";
import type { ConfigLocalDB } from "../config-local-db.ts";

export interface ConfigLastSyncedValue {
    vclock: VectorClock;
    /** Chunk ids of the shared version. A disk whose freshly cut chunks
     *  equal these has no local change. */
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
     *  subsequent calls are no-ops. Called by Push and Pull before any
     *  read of the cache.
     *
     *  v0.25 → v0.26 legacy entries carry a `dataHash: string` field
     *  instead of `chunks`. Such entries are dropped during load — the
     *  path then has no base — and the migration guard
     *  (`findLegacyConfigDoc`) ensures the DB rebuild path runs before
     *  live sync resumes anyway. */
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

    /** Paths with a base. */
    paths(): string[] {
        return [...this.cache.keys()];
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
