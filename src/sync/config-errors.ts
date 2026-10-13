/**
 * config-errors.ts — typed "not ready" failures for config sync.
 *
 * Why a typed error: config ops used to throw plain `Error`s from their
 * pre-checks BEFORE a ProgressNotice existed, and the settings tab swallowed
 * them — a Pull that "does nothing" with no notice and no log line. Every
 * pre-check now throws `ConfigNotReadyError` from inside the op runner, so the
 * failure always reaches ProgressNotice + log, and callers can tell a
 * precondition failure (fix a setting, wait, reload) apart from a transport
 * failure without sniffing message text.
 *
 * Each `kind` is one cause the user can act on — a setting to fix, a step
 * to run (Join, Create, Check), or a server to verify — so a kind maps to
 * exactly one piece of advice. Transport failures (network / timeout / auth) are NOT not-ready kinds —
 * they stay the transport's own errors and are classified by `classifyError`.
 *
 * The user-facing wording of every kind lives in `configNotReady` below, so
 * the preflight, Join, Create and the settings tab all say the same thing.
 */

export type ConfigNotReadyKind =
    /** No config DB name, or the local config store is not open. */
    | "not-configured"
    /** Another config op is in flight. */
    | "busy"
    /** The remote config DB does not exist (404). */
    | "db-missing"
    /** No `config:meta` and no docs — never set up. */
    | "uninitialized"
    /** No `config:meta` but docs exist — legacy layout or an interrupted setup. */
    | "meta-missing"
    /** `config:meta` schemaVersion 1 (pre-Phase-2 legacy root). */
    | "legacy-meta"
    /** This device has not joined the configured config DB. */
    | "unattached"
    /** Encrypted config DB, and this device has no passphrase for it. */
    | "passphrase-missing"
    /** The passphrase this device has for the DB does not unlock it. */
    | "passphrase-mismatch"
    /** Create would encrypt, but neither Step 1 nor Vault Sync has a
     *  passphrase to encrypt with. */
    | "create-passphrase-missing"
    /** `config:meta` is a different root than the one this device joined
     *  (new generation id, or new salt / keyCheck on a meta without one) —
     *  another device ran Create. Encrypted or not. */
    | "root-changed"
    /** This device joined the DB encrypted, and `config:meta` is now a
     *  plaintext root. Either someone re-created it without encryption or
     *  the server was tampered with — never followed silently. */
    | "encryption-removed"
    /** `config:meta` cipherVersion below the local floor — possible tampering. */
    | "cipher-downgrade"
    /** This device's Create died mid-flight (#err-9). */
    | "setup-interrupted"
    /** Push needs a device name to advance vclocks. */
    | "device-id-missing"
    /** Encrypted config DB, but no config key is unlocked on this device. */
    | "key-missing";

export class ConfigNotReadyError extends Error {
    /** The message is written for the user (cause and fix), so it is also
     *  the `userMessage` `describeError` shows as is. */
    readonly userMessage: string;
    constructor(
        readonly kind: ConfigNotReadyKind,
        message: string,
    ) {
        super(message);
        this.name = "ConfigNotReadyError";
        this.userMessage = message;
    }
}

/** Facts a message can name. */
export interface ConfigNotReadyContext {
    /** Config DB name. */
    db?: string;
    /** Documents found on a meta-less config DB (`meta-missing`). */
    docCount?: number;
    /** `config:meta` schemaVersion (`legacy-meta`). */
    schemaVersion?: number;
    /** Remote cipherVersion and local floor (`cipher-downgrade`). */
    remoteCipherVersion?: number;
    localFloor?: number;
}

/**
 * Build the `ConfigNotReadyError` for `kind` with its canonical user-facing
 * message. The message is the only place a kind's advice lives. Guidance
 * rules:
 *   - key / passphrase / reset problems never suggest Create — it wipes the
 *     config every device shares and cannot fix a key. Their messages never
 *     contain the word "Create" (tests pin this per kind);
 *   - Create is named only where re-creating is the actual fix
 *     (db-missing, uninitialized, meta-missing, legacy-meta,
 *     setup-interrupted), and then with its blast radius — or where Create
 *     itself is what failed (create-passphrase-missing).
 */
