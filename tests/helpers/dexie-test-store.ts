/**
 * Test helper: creates a DexieStore backed by fake-indexeddb.
 *
 * Each call returns a fresh, isolated DexieStore with a unique DB name.
 * Call `store.destroy()` in afterEach to clean up.
 */

import "fake-indexeddb/auto";
import { DexieStore } from "../../src/db/dexie-store.ts";

let counter = 0;

export function createTestStore<T extends { _id: string; _rev?: string } = any>(
    prefix = "test",
): DexieStore<T> {
    const name = `${prefix}-${Date.now()}-${counter++}`;
    return new DexieStore<T>(name);
}
