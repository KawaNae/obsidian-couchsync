# Changelog

All notable changes to obsidian-couchsync.

## 0.25.0 — data-layer-v2

Comprehensive rewrite of the data layer: chunk content moves into
CouchDB attachments, the codec axes (encryption, compression) become
independent toggles, four named modes are first-class, and every byte
persisted to the wire is self-describing so future format evolution can
proceed per-artifact without a full dual-reader migration.

This release is the technical foundation for a future v1.0 publication.
The version line stays in the 0.x family until the project is opened
publicly; the breaking changes below still apply (destructive migration
required from any earlier 0.x build).

### Breaking

- **Chunk hash boundary changed from base64 string to binary
  Uint8Array.** Doc identity (`chunk:<alg>:<hash>`) differs from any
  v0.x vault. There is no automated dual-reader path; migration is
  destructive (recreate the remote DB and re-Init from one device,
  Clone from the rest — see Migration below).
- **Chunk ids carry an explicit hash-algorithm tag** —
  `chunk:x64:<16-hex>` instead of `chunk:<16-hex>`. The default
  algorithm (`x64`, xxhash64 over plain bytes) is unchanged; a future
  switch to e.g. blake3 will mint `chunk:b3:...` ids alongside the
  existing cohort without ambiguity (invariant 14).
- **`ChunkDoc.data` (legacy base64 payload) removed entirely.**
  The canonical chunk payload now lives only in the CouchDB
  attachment `_attachments.c`; the local doc holds the binary
  `content` field as well so the push pipeline can re-wrap it
  without re-reading from vault. Drops the ~1.75× local-DB inflation
  that v0.24.x carried during the v2 transition.
- **`ChunkDoc.schemaVersion` (and FileDoc / ConfigDoc) is now a
  required field.** The 4 writer paths (chunker, sync-engine,
  vault-sync, config-sync) already stamped it; the type now matches
  the writer-side contract so a missing stamp is a compile error
  (invariant 11).
- **Encryption envelope format changed.** Legacy
  `base64(IV):base64(cipher)` (string fields) and `IV || cipher`
  (attachment binary) are gone. Both forms now carry a 1-byte codec
  header (`[bits][IV?][body]`), wrapped in base64 for the one remaining
  encrypted string field (`encryptedPath`) or written binary-direct for
  attachments. The header declares encrypted / compressed bits so a
  single byte sequence on the wire is decodable without consulting
  `vault:meta` (invariants 12, 13). See `SECURITY.md#envelope-format`.
- **`ConfigDoc` no longer carries an in-doc `data` payload.** Config
  files are chunked exactly like vault files — `ConfigDoc.chunks` is an
  ordered list of `chunk:<alg>:<hash>` ids and the body rides as chunk
  attachments. `CONFIG_SCHEMA_VERSION` is `3` (independent of the
  FileDoc/ChunkDoc v2 line so config can evolve separately). Encryption
  now touches only the `_id`/`encryptedPath` and the chunk attachment
  bodies — never an in-doc string blob.
- **`encryption:meta` document and `src/db/encryption-meta.ts`
  removed.** Already superseded by `vault:meta` in the previous
  release window; the migration shim (`LegacyEncryptionMetaDoc`) stays
  in `vault-meta.ts` for the Init-time legacy detection prompt.
- **`crypto.encrypt()` / `crypto.decrypt()` / `encryptPath()` /
  `decryptPath()` (string envelope API) physically removed from
  `CryptoProvider`.** Replaced by `encryptBytesIv()` / `decryptBytesIv()`
  primitives plus `envelope.ts:encryptString()` / `decryptString()`
  composition. Eliminates the possibility of accidentally re-emitting
  the legacy unversioned envelope.
- **`DiffRecord.source` (history rows) is now a required field.**
  The "undefined = local" back-compat hack from v0.21.x is gone;
  writers always stamp `source: "local" | "sync"` explicitly.
- **Each local Dexie DB carries a `_meta.schemaVersion = 1` row**
  (vault docs, vault meta, config docs, config meta, history, log).
  Stamped on first open via `ensureSchemaVersion()`; mismatch on a
  later open throws a degraded-state error so a build/data desync
  surfaces before any content read (invariant 15).

### Added

- **`src/db/envelope.ts` — unified codec envelope** module. Single
  `encodeEnvelope()` / `decodeEnvelope()` pair handles every
  persisted byte sequence (attachments + encrypted strings).
  `encryptString()` / `decryptString()` helpers compose the
  CryptoProvider primitive with the envelope so the only way to
  produce an encrypted string in this codebase is via the
  self-describing format.
- **Four codec modes**: `raw`, `gzip`, `encrypt`, `gzip-encrypt`,
  selectable independently at Init time. `gzip-encrypt` is the
  recommended default for untrusted servers.
- **CompressingCouchClient decorator** — gzip attachment bodies on
  push, gunzip on pull. Compression layer is outside encryption so
  the push path is plain → gzip → encrypt → wire.
- **CryptoProvider binary I/O**: `encryptBytesIv()` returns
  `{ iv, cipher }` and `decryptBytesIv(iv, cipher)` reverses it. The
  attachment encryptor packs these into the codec envelope
  (`[bits][IV][cipher]`), so raw cipher bytes never travel outside the
  self-describing format.
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
- **`SECURITY.md`** (repository root) — threat model and mode-selection
  guide for end users.
