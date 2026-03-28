# obsidian-couchsync: CouchDB専用LiveSyncフォーク 実装計画

## Context

obsidian-livesyncは3つの同期バックエンド(CouchDB/MinIO/P2P)をサポートするが、CouchDBセルフホストのみ使用する場合、他バックエンドのコードが不要な複雑性と依存関係の肥大化を招いている。さらにCouchDB接続パスに8つの信頼性問題が発見された。本フォークは不要なバックエンドを削除し、CouchDB接続の信頼性を向上させる。

## 実行開始時の最初のステップ
- `C:/VScode/obsidian-couchsync/` にプラグイン開発フォルダを作成
- 元リポジトリからコピー
- この計画書を `docs/IMPLEMENTATION_PLAN.md` として配置

---

## Phase 1: フォーク作成とバックエンド削除

### Step 1.1: フォークとリネーム
- `manifest.json`: id を `obsidian-couchsync` に変更、名前・説明を更新
- `package.json`: name 変更、S3/P2P関連テストスクリプト削除

### Step 1.2: ファイル削除
| 削除対象 | 内容 |
|---|---|
| `src/lib/src/replication/journal/` | MinIO同期 (4ファイル, ~1,784行) |
| `src/lib/src/replication/trystero/` | P2P同期 (14ファイル, ~2,602行) |
| `src/modules/core/ModuleReplicatorMinIO.ts` | MinIOモジュール |
| `src/modules/core/ModuleReplicatorP2P.ts` | P2Pモジュール |
| `src/features/P2PSync/` | P2P機能UI |
| `src/serviceFeatures/useP2PReplicatorUI.ts` | P2P UI機能 |
| `src/apps/cli/`, `src/apps/webapp/`, `src/apps/webpeer/` | 非Obsidianアプリ |

### Step 1.3: インポート修正
- **`src/LiveSyncBaseCore.ts`** (行136-144): MinIOモジュール登録削除、journalインポート削除
- **`src/main.ts`** (行42-44, 184-190): P2Pインポート・登録削除
- **`src/modules/core/ModuleReplicatorCouchDB.ts`**: REMOTE_MINIO/P2Pガード条件削除、常にCouchDBリプリケーターを返す

### Step 1.4: 型システム簡素化
- **`setting.const.ts`**: `REMOTE_MINIO`, `REMOTE_P2P` 削除
- **`setting.type.ts`**: `BucketSyncSetting`, `P2PSyncSetting` 削除、`RemoteDBSettings` union型を簡素化

### Step 1.5: 設定UI簡素化
- **`PaneRemoteConfig.ts`**: MinIO/P2Pパネル削除 (UIの42%)
- **`settingUtils.ts`**: `getBucketConfigSummary`, `getP2PConfigSummary` 削除

### Step 1.6: 依存関係削除 (package.json)
削除: `@aws-sdk/client-s3`, `@smithy/*` (6パッケージ), `trystero`, `node-datachannel`, `commander`, `pouchdb-adapter-leveldb`
→ バンドル ~950KB削減見込み

### 検証
- `npm install` → `npm run tsc-check` → `npm run build`
- Obsidianで手動テスト: プラグイン読み込み、設定画面、既存CouchDB同期動作確認

---

## Phase 2: CouchDB信頼性修正 (Critical)

### Step 2.1: REPLICATION_BUSY_TIMEOUT修正
- **ファイル**: `src/lib/src/common/models/shared.const.behabiour.ts`
- 3,000,000ms (50分) → 300,000ms (5分) に修正

### Step 2.2: エラー黙殺修正
- **ファイル**: `src/lib/src/replication/couchdb/LiveSyncReplicator.ts` (行244-279)
- catch内でログレベルをNOTICEに昇格、syncStatusをERROREDに設定
- 呼び出し元に失敗を伝播させる

### Step 2.3: 401認証リフレッシュ追加
- **ファイル**: `src/lib/src/services/base/RemoteService.ts`
- fetchコールバック内で401検出時にJWTトークン再生成→1回リトライ

### Step 2.4: チャンク送信の部分リカバリ
- **ファイル**: `LiveSyncReplicator.ts` (行581-613)
- 失敗バッチを3回まで指数バックオフでリトライ
- 失敗時はバッチを分割して再送
- 進捗ログ: "Sent X/Y chunks, Z failed"

### 検証
- 新規リトライロジックのユニットテスト
- CouchDB Docker環境でのテスト
- ネットワーク切断→復旧のシナリオテスト

---

## Phase 3: CouchDB信頼性修正 (High)

### Step 3.1: 指数バックオフリトライユーティリティ
- `retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, jitter: true })`
- RemoteService.tsのfetchコールバックに適用 (ネットワークエラー/5xxのみ)

### Step 3.2: バッチサイズリトライに遅延追加
- **ファイル**: `LiveSyncReplicator.ts` (行750-770, 952-971)
- 2秒から倍増する遅延、最大リトライ深度5回、深度超過時は`FAILED`

### Step 3.3: SyncParams競合状態修正
- **ファイル**: `SyncParamsHandler.ts` (行85-95)
- 409コンフリクト検出→shouldRetry=trueでループ再実行、最大3回

### Step 3.4: レプリケーションコントローラーrace condition修正
- **ファイル**: `LiveSyncReplicator.ts` (行317-320)
- `serialized`ロックでcontroller交換をガード

### 検証
- retryWithBackoffユニットテスト
- SyncParams 409ハンドリングテスト
- 同時同期操作テスト

---

## Phase 4: クリーンアップ

### Step 4.1: 抽象リプリケーター整理
- `LiveSyncAbstractReplicator.ts`を維持しつつ、MinIO/P2P専用メソッド削除（保守的アプローチ）

### Step 4.2: 不要な設定デフォルト値削除
- `setting.const.defaults.ts`からMinIO/P2P設定値を削除
- 既存vault保存データとの後方互換性は維持（未知フィールドは無視される）

### Step 4.3: ビルド設定更新
- `esbuild.config.mjs`, `vite.config.ts`からP2P worker設定削除

### Step 4.4: ドキュメント整備
- README更新（フォーク目的、CouchDB専用スコープ、信頼性改善）
- 移行ノート

### 最終検証
- フルビルド・lint
- テスト全パス
- 手動テスト: 新規vault / 既存vault / E2EE / 大ファイル / ネットワーク断→復旧 / LiveSync長時間安定性

---

## リスクと注意点

1. **保存設定の互換性**: 既存vaultにはMinIO/P2P設定フィールドが保存されている。TypeScriptの構造的型付けにより未知フィールドは無視されるため問題なし
2. **CouchDBデータ形式**: ドキュメント形式・PouchDBレプリケーションプロトコル・暗号化方式は変更しない。元プラグインとの相互互換性を維持
3. **upstream追従**: 元リポジトリの活発な開発により、時間が経つほどマージが困難に。共通部分のバグ修正は手動マージが必要

## 重要ファイル一覧
- `src/lib/src/replication/couchdb/LiveSyncReplicator.ts` — CouchDBリプリケーター (1,362行、6/8の修正対象)
- `src/lib/src/services/base/RemoteService.ts` — HTTP接続層 (リトライ・401対応)
- `src/LiveSyncBaseCore.ts` — モジュール登録
- `src/main.ts` — プラグインエントリポイント
- `src/lib/src/common/models/setting.type.ts` — 型定義
- `src/lib/src/common/models/shared.const.behabiour.ts` — タイムアウト定数
- `src/lib/src/replication/SyncParamsHandler.ts` — 同期パラメータ管理
