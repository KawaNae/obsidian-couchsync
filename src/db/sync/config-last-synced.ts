/**
 * ConfigLastSynced — per-config-path integration baseline.
 *
 * Records, for each `.obsidian/...` path, the `{vclock, size, dataHash}` at
 * the moment the local DB and vault file were last reconciled. Loaded on
 * first use into an in-memory map keyed by config path; persisted to the
 * ConfigLocalDB meta store under `_local/config-last-synced/<path>`.
 *
 * Mirror of `LastSynced` (`src/sync/last-synced.ts`) for vault FileDocs,
 * but with `dataHash` instead of `chunks`. Configs are single-doc base64
 * payloads, not chunked, so a content-addressed digest is the natural
 * cheap-equality key for the scan() short-circuit.
 *
 * Persistence layer: `WriteTransaction.meta` (`{op:"put",key,value}`)
 * lands the meta write atomically with the doc upsert, so the in-memory
 * cache update in `onCommit` always reflects committed state.
 */

import type { VectorClock } from "../../sync/vector-clock.ts";
import type { ConfigLocalDB } from "../config-local-db.ts";

export interface ConfigLastSyncedValue {
    vclock: VectorClock;
    size: number;
    /** First 16 hex chars of SHA-256(data). Sufficient for content equality
     *  in the scan() short-circuit; collision risk at <1e-19 per pair. */
    dataHash: string;
}

export const CONFIG_LAST_SYNCED_PREFIX = "_local/config-last-synced/";

/** Meta key for a given config path. Keep colocated with the prefix so
 *  consumers can build the same key shape for explicit `tx.meta` writes. */
export function configLastSyncedKey(path: string): string {
    return CONFIG_LAST_SYNCED_PREFIX + path;
}

/** SHA-256(buf) → first 16 hex chars (64 bits). Used by scan() to
 *  detect "vault content unchanged since last sync" without re-encoding
 *  to base64 for string comparison. */
export async function computeConfigDataHash(buf: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const arr = new Uint8Array(digest);
    let out = "";
    for (let i = 0; i < 8; i++) out += arr[i].toString(16).padStart(2, "0");
    return out;
}

export class ConfigLastSynced {
    private cache = new Map<string, ConfigLastSyncedValue>();
    private loaded = false;

    constructor(private db: ConfigLocalDB) {}

    /** Lazy-load the on-disk meta into the in-memory cache. Idempotent —
     *  subsequent calls are no-ops. Called from ConfigSync.scan() / push()
     *  / pull() before any read of the cache. */
    async ensureLoaded(): Promise<void> {
        if (this.loaded) return;
        const rows = await this.db.getMetaByPrefix<ConfigLastSyncedValue>(
            CONFIG_LAST_SYNCED_PREFIX,
        );
        this.cache.clear();
        for (const { key, value } of rows) {
            const path = key.slice(CONFIG_LAST_SYNCED_PREFIX.length);
            this.cache.set(path, value);
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
