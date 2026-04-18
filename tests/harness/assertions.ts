/**
 * Effect-first assertion ヘルパー。
 *
 * 目的: テストを「何が呼ばれたか」(how) ではなく「何が書かれたか」(what)
 * で書けるようにする。fluent API で検証対象のレイヤー (vault/db/couch)
 * が一目で分かる命名を採る。
 *
 * 例:
 *   expectVault(dev.vault).toHaveFile("notes/a.md").withContent("hello");
 *   await expectDb(dev.db).toHaveFileDoc("notes/a.md").withChunks(1);
 *   expectCouch(harness.couch).toHaveDoc("file:notes/a.md");
 */

import { expect } from "vitest";
import type { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import type { ICouchClient } from "../../src/db/interfaces.ts";
import { LocalDB } from "../../src/db/local-db.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import { toPathKey } from "../../src/utils/path.ts";
import { compareVC } from "../../src/sync/vector-clock.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";
import type { VectorClock } from "../../src/sync/vector-clock.ts";

function vclockEqual(a: VectorClock, b: VectorClock): boolean {
    return compareVC(a, b) === "equal";
}

// ── expectVault ──────────────────────────────────────

export interface VaultFileExpectation {
    /** File bytes equal UTF-8 encoding of `expected`. */
    withContent(expected: string): void;
    /** File bytes equal the given ArrayBuffer (byte-for-byte). */
    withBinary(expected: ArrayBuffer): void;
    /** File size (bytes) equals `expected`. */
    withSize(expected: number): void;
}

export function expectVault(vault: FakeVaultIO) {
    return {
        toHaveFile(path: string): VaultFileExpectation {
            const entry = vault.files.get(path);
            expect(entry, `expected vault to contain file "${path}"`).toBeTruthy();
            return {
                withContent(expected: string) {
                    const actual = new TextDecoder().decode(entry!.data);
                    expect(actual).toBe(expected);
                },
                withBinary(expected: ArrayBuffer) {
                    expect(byteEqual(entry!.data, expected)).toBe(true);
                },
                withSize(expected: number) {
                    expect(entry!.data.byteLength).toBe(expected);
                },
            };
        },
        toNotHaveFile(path: string): void {
            expect(vault.files.has(path), `expected vault not to contain "${path}"`).toBe(false);
        },
        toHaveFileCount(n: number): void {
            expect(vault.files.size).toBe(n);
        },
    };
}

// ── expectDb ─────────────────────────────────────────

export interface DbFileDocExpectation {
    /** FileDoc.chunks.length === n */
    withChunks(n: number): Promise<void>;
    /** FileDoc.deleted === true */
    deleted(): Promise<void>;
    /** FileDoc.vclock deep-equals `expected` */
    withVclock(expected: VectorClock): Promise<void>;
}

export function expectDb(db: LocalDB) {
    return {
        toHaveFileDoc(path: string): DbFileDocExpectation {
            const load = async () => {
                const doc = (await db.get(makeFileId(path))) as FileDoc | null;
                expect(doc, `expected DB to contain FileDoc for "${path}"`).not.toBeNull();
                return doc!;
            };
            return {
                async withChunks(n: number) {
                    const doc = await load();
                    expect(doc.chunks.length).toBe(n);
                },
                async deleted() {
                    const doc = await load();
                    expect(doc.deleted).toBe(true);
                },
                async withVclock(expected: VectorClock) {
                    const doc = await load();
                    expect(vclockEqual(doc.vclock ?? {}, expected)).toBe(true);
                },
            };
        },

        async toNotHaveFileDoc(path: string): Promise<void> {
            const doc = await db.get(makeFileId(path));
            expect(doc, `expected DB not to contain FileDoc for "${path}"`).toBeNull();
        },

        async toHaveChunks(ids: string[]): Promise<void> {
            const found = await db.getChunks(ids);
            const foundIds = new Set(found.map((c) => c._id));
            const missing = ids.filter((id) => !foundIds.has(id));
            expect(missing, `expected chunks missing: ${missing.join(", ")}`).toEqual([]);
        },

        async toHaveLastSyncedVclock(path: string, expected: VectorClock): Promise<void> {
            const all = await db.loadAllSyncedVclocks();
            const key = toPathKey(path);
            const actual = all.get(key);
            expect(actual, `no lastSyncedVclock entry for "${path}"`).toBeTruthy();
            expect(vclockEqual(actual!, expected)).toBe(true);
        },
    };
}

// ── expectCouch ──────────────────────────────────────

export interface CouchDocExpectation<T extends CouchSyncDoc = CouchSyncDoc> {
    withRev(rev: string): void;
    withVclock(vc: VectorClock): void;
    /** Run a custom predicate against the fetched doc. */
    satisfying(pred: (doc: T) => boolean, message?: string): void;
}

export function expectCouch(couch: ICouchClient) {
    return {
        async toHaveDoc<T extends CouchSyncDoc = CouchSyncDoc>(
            id: string,
        ): Promise<CouchDocExpectation<T>> {
            const doc = await couch.getDoc<T & { _rev?: string }>(id);
            expect(doc, `expected couch to contain doc "${id}"`).not.toBeNull();
            return {
                withRev(rev: string) {
                    expect(doc!._rev).toBe(rev);
                },
                withVclock(vc: VectorClock) {
                    const fileDoc = doc as unknown as FileDoc;
                    expect(vclockEqual(fileDoc.vclock ?? {}, vc)).toBe(true);
                },
                satisfying(pred: (doc: T) => boolean, message?: string) {
                    expect(pred(doc as T), message ?? `doc "${id}" did not satisfy predicate`).toBe(true);
                },
            };
        },

        async toNotHaveDoc(id: string): Promise<void> {
            const doc = await couch.getDoc(id);
            expect(doc, `expected couch not to contain doc "${id}"`).toBeNull();
        },

        async toHaveDocCount(n: number): Promise<void> {
            const info = await couch.info();
            expect(info.doc_count).toBe(n);
        },
    };
}

// ── helpers ──────────────────────────────────────────

function byteEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
    if (a.byteLength !== b.byteLength) return false;
    const av = new Uint8Array(a);
    const bv = new Uint8Array(b);
    for (let i = 0; i < av.length; i++) {
        if (av[i] !== bv[i]) return false;
    }
    return true;
}
