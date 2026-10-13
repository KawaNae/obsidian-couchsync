/**
 * ConfigPushPipeline — sends a Push plan to the server.
 *
 *   1. freshness: read the server docs of the planned paths (one allDocs).
 *      A path is sent only when
 *        - the server doc is the shared version this device holds (the
 *          config DB doc), and
 *        - the disk took that version in (the base is the shared version),
 *      or when the path is new everywhere (no server doc, no shared, no
 *      base). Any other path is held: the server or the disk is behind,
 *      and a Pull & Reload has to merge first. Pushing it would overwrite
 *      shared changes this device never saw.
 *   2. send: chunks first, then the docs, each with the vclock of its base
 *      advanced by this device and the server's `_rev`.
 *   3. record: for each doc the server accepted, the config DB doc and
 *      lastSynced become the sent version, in one tx. A doc the server
 *      rejected leaves both as they were.
 *
 * The pipeline never asks to overwrite: a path whose server doc moved is
 * held, never forced.
 */

import type { ConfigDoc, CouchSyncDoc, ChunkDoc } from "../../types.ts";
import { CONFIG_SCHEMA_VERSION } from "../../types.ts";
import { makeConfigId } from "../../types/doc-id.ts";
import { incrementVC } from "../../sync/vector-clock.ts";
import { sameVersion, pushContent, type PushPlanEntry } from "../../sync/config-reconcile.ts";
import type { DocWithAttachments, ICouchClient } from "../interfaces.ts";
import type { ConfigLocalDB } from "../config-local-db.ts";
import { buildChunkAttachment } from "../chunk-attachment.ts";
import { splitIntoChunks, MAX_CHUNK_BYTES_CONFIG, type ChunkHasher } from "../chunker.ts";
import { logDebug, logInfo } from "../../ui/log.ts";
import {
    configLastSyncedKey,
    type ConfigLastSynced,
} from "./config-last-synced.ts";

/** Why a path was not sent.
 *   - remote-changed: the server doc is not the shared version held here
 *   - not-merged: the disk has not taken in the shared version (no base,
 *     or an older one) */
export type ConfigPushHoldReason = "remote-changed" | "not-merged";

export interface ConfigPushResult {
    pushed: string[];
    held: Array<{ path: string; reason: ConfigPushHoldReason }>;
    /** Rejected by the server for a reason other than a conflict. */
    failed: string[];
}

export interface ConfigPushPipelineDeps {
    db: ConfigLocalDB;
    client: ICouchClient;
    lastSynced: ConfigLastSynced;
    hasher: ChunkHasher;
    getDeviceId: () => string;
    signal: AbortSignal;
}

interface Outgoing {
    path: string;
    doc: ConfigDoc & { _rev?: string };
    chunks: ChunkDoc[];
}

export class ConfigPushPipeline {
    constructor(private deps: ConfigPushPipelineDeps) {}

