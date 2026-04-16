# VaultSync PathKey 統一 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VaultSync 内の全パスキー構造を `PathKey`（NFC + lowercase）で統一し、case-insensitive FS 上の lookup miss バグを根絶する

**Architecture:** `src/utils/path.ts` の既存 `PathKey` / `toPathKey()` を VaultSync・永続化層に適用。インメモリ map/set のキー型を `PathKey` に変更し、永続化キー `_local/vclock/<path>` も正規化。ロード時にレガシー非正規化キーをマイグレーション。パブリック API のシグネチャは `string` のまま、内部で正規化。

**Tech Stack:** TypeScript, Vitest, Dexie (IndexedDB)

**Spec:** `docs/superpowers/specs/2026-04-16-vault-sync-pathkey-design.md`

---

### Task 1: `dexie-store.ts` — `vclockMetaKey` の正規化

永続化キーの正規化が全ての基盤。ここを先に変えることで、以降の書き込みは自動的に正規化キーで保存される。

**Files:**
- Modify: `src/db/dexie-store.ts:66-69`
- Test: `tests/utils/path.test.ts`（既存テストで `toPathKey` の動作は検証済み。`vclockMetaKey` は純粋関数で `toPathKey` を呼ぶだけなので、結合テストは Task 4 で担保）

- [ ] **Step 1: `dexie-store.ts` に `toPathKey` を import し、`vclockMetaKey` を正規化**

```typescript
// src/db/dexie-store.ts:5 付近に import 追加
import { toPathKey } from "../utils/path.ts";

// L67-69 を書き換え
export function vclockMetaKey(path: string): string {
    return VCLOCK_KEY_PREFIX + toPathKey(path);
}
```

- [ ] **Step 2: ビルド確認**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 3: 既存テスト pass 確認**

Run: `npx vitest run`
Expected: 全テスト pass（`vclockMetaKey` の caller は全て生パスを渡しているが、正規化は冪等なので ASCII 小文字パスの既存データには影響しない）

- [ ] **Step 4: コミット**

```bash
git add src/db/dexie-store.ts
git commit -m "refactor: vclockMetaKey を PathKey で正規化"
```

---

### Task 2: `local-db.ts` — `loadAllSyncedVclocks` のロード時正規化 + マイグレーション

永続化済みの非正規化キーを正規化して読み込み、重複があればマージする。

**Files:**
- Modify: `src/db/local-db.ts:264-297`

- [ ] **Step 1: `local-db.ts` に `toPathKey` を import**

```typescript
// src/db/local-db.ts の import に追加
import { toPathKey, type PathKey } from "../utils/path.ts";
```

- [ ] **Step 2: `loadAllSyncedVclocks` の返却型と内部処理を正規化**

