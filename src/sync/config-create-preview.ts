/**
 * config-create-preview.ts — what the Create confirm dialog tells the user
 * about the server before they wipe it, and what Create will build
 * (config-binding design, Create).
 *
 * `ConfigSync.previewCreate` reads the remote config DB (raw client, no key
 * needed) and returns a `ConfigCreatePreview`; `describeCreateConfirm` turns
 * it, plus the codec Create will build with, into the dialog text. When the
 * server cannot be read the text says so — a document count is never
 * guessed.
 */

/** A root's codec as the dialog shows it. `cipherVersion` is set iff
 *  `encryption` is. */
export interface CreateCodec {
    encryption: boolean;
    compression: boolean;
    cipherVersion?: number;
}

export type ConfigCreatePreview = (
    /** The DB exists and was read. */
    | {
        kind: "read";
        /** `doc_count` of the remote DB (config docs, chunks, config:meta). */
        docCount: number;
        /** `config:meta` state: current (schemaVersion 2), an older
         *  format, or none. */
        meta: "present" | "legacy" | "absent";
        /** The present meta's codec. */
        codec?: CreateCodec;
    }
    /** The DB does not exist on the server (404). */
    | { kind: "missing" }
    /** The server could not be read; `message` says why. */
    | { kind: "unreadable"; message: string }
) & {
    /** The binding (`configBindingKey`) this preview was read for; null when
     *  there was none. Create must run against the same binding. */
    bindingKey: string | null;
};

/** "encryption on (cipherVersion 3), compression off" */
export function describeCreateCodec(c: CreateCodec): string {
    const enc = c.encryption
        ? `encryption on (cipherVersion ${c.cipherVersion ?? "?"})`
        : "encryption off";
    return `${enc}, compression ${c.compression ? "on" : "off"}`;
}

/** How `next` is weaker than `current` (the root Create replaces), or null.
 *  Weaker = loses encryption, or encrypts with an older cipher. Compression
 *  is not a security property and never counts. */
export function weakerCodecReason(current: CreateCodec, next: CreateCodec): string | null {
    if (current.encryption && !next.encryption) {
        return "the database is encrypted now, and Create makes it UNENCRYPTED — " +
            "every device's config will then be stored on the server in plaintext";
    }
    if (current.encryption && next.encryption
        && (next.cipherVersion ?? 0) < (current.cipherVersion ?? 0)) {
        return `the database uses cipherVersion ${current.cipherVersion} now, and ` +
            `Create uses the older cipherVersion ${next.cipherVersion}`;
    }
    return null;
}

/**
 * The Create confirm dialog body. Paragraphs are separated by a blank line
 * (the confirm modal renders each as its own paragraph; one starting with
 * "⚠" is emphasised):
 *   0. (only when weaker than the current root) the warning
 *   1. what Create does, the codec it builds with, and that it cannot be
 *      undone
 *   2. what is on the server now (or that it could not be read)
 *   3. every other device must Join again
 *   4. this device: local store emptied, files untouched, Push next
 *
 * `next` is the codec Create builds the new root with (Step 1, with the
 * cipherVersion this build writes).
 */
export function describeCreateConfirm(
    dbName: string,
    p: ConfigCreatePreview,
    next: CreateCodec,
): string {
    const db = `"${dbName}"`;
    const what =
        `Create deletes the config database ${db} on the server and re-creates it ` +
        `empty, with a new root (config:meta): ${describeCreateCodec(next)} — the ` +
        "Step 1 settings. This cannot be undone.";

    let server: string;
    let warning: string | null = null;
    switch (p.kind) {
        case "read": {
            const meta = p.meta === "present"
                ? `config:meta present (${p.codec ? describeCreateCodec(p.codec) : "codec unknown"})`
                : p.meta === "legacy"
                    ? "config:meta in an older format"
                    : "no config:meta";
            server = p.docCount === 0
                ? `On the server now: no documents, ${meta}.`
                : `On the server now: ${p.docCount.toLocaleString()} document(s), ${meta}. ` +
                    "All of them will be deleted.";
            const reason = p.codec ? weakerCodecReason(p.codec, next) : null;
            if (reason) {
                warning = `⚠ Weaker than now: ${reason}. Continue only if this is intended.`;
            }
            break;
        }
        case "missing":
            server = "On the server now: the database does not exist yet. Create makes it.";
            break;
        case "unreadable":
            server = `The server could not be read (${p.message}), so what Create would ` +
                "delete is unknown.";
            break;
    }

    const others =
        `Every other device that uses ${db} must Join again (Step 3) before it can ` +
        "sync; until then its Push and Pull stop and ask it to Join.";
    const self =
        "On this device the local config store is emptied; the .obsidian files are " +
        "not touched. Run Push afterwards to send this device's config.";
    return [warning, what, server, others, self].filter((x): x is string => x !== null).join("\n\n");
}