- **Test matrix**: `tests/sync-mode-matrix.test.ts` runs the
  attachment round-trip suite across all four codec modes via
  `describe.each` so regressions in any mode surface immediately.

### Internal

- Decorator stack composition: `CompressingCouchClient(EncryptingCouchClient(CouchClient))`,
  with each layer aware only of its own concern. Decorators now
  contract on envelope-formatted bytes at every boundary: each one
  parses the incoming envelope, transforms the body, ORs its bit
  (`compressed`=0x02 for Compressing, `encrypted`=0x01 for
  Encrypting), and re-encodes.
- New `Invariants 7-15`: decorator boundary, chunk attachment
  integrity, binary hash input, composition order, schemaVersion
  presence (writer-side enforcement via required type field),
  attachment envelope universality, encrypted-string envelope
  versioning, chunk-id algorithm self-declaration, local schema
  version traceability.
- `splitForPush` (`remote-couch.ts`) and `push-pipeline.ts` both
  envelope-wrap the chunk body before handing it to
  `bulkDocsWithAttachments`. The wire format `[codec][IV?][body]`
  is established at the boundary; decorators only modify it.
- `vault:meta` retains `kdfVersion` / `cipherVersion` /
  `compression.version` but is now explicitly the "capability
  declaration" of the vault, never consulted for per-blob decode
  (which is fully self-describing via the envelope header).
- **Init/Clone bulk paths paginated** to match steady-state robustness.
  `pullAll` streams `_all_docs` over keyset continuation
  (`DEFAULT_BATCH_SIZE` per request), fetching each batch's chunk
  attachments and committing it in its own write tx; `pushAll`
  enumerates ids via `listIds` and pushes one page at a time. Keys-mode
  `allDocs` is batched on the same boundary as `bulkGet`/`bulkDocs`.
  Bounds per-request HTTP payload (survivable under the 30 s mobile
  timeout) and peak memory (a large vault's chunk bodies are never all
  resident at once).
- **Init/Clone factory unification** — `VaultRemoteOps.setClientWrapper`
  (mutable setter) removed. The codec stack (`compress(encrypt(raw))`)
  is now built by a single private `wrapRemoteClient` closure on the
  plugin instance, reused by SyncEngine's live loop, VaultRemoteOps,
  and ConfigSync. Fixes a pre-existing bug where Init/Clone wrapped
  only with `EncryptingCouchClient` and silently dropped compression
  — visible only after the envelope header landed in v0.25.0 (wire
  byte was `0x01` instead of the expected `0x03`).
- **Chunk-id algorithm tag corrected for encrypted vaults** — the
  chunker takes a `ChunkHasher { alg, hash }` bundle instead of a
  bare hash function, so the tag stamped into `chunk:<alg>:<hash>`
  reflects the actually-used algorithm. Encrypted vaults now emit
  `chunk:hmac:<64-hex>` (HMAC-SHA256 of plain bytes) rather than
  mis-tagging as `chunk:x64:<64-hex>`. `ChunkHashAlg` gains the
  `hmac` variant and `ID_RANGE.chunk.hmac` joins `chunk.x64` for
  per-algorithm range queries.
- **ConfigDoc chunk-ification completed** (`CONFIG_SCHEMA_VERSION = 3`).
  Config files split into content-addressed chunks via the same
  `chunker` + `ChunkHasher` path as vault files; `config-sync` assembles
  them on write (`getChunks` / `assembleChunks`). Config thus inherits
  the full codec stack (gzip + encrypt + attachment storage) and the
  `config:meta` doc stays codec-free so a fresh-Clone device can read it
  before unlocking.

### Performance (dev vault baseline — 279 files, 900 docs, encrypted+gzipped baseline)

`_changes` feed during catchup: ~10 MB → ~50 KB (chunks no longer
inlined). The four-codec Init wall-clock breakdown, all 4 modes
re-measured on dev vault after the Init/Clone factory unification
landed (gzip actually applies during Init now — pre-fix the wire
header was `0x01` regardless of `compressionEnabled`):

| Mode | Init wall-clock | Δ vs raw | Notes |
|---|---|---|---|
| `raw` | 7.67 s | — | base case |
| `gzip` | 9.16 s | +19 % | gzip CPU overhead on a fast LAN |
| `encrypt` | 9.35 s | +22 % | AES-GCM dominates; no compression |
| `encrypt`+`gzip` | 8.97 s | +17 % | gzip shrinks the cipher input; smaller wire offsets some of the gzip CPU cost vs gzip-only |

Clone wall-clock (Dev2, full pull): **4.65 s** in `encrypt`+`gzip`
mode.

Initial-push 108 MB local-DB load (data + content double-storage) is
**eliminated** — ChunkDoc.data removal slimmed every chunk row to its
canonical binary `content` only.

### Migration

**Destructive — no automated upgrade from v0.x.** Doc identity changed
(binary chunk hashes), so old and new vaults cannot interoperate. To
migrate: stop sync on every device, recreate the remote DB, run **Init**
on one device (choosing the codec mode — encryption/compression are set
at Init), then **Clone** on the rest. Encrypted vaults require the same
passphrase on every device. See `SECURITY.md` for mode selection.

---

## Pre-1.0 history

See git log for v0.x development history. v0.24.x was the last
pre-data-layer-v2 release line.
