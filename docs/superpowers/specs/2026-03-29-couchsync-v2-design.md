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

## ドキュメントフォーマット

### FileDoc（ノート・画像・添付ファイル）
```typescript
interface FileDoc {
  _id: string;              // ファイルパス "notes/hello.md"
  _rev?: string;
  type: "file";
  chunks: string[];         // ["chunk:<hash1>", "chunk:<hash2>"]
  mtime: number;
  ctime: number;
  size: number;
  deleted?: boolean;
}
```

### ChunkDoc（ファイルの断片）
```typescript
interface ChunkDoc {
  _id: string;              // "chunk:<hash>"
  _rev?: string;
  type: "chunk";
  data: string;             // base64
}
```

### HiddenFileDoc（.obsidian/配下）
```typescript
interface HiddenFileDoc {
  _id: string;              // "hidden:<path>"
  _rev?: string;
  type: "hidden";
  data: string;
  mtime: number;
  size: number;
  deleted?: boolean;
}
```

### PluginConfigDoc（プラグイン設定）
```typescript
interface PluginConfigDoc {
  _id: string;              // "plugin:<pluginId>/<filename>"
  _rev?: string;
  type: "plugin-config";
  data: string;
  mtime: number;
  deviceName: string;
  deleted?: boolean;
}
```

### SyncMetaDoc（ローカル専用メタデータ）
```typescript
interface SyncMetaDoc {
  _id: "_local/sync-meta";
  deviceId: string;
  deviceName: string;
  lastSync: number;
}
```

---

## ファイル構成

```
src/
├── main.ts                    — Plugin entry, サービス初期化
├── types.ts                   — 全ドキュメント型・共通型
├── settings.ts                — Settings interface + defaults
├── settings-tab/
│   ├── index.ts               — SettingTab (task-viewerタブパターン)
│   ├── connection-tab.ts      — CouchDB接続設定 + テスト
│   ├── files-tab.ts           — フィルタ・Hidden/Plugin設定
│   ├── history-tab.ts         — 履歴保持期間・ストレージ設定
│   └── maintenance-tab.ts     — トラブルシュート・リセット
├── db/
│   ├── local-db.ts            — PouchDB初期化・CRUD
│   ├── replicator.ts          — CouchDB Liveレプリケーション
│   ├── chunker.ts             — ファイル→チャンク分割・結合
│   └── gc.ts                  — 未参照チャンクGC
├── sync/
│   ├── vault-sync.ts          — Vaultファイル ↔ DB
│   ├── hidden-sync.ts         — .obsidian/ ファイル同期
│   ├── plugin-sync.ts         — プラグイン設定同期
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

### 自動解決（デフォルト）
- mtime が新しい方を採用
- 同じmtime → _rev が大きい方を採用

### 手動解決
- conflict-modal で Side-by-side 差分表示
- 「Local」「Remote」「マージ（結合）」の3択
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