    async run(
        plan: readonly PushPlanEntry[],
        onProgress?: (msg: string) => void,
    ): Promise<ConfigPushResult> {
        const result: ConfigPushResult = { pushed: [], held: [], failed: [] };
        if (plan.length === 0) return result;

        onProgress?.(`Checking the server for ${plan.length} changed file(s)...`);
        const ids = plan.map((e) => makeConfigId(e.path));
        const remoteRows = await this.deps.client.allDocs<ConfigDoc>(
            { keys: ids, include_docs: true }, this.deps.signal,
        );
        const remote = new Map<string, { rev: string; doc: ConfigDoc }>();
        for (const row of remoteRows.rows) {
            if (row.value?.rev && !row.value.deleted && row.doc) {
                remote.set(row.id, { rev: row.value.rev, doc: row.doc as ConfigDoc });
            }
        }

        const deviceId = this.deps.getDeviceId();
        const outgoing: Outgoing[] = [];
        for (const entry of plan) {
            const id = makeConfigId(entry.path);
            const server = remote.get(id) ?? null;
            const shared = await this.deps.db.get(id);
            const sharedLive = shared && !shared.deleted ? shared : null;
            const fresh = server && sharedLive
                ? sameVersion(server.doc, sharedLive)
                : !server && !sharedLive;
            if (!fresh) {
                result.held.push({ path: entry.path, reason: "remote-changed" });
                continue;
            }
            const merged = entry.base && sharedLive
                ? sameVersion(entry.base, sharedLive)
                : !entry.base && !sharedLive;
            if (!merged) {
                result.held.push({ path: entry.path, reason: "not-merged" });
                continue;
            }
            const content = pushContent(entry.diff, entry.local);
            const chunks = content === entry.local
                ? entry.chunks
                : await splitIntoChunks(
                    content.slice().buffer as ArrayBuffer,
                    { hasher: this.deps.hasher, chunkBytes: MAX_CHUNK_BYTES_CONFIG },
                );
            const doc: ConfigDoc & { _rev?: string } = {
                _id: id,
                schemaVersion: CONFIG_SCHEMA_VERSION,
                type: "config",
                chunks: chunks.map((c) => c._id),
                mtime: entry.mtime,
                size: content.byteLength,
                vclock: incrementVC(entry.base?.vclock, deviceId),
            };
            if (server) doc._rev = server.rev;
            outgoing.push({ path: entry.path, doc, chunks });
        }
        if (outgoing.length === 0) return result;

        // Chunks first: a peer never sees a doc whose chunks are not on
        // the server yet. Content-addressed, so a chunk already there is a
        // benign conflict.
        const attachments = this.chunkAttachments(outgoing);
        onProgress?.(`Pushing ${outgoing.length} file(s) + ${attachments.length} chunk(s)...`);
        const badChunks = new Set<string>();
        if (attachments.length > 0) {
            const chunkResults = await this.deps.client.bulkDocsWithAttachments(
                attachments, this.deps.signal,
            );
            for (const r of chunkResults) {
                if (r.error && r.error !== "conflict") badChunks.add(r.id);
            }
        }
        const sendable: Outgoing[] = [];
        for (const o of outgoing) {
            if (o.chunks.some((c) => badChunks.has(c._id))) {
                logDebug(`  → ${o.path} (a chunk was rejected by the server)`);
                result.failed.push(o.path);
            } else {
                sendable.push(o);
            }
        }
        if (sendable.length === 0) return result;
        const docResults = await this.deps.client.bulkDocs(
            sendable.map((o) => o.doc), this.deps.signal,
        );
        const byId = new Map(docResults.map((r) => [r.id, r]));

        for (const o of sendable) {
            const r = byId.get(o.doc._id);
            if (!r || r.error) {
                if (r?.error === "conflict") {
                    result.held.push({ path: o.path, reason: "remote-changed" });
                } else {
                    logDebug(`  → ${o.path} (${r?.error ?? "no result"}: ${r?.reason ?? ""})`);
                    result.failed.push(o.path);
                }
                continue;
            }
            await this.record(o);
            result.pushed.push(o.path);
        }

        if (result.pushed.length > 0) {
            logInfo(`Config Push: ${result.pushed.length} pushed`);
        }
        return result;
    }

    /** The server accepted `o`: it is now the shared version and the base. */
    private async record(o: Outgoing): Promise<void> {
        const { _rev: _r, ...doc } = o.doc;
        void _r;
        const value = { vclock: doc.vclock, size: doc.size, chunks: doc.chunks };
        await this.deps.db.runWriteTx({
            docs: [{ doc: doc as CouchSyncDoc }],
            chunks: o.chunks as unknown as CouchSyncDoc[],
            meta: [{ op: "put", key: configLastSyncedKey(o.path), value }],
            onCommit: () => this.deps.lastSynced.set(o.path, value),
        });
    }

    /** Envelope-formatted chunk attachments, de-duplicated by id.
     *  `keepRev: false`: the server would reject a rev it never issued. */
    private chunkAttachments(outgoing: readonly Outgoing[]): DocWithAttachments[] {
        const seen = new Set<string>();
        const out: DocWithAttachments[] = [];
        for (const o of outgoing) {
            for (const c of o.chunks) {
                if (seen.has(c._id)) continue;
                seen.add(c._id);
                out.push(buildChunkAttachment(c, { keepRev: false }));
            }
        }
        return out;
    }
}
