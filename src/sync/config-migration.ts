/**
 * One-time correction of a config store written by builds that let Push's
 * scan write the config DB and lastSynced.
 *
 * Those builds wrote the disk's content into the config DB doc and
 * lastSynced before sending it, so either may hold a version the server
 * never accepted. From now on the config DB doc is only what the server
 * accepted (the shared version) and lastSynced is the shared version the
 * disk took in (the base). This step brings an old store to that meaning,
 * without losing an edit that was never pushed: a difference between the
 * disk and lastSynced is such an edit and is kept as a local change.
 *
 * Old lastSynced always named the same chunks as the config DB doc (scan
 * and Pull wrote both in one tx), and an old Pull wrote every received doc
 * that passed the receive gates to the disk. Whether a doc was ever sent
 * is told by comparing it with the server doc:
 *
 *   | config DB doc vs server        | base                               |
 *   |--------------------------------|------------------------------------|
 *   | equal (and same chunks)        | old lastSynced                     |
 *   | dominated (server newer)       | old lastSynced                     |
 *   | dominates (unsent scan)        | the server doc (the disk took it)  |
 *   | concurrent / same vclock but   | none; kept local-first: keys that  |
 *   |   other chunks                 | differ keep the disk's value and   |
 *   |                                | are reported as conflicts          |
 *   | no server doc                  | none (a new file on this device)   |
 *
 * A path that does not take part in sharing on this device loses its
 * lastSynced: an old Pull did not write it, so it is not on the disk. Every config DB doc is
 * replaced by the server doc (or removed when there is none), so the store
 * holds only shared versions afterwards. The push cursor goes away.
 */

import type { ConfigDoc, CouchSyncDoc } from "../types.ts";
import { CONFIG_SCHEMA_VERSION, isConfigDoc } from "../types.ts";
import { configPathFromId, makeConfigId } from "../types/doc-id.ts";
import { stripRev } from "../utils/doc.ts";
import type { ICouchClient } from "../db/interfaces.ts";
import type { ConfigLocalDB } from "../db/config-local-db.ts";
import type { MetaWrite } from "../db/write-transaction.ts";
import {
    configLastSyncedKey,
    type ConfigLastSynced,
} from "../db/sync/config-last-synced.ts";
import { assertSchemaVersion } from "../db/sync/schema-gate.ts";
import { compareVC } from "./vector-clock.ts";
import { chunkListsEqual } from "./chunk-equality.ts";
import { logInfo } from "../ui/log.ts";

/** Set once the store has the shared / base meaning. */
export const META_CONFIG_BASE_MIGRATED = "_sync/config-base-migrated";

/** Paths whose missing base is settled keeping the disk's values (the
 *  concurrent row above). Removed when Pull merges the path. */
export const CONFIG_LOCAL_FIRST_PREFIX = "_local/config-local-first/";

export function configLocalFirstKey(path: string): string {
    return CONFIG_LOCAL_FIRST_PREFIX + path;
}

/** The push cursor of the builds this migrates from. */
const LEGACY_META_CONFIG_PUSH_SEQ = "_sync/config-push-seq";

export async function loadLocalFirst(store: ConfigLocalDB): Promise<Set<string>> {
    const rows = await store.getMetaByPrefix(CONFIG_LOCAL_FIRST_PREFIX);
    return new Set(rows.map((r) => r.key.slice(CONFIG_LOCAL_FIRST_PREFIX.length)));
}

export interface ConfigMigrationDeps {
    store: ConfigLocalDB;
    lastSynced: ConfigLastSynced;
    client: ICouchClient;
    signal: AbortSignal;
    /** Does `path` take part in sharing on this device? */
    participates: (path: string) => boolean;
    /** Fetch the chunks of a doc the store just took from the server. */
    ensureChunks: (doc: ConfigDoc) => Promise<void>;
}

export interface ConfigMigrationResult {
    /** False when the store was already migrated. */
    ran: boolean;
    /** Paths left without a base, settled local-first on the next Pull. */
    localFirst: string[];
}

