# VaultSync PathKey 統一設計

## コンテキスト

reconciler で `PathKey`（NFC + lowercase）を導入し、case-insensitive FS 上での
vault/DB パス比較を正規化した。しかし VaultSync 内部のパスキー構造は未正規化のまま
残っており、同根のバグが潜在している：

- `lastSyncedVclock`: vault 側で `"README.md"` として書き込んだエントリを、
  DB 由来の `"readme.md"` で取得 → miss → 常に `remote-pending` 判定
- `skippedPaths`: 同一ファイルが大文字小文字違いで二重にスキップ判定される可能性
- 永続化キー `_local/vclock/<path>`: 正規化なしで書き込むため、同一論理パスに
  複数エントリが蓄積しうる

## 設計

### 原則

1. **パスキーは PathKey で統一** — インメモリ・永続化ともに正規化済みキーを使用
2. **FS I/O は常に元パス** — PathKey はキー/比較専用。ファイル操作には元 case を使用
3. **パブリック API 境界で正規化** — caller に PathKey を意識させない。内部で `toPathKey()`

### 変更対象

#### 1. `vault-sync.ts` — インメモリ構造

```typescript
// Before
private lastSyncedVclock = new Map<string, VectorClock>();
private skippedPaths: Set<string> | null = null;

// After
private lastSyncedVclock = new Map<PathKey, VectorClock>();
private skippedPaths: Set<PathKey> | null = null;
```

全 `.set()` / `.get()` / `.delete()` / `.has()` 呼び出しでキーを `toPathKey()` 経由にする。

対象メソッド:
- `loadLastSyncedVclocks()` — ロード時に `toPathKey()` で正規化
- `fileToDb()` — L138: `.set(toPathKey(path), newVclock)`
- `dbToFile()` — L213: `.set(toPathKey(vaultPath), clock)`
- `compareFileToDoc()` — L233: `.get(toPathKey(filePathFromId(...)))`
- `markDeleted()` — L251, L266: `.delete(toPathKey(path))`
- `hasUnpushedChanges()` — L306: `.get(toPathKey(path))`
- `loadSkippedCache()` — `.add(toPathKey(...))`
- `wasSkipped()` — `.has(toPathKey(path))`
- `recordSkipped()` — `.add(toPathKey(path))`
- `forgetSkipped()` — `.delete(toPathKey(path))`

#### 2. `dexie-store.ts` — 永続化キー正規化

```typescript
// Before
export function vclockMetaKey(path: string): string {
    return VCLOCK_KEY_PREFIX + path;
}

// After
export function vclockMetaKey(path: string): string {
    return VCLOCK_KEY_PREFIX + toPathKey(path);
}
```

書き込み時に自動的に正規化されるので、caller 側の変更は不要。

#### 3. `local-db.ts` — ロード時マイグレーション

`loadAllSyncedVclocks()` で：
- 既存エントリのキーを `toPathKey()` で正規化して読み込む
- 同一 PathKey に複数の生パスがマッピングされている場合（レガシーデータ）、
  いずれか一つを採用（後勝ち — 実質的に差異はない）
- 正規化済みの新キーを書き込み、旧キーを削除（ワンショットマイグレーション）

#### 4. `SkippedFilesDoc` のキー正規化

`vault-sync.ts` 内の `recordSkipped()` / `forgetSkipped()` で
`doc.files` への read/write 時に `toPathKey()` を適用。
`SkippedFilesDoc` の型定義自体は変えない（永続化 JSON のスキーマ互換性維持）。

### パブリック API への影響

| メソッド | 引数型 | 変更 |
|---|---|---|
| `hasUnpushedChanges(path, vc)` | `string` | 変更なし。内部で正規化 |
| `fileToDb(file)` | `TFile` | 変更なし。`file.path` を内部で正規化 |
| `dbToFile(doc)` | `FileDoc` | 変更なし |
| `markDeleted(path)` | `string` | 変更なし。内部で正規化 |
| `handleRename(file, oldPath)` | `TFile, string` | 変更なし |

caller（`main.ts`, `reconciler.ts`）への変更は不要。

### テスト

- `vault-sync.ts` のユニットテスト（既存テストの拡張）：
  - case 違いの set/get が同一エントリとして扱われることを検証
  - `compareFileToDoc` で DB パスと vault パスの case が異なるケース
  - `hasUnpushedChanges` で case 違いパスを渡すケース
- `loadAllSyncedVclocks` マイグレーションテスト：
  - 旧フォーマット（非正規化キー）からの読み込みで正規化されることを検証
- 既存テストが壊れないことの確認

### 検証方法

1. `npm test` — 全テスト pass
2. `npm run build` — TypeScript コンパイル成功
3. case 違いテストケースの追加と pass 確認