```typescript
// L264-297 を書き換え
async loadAllSyncedVclocks(): Promise<Map<PathKey, VectorClock>> {
    const out = new Map<PathKey, VectorClock>();
    // 非正規化キー → 正規化キーへのマイグレーション用
    const staleKeys: string[] = [];

    const rows = await this.getStore().getMetaByPrefix<VectorClock>(
        VCLOCK_KEY_PREFIX,
    );
    for (const { key, value } of rows) {
        const rawPath = key.slice(VCLOCK_KEY_PREFIX.length);
        const normalized = toPathKey(rawPath);
        out.set(normalized, value); // 重複時は後勝ち（内容差異なし）
        // キーが既に正規化済みならマイグレーション不要
        if (rawPath !== (normalized as string)) {
            staleKeys.push(key);
        }
    }

    // One-shot migration: legacy single-doc lived on the *meta* store.
    const legacyMeta = this.getMetaStore();
    const legacy = await legacyMeta.getMeta<{ clocks: Record<string, VectorClock> }>(
        LAST_SYNCED_VCLOCKS_ID,
    );
    if (legacy?.clocks) {
        const newVclocks: Array<{ path: string; op: "set"; clock: VectorClock }> = [];
        for (const [path, vc] of Object.entries(legacy.clocks)) {
            const normalized = toPathKey(path);
            if (!out.has(normalized)) {
                out.set(normalized, vc);
                newVclocks.push({ path, op: "set", clock: vc });
            }
        }
        if (newVclocks.length > 0) {
            await this.getStore().runWrite({ vclocks: newVclocks });
        }
        await legacyMeta.runWrite({
            meta: [{ op: "delete", key: LAST_SYNCED_VCLOCKS_ID }],
        });
    }

    // Stale-key cleanup: 非正規化キーを削除し、正規化キーで再書き込み。
    // Task 1 で vclockMetaKey が正規化済みなので、runWrite の vclocks
    // に path を渡すだけで正規化キーが書かれる。
    if (staleKeys.length > 0) {
        const ops: Array<{ path: string; op: "set"; clock: VectorClock } | { path: string; op: "delete" }> = [];
        // 旧キーの物理削除（meta テーブル直接）
        await this.getStore().runWrite({
            meta: staleKeys.map((key) => ({ op: "delete" as const, key })),
        });
        // 正規化キーで再書き込み
        const rewriteOps = [...out.entries()].map(([pathKey, clock]) => ({
            path: pathKey as string,
            op: "set" as const,
            clock,
        }));
        await this.getStore().runWrite({ vclocks: rewriteOps });
    }

    return out;
}
```

- [ ] **Step 3: ビルド確認**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 4: 既存テスト pass 確認**

Run: `npx vitest run`
Expected: 全テスト pass

- [ ] **Step 5: コミット**

```bash
git add src/db/local-db.ts
git commit -m "refactor: loadAllSyncedVclocks を PathKey で正規化 + stale key マイグレーション"
```

---

### Task 3: `vault-sync.ts` — インメモリ構造を PathKey 化

本体。`lastSyncedVclock` と `skippedPaths` の全アクセスを `PathKey` 経由にする。

**Files:**
- Modify: `src/sync/vault-sync.ts`

- [ ] **Step 1: import 追加**

```typescript
// src/sync/vault-sync.ts:1 付近
import { toPathKey, type PathKey } from "../utils/path.ts";
```

- [ ] **Step 2: `lastSyncedVclock` の型を変更**

```typescript
// L50
private lastSyncedVclock = new Map<PathKey, VectorClock>();
```

- [ ] **Step 3: `skippedPaths` の型を変更**

```typescript
// L56
private skippedPaths: Set<PathKey> | null = null;
```

- [ ] **Step 4: `loadLastSyncedVclocks` — ロードは既に `PathKey` で返ってくるのでそのまま**

```typescript
// L75-81: loadAllSyncedVclocks() の返却型が Map<PathKey, VectorClock> に
// なったので、型は自動的に合う。変更不要。
```

- [ ] **Step 5: `fileToDb` — L136-138 の onCommit で `.set` を正規化**

```typescript
// L136-138 を書き換え
vclocks: [{ path, op: "set", clock: newVclock }],
onCommit: () => {
    this.lastSyncedVclock.set(toPathKey(path), newVclock);
},
```

- [ ] **Step 6: `dbToFile` — L211-213 の vclock set を正規化**

```typescript
// L210-213 を書き換え
await this.db.runWrite({
    vclocks: [{ path: vaultPath, op: "set", clock }],
});
this.lastSyncedVclock.set(toPathKey(vaultPath), clock);
```

- [ ] **Step 7: `compareFileToDoc` — L233 の get を正規化**

```typescript
// L233 を書き換え
const lastSynced = this.lastSyncedVclock.get(toPathKey(filePathFromId(fileDoc._id)));
```

- [ ] **Step 8: `markDeleted` — L250-251, L265-266 の delete を正規化**

```typescript
// L250-251 を書き換え（既に deleted 分岐）
vclocks: [{ path, op: "delete" }],
onCommit: () => { this.lastSyncedVclock.delete(toPathKey(path)); },

// L265-266 を書き換え（通常分岐）
vclocks: [{ path, op: "delete" }],
onCommit: () => { this.lastSyncedVclock.delete(toPathKey(path)); },
```

