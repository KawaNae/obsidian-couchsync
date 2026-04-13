# Log View — 設計スペック

## Context

モバイル（iPad等）では DevTools がなく、`console.error` / `console.warn` が見えない。
同期トラブルの多くはモバイルで発生するため、プラグイン内でログを確認できるUIが必要。

## 設計

### リングバッファ (`src/ui/log.ts` 拡張)

既存の `log.ts` にメモリ上のリングバッファを追加。

```typescript
type LogLevel = "debug" | "info" | "error";

interface LogEntry {
    timestamp: number;
    level: LogLevel;
    message: string;
}
```

- 最大 **500件** のリングバッファ（配列 + インデックス管理）
- `logVerbose` → `level: "debug"` でバッファに追加
- `logNotice` → `level: "info"` でバッファに追加
- 新規 `logError(message: string)` → `console.error` + `level: "error"` でバッファに追加
- `getLogEntries(): LogEntry[]` — 全エントリを時系列で返す
- `clearLog(): void` — バッファクリア
- `onLogEntry(callback): void` — 新エントリ時に通知（View のリアルタイム更新用）

バッファはプラグインリロードでクリアされる（メモリのみ）。

### `logError` による `console.error` 統合

既存の `console.error("CouchSync: ...")` パターンを `logError()` に置き換え。
初回は sync-engine.ts と main.ts の主要箇所から段階的に移行。

### Log View (`src/ui/log-view.ts`)

DiffHistoryView と同じ ItemView パターンで構築。

- **VIEW_TYPE**: `"couchsync-log-view"`
- **表示テキスト**: `"CouchSync Log"`
- **アイコン**: `"scroll-text"`
- **レイアウト**:
  - ヘッダー: レベルフィルタボタン (All / Info / Error) + Clear ボタン
  - ボディ: ログエントリのリスト（新しいものが上）
- **エントリ表示**: `[HH:MM:SS] [LEVEL] message` のモノスペース行
  - error は赤系、debug はグレー系の控えめな色分け
- **リアルタイム更新**: `onLogEntry` コールバックで新エントリをDOMに追加
- **onOpen**: 既存バッファ内容をレンダリング
- **onClose**: コールバック解除

### main.ts での登録

- `registerView(VIEW_TYPE_LOG, ...)` — DiffHistoryView と同様
- `addCommand("couchsync-show-log", "Show sync log")` — コマンドパレットから開く
- `activateLogView()` — 右サイドバーに開く

### 修正対象ファイル

| ファイル | 変更 |
|---|---|
| `src/ui/log.ts` | リングバッファ、LogEntry型、logError、getLogEntries、onLogEntry追加 |
| `src/ui/log-view.ts` | **新規** — ItemView ベースの Log View |
| `src/main.ts` | registerView、addCommand、activateLogView |
| `src/db/sync-engine.ts` | 主要 console.error → logError |
| `src/sync/reconciler.ts` | console.error → logError |
| `src/sync/vault-sync.ts` | console.error → logError |

### 検証

1. コマンドパレットから "Show sync log" で右サイドバーに開く
2. verbose log 有効時に debug/info レベルが表示される
3. エラー発生時に error レベルが即座に表示される
4. フィルタボタンでレベル絞り込み
5. Clear でバッファクリア
6. モバイルで動作確認
