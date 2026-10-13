/**
 * Test helpers for config bindings.
 *
 * A binding's state lives in two places: the attachment (codec + joined
 * root) inside its local store, and the settings entry (cipher floor, setup
 * flag) under `configBindingKey(server, db)`. These helpers read and write
 * both the way a completed Create / Join would — for tests that exercise
 * Push / Pull / listing rather than the relation ops themselves.
 */
import type { ICouchClient } from "../../src/db/interfaces.ts";
import type { ConfigLocalDB } from "../../src/db/config-local-db.ts";
import type { ConfigBindingRecord, CouchSyncSettings } from "../../src/settings.ts";
import {
    buildInitialConfigMeta,
    pushConfigMeta,
    metaFingerprint,
    type ConfigMetaDoc,
} from "../../src/db/vault-meta.ts";
import {
    CONFIG_ATTACHMENT_KEY,
    configBindingKey,
    metaCodec,
    parseAttachment,
    type ConfigAttachment,
} from "../../src/sync/config-binding-record.ts";
import { resolveConfigCodec } from "../../src/sync/config-codec-policy.ts";

/** `settings.configBindings` key for `dbName` (default: the settings' DB). */
export function recordKeyFor(settings: CouchSyncSettings, dbName?: string): string {
    return configBindingKey(settings.couchdbUri, dbName ?? settings.couchdbConfigDbName);
}

/** The settings entry (cipher floor, setup flag) of a binding. */
export function getEntry(settings: CouchSyncSettings, dbName?: string): ConfigBindingRecord | undefined {
    return settings.configBindings?.[recordKeyFor(settings, dbName)];
}

export function putEntry(
    settings: CouchSyncSettings,
    rec: ConfigBindingRecord,
    dbName?: string,
): void {
    settings.configBindings = { ...(settings.configBindings ?? {}), [recordKeyFor(settings, dbName)]: rec };
}

/** The attachment recorded in a binding's store, or null. */
export async function getAttachment(store: ConfigLocalDB): Promise<ConfigAttachment | null> {
    return parseAttachment(await store.getMeta(CONFIG_ATTACHMENT_KEY));
}

export async function putAttachment(store: ConfigLocalDB, att: ConfigAttachment): Promise<void> {
    await store.runWriteTx({ meta: [{ op: "put", key: CONFIG_ATTACHMENT_KEY, value: att }] });
}

/**
 * Push a plaintext `config:meta` matching the settings' compression onto
 * `remote` and record `store` as joined to it. Encryption must be off in
 * `settings` (use a real Create / Join for encrypted fixtures).
 */
export async function attachPlain(
    settings: CouchSyncSettings,
    remote: ICouchClient,
    store: ConfigLocalDB,
): Promise<ConfigMetaDoc> {
    const codec = resolveConfigCodec(settings);
    if (codec.encryption) throw new Error("attachPlain: encryption must be off");
    const { meta } = await buildInitialConfigMeta({
        encryption: false, compression: codec.compression,
    });
    await pushConfigMeta(remote, meta);
    await putAttachment(store, {
        codec: metaCodec(meta),
        metaFingerprint: await metaFingerprint(meta),
    });
    return meta;
}