- [ ] **Step 9: `hasUnpushedChanges` — L306 の get を正規化**

```typescript
// L305-309 を書き換え
hasUnpushedChanges(path: string, localVclock: VectorClock): boolean {
    const lastSynced = this.lastSyncedVclock.get(toPathKey(path));
    if (!lastSynced) return false;
    return compareVC(localVclock, lastSynced) !== "equal";
}
```

- [ ] **Step 10: `loadSkippedCache` — L319 の Set 構築を正規化**

```typescript
// L316-321 を書き換え
private async loadSkippedCache(): Promise<Set<PathKey>> {
    if (this.skippedPaths) return this.skippedPaths;
    const doc = await this.db.getSkippedFiles();
    this.skippedPaths = new Set(Object.keys(doc.files).map(toPathKey));
    return this.skippedPaths;
}
```

- [ ] **Step 11: `wasSkipped` — L323-326 の has を正規化**

```typescript
// L323-326 を書き換え
private async wasSkipped(path: string): Promise<boolean> {
    const cache = await this.loadSkippedCache();
    return cache.has(toPathKey(path));
}
```

- [ ] **Step 12: `recordSkipped` — L328-343 の doc.files アクセスと cache.add を正規化**

```typescript
// L328-343 を書き換え
private async recordSkipped(path: string, sizeMB: number, limitMB: number): Promise<void> {
    const doc = await this.db.getSkippedFiles();
    const key = toPathKey(path);
    const existing = doc.files[key];
    const roundedSize = Math.round(sizeMB * 10) / 10;
    const isNew = !existing || Math.round(existing.sizeMB * 10) / 10 !== roundedSize;
    doc.files[key] = { sizeMB: roundedSize, skippedAt: Date.now() };
    await this.db.putSkippedFiles(doc);
    (await this.loadSkippedCache()).add(key);
    if (isNew) {
        notify(
            `Skipped "${path}" — ${roundedSize} MB exceeds ${limitMB} MB limit. ` +
                `Raise the limit in settings to sync it.`,
            8000,
        );
    }
}
```

Note: `notify()` には元 case の `path` を渡す（ユーザー表示用）。`doc.files` のキーは `PathKey` で保存。

- [ ] **Step 13: `forgetSkipped` — L345-351 の doc.files アクセスと cache.delete を正規化**

```typescript
// L345-351 を書き換え
private async forgetSkipped(path: string): Promise<void> {
    const doc = await this.db.getSkippedFiles();
    const key = toPathKey(path);
    if (!(key in doc.files)) return;
    delete doc.files[key];
    await this.db.putSkippedFiles(doc);
    this.skippedPaths?.delete(key);
}
```

- [ ] **Step 14: ビルド確認**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 15: 既存テスト pass 確認**

Run: `npx vitest run`
Expected: 全テスト pass

- [ ] **Step 16: コミット**

```bash
git add src/sync/vault-sync.ts
git commit -m "refactor: VaultSync の全パスキーを PathKey で統一"
```

---

### Task 4: テスト — VaultSync の case-insensitive 動作を検証

VaultSync のユニットテストファイルを新規作成し、PathKey 化の正しさを検証する。

**Files:**
- Create: `tests/vault-sync-pathkey.test.ts`

- [ ] **Step 1: テストファイル作成 — `compareFileToDoc` の case 違い検証**

