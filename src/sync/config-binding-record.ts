/**
 * config-binding-record.ts — identity of a config binding, the name of its
 * local store, and the participation record kept INSIDE that store.
 *
 * One key identifies a binding everywhere: `configBindingKey(server, db)`.
 * The settings entry (`configBindings[key]`: cipher floor, setup flag) and
 * the local store name are both derived from it, so a server or DB-name
 * change can never pair one server's cursors and docs with another's.
 *
 * Pure helpers with no ConfigSync / Obsidian dependency, so the settings
 * migration can use them too.
 */
import type { ConfigMetaDoc } from "../db/vault-meta.ts";

/**
 * Normalise a CouchDB server URI for use as half of a binding key.
 *
 * Two spellings of the same server must map to one key, or a harmless
 * edit (a trailing slash, an upper-case host) would silently detach the
 * device. Parsed with `URL`, which already lower-cases scheme and host and
 * drops a default port; on top of that we drop credentials (never a key
 * component — they change without the server changing), query and
 * fragment, and trailing slashes on the path. The path itself is kept
 * as-is (a CouchDB behind a reverse proxy may live under a case-sensitive
 * prefix). A string `URL` cannot parse falls back to trim + strip trailing
 * slashes.
 */
export function normalizeServerUri(uri: string): string {
    const raw = uri.trim();
    try {
        const u = new URL(raw);
        const path = u.pathname.replace(/\/+$/, "");
        return `${u.protocol}//${u.host}${path}`;
    } catch {
        return raw.replace(/\/+$/, "");
    }
}

/** Key of `settings.configBindings`: normalised server URI + `|` + config
 *  DB name. `|` cannot occur in a CouchDB database name, so the split is
 *  unambiguous. */
export function configBindingKey(serverUri: string, dbName: string): string {
    return `${normalizeServerUri(serverUri)}|${dbName}`;
}

/**
 * IndexedDB name of the local config store for (vault, server, DB).
 *
 * Derived from the binding key, so each server + DB pair has its own store
 * (cursors, docs, lastSynced and the participation record). The key holds a
 * URI, which is not something to put into a store name verbatim, so it
 * enters as a hash: SHA-256 of the key, first 64 bits as hex. The DB name
 * stays readable in front of it (CouchDB DB names are `[a-z0-9_$()+/-]`).
 * The vault name keeps two vaults on one device apart, as before.
 *
 * `couchsync-<vault>-config-<db>-<hash16>`. Stores named by the previous
 * layout (`couchsync-<vault>-config-<db>`) are no longer opened; they stay
 * on disk (cleaning unused stores is out of scope).
 */
export async function configStoreName(
    vaultName: string,
    serverUri: string,
    dbName: string,
): Promise<string> {
    const key = configBindingKey(serverUri, dbName);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const hex = Array.from(new Uint8Array(digest).slice(0, 8))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    return `couchsync-${vaultName}-config-${dbName}-${hex}`;
}

/** The codec a config DB was built with, as declared by its `config:meta`. */
export interface ConfigCodec {
    encryption: boolean;
    compression: boolean;
}

/**
 * This device's participation in one config DB, written by a completed
 * Create or Join into the binding's own local store (meta key
 * `CONFIG_ATTACHMENT_KEY`). Its presence is what "attached" means: deleting
 * the store (Maintenance) makes the device Unattached, so the record and
 * the store's contents can never disagree.
 */
export interface ConfigAttachment {
    /** The codec every Push / Pull uses for this DB (wrap + chunk hasher):
     *  the `config:meta` codec at Create / Join. Step 1 settings are only
     *  the input of the next Create. */
    codec: ConfigCodec;
    /** `metaFingerprint` of the root this device joined; a different
     *  root on the server is `root-changed` (or `encryption-removed`). */
    metaFingerprint: string;
}

export const CONFIG_ATTACHMENT_KEY = "_local/config-binding/attachment";

/** Validate a stored attachment; anything malformed reads as none. */
export function parseAttachment(v: unknown): ConfigAttachment | null {
    const a = v as ConfigAttachment | null;
    if (!a || typeof a !== "object") return null;
    if (typeof a.metaFingerprint !== "string" || a.metaFingerprint === "") return null;
    if (!a.codec || typeof a.codec.encryption !== "boolean"
        || typeof a.codec.compression !== "boolean") return null;
    return {
        codec: { encryption: a.codec.encryption, compression: a.codec.compression },
        metaFingerprint: a.metaFingerprint,
    };
}

/** The codec a `config:meta` declares. */
export function metaCodec(meta: ConfigMetaDoc): ConfigCodec {
    return { encryption: meta.encryption.enabled, compression: meta.compression.enabled };
}

export function sameCodec(a: ConfigCodec, b: ConfigCodec): boolean {
    return a.encryption === b.encryption && a.compression === b.compression;
}

/** "encryption on, compression off" */
export function describeCodec(c: ConfigCodec): string {
    return `encryption ${c.encryption ? "on" : "off"}, compression ${c.compression ? "on" : "off"}`;
}
