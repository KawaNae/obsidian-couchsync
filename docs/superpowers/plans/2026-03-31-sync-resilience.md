# Sync Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live sync が止まっても自動検知・復旧し、ローカルの変更が確実にリモートに送信されるようにする。

**Architecture:** Replicator のヘルスチェックを update_seq 比較で強化し、サイレント切断を検出して sync session を再作成する。visibilitychange/online イベントで常に session を再作成する。ChangeTracker の pause 中のイベントをキューする。

**Tech Stack:** PouchDB, Obsidian Plugin API

---

## File Structure

| File | Responsibility | Change |
|------|---------------|--------|
| `src/db/replicator.ts` | Live sync engine | ヘルスチェック強化、再接続ロジック改善、lastSyncedSeq 管理 |
| `src/sync/change-tracker.ts` | Vault イベント監視 | pause 中のイベントキュー |
| `src/main.ts` | Plugin lifecycle | visibilitychange 常時再接続、Force Sync push 保証 |

---

### Task 1: Replicator — ヘルスチェック強化 + 再接続ロジック

**Files:**
- Modify: `src/db/replicator.ts`

- [ ] **Step 1: lastSyncedSeq プロパティと updateLastSyncedSeq メソッドを追加**

`src/db/replicator.ts` のクラスプロパティに追加し、ローカルDBの update_seq を取得するメソッドを追加:

```typescript
// 既存プロパティの後に追加 (line 22 の後)
private lastSyncedSeq: number | string = 0;
```

```typescript
// private メソッドとして追加
private async updateLastSyncedSeq(): Promise<void> {
    const info = await this.localDb.getDb().info();
    this.lastSyncedSeq = info.update_seq;
}
```

- [ ] **Step 2: start() で lastSyncedSeq を初期化し、paused イベントで更新**

`start()` メソッドの先頭で初期化:

```typescript
start(): void {
    if (this.sync) return;

    // Initialize checkpoint from current DB state
    this.localDb.getDb().info().then((info) => {
        this.lastSyncedSeq = info.update_seq;
    });

    // ... 既存コード ...
```

paused イベントハンドラを修正:

```typescript
this.sync.on("paused", (err) => {
    if (err) {
        this.setState("error");
        this.emitError("Sync paused: connection issue");
    } else {
        this.updateLastSyncedSeq();
        this.setState("connected");
    }
});
```

- [ ] **Step 3: checkHealth() を update_seq 比較に強化**

既存の `checkHealth()` を完全に置き換え:

```typescript
private async checkHealth(): Promise<void> {
    if (this.state === "syncing") return; // 処理中は介入しない

    const info = await this.localDb.getDb().info();
    const currentSeq = info.update_seq;

    // ローカルに未同期の変更がある → sync が止まっている
    if (currentSeq !== this.lastSyncedSeq) {
        console.log("CouchSync: Stalled sync detected, restarting session");
        this.restart();
        return;
    }

    // 接続確認（idle 状態のみ）
    if (this.state === "connected") {
        const err = await this.testConnection();
        if (err) {
            console.log("CouchSync: Server unreachable, restarting session");
            this.restart();
        }
    }
}
```

- [ ] **Step 4: restart() メソッドを追加**

stop + start を1メソッドに。外部からも呼べるように public:

```typescript
/** Restart sync session (preserves PouchDB checkpoint) */
restart(): void {
    this.stop();
    this.start();
}
```

- [ ] **Step 5: handleOnline() を session 再作成に変更**

既存の `handleOnline()` を置き換え:

```typescript
private handleOnline(): void {
    if (this.state === "disconnected" || this.state === "error") {
        console.log("CouchSync: Network online, restarting session");
        this.restart();
    }
}
```

- [ ] **Step 6: ビルド確認**

Run: `npm run build`
Expected: ビルド成功

- [ ] **Step 7: コミット**

```bash
git add src/db/replicator.ts
git commit -m "feat: enhance health check with update_seq stall detection"
```

---

### Task 2: main.ts — visibilitychange 常時再接続 + Force Sync push 保証

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: visibilitychange を常時 session 再作成に変更**

既存の visibilitychange ハンドラ (lines 64-75) を置き換え:

```typescript
// Reconnect when returning from background (mobile)
this.registerDomEvent(document, "visibilitychange", () => {
    if (
        document.visibilityState === "visible" &&
        this.settings.connectionState === "syncing"
    ) {
        // Always restart session on foreground return
        // PouchDB checkpoint ensures no duplicates
        this.replicator.restart();
    }
});
```

