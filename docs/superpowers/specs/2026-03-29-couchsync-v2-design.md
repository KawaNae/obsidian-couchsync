# CouchSync v2 — ゼロから作り直し設計

## Context
obsidian-couchsyncはobsidian-livesyncのフォークだが、サブモジュール依存・180設定項目・複雑な抽象化層が保守の障壁になっている。CouchDB同期の本質的なロジック（PouchDBレプリケーション + チャンク分割）を参照しつつ、ゼロからシンプルに再実装する。diff-historyプラグインの履歴機能も統合する。

## 決定事項
- **PouchDB + CouchDB** レプリケーション（仕組み踏襲、フォーマット新規）
- **クリーンスタート** — 既存livesyncのDBとの互換性なし
- **E2EE なし**
- **Liveモードのみ** — `live: true, retry: true` で常時双方向同期
- **フラットサービス構成** — diff-history/wasm-imageと同じパターン
- **diff-history統合** — ローカル履歴をDexieに保存、PouchDBとは独立
- **Vault + Hidden File + Plugin Sync** 全対応

---

## ストレージ構造

CouchSync は **vault DB と config DB を物理的に分離** する。これは「異なる共有スコープのデータは異なる replication boundary を持つ」という原則の具体化：
- **Vault DB** (`couchdbDbName`): 全デバイスで共有する vault の中身。FileDoc + ChunkDoc のみ
- **Config DB(s)** (`couchdbConfigDbName`): デバイスのプール（mobile / desktop など）ごとに独立可能な `.obsidian/` 設定。ConfigDoc のみ

1 つの CouchDB サーバー上で `obsidian-dev` (vault) + `obsidian-dev-config-mobile` + `obsidian-dev-config-desktop` を並列に持てる。各デバイスは vault DB には必ず接続し、config DB は自分の pool 名を選ぶ。`couchdbConfigDbName === ""` で config sync 機能を完全に無効化できる。

CouchDB credentials（URI / User / Password）は両 DB で共有する。同一サーバー前提。

## ドキュメントフォーマット

### ID 体系（統一）

すべての replicated ドキュメントは `<kind>:<payload>` 形式のプレフィックス付き `_id` を持つ。PouchDB 予約の `_local/<name>` は尊重し、それ以外に bare な `_id` は存在しない。生成・判定・パースは `src/types/doc-id.ts` の単一モジュールに集約し、呼び出し側は生の `startsWith` / `slice` を使ってはならない。

```
file:<vaultPath>      FileDoc    例: file:notes/hello.md          (vault DB)
chunk:<xxhash64>      ChunkDoc   例: chunk:a1b2c3d4...            (vault DB)
config:<vaultPath>    ConfigDoc  例: config:.obsidian/appearance.json  (config DB)
_local/<name>         PouchDB reserved（非レプリケート）
```

3 プレフィックスは lexicographically disjoint（`chunk:` < `config:` < `file:`）。`allDocs({ startkey, endkey })` で種別ごとの range query が成立する。

**不変条件**：vault DB には `config:*` doc が存在してはならず、config DB には `file:*` / `chunk:*` doc が存在してはならない。起動時の schema guard が両方向で検証する。

### VectorClock（因果順序）
```typescript
type VectorClock = Record<string, number>; // deviceId → logical counter
```
すべての replicated ドキュメントは `vclock` を必須で持つ。順序判定は Vector Clock のみで行い、`mtime` / `ctime` は表示用メタデータとしてのみ保持する（last-write-wins には使わない）。

### FileDoc（ノート・画像・添付ファイル）
```typescript
interface FileDoc {
  _id: string;              // makeFileId(path) = "file:<vaultPath>"
  _rev?: string;
  type: "file";
  chunks: string[];         // ["chunk:<hash1>", "chunk:<hash2>"]
  mtime: number;            // 表示用のみ。順序付けには使わない
  ctime: number;            // 表示用のみ
  size: number;
  deleted?: boolean;
  vclock: VectorClock;      // 因果順序。必須
}
```

### ChunkDoc（ファイルの断片）
```typescript
interface ChunkDoc {
  _id: string;              // makeChunkId(hash) = "chunk:<hash>"
  _rev?: string;
  type: "chunk";
  data: string;             // base64
}
```

