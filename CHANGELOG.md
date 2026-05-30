# Changelog

All notable changes to obsidian-couchsync.

## 0.26.0

Closes the four highest-severity findings from a full integrated review of the
v0.25.x data layer. They are fixed as the symmetric completion of two
invariants the codebase already relied on elsewhere — *everything read from the
(untrusted) remote is authenticated at a single boundary before it is trusted*,
and *no unresolved decision is lost when the pull cursor advances*. Each was
reproduced first (in a Docker e2e harness and on a real three-device fleet), and
the migration to the new encrypted-body format was rehearsed end to end on real
devices — which also surfaced and fixed two bugs that only appear under live
reconnect churn.

### ⚠️ Breaking — encrypted vaults must be re-initialised

The on-the-wire format for encrypted **file and config documents** changed
(`cipherVersion` 3, the new "encBody" scheme). A v0.26.0 client can still *read*
the previous format, but it only ever *writes* the new one, so a vault must not
be left running a mix of old and new clients.

**Encrypted vaults require a one-time destructive re-init:** stop sync on every
device → run **Init** on one device → **Clone** on the rest (the same procedure
used for past encryption changes; the passphrase is unchanged). The re-init also
clears any orphaned documents left by earlier re-inits. **Plaintext
(unencrypted) vaults are unaffected** and need no migration.

### Security

- **File and config document bodies are now authenticated and confidential.**
  Previously only the path was encrypted; the chunk list, vector clock, size and
  timestamps rode in the clear, and the AES-GCM ciphertext was not bound to the
  document id. A malicious or man-in-the-middle CouchDB could therefore reorder
  or substitute chunk references, swap a body onto another document, or roll back
  a vector clock undetected — and could read the vault's structure. Now the whole
  body is compressed-then-encrypted into a single `encBody` field, GCM-bound to
  the document id (the id is the additional authenticated data). Any tampering or
  id-swap fails authentication and the document is rejected; the server can no
  longer see which chunks a file is built from or its history. (Compression
  precedes encryption, so long chunk-id arrays still pack down — no size
  regression.)