```typescript
// tests/vault-sync-pathkey.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VectorClock } from "../src/sync/vector-clock.ts";
import type { PathKey } from "../src/utils/path.ts";
import { toPathKey } from "../src/utils/path.ts";

/**
 * VaultSync の lastSyncedVclock は private なので、同じ PathKey
 * ロジックを Map<PathKey, VectorClock> で再現して動作を検証する。
 * VaultSync 本体のメソッドを直接テストすると Obsidian App の
 * モック量が膨大になるため、PathKey キーイングの正しさに
 * フォーカスした軽量テスト。
 */
describe("PathKey-keyed Map (lastSyncedVclock pattern)", () => {
    let map: Map<PathKey, VectorClock>;

    beforeEach(() => {
        map = new Map();
    });

    it("case-insensitive set/get — vault case で書き込み、DB case で取得", () => {
        const vc: VectorClock = { "device-a": 3 };
        map.set(toPathKey("README.md"), vc);
        expect(map.get(toPathKey("readme.md"))).toBe(vc);
    });

    it("case-insensitive delete — vault case で書き込み、DB case で削除", () => {
        map.set(toPathKey("Notes/TODO.md"), { "device-a": 1 });
        map.delete(toPathKey("notes/todo.md"));
        expect(map.size).toBe(0);
    });

    it("Unicode NFC normalization — precomposed と decomposed が同一キー", () => {
        const vc: VectorClock = { "device-a": 1 };
        map.set(toPathKey("caf\u00e9.md"), vc);
        expect(map.get(toPathKey("cafe\u0301.md"))).toBe(vc);
    });

    it("同一 PathKey への上書き — 後勝ち", () => {
        map.set(toPathKey("File.md"), { "device-a": 1 });
        map.set(toPathKey("file.md"), { "device-a": 2 });
        expect(map.size).toBe(1);
        expect(map.get(toPathKey("FILE.md"))?.["device-a"]).toBe(2);
    });
});

describe("PathKey-keyed Set (skippedPaths pattern)", () => {
    it("case-insensitive has", () => {
        const set = new Set<PathKey>();
        set.add(toPathKey("BigFile.zip"));
        expect(set.has(toPathKey("bigfile.zip"))).toBe(true);
        expect(set.has(toPathKey("BIGFILE.ZIP"))).toBe(true);
    });

    it("case-insensitive delete", () => {
        const set = new Set<PathKey>();
        set.add(toPathKey("Archive/Large.tar"));
        set.delete(toPathKey("archive/large.tar"));
        expect(set.size).toBe(0);
    });
});
```

- [ ] **Step 2: テスト実行 — pass 確認**

Run: `npx vitest run tests/vault-sync-pathkey.test.ts`
Expected: 全テスト pass

- [ ] **Step 3: `vclockMetaKey` の正規化テスト追加**

`tests/utils/path.test.ts` に以下を追記：

```typescript
import { VCLOCK_KEY_PREFIX, vclockMetaKey } from "../../src/db/dexie-store.ts";

describe("vclockMetaKey", () => {
    it("normalizes the path portion of the key", () => {
        expect(vclockMetaKey("README.md")).toBe(
            VCLOCK_KEY_PREFIX + "readme.md",
        );
    });

    it("produces the same key for case-only differences", () => {
        expect(vclockMetaKey("Notes/TODO.md")).toBe(
            vclockMetaKey("notes/todo.md"),
        );
    });
});
```

- [ ] **Step 4: テスト実行 — 全テスト pass 確認**

Run: `npx vitest run`
Expected: 全テスト pass

- [ ] **Step 5: コミット**

```bash
git add tests/vault-sync-pathkey.test.ts tests/utils/path.test.ts
git commit -m "test: VaultSync PathKey 統一の動作検証テスト追加"
```

---

### Task 5: 最終検証

**Files:** なし（検証のみ）

- [ ] **Step 1: TypeScript ビルド**

Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 2: 全テスト pass**

Run: `npx vitest run`
Expected: 全テスト pass、新テスト含む

- [ ] **Step 3: 変更差分の最終確認**

Run: `git diff --stat HEAD`
Expected: 変更ファイル一覧が以下と一致：
- `src/db/dexie-store.ts` — `vclockMetaKey` 正規化 + import
- `src/db/local-db.ts` — `loadAllSyncedVclocks` 正規化 + マイグレーション + import
- `src/sync/vault-sync.ts` — 全パスキー `PathKey` 化 + import
- `tests/vault-sync-pathkey.test.ts` — 新規
- `tests/utils/path.test.ts` — `vclockMetaKey` テスト追加