### ConfigDoc（`.obsidian/` 配下のファイル）

`.obsidian/` 配下のテーマ・スニペット・プラグイン設定を含む、vault 直下のドット始まり領域を扱う。scan-based sync（常駐監視ではなく明示的な rescan/write）。

```typescript
interface ConfigDoc {
  _id: string;              // makeConfigId(path) = "config:<vaultPath>"
  _rev?: string;
  type: "config";
  data: string;             // base64
  mtime: number;            // 表示用のみ
  size: number;
  deleted?: boolean;
  vclock: VectorClock;      // 必須
}
```

> **設計メモ**: 初期案では `HiddenFileDoc` と `PluginConfigDoc` を分離する構想があったが、両者とも「vault 直下のドット始まりファイルを base64 で保存」という同一ストレージ形状のため `ConfigDoc` に統合した。将来プラグイン設定固有の振る舞い（deviceName 付与など）が必要になった時点で専用の doc type を切り出す。

### ローカル専用メタデータ

`_local/<name>` プレフィックスの PouchDB 予約空間に置く。複製されない：
- `_local/scan-cursor` — Reconciler の fast-path で使う前回スキャン情報（vault DB のみ）
- `_local/vault-manifest` — 削除検出用の vault パス集合スナップショット（vault DB のみ）
- `_local/skipped-files` — `maxFileSizeMB` を超えて同期除外されたファイル一覧（vault DB のみ）

`deviceId` は PouchDB ではなく Obsidian の `data.json` (plugin settings) に保存する。専用の `_local` ドキュメントは持たない。

### Local PouchDB instances

各 vault に対して 2 つの local PouchDB instance を持つ（IndexedDB 内で別ストア）：
- `couchsync-${vaultName}` — vault DB のローカルレプリカ
- `couchsync-${vaultName}-config-${configDbName}` — config DB のローカルレプリカ。`configDbName` を含めることで pool 切り替え時に自然に新しいローカル DB が作られる

---

## ファイル構成

```
src/
├── main.ts                    — Plugin entry, サービス初期化
├── types.ts                   — 全ドキュメント型・共通型
├── types/
│   └── doc-id.ts              — _id 生成・判定・パースの単一 source of truth
├── settings.ts                — Settings interface + defaults
├── settings-tab/
│   ├── index.ts               — SettingTab (task-viewerタブパターン)
│   ├── vault-sync-tab.ts      — Vault sync 設定 (Connection + Setup + Live Sync + Filters)
│   ├── config-sync-tab.ts     — Config sync 設定 (Connection + Operations)、vault と並列の step UI
│   ├── history-tab.ts         — 履歴保持期間・ストレージ設定
│   └── maintenance-tab.ts     — トラブルシュート・リセット
├── db/
│   ├── local-db.ts            — Vault PouchDB 初期化・CRUD（FileDoc + ChunkDoc）
│   ├── config-local-db.ts     — Config PouchDB 初期化・CRUD（ConfigDoc 専用）
│   ├── remote-couch.ts        — URL+認証情報を取る stateless な remote 操作 helper
│   ├── replicator.ts          — Vault DB の CouchDB Live レプリケーション (live sync 専用)
│   ├── chunker.ts             — ファイル→チャンク分割・結合
│   └── gc.ts                  — 未参照チャンクGC
├── sync/
│   ├── vault-sync.ts          — Vaultファイル ↔ DB
│   ├── config-sync.ts         — .obsidian/ ↔ Config DB（scan-based、live sync 無し）
│   └── change-tracker.ts      — ファイル変更検知・デバウンス
├── history/
│   ├── history-db.ts          — Dexie DB (diff/snapshot保存)
│   ├── history-manager.ts     — 履歴キャプチャ・復元ロジック
│   ├── diff-engine.ts         — diff-match-patch wrapper
│   ├── history-view.ts        — サイドバー履歴UI
│   └── diff-modal.ts          — Side-by-side diffモーダル
├── conflict/
│   ├── conflict-resolver.ts   — 自動解決 + 振り分け
│   └── conflict-modal.ts      — 手動解決UI
└── ui/
    ├── status-bar.ts          — 同期状態表示
    └── notices.ts             — Notice通知ヘルパー
```