- **Pulled chunks are verified on every path.** Live sync already re-hashed each
  pulled chunk against its content-addressed id, but the Clone (full-resync) and
  repair paths did not — so an untrusted server could substitute or roll back a
  chunk body during a Clone and the corruption landed silently. The hasher is now
  threaded through every fetch boundary; a chunk whose bytes don't match its id
  (or whose id algorithm can't be verified) is skipped and routed to repair
  instead of being trusted.

### Fixed

- **A remote deletion no longer silently un-deletes a locally edited file.** When
  a pulled deletion collided with an unpushed local edit, the conflict was shown
  only as an in-memory modal while the pull cursor advanced past it — so a missed
  or dismissed modal, or a restart, lost the deletion intent and the surviving
  edit quietly resurrected the file on the next push. The conflict is now recorded
  durably in the same transaction as the cursor advance and re-presented after a
  restart, exactly like the existing pending-apply recovery.
- **Chunk repair can no longer delete a chunk that was re-referenced after the
  scan.** The repair plan was derived from a possibly-stale consistency report;
  a chunk that another device re-referenced between the scan and the click was
  tombstoned anyway, breaking the referencing file. Repair now re-validates the
  live reference set immediately before deleting and re-analyses at click time.

### Hardening

- KDF parameters (PBKDF2 600k / SHA-256 / 16-byte salt) are now pinned by a
  regression test so a strength reduction can't slip in unnoticed, and
  `SECURITY.md` documents the new integrity / metadata-confidentiality
  guarantees alongside the residual offline-bruteforce and `data.json`-plaintext
  caveats.
- Duplicate conflict modals no longer stack when a long-lived unresolved
  conflict is re-emitted by successive sync sessions or reconnects (a guard in
  the conflict orchestrator), and a re-init of an already-encrypted vault now
  stamps the correct `cipherVersion`.

## 0.25.3

Hardens the data layer against the failure modes seen in the v0.25.0–0.25.2
migration logs, established as three architectural invariants rather than
point patches. All were reproduced on a real device before fixing, and the
e2e suite was overhauled to drive the real sync pipeline so these paths are
guarded going forward.

### Fixed

- **A chunk present but without content no longer crashes reconcile.** A
  content-less chunk doc used to slip past the "missing chunk" guard and blow
  up chunk reassembly with an opaque `cannot read 'length' of undefined`,
  failing every file in a reconcile pass. A chunk is now treated as available
  only when it has real content; an incomplete one is re-fetched, or surfaces
  the same clean "Missing N chunk(s)" error as an absent one (vault + config).
- **Broken files no longer ping-pong forever.** A file whose chunks are gone
  on both this device and the server (e.g. a synced log file whose chunks were
  GC'd mid-migration) used to be retried every reconcile — spamming errors and
  fighting chunk-repair. It is now **quarantined**: retry is suppressed and the
  file is surfaced once, with no data loss (another device may still hold the
  chunk), and it **recovers automatically** if the chunk reappears.
- **An interrupted Clone can no longer bring up a broken sync session.** A
  Clone that failed mid-way (e.g. a dropped connection) left the codec stack
  half-built — compression on, encryption off — and a reconnect would open a
  session on it, failing every chunk fetch with "cannot decompress
  still-encrypted body". A vault sync session now starts only when the vault is
  fully provisioned, and the client refuses to build an encrypt-less stack for
  an encrypted vault.
- **Quieter, safer shutdown.** Reconcile work no longer runs against a
  closing database during unload (no more `DatabaseClosedError` noise), and
  that error class is now correctly recognized.

### Added

- **Startup version banner in the log.** Every session's log now opens with
  `CouchSync v<version> starting — built <time>, commit <hash>`, so a log
  attached to a report self-identifies the exact build.

Internal: e2e tests now drive the real push/pull pipeline (attachments, codec,
catchup/longpoll, Init/Clone) against real CouchDB instead of hand-rolled
requests; added Init/Clone and at-rest encrypt+gzip verification, a
broken-file quarantine regression, and a `npm run bench` codec benchmark.

## 0.25.2

Makes the maintenance/diagnostic tooling work on **encrypted** vaults. The
chunk-consistency report and chunk-repair were written against the pre-v2,
pre-encryption data model (raw client, chunk content in the doc body,
plaintext ids) and were never updated for data-layer-v2.

### Fixed

- **Chunk consistency report was permanently stuck on encrypted vaults.**
  It talked to the remote with a raw (non-decrypting) client, so remote
  file-doc ids (`file:<hmac>`) never matched local plaintext ids and the
  convergence gate always reported "not converged" — the report and its
  repair never ran. It now uses the codec (encryption/compression) data
  client, so remote docs are seen with their restored plaintext ids.
- **Chunk-repair could corrupt an encrypted vault or pull empty chunks.**
  Via the raw client, repair-push wrote *plaintext* chunk bodies into an
  encrypted vault, and repair-pull fetched only doc bodies — which in v2
  carry no chunk content (it rides in the `c` attachment). Repair now runs
  through the codec client (push encrypts, ids translate) and reconstructs
  pulled chunk content from attachments, reusing the same primitive as
  clone/live-pull.
- **Remote enumeration could mis-page on large encrypted vaults.** The
  report's bespoke pager continued on the decrypted (plaintext) `row.id`;
  under encryption the remote is ordered by the `file:<hmac>` storage key,
  so paging jumped to the wrong place after the first batch. It now reuses
  the canonical `paginateAllDocs` helper, which continues on the raw
  `row.key`.

Internal: `VaultRemoteOps` now exposes `makeDataClient()` (codec-wrapped)
for data-plane diagnostics/maintenance; `makeClient()` is documented as
raw/admin-only (db create/destroy, connection test, `vault:meta`). Other
maintenance commands (verify-and-repair, chunk GC, log export, DB reset)
were audited and were already encryption-safe.

## 0.25.1

Fixes two issues surfaced during v0.24.2 → v0.25.0 migration, each by
re-establishing an invariant that the data-layer-v2 rewrite left implicit.

### Fixed

- **Pull-side "Missing N chunk(s)" / permanent ghost files (esp. exported
  logs).** The v2 push split file docs and chunk attachments into two
  parallel `bulkDocs` requests, so a file doc could become visible on the
  remote `_changes` feed before its chunks were durable — a peer then
  pulled the file, found chunks missing, and (because the pull checkpoint
  had already advanced) never retried, leaving the file silently absent.
  Large, write-once files like exported logs were the most exposed.
  - *Push order contract:* `pushDocs` now uses an ordered two-phase
    transport — chunks are committed first, then only the files whose
    chunks all landed; a file referencing a chunk that failed to push is
    withheld and retried.
  - *Pull durability:* a missing-chunk apply failure no longer advances
    the checkpoint past the file unrecorded. The file is recorded in a
    persistent pending-apply set (mirror of the push-side unpushed set)
    and re-applied every pull cycle — including on the idle longpoll —
    until its chunks become durable.

- **Live Sync could be started after a failed Init/Clone, against a
  half-built database.** Init/Clone destroy the local DB at the start but
  only advanced state to `setupDone` on success, so a failure during a
  re-run left the prior `setupDone`/`syncing` state — and an enabled Live
  Sync toggle. Setup is now atomic: it drops to a non-syncable
  `settingUp` state (persisted before the destructive step) and only
  reaches `setupDone` on confirmed success; a failure keeps Init/Clone
  available to retry but Live Sync disabled. Clone's encryption and
  compression settings are now committed only on success (compression
  runs from an in-memory override during the clone), so a failed clone
  leaves persisted settings untouched.

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
