/** Test helpers for v0.26 ConfigDoc (chunks-based) fixtures.
 *
 * The pre-v0.26 fixtures used `{ data: base64, schemaVersion: 2 }`; v0.26
 * switches ConfigDoc to `{ chunks: string[], schemaVersion: 3 }` and
 * routes the binary content through real ChunkDocs in the same store.
 * Hand-writing those by hand in every test is noisy, so this module
 * provides a single `makeConfigFixture(path, contentString)` that
 * returns the ConfigDoc plus its referenced ChunkDocs, both ready to
 * `runWriteTx` straight into a ConfigLocalDB. */

import { splitIntoChunks } from "../../src/db/chunker.ts";
import { makeConfigId } from "../../src/types/doc-id.ts";
import {
    CONFIG_SCHEMA_VERSION,
    type ChunkDoc,
    type ConfigDoc,
    type VectorClock,
} from "../../src/types.ts";

export interface ConfigFixtureOpts {
    vclock?: VectorClock;
    mtime?: number;
    deleted?: boolean;
    /** Override the chunk size (default = chunker's vault default). Useful
     *  for tests that want to force a multi-chunk doc out of small data. */
    chunkBytes?: number;
}

export interface ConfigFixture {
    doc: ConfigDoc;
    chunks: ChunkDoc[];
}

/** Convenience: encode a string as UTF-8 bytes. */
export function utf8(s: string): ArrayBuffer {
    return new TextEncoder().encode(s).buffer;
}

/** Build a v3 ConfigDoc + its ChunkDocs from string content. The chunks
 *  are content-addressed via the default xxhash64 hasher (plaintext-mode
 *  config DB) which keeps fixture ids stable across test runs. */
export async function makeConfigFixture(
    path: string,
    content: string,
    opts: ConfigFixtureOpts = {},
): Promise<ConfigFixture> {
    const buf = utf8(content);
    const chunks = await splitIntoChunks(
        buf,
        opts.chunkBytes !== undefined
            ? { hasher: { alg: "x64", hash: defaultHash }, chunkBytes: opts.chunkBytes }
            : undefined,
    );
    const chunkIds = chunks.map((c) => c._id);
    const doc: ConfigDoc = {
        _id: makeConfigId(path),
        schemaVersion: CONFIG_SCHEMA_VERSION,
        type: "config",
        chunks: chunkIds,
        size: buf.byteLength,
        mtime: opts.mtime ?? 1700000000000,
        vclock: opts.vclock ?? { "dev-A": 1 },
        ...(opts.deleted ? { deleted: true } : {}),
    };
    return { doc, chunks };
}

/** Re-export the chunker's default hasher closure so fixtures stay in
 *  lockstep with production chunk ids. */
async function defaultHash(data: Uint8Array): Promise<string> {
    const { computeHash } = await import("../../src/db/chunker.ts");
    return computeHash(data);
}
