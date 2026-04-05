# Content-Aware Safe Sync — 実装レビューレポート

**日付:** 2026-04-05
**対象:** Content-Aware Safe Sync 実装（未コミット、bdec1d9からの差分）
**レビュー観点:** 理想的な設計か、パッチ的・場当たり的ではないか

---

## 総合評価

**設計としては理想的。パッチ的ではない。** 3レイヤーはそれぞれ明確な責務を持ち、結合せずに合成される。ただし実装にCritical 2件、Important 3件の問題がある。

---

## 設計の良い点

- **根本原因分析が正確** — mtime launderingという本質的な問題を特定し、症状ではなく原因に対処
- **chunk IDの再利用** — 既存のチャンキング機構を活用。新しいハッシュ方式を発明していない
- **editedAtのセット箇所** — `fileToDb()`でのみセット、`dbToFile()`では絶対にセットしない。これがlaundering防止の核心
- **鮮度ガードの委譲** — ローカルが新しい場合、インラインで解決せずconflict-resolverに委ねる正しい設計
- **後方互換性** — オプショナルフィールド、mtimeフォールバック、マイグレーション不要

---

## Critical（修正必須）

### C1: `editedBy`が宣言されたが一度もセットされていない

`types.ts`で定義、`conflict-resolver.ts`でコピーされるが、`vault-sync.ts:fileToDb()`で値をセットしていない。全ドキュメントで`editedBy: undefined`になる。

**対処:** VaultSyncにdeviceIdへのアクセスを追加し、`fileToDb()`で`editedBy`をセットする。

### C2: `dbToFile()`がfire-and-forget（Promiseが破棄される）

`main.ts:79`で、旧コードは`.finally()`でdbToFile完了を待っていたが、新コードはPromiseを完全に破棄:

```typescript
this.vaultSync.dbToFile(doc);                    // Promise破棄
this.conflictResolver.resolveIfConflicted(doc);  // 並行実行、順序保証なし
```

問題:
- エラーがunhandled promise rejectionになる
- conflict-resolverがファイル書き込みと同じdocで競合する

**対処:** `.then(() => this.conflictResolver.resolveIfConflicted(doc)).catch(...)`でチェーンする。

---

## Important（修正推奨）

### I1: 鮮度比較のタイムスタンプ非対称性

`vault-sync.ts:88-89`で`localFile.stat.mtime`（ディスク書き込み時刻）と`fileDoc.editedAt`（ユーザー編集時刻）を比較している。前回の`dbToFile()`でローカルに書き込まれたファイルのmtimeは中継時刻を反映するため、狭い条件で誤判定の可能性がある。

「原則1台で編集」の前提で発生頻度は低いが、コメントでの明記または`lastAppliedEditedAt`の追跡を検討。

### I2: スキップ時のデバッグログがない

dbToFile()がcontent比較や鮮度比較でスキップした場合、何も出力しない。sync pluginでは「なぜファイルが更新されないのか」のデバッグが重要。

**対処:** 各スキップポイントに`console.debug()`を追加。

### I3: `isBinaryFile()`の重複呼び出し

`vault-sync.ts`で72行目（existingブロック内）と96行目（ガード後）で2回呼ばれる。メソッド先頭で一度だけ計算すべき。

---

## Suggestions（任意）

| # | 内容 |
|---|------|
| S1 | Safe Writeロジック（~20行）を`shouldSkipWrite(fileDoc, localFile)`に抽出 → 可読性・テスト性向上 |
| S2 | `tests/safe-write.test.ts`がローカル関数で比較ロジックを再実装している。実コードと乖離するリスク。S1で抽出した関数をインポートしてテストすべき |
| S3 | `editedAt`（ユーザー意図の時刻）と`mtime`（OS書き込み時刻）の意味的違いをコメントで明記 |

---

## レビュー者の回答

| 質問 | 回答 |
|------|------|
| **理想的かパッチ的か？** | **理想的。** 3レイヤーが明確な責務で結合なく合成される |
| **残るデータ損失シナリオは？** | I1の中継mtime問題、時計ズレ、C2の競合。全て狭いエッジケース |
| **500ms削除は安全か？** | **安全。** content比較はタイミングより本質的に信頼性が高い。ただしC2のfire-and-forget修正が前提 |
| **editedAt設計は？** | 良い設計。「fileToDbでのみセット」の不変条件が正確性の核。editedBy未セット（C1）が唯一の穴 |
| **テストカバレッジは？** | コアロジックは十分。ファイル未存在パス、concurrent dbToFile+resolve、deleted fileのテストが不足 |
| **後方互換性は？** | 問題なし。混在バージョン期間もmtimeフォールバックで安全 |

---

## 修正優先順位

1. **C2** → main.tsのPromiseチェーン修正（競合条件の排除）
2. **C1** → editedByのセット（deviceIdアクセスの追加）
3. **I3** → isBinaryFile()の重複排除
4. **I2** → デバッグログ追加
5. **S1** → shouldSkipWrite()抽出（テスト改善に連動）