~22ファイル。各ファイルは1責務。

---

## サービス依存グラフ

```
main.ts
 ├── local-db         ← PouchDB管理
 ├── replicator       ← local-db でCouchDBとLive同期
 ├── vault-sync       ← local-db + chunker + Vault API
 ├── hidden-sync      ← local-db + Vault API
 ├── plugin-sync      ← local-db + Vault API
 ├── change-tracker   ← Vault イベント監視 → sync各サービスに通知
 ├── history-manager  ← history-db + diff-engine
 ├── conflict-resolver← replicator のコンフリクト → auto or modal
 ├── status-bar       ← replicator の状態表示
 └── settings-tab     ← 設定UI
```

---

## 同期フロー

### Live同期（唯一のモード）
PouchDB `live: true, retry: true` で常時双方向レプリケーション。
接続したら自動で同期開始、切断時は自動再接続。

### ローカル変更 → リモート
```
Vault file modified
  → change-tracker (debounce 2s)
  → vault-sync.fileToDb(path)
    → 旧内容との差分をhistory-managerに保存
    → chunker.split(content) → ChunkDoc[]
    → local-db.put(chunks + fileDoc)
  → PouchDB live replication → CouchDB
```

### リモート変更 → ローカル
```
PouchDB receives remote change
  → replicator.onChange(doc)
  → type判別:
    "file"          → vault-sync.dbToFile(doc)
    "hidden"        → hidden-sync.dbToFile(doc)
    "plugin-config" → plugin-sync.apply(doc)
  → conflict検出時 → conflict-resolver.handle(doc)
```

### チャンク分割
- テキスト: 行ベースで最大1000文字/チャンク
- バイナリ: 100KB/チャンク
- チャンクIDはコンテンツのxxhash64ハッシュ（content-addressable）
- 同一チャンクは重複保存しない

---

## 履歴管理（diff-history統合）

### ストレージ
- **Dexie/IndexedDB** でローカル専用（リモートに同期しない）
- diff-historyと同じスキーマ: DiffRecord + FileSnapshot
- PouchDBとは完全に独立

### キャプチャフロー
vault-sync.fileToDb() 内で:
1. 現在のDB内容（前回スナップショット）を取得
2. diff-engine.computePatch(old, new) でパッチ生成
3. history-db.saveDiff(path, patch, stats)
4. history-db.saveSnapshot(path, newContent)

### 復元
1. history-view でファイルの履歴一覧表示
2. 任意の時点を選択 → history-manager.reconstructAtPoint()
3. スナップショットから逆順にパッチ適用して復元
4. change-tracker を一時停止してVaultに書き戻し

### diff UI
- diff-modal: Side-by-side差分表示（diff-historyのDiffCompareModal移植）
- conflict-modal: 同じdiff UIでコンフリクト解決

---

## コンフリクト解決

### Vector Clock による因果判定

全ドキュメントは `vclock: VectorClock`（`Record<deviceId, counter>`）を持ち、書き込みごとに当該デバイスの counter を increment する。2 つの revision を比較する関数 `compareVC(a, b)` は以下のいずれかを返す：

- `equal` — 完全一致
- `dominates` — a が b を包含（`a ≥ b` かつ少なくとも 1 つ `>`）
- `dominated` — b が a を包含
- `concurrent` — 比較不能（並行編集）

### 自動解決
- `dominates` / `dominated`: 勝者を一意に決められるため安全に採用
- 敗者側 revision は PouchDB の conflict ツリーから除去
- `mtime` 比較は一切行わない（クロックスキュー・遅延耐性のため）

### 手動解決
- `concurrent` の場合のみ conflict-modal を開く
- Side-by-side 差分表示で「Local」「Remote」「マージ（結合）」の 3 択
- 解決時は両辺の VC を `mergeVC` で統合した上で当該デバイスの counter を increment → 単一書き込みが両辺を dominate するため再発生しない
- Notice でコンフリクト発生を通知、モーダルで解決

---

## 設定項目（~20項目）

