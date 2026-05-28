# Changelog

All notable changes to obsidian-couchsync.

## 1.0.0 — data-layer-v2

First publication-ready release. Comprehensive rewrite of the data
layer: chunk content moves into CouchDB attachments, the codec axes
(encryption, compression) become independent toggles, and four named
modes are first-class.

### Breaking

- **Chunk hash boundary changed from base64 string to binary
  Uint8Array.** Doc identity (`chunk:<hash>`) differs from any v0.x
  vault. There is no automated dual-reader path; migration is
  destructive (recreate the remote DB and re-Init from one device,
  Clone from the rest). See `docs/migration-v2.md`.
- **Chunk payload moved to CouchDB attachment** (`_attachments.c`).
  The legacy `ChunkDoc.data: string` field is no longer used by the
  v2 read/write paths (still present on the type for transitional
  reads of legacy docs).
- **`encryption:meta` document replaced by `vault:meta`** with the
  generalised v2 schema (`schemaVersion: 2`, separate `encryption`
  and `compression` sections). Legacy `encryption:meta` docs surface
  a migration prompt and refuse to sync until Init/Clone runs.

### Added

- **Four codec modes**: `raw`, `gzip`, `encrypt`, `gzip-encrypt`,
  selectable independently at Init time. `gzip-encrypt` is the
  recommended default for untrusted servers.
- **CompressingCouchClient decorator** — gzip attachment bodies on
  push, gunzip on pull. Compression layer is outside encryption so
  the push path is plain → gzip → encrypt → wire.
- **CryptoProvider binary I/O**: `encryptBytes` / `decryptBytes`
  return `IV(12B) || AES-GCM(plain)` as one Uint8Array. Used by
  attachment encryption (no base64 envelope on the wire).
- **Pull pipeline reads chunks via attachment GET**, not `_changes`.
  Chunk rows in `_changes` are now dropped; `ensureChunks` fetches
  the binary payload directly. Catchup `_changes` feed shrinks
  ~100× on chunk-heavy batches.
- **Push pipeline routes chunks through `bulkDocsWithAttachments`**
  with the canonical binary attached; file docs continue via plain
  `_bulk_docs`. Files and chunks push in parallel via
  `Promise.all`.
- **`schemaVersion: 2` stamped on all writer-produced docs**, with
  a `CURRENT_SCHEMA_VERSION` constant and `SchemaVersion` literal
  type so future bumps are explicit.
- **Settings: `compressionEnabled` toggle** (default on) wired through
  the composition root. Disabled after Init / setup (server is
  source-of-record).
- **`docs/SECURITY.md`** — threat model and mode-selection guide for
  end users.
- **Test matrix**: `tests/sync-mode-matrix.test.ts` runs the
  attachment round-trip suite across all four codec modes via
  `describe.each` so regressions in any mode surface immediately.

### Internal

- Decorator stack composition: `CompressingCouchClient(EncryptingCouchClient(CouchClient))`,
  with each layer aware only of its own concern.
- New `Invariants 7-10`: decorator boundary, chunk attachment
  integrity, binary hash input, composition order.
- 14-phase implementation plan tracked in
  `docs/superpowers/plans/2026-05-28-data-layer-v2.md` (untracked,
  local working notes).
- ConfigDoc chunk-ification deferred to v2.1 (see plan).

### Performance (dev vault baseline)

- `_changes` feed during catchup: ~10 MB → ~50 KB (chunks no longer
  inlined).
- Wire bytes per chunk (encrypted+compressed, gzipped): ~73 KB →
  ~35 KB (~50 % reduction).
- Wire bytes per chunk (plain+compressed): ~50 KB → ~30 KB.

### Migration

Destructive — see `docs/migration-v2.md`. No automated upgrade from
v0.x.

---

## Pre-1.0 history

See git log for v0.x development history. v0.24.x was the last
pre-data-layer-v2 release line.