state チェックを削除。"connected" でも "syncing" でも常に session を再作成する。PouchDB のチェックポイントが重複を防止する。

- [ ] **Step 2: Force Sync コマンドに push 保証を追加**

既存の force-sync コマンド (lines 77-81) を置き換え:

```typescript
this.addCommand({
    id: "couchsync-force-sync",
    name: "Force sync all files now",
    callback: async () => {
        await this.scanVaultToDb();
        // Restart sync session to ensure all changes are pushed
        if (this.settings.connectionState === "syncing") {
            this.replicator.restart();
        }
        showNotice("Force sync: scanning complete.");
    },
});
```

- [ ] **Step 3: ビルド確認**

Run: `npm run build`
Expected: ビルド成功

- [ ] **Step 4: コミット**

```bash
git add src/main.ts
git commit -m "feat: always restart sync on foreground return, force sync ensures push"
```

---

### Task 3: ChangeTracker — pause 中のイベントキュー

**Files:**
- Modify: `src/sync/change-tracker.ts`

- [ ] **Step 1: pendingQueue プロパティを追加**

クラスの先頭にキュー用の配列を追加:

```typescript
export class ChangeTracker {
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private paused = false;
    private pendingQueue: TFile[] = [];
    private eventRefs: ReturnType<App["vault"]["on"]>[] = [];
```

- [ ] **Step 2: scheduleSync() で pause 中はキューに保存**

既存の `scheduleSync()` メソッド (lines 71-85) を置き換え:

```typescript
private scheduleSync(file: TFile): void {
    if (this.paused) {
        if (!this.pendingQueue.some((f) => f.path === file.path)) {
            this.pendingQueue.push(file);
        }
        return;
    }

    this.cancelPending(file.path);

    const debounceMs = 2000;
    const timer = setTimeout(() => {
        this.timers.delete(file.path);
        this.vaultSync.fileToDb(file).catch((e) => {
            console.error(`CouchSync: Failed to sync ${file.path}:`, e);
        });
    }, debounceMs);

    this.timers.set(file.path, timer);
}
```

- [ ] **Step 3: resume() でキューを処理**

既存の `resume()` メソッド (lines 67-69) を置き換え:

```typescript
resume(): void {
    this.paused = false;
    const queued = this.pendingQueue.splice(0);
    for (const file of queued) {
        this.scheduleSync(file);
    }
}
```

- [ ] **Step 4: stop() でキューもクリア**

既存の `stop()` メソッド (lines 52-61) を修正。timers.clear() の後に追加:

```typescript
stop(): void {
    for (const ref of this.eventRefs) {
        this.app.vault.offref(ref);
    }
    this.eventRefs = [];
    for (const timer of this.timers.values()) {
        clearTimeout(timer);
    }
    this.timers.clear();
    this.pendingQueue = [];
}
```

- [ ] **Step 5: ビルド確認**

Run: `npm run build`
Expected: ビルド成功

- [ ] **Step 6: コミット**

```bash
git add src/sync/change-tracker.ts
git commit -m "feat: queue events during pause to prevent dropped changes"
```

---

### Task 4: 統合テスト + バージョン更新

**Files:**
- Modify: `package.json`
- Modify: `manifest.json`

- [ ] **Step 1: 全ファイルのビルド確認**

Run: `npm run build`
Expected: ビルド成功

- [ ] **Step 2: 変更の最終確認**

Replicator の変更を確認:
- `lastSyncedSeq` プロパティが存在
- `start()` で初期化
- `paused` イベントで `updateLastSyncedSeq()` 呼び出し
- `checkHealth()` が update_seq を比較
- `restart()` が public メソッド
- `handleOnline()` が `restart()` を呼ぶ

main.ts の変更を確認:
- `visibilitychange` が常に `restart()` を呼ぶ
- Force Sync が `restart()` をトリガー

ChangeTracker の変更を確認:
- `pendingQueue` が存在
- `scheduleSync()` が pause 中にキュー
- `resume()` がキューを処理
- `stop()` がキューをクリア

- [ ] **Step 3: コミット**

```bash
git add -A
git commit -m "v0.4.2: sync resilience — stall detection, aggressive reconnection, event queue"
```