### Connection タブ
- `couchdbUri: string` — CouchDB URI
- `couchdbUser: string` — ユーザー名
- `couchdbPassword: string` — パスワード
- `couchdbDbName: string` — データベース名
- Test Connection ボタン

### Files タブ
- `syncFilter: string` — 同期対象パターン (RegExp)
- `syncIgnore: string` — 除外パターン (RegExp)
- `maxFileSizeMB: number` — 最大ファイルサイズ (default: 50)
- `enableHiddenSync: boolean` — Hidden File同期 (default: false)
- `enablePluginSync: boolean` — Plugin設定同期 (default: false)
- `deviceName: string` — デバイス名 (Plugin Sync用)
- `hiddenSyncIgnore: string` — Hidden除外パターン

### History タブ
- `historyRetentionDays: number` — 保持日数 (default: 30)
- `historyDebounceMs: number` — デバウンス (default: 5000)
- `historyMinIntervalMs: number` — 最小間隔 (default: 60000)
- `historyMaxStorageMB: number` — 最大容量 (default: 500)

### Maintenance タブ
- Fetch from Remote ボタン
- Rebuild Local DB ボタン
- Clear History ボタン
- Reset Settings ボタン
- `showVerboseLog: boolean` — 詳細ログ

---

## 依存関係

```json
{
  "dependencies": {},
  "devDependencies": {
    "pouchdb-browser": "^9.0.0",
    "dexie": "^4.0.0",
    "diff-match-patch": "^1.0.5",
    "@anthropic-ai/sdk": "不要",
    "esbuild": "existing",
    "typescript": "existing",
    "@types/pouchdb-browser": "^6.1.0"
  }
}
```

- **pouchdb-browser** — ローカルDB + CouchDBレプリケーション
- **dexie** — 履歴データ保存（diff-historyから流用）
- **diff-match-patch** — 差分計算（diff-historyから流用）

---

## 実装順序

### Phase 1: 基盤（まず同期が動くまで）
1. プロジェクト初期化（サブモジュール解除、src/一掃、依存追加）
2. types.ts — ドキュメント型定義
3. settings.ts — 設定型・デフォルト値
4. db/local-db.ts — PouchDB初期化・CRUD
5. db/chunker.ts — ファイル分割・結合
6. sync/vault-sync.ts — ファイル ↔ DB 変換
7. sync/change-tracker.ts — ファイル変更検知
8. db/replicator.ts — CouchDB Live レプリケーション
9. main.ts — 最小限のプラグインエントリ
10. settings-tab/ — 接続設定だけの最小UI

### Phase 2: 完全な同期
11. sync/hidden-sync.ts — Hidden File同期
12. sync/plugin-sync.ts — Plugin設定同期
13. conflict/conflict-resolver.ts — 自動コンフリクト解決
14. db/gc.ts — チャンクGC
15. ui/status-bar.ts — 同期状態表示
16. ui/notices.ts — 通知ヘルパー
17. settings-tab/ — 全タブ実装

### Phase 3: 履歴・差分UI
18. history/history-db.ts — Dexie DB
19. history/diff-engine.ts — diff-match-patch wrapper
20. history/history-manager.ts — 履歴キャプチャ・復元
21. history/history-view.ts — サイドバーUI
22. history/diff-modal.ts — Side-by-side diff
23. conflict/conflict-modal.ts — コンフリクト解決UI（diff UIベース）

---

## Verification

### Phase 1 完了時
1. `npm run build` 成功
2. Obsidian でプラグイン有効化
3. CouchDB接続設定 → Test Connection 成功
4. .mdファイルを作成 → PouchDB に保存される
5. CouchDB Fauxton で FileDoc + ChunkDoc を確認

### Phase 2 完了時
6. 2台のデバイスで同じCouchDB → ファイルが双方向同期
7. .obsidian/ 設定ファイルが同期される
8. プラグイン設定が同期される
9. 同時編集時にコンフリクトが自動解決される
10. ステータスバーに同期状態が表示される

### Phase 3 完了時
11. ファイル編集 → サイドバーに履歴エントリ追加
12. 履歴から任意の時点を選択 → Side-by-side diff表示
13. 「復元」で過去の状態に戻せる
14. コンフリクト発生 → diff UI で手動解決できる
