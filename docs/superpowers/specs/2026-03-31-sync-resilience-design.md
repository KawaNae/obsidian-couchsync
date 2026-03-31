# Sync Resilience Design

## Problem

PouchDB の live sync がサイレントに停止しても検知・復旧できず、ローカルDBに書き込まれた変更が送信されないまま放置される。iPad で編集した内容がデスクトップに反映されない事象が確認された。

### 根本原因

1. **ヘルスチェックが接続の生存だけを見る** — リモートに `info()` できるか確認するだけで、ローカルに未送信の変更があるかは検知しない
2. **visibilitychange が状態を信頼しすぎる** — state が "connected" なら何もしない。実際は sync stream が死んでいる可能性がある
3. **ChangeTracker の pause 中にイベントがドロップされる** — リモート変更適用中の500msウィンドウ内のローカル変更が消える
4. **Force Sync がローカルDBへの書き込みのみ** — push を保証しない

## 設計

### 1. Replicator: ヘルスチェックの強化

#### update_seq による未同期検出

現在の30秒間隔ヘルスチェックに、update_seq 比較を追加。

```
checkHealth():
  1. ローカル db.info() → local.update_seq を取得
  2. 前回チェック時に保存した lastSyncedSeq と比較
  3. local.update_seq > lastSyncedSeq かつ state === "connected" → sync が止まっている
  4. sync session を再作成（stop → start）
  5. sync の "paused" イベント（err なし = 全同期完了）で lastSyncedSeq を更新
```

`lastSyncedSeq` は sync の "paused" イベント（エラーなし = idle 状態 = 全変更が同期済み）で更新する。これにより「ローカルに変更があるが送信されていない」状態を検出できる。

#### 接続テストとの組み合わせ

```
checkHealth():
  if state === "connected":
    1. update_seq 比較で未同期検出 → 差分あれば session 再作成
    2. testConnection() で接続確認 → 失敗なら disconnected
  if state === "syncing":
    // 処理中なので介入しない
  if state === "error" or "disconnected":
    // retry が処理するはず。一定時間経過で session 再作成
```

### 2. Replicator: 積極的な再接続

#### visibilitychange — 常に session 再作成

バックグラウンド復帰時は state に関係なく session を再作成。PouchDB のチェックポイントから再開するので重複は発生しない。

```
visibilitychange → visible:
  if connectionState === "syncing":
    replicator.stop()
    replicator.start()
```

#### ネットワーク復帰 — 同様

```
online event:
  if connectionState === "syncing":
    replicator.stop()
    replicator.start()
```

#### 既存の handleOnline/handleOffline を置換

現在は setState のみ。新しい設計では session 再作成。

### 3. Replicator: lastSyncedSeq の管理

`lastSyncedSeq` は `start()` 時に `db.info().update_seq` で初期化。sync session の "paused" イベント（`err` なし）は「全変更が同期済み」を意味する。このタイミングで `lastSyncedSeq` を更新。

```typescript
this.sync.on("paused", (err) => {
    if (!err) {
        // All changes synced — update checkpoint
        this.updateLastSyncedSeq();
        this.setState("connected");
    } else {
        this.setState("error");
    }
});
```

### 4. ChangeTracker: pause 中のイベントキュー

#### 現在の問題

```
1. リモート変更を受信 → changeTracker.pause()
2. dbToFile() でファイル書き出し
3. 書き出し中にユーザーが別ファイルを編集 → modify イベント発火
4. scheduleSync() で paused チェック → return（ドロップ）
5. 500ms 後に resume() → しかしイベントは消えている
```

#### 修正: キュー方式

```typescript
private pendingQueue: TFile[] = [];

private scheduleSync(file: TFile): void {
    if (this.paused) {
        // キューに追加（重複排除）
        if (!this.pendingQueue.some(f => f.path === file.path)) {
            this.pendingQueue.push(file);
        }
        return;
    }
    // ... 通常のデバウンス処理
}

resume(): void {
    this.paused = false;
    // キューを処理
    const queued = this.pendingQueue.splice(0);
    for (const file of queued) {
        this.scheduleSync(file);
    }
}
```

### 5. Force Sync: push を保証

現在の `scanVaultToDb()` の後に sync session 再作成をトリガー。

```typescript
this.addCommand({
    id: "couchsync-force-sync",
    name: "Force sync all files now",
    callback: async () => {
        await this.scanVaultToDb();
        // sync session を再作成して未同期を確実に送信
        this.replicator.stop();
        this.replicator.start();
        showNotice("Force sync: scanning complete, pushing changes...");
    },
});
```

## 修正ファイル

1. **`src/db/replicator.ts`** — ヘルスチェック強化（update_seq 比較）、再接続ロジック改善、lastSyncedSeq 管理
2. **`src/sync/change-tracker.ts`** — pause 中のイベントキュー
3. **`src/main.ts`** — visibilitychange 常時再接続、Force Sync の push 保証

## 対応しないもの（今回のスコープ外）

- ドキュメント単位の sync 状態追跡（pending_sync フラグ）— update_seq 比較で十分
- エラー種別の分類（永続/一時） — 現状の retry で対応可能
- Init/Clone のアトミック性 — 稀なケースで影響が小さい
- Config sync のライブ同期 — 設計上手動操作

## 検証シナリオ

1. ネットワーク切断中にファイル編集 → 復帰後に自動同期される
2. バックグラウンドに移行 → 復帰後に sync session が再作成される
3. PouchDB silent stall 時 → ヘルスチェックが update_seq 差分を検出 → session 再作成
4. リモート変更適用中にローカル編集 → キューされて resume 後に処理される
5. Force Sync → ローカルDB書き込み後にリモートへも送信される
6. アプリ再起動 → PouchDB チェックポイントから再開、未同期ドキュメントが送信される