export function configNotReady(
    kind: ConfigNotReadyKind,
    ctx: ConfigNotReadyContext = {},
): ConfigNotReadyError {
    const db = ctx.db ? `"${ctx.db}"` : "the config database";
    const msg = ((): string => {
        switch (kind) {
            case "not-configured":
                // With a DB name: the name is applied, but its local store
                // could not be opened (the cause was logged when it failed).
                return ctx.db
                    ? `Config database ${db} is not active on this device — its local ` +
                        "store could not be opened (see the log). Apply the name again in Step 2."
                    : "Config sync is not configured — apply a config database name in Step 2.";
            case "busy":
                return "Another config operation is already in progress. " +
                    "Wait for it to finish or cancel it first.";
            case "db-missing":
                return `Config database ${db} does not exist on the server. Run Check in ` +
                    "Step 2 to create it; on the first device, then run Create in Step 3.";
            case "uninitialized":
                return `Config database ${db} has not been set up yet (no config:meta, ` +
                    "no documents). On the first device, run Create in Step 3.";
            case "meta-missing": {
                const n = ctx.docCount ?? 0;
                return `Config database ${db} holds ${n} document(s) but no config:meta ` +
                    "(a legacy layout, or a Create that did not finish). Create in Step 3 " +
                    `rebuilds it and deletes those ${n} document(s) — run it only if this ` +
                    "device's config should become the shared one.";
            }
            case "legacy-meta":
                return `Config database ${db} uses a legacy config:meta ` +
                    `(schemaVersion ${ctx.schemaVersion ?? "?"}). Create in Step 3 rebuilds ` +
                    "it; this resets the config shared by every device, and every other " +
                    "device must Join again.";
            case "unattached":
                return `This device has not joined config database ${db}. Press Join in ` +
                    "Step 3 (it does not change the server), then sync.";
            case "passphrase-missing":
                return `Config database ${db} is encrypted, and this device has no ` +
                    "passphrase for it. Press Join in Step 3 — it asks for the " +
                    "passphrase the database was set up with.";
            case "passphrase-mismatch":
                return `The passphrase this device has does not unlock config database ` +
                    `${db}. Press Join in Step 3 — it asks for the passphrase the ` +
                    "database was set up with.";
            case "create-passphrase-missing":
                return `Encryption is on for ${db}, but there is no passphrase to ` +
                    "encrypt with. Enter one in Step 1 (Encryption & compression), " +
                    "or set the Vault Sync passphrase it inherits.";
            case "root-changed":
                return `Config database ${db} was re-created on another device (it has ` +
                    "a new config:meta root). Press Join in Step 3 to join it again; " +
                    "this device does not sync with it until then.";
            case "encryption-removed":
                return `Config database ${db} was encrypted when this device joined it, ` +
                    "but its config:meta is now unencrypted. It was re-created without " +
                    "encryption on another device, or the server was tampered with. " +
                    "Sync is refused: verify the server first, and only if the unencrypted " +
                    "database is intended, press Join in Step 3 (it asks you to confirm).";
            case "cipher-downgrade":
                return `config:meta of ${db} declares cipherVersion ` +
                    `${ctx.remoteCipherVersion ?? "?"}, below this device's floor ` +
                    `${ctx.localFloor ?? "?"} — possible tampering. Sync is refused; ` +
                    "verify the server.";
            case "setup-interrupted":
                return `Create was interrupted on this device — run Create in Step 3 ` +
                    `again before syncing ${db}.`;
            case "device-id-missing":
                return "Push needs a device name — set it in Settings → Vault Sync.";
            case "key-missing":
                return `Config database ${db} is encrypted, but its key is not unlocked ` +
                    "on this device. Run the operation again (it unlocks the key), or " +
                    "Join in Step 3.";
        }
    })();
    return new ConfigNotReadyError(kind, msg);
}
