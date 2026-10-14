import { PendingApply } from "../../src/db/sync/pending-apply.ts";
import type { FileDoc } from "../../src/types.ts";
import type { WriteResult } from "../../src/sync/vault-writer.ts";

/**
 * A PendingApply for tests. `ensureChunks` may land chunks locally (a
 * modelled remote fetch); availability is then read from the store, as
 * the engine does, and a still-missing chunk counts as absent on the
 * server too. `write` defaults to a successful vault write.
 */
export function makePendingApply(
    localDb: any,
    opts: {
        ensureChunks?: (doc: FileDoc) => Promise<void>;
        write?: (doc: FileDoc) => Promise<WriteResult>;
        onRecovered?: (path: string) => void;
    } = {},
): PendingApply {
    return new PendingApply({
        localDb,
        ensureChunks: async (doc) => {
            await opts.ensureChunks?.(doc);
            if (typeof localDb.getChunks !== "function") {
                return { stillMissing: [], remoteConsulted: true };
            }
            const have = await localDb.getChunks(doc.chunks);
            const usable = new Set(
                have.filter((c: any) => c.content instanceof Uint8Array).map((c: any) => c._id),
            );
            return {
                stillMissing: doc.chunks.filter((id) => !usable.has(id)),
                remoteConsulted: true,
            };
        },
        write: opts.write ?? (async () => ({ applied: true })),
        onRecovered: opts.onRecovered,
    });
}
