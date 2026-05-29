/**
 * schema-gate.ts — the doc-shape contract enforced at the pull boundary.
 *
 * Replicated docs carry a `schemaVersion`. A reader that silently accepts
 * a doc whose shape it does not understand will corrupt the local store
 * (wrong field layout written to disk / db). Both the vault and config
 * pull paths must therefore *abort loudly* on a version mismatch and route
 * the user to the re-init/clone migration — never best-effort decode.
 *
 * This module is the single home for that gate so both paths behave
 * symmetrically (the config path learned the lesson the hard way during
 * the v2→v3 ConfigDoc shape change; the vault path now shares the guard
 * as defense-in-depth for any future FILE_SCHEMA_VERSION bump).
 *
 * The error carries `nonRetriable` so the sync engine's error classifier
 * routes it to a terminal state (surface + halt) instead of the default
 * retry/backoff loop — a shape mismatch never self-heals by retrying.
 */

export type SchemaDocKind = "file" | "config";

export class SchemaVersionMismatchError extends Error {
    /** Marks the error as terminal for `classifyError`: retrying a pull
     *  against a doc this build cannot read will never succeed. */
    readonly nonRetriable = true;
    /** Ready-to-show notice describing the migration the user must run. */
    readonly userMessage: string;

    constructor(
        public readonly docId: string,
        public readonly remoteVersion: unknown,
        public readonly kind: SchemaDocKind,
        public readonly expectedVersion: number,
    ) {
        super(
            `${kind} DB contains schemaVersion ${String(remoteVersion)} doc ` +
            `(expected ${expectedVersion}) — re-init required (doc id: ${docId})`,
        );
        this.name = "SchemaVersionMismatchError";
        const initCmd = kind === "config" ? "Config Init" : "Init";
        const cloneCmd = kind === "config" ? "Config Pull" : "Clone";
        this.userMessage =
            `Remote ${kind} DB is on schemaVersion ${String(remoteVersion)} ` +
            `but this build expects ${expectedVersion}. One device must run ` +
            `"${initCmd}" first; the rest then re-run "${cloneCmd}". ` +
            `(doc id: ${docId})`;
    }
}

/** Throw `SchemaVersionMismatchError` unless `doc.schemaVersion` matches
 *  `expected`. The single gate both pull paths call. */
export function assertSchemaVersion(
    doc: { _id: string; schemaVersion: unknown },
    expected: number,
    kind: SchemaDocKind,
): void {
    if (doc.schemaVersion !== expected) {
        throw new SchemaVersionMismatchError(doc._id, doc.schemaVersion, kind, expected);
    }
}