/** Run the migration once per store. */
export async function migrateConfigBase(deps: ConfigMigrationDeps): Promise<ConfigMigrationResult> {
    const { store, lastSynced } = deps;
    if (await store.getMeta(META_CONFIG_BASE_MIGRATED)) return { ran: false, localFirst: [] };
    await lastSynced.ensureLoaded();

    const localDocs = new Map<string, ConfigDoc>();
    for (const d of await store.allConfigDocs()) {
        if (!d.deleted) localDocs.set(configPathFromId(d._id), d);
    }
    const paths = new Set<string>(localDocs.keys());
    for (const p of lastSynced.paths()) paths.add(p);

    const serverDocs = new Map<string, ConfigDoc>();
    if (paths.size > 0) {
        const rows = await deps.client.allDocs<ConfigDoc>(
            { keys: [...paths].map(makeConfigId), include_docs: true }, deps.signal,
        );
        for (const row of rows.rows) {
            if (!row.doc || row.value?.deleted) continue;
            const doc = stripRev(row.doc) as ConfigDoc;
            if (!isConfigDoc(doc)) continue;
            assertSchemaVersion(doc, CONFIG_SCHEMA_VERSION, "config");
            serverDocs.set(configPathFromId(doc._id), doc);
        }
    }

    const adopt: ConfigDoc[] = [];
    const removeDocs: string[] = [];
    const meta: MetaWrite[] = [];
    const baseSet = new Map<string, ConfigDoc>();
    const baseDropped: string[] = [];
    const localFirst: string[] = [];

    for (const path of paths) {
        const mine = localDocs.get(path) ?? null;
        const server = serverDocs.get(path) ?? null;
        const old = lastSynced.get(path) ?? null;

        // The config DB holds the server's version from here on.
        if (server) {
            if (!mine || !sameDoc(mine, server)) adopt.push(server);
        } else if (mine) {
            removeDocs.push(mine._id);
        }

        if (!old) continue;
        const dropBase = () => {
            baseDropped.push(path);
            meta.push({ op: "delete", key: configLastSyncedKey(path) });
        };
        if (!deps.participates(path) || !server) {
            dropBase();
            continue;
        }
        const ref = mine ?? old;
        const rel = compareVC(ref.vclock ?? {}, server.vclock ?? {});
        if ((rel === "equal" && chunkListsEqual(ref.chunks, server.chunks)) || rel === "dominated") {
            continue; // old lastSynced is a shared version the disk took in
        }
        if (rel === "dominates") {
            baseSet.set(path, server);
            meta.push({
                op: "put", key: configLastSyncedKey(path),
                value: { vclock: server.vclock, size: server.size, chunks: server.chunks },
            });
            continue;
        }
        dropBase();
        localFirst.push(path);
        meta.push({ op: "put", key: configLocalFirstKey(path), value: true });
    }

    meta.push({ op: "delete", key: LEGACY_META_CONFIG_PUSH_SEQ });
    meta.push({ op: "put", key: META_CONFIG_BASE_MIGRATED, value: 1 });

    await store.runWriteTx({
        docs: adopt.map((d) => ({ doc: d as CouchSyncDoc })),
        deletes: removeDocs,
        meta,
        onCommit: () => {
            for (const p of baseDropped) lastSynced.delete(p);
            for (const [p, d] of baseSet) {
                lastSynced.set(p, { vclock: d.vclock, size: d.size, chunks: d.chunks });
            }
        },
    });
    for (const d of adopt) await deps.ensureChunks(d);

    if (paths.size > 0) {
        logInfo(
            `Config: moved the local config store to three-way merge ` +
            `(${adopt.length} doc(s) taken from the server, ${removeDocs.length} unsent doc(s) dropped, ` +
            `${baseSet.size} base(s) set to the server version, ${baseDropped.length} base(s) cleared, ` +
            `${localFirst.length} path(s) to merge keeping this device's values).`,
        );
    }
    return { ran: true, localFirst };
}

function sameDoc(a: ConfigDoc, b: ConfigDoc): boolean {
    return compareVC(a.vclock ?? {}, b.vclock ?? {}) === "equal" && chunkListsEqual(a.chunks, b.chunks);
}
