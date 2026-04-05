# Content-Aware Safe Sync

**日付:** 2026-04-05
**対象:** obsidian-couchsync v0.5.3 (develop branch)
**前提レポート:** `docs/reports/2026-04-05-mobile-editing-rollback-analysis.md`

---

## Context

モバイルデバイスでの実運用（美術館でのメモ取りなど）で複数の問題が発生している:

- 編集中テキストが数秒前の状態に巻き戻る
- 頻繁なopen/closeサイクルでsyncが完了前にバックグラウンドに入る
- 部分的にしかsyncが届かない
- `reconnectWithPullFirst()`が毎回重いフローを実行（最新でも）

根本原因は`dbToFile()`の無条件上書き、mtime依存のコンフリクト解決、再起動フローの非効率性にある。

### 使用パターンの前提

- **原則として1台で編集**（同時編集はしない）
- ただし両デバイスがオフラインで別々に同じファイルを編集する状況は想定する
- モバイルでは頻繁にopen/close/バックグラウンド移行が発生する
- ネットワークは不安定になりうる（モバイル回線、WiFi切替）

---

## 設計: 3レイヤー防御

### Layer 1: dbToFile() Safe Write

**対象ファイル:** `src/sync/vault-sync.ts` — `dbToFile()`

現在の`dbToFile()`は受信ドキュメントを無条件でvaultに書き込む。これを2段階のガードで保護する。

#### 判定フロー

```
dbToFile(remoteDoc: FileDoc) {
  const file = app.vault.getAbstractFileByPath(remoteDoc._id);

  // --- Step 1: Content比較 (chunk ID) ---
  // ローカルファイルの内容からchunk IDを計算し、remoteDoc.chunksと比較
  // 同じ → SKIP（何もしない）
  // 違う → Step 2へ
  //
  // 大半のケース（再起動時、echo、重複pull）はここで終了

  // --- Step 2: 鮮度比較 (editedAt vs local mtime) ---
  // remoteDoc.editedAt と localFile.stat.mtime を比較
  //
  // remoteDoc.editedAtの方が新しい → APPLY（vault.modify）
  // localFile.stat.mtimeの方が新しい → SKIP（ローカル保護）
  //   ローカルの変更がfileToDb()経由でCouchDBに届けば
  //   自然にコンフリクトが発生し、conflict-resolverが処理する
  //
  // editedAtが未設定（旧ドキュメント）の場合 → 現行のmtime比較にフォールバック
}
```

#### Content比較のコストについて

Step 1でローカルファイルの内容を読み込み、chunk IDを計算する必要がある。これは`splitIntoChunks()`を使用するため、ファイル読み込み + ハッシュ計算のコストが発生する。ただし:

- `vault.modify()`（現行の無条件上書き）もファイルI/Oを行うため、比較のコストは上書きのコストと同等
- 大半のケース（同一内容）でvault.modify()を**スキップできる**ため、トータルではI/O削減になる
- バイナリファイル（画像等）は大きい場合があるが、chunk IDの比較だけで済む（内容全体の比較は不要）

#### 解決する問題

| 問題 | 対処 |
|------|------|
| dbToFileの無条件上書き | chunk比較でスキップ |
| 自分が最新の場合の不要な処理 | chunk比較で0コストで検出 |
| 編集中ファイルの巻き戻り | 鮮度比較でローカル保護 |
| PC echo衝突 | chunk比較で同一内容のechoを検出 |
| pull中断後の再pullでの重複適用 | chunk比較で適用済みdocをスキップ |

---

### Layer 2: editedAtフィールドとコンフリクト解決改善

**対象ファイル:** `src/types.ts`, `src/sync/vault-sync.ts`, `src/conflict/conflict-resolver.ts`

#### 2a: FileDocスキーマ拡張

```typescript
interface FileDoc extends CouchSyncDocBase {
    type: "file";
    chunks: string[];
    mtime: number;       // 既存: ディスク書き込み時刻
    ctime: number;       // 既存
    size: number;        // 既存
    deleted?: boolean;   // 既存
    editedAt?: number;   // 新規: ユーザーが実際に編集した時刻 (Date.now(), UTC)
    editedBy?: string;   // 新規: 編集したdeviceId
}
```

- `editedAt`は`fileToDb()`でのみセットされる（`dbToFile()`経由の書き込みではセットしない）
- これによりPC中継によるmtime laundering問題を解決
- `Date.now()`はUNIXタイムスタンプ（UTC）なのでタイムゾーン・時差の影響なし
- `editedAt`が未設定の旧ドキュメントには`mtime`をフォールバック値として使用

#### 2b: fileToDb()でのeditedAtセット

```typescript
// vault-sync.ts — fileToDb()内
const fileDoc: FileDoc = {
    _id: file.path,
    type: "file",
    chunks: chunkIds,
    mtime: file.stat.mtime,
    ctime: file.stat.ctime,
    size: file.stat.size,
    editedAt: Date.now(),        // 新規: ユーザー編集時刻
    editedBy: this.deviceId,     // 新規: 編集デバイス
};
```

#### 2c: コンフリクト解決の改善

```typescript
// conflict-resolver.ts
// 現在: mtime比較
//   if (conflicting.mtime > winner.mtime)
// 改善: editedAt比較（フォールバックあり）
//   const winnerTime = winner.editedAt ?? winner.mtime;
//   const conflictTime = conflicting.editedAt ?? conflicting.mtime;
//   if (conflictTime > winnerTime)
```

#### 後方互換性

- `editedAt`はオプショナルフィールド（`?`付き）
- 旧バージョンのプラグインが生成したドキュメントには`editedAt`がない → `mtime`にフォールバック
- 旧バージョンのプラグインは`editedAt`フィールドを無視する（未知のフィールドはPouchDBが保持）
- マイグレーション不要

---

### Layer 3: 再起動フローの最適化

**対���ファイル:** `src/main.ts` — `reconnectWithPullFirst()`

#### 改善後のフロー

```
reconnect() {
  if (this.reconnecting) return;  // 既存のreentrancy guard
  this.reconnecting = true;

  // Phase 1: Pull（changeTrackerは止めない）
  //   replicator.stop() → pullFromRemote() → replicator.start()
  //
  //   pullFromRemote()の結果を取得し、各docについてdbToFile()を呼ぶ
  //   Layer 1のSafe Writeにより:
  //   - 内容が同じdocは自動スキップ（コスト最小）
  //   - ローカルが新しいdocはスキップ（保護）
  //   - リモートが新しいdocのみ適用

  // Phase 2: Live Sync開始
  //   replicator.start()

  // Phase 3: Change Tracker再開
  //   changeTracker.start()
  //   500ms固定待機を廃止
  //   → dbToFile()のSafe Writeがあるため、changeTrackerの
  //     即時再開でecho問題は発生しない

  this.reconnecting = false;
}
```

#### 500ms待機の廃止について

現在の500ms待機は「dbToFileが書いたファイルをchangeTrackerが拾ってechoしないように」するためのもの。Layer 1のcontent比較により:
- dbToFileが書いたファイルの内容 = DBの内容 → fileToDb()のchunk比較でスキップ
- よって500ms待機は不要になる

#### Live Sync中のonChangeハンドラも同様に改善

```typescript
// main.ts — replicator.onChange()内
// 現在: changeTracker.pause() → dbToFile → 500ms後resume
// 改善: dbToFile()のSafe Writeに任せ、pause/resumeを簡略化
//   dbToFile()が内容比較でスキップした場合、pause/resumeすら不要
```

---

## 変更対象ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `src/types.ts` | FileDocに`editedAt`, `editedBy`フィールド追加 |
| `src/sync/vault-sync.ts` | dbToFile(): chunk比較+editedAt比較ガード追加 |
| `src/sync/vault-sync.ts` | fileToDb(): editedAt, editedByセット |
| `src/conflict/conflict-resolver.ts` | mtime比較をeditedAt比較に変更 |
| `src/main.ts` | reconnectWithPullFirst(): 500ms待機廃止、フロー簡略��� |
| `src/main.ts` | onChange handler: pause/resume簡略化 |

---

## 既存関数の再利用

- `splitIntoChunks()` — dbToFile()内でローカルファイルのchunk ID計算に再利用
- `isFileDoc()` — 既存のtype guard
- `SyncMetaDoc.deviceId` — editedByフィールドの値として再利用

---

## 検証計画

### 1. 単体テスト

- dbToFile(): 内容同一時にスキップすること
- dbToFile(): remoteのeditedAtが新しい場合に適用すること
- dbToFile(): localのmtimeが新しい場合にスキップすること
- dbToFile(): editedAtが未設定の旧docでmtimeフォールバックすること
- conflict-resolver: editedAtベースで正しい勝者を選ぶ���と
- conflict-resolver: editedAt未設定時にmtimeフォールバックすること
- fileToDb(): editedAtとeditedByがセットされること

### 2. 統合テスト

- PC echo衝突シナリオ（レポートのシナリオA）が発生しないこと
- モバイルネットワーク再接続シナリオ（シナリオB）が発生しないこと
- オフラインフォーク時にコンフリクト解決が正しく動作すること

### 3. 手動テスト

- モバイルで編集中にPC側のObsidianも起動 → 巻き戻りが発生しないこと
- 頻繁なopen/close/バックグラウンド移行 → syncが安定していること
- 再起動時に最新の場合 → 即座にconnected状態になること
- 両デバイスオフラインで別々に編集 → 再接続後にeditedAtベースで解決されること
