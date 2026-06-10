# Changelog

All notable changes to obsidian-couchsync.

## 0.28.3

A connection-recovery overhaul plus the trust-boundary and retry-cadence
fixes surfaced by a production-log review across four real devices. The
headline: on mobile, sync could silently stay dead after the app launched
during a brief network blip, and every wake from a long sleep popped a
spurious "Server unreachable" notice even though sync recovered a second
later. Both are gone. All fixes ship as one release; no schema change, no
re-Init required.

### Fixed

- **Sync no longer stays permanently dead when the app loads during a network
  blip (mobile cold-start).** The encryption-agreement check ran as an
  unsupervised gate before sync started; if its first network call failed
  (common right after a tablet/phone wakes, before the network stack is
  ready) it gave up with no retry, leaving sync silently off until a manual
  reload. Two mobile devices hit this in production. The check is now a single
  supervised step inside the sync session, so a transient failure retries and
  auto-recovers the moment the network returns.
- **No more spurious "Server unreachable" notifications on resume.** A request
  frozen by a background suspend aborts on wake; that abort was misread as the
  server being down, firing a Notice and bouncing a healthy session through an
  error state. Suspend-frozen aborts are now told apart from genuine timeouts
  (by elapsed wall-clock) and handled silently, and only user-actionable
  errors raise a Notice now — transient blips show in the status bar only.
- **A malicious or compromised server can no longer write outside the vault.**
  Paths from remote documents were applied without validation; on a
  plaintext vault a crafted id (`../…`, absolute, drive-letter, backslash)
  could escape the vault sandbox on write *or* delete. All remote-applied
  paths are now validated at the write boundary, independent of encryption.
- **Pull now honours the same max-file-size ceiling as push.** An oversized
  document from another device (or a hostile server) is skipped instead of
  being assembled wholesale in memory.
- **Push no longer busy-spins on `404` / transient encryption errors.** Those
  paths retried with no delay until the 10 s escalation tore the session down;
  they now back off like the pull loop, saving mobile battery and bandwidth.
- **A stalled reconnect can no longer hang forever.** A health-check watchdog
  re-kicks recovery if it ever finds the engine stuck with nothing in flight,
  while leaving genuinely terminal states (auth, migration, encryption pause)
  alone.

### Added

- **Device specs in the log-export frontmatter.** Exports now record CPU core
  count, JS-heap usage/limit, RAM, CPU model, and architecture (best-effort,
  platform-dependent) to help diagnose memory-pressure and OOM-class issues.
  The `os` field also reports a real value on mobile (e.g. `android 17`) — it
  was previously always `unknown` off the desktop.

## 0.28.2

Five structural fixes from a log-driven bug hunt across two real-device
incident logs. Two of them had been silently losing data propagation in
production: a deleted-then-recreated note that could never sync again, and
deletions that never reached other devices and resurrected there.

### Fixed

- **Recreating a deleted note no longer wedges it permanently (Invariant 7:
  deletion is an integration event).** Deleting a file erased its integration
  baseline (`lastSynced`), destroying the causal record "this device
  integrated that deletion". Recreating the same path then made the push
  guard classify the old tombstone as an unintegrated remote edit — push
  skipped forever, pull already converged, reconcile re-entered the same
  guard: no exit (the 2026-06-03 `2026-W24.md` incident, 4 days stuck).
  Deletion now *establishes* a deleted baseline instead of erasing it, the
  classifier gained a deleted axis (a tombstone's retained chunks no longer
  masquerade as live content), and recreate-after-delete pushes cleanly with
  no modal. Devices already wedged self-heal through a new
  recreate-vs-deletion conflict prompt on their next reconcile. Three sibling
  bugs fell to the same axis: recreating with *identical* content no longer
  short-circuits into a dead tombstone, a tombstone can no longer
  silent-merge-resurrect against a live doc sharing its retained chunks, and
  a pull-applied deletion no longer leaves a stale alive baseline that turned
  a later legitimate recreate into a false conflict.
- **Deletions can no longer be permanently skipped by the push cursor (lost-
  update race).** `changes()` read its cursor bound (`_update_seq`) in a
  separate transaction from the row query; a write committing in between was
  covered by the cursor but never enumerated. Edits self-heal on the next
  keystroke — a skipped *tombstone* never gets another vault event, so the
  deletion silently stopped propagating and the file resurrected on every
  other device (the 2026-06-03 `search1.jpeg` incident: 2 of 15 batch-deleted
  images lost their tombstone push). The cursor now derives from the rows
  actually enumerated, making the race structurally impossible. A one-time
  **push-backfill sweep** at session start (also wired into "Verify
  consistency and repair") re-enqueues docs already stranded behind the
  cursor — it found and repaired 4 stranded tombstones on the dev vault
  alone.
- **Case-only and NFC/NFD renames no longer revert forever.** `Note.md →
  note.md` desugared into create+delete: the create minted a fresh vclock
  (discarding the file's causal history) and clobbered the shared
  case-folded baseline, the delete's divergent guard then misfired (no
  tombstone), and reconcile picked the *old* doc as canonical — physically
  reverting the rename on every retry. Rename is now a single atomic
  write transaction: the new doc inherits the old causality and strictly
  dominates the old path's tombstone (strictness is load-bearing — equal
  clocks would converge to fleet-wide deletion on case-insensitive
  receivers), and the shared-PathKey baseline keeps exactly the alive entry.
- **Editing near emoji no longer silently loses history.** diff-match-patch
  splits diffs at UTF-16 code-unit boundaries, so edits around emoji that
  share a surrogate half (🍅→🍆) produced lone-surrogate segments whose
  serialization throws `URIError: URI malformed` — the capture was dropped,
  and the stale snapshot reproduced the same failure on every subsequent
  edit of that file (13 consecutive losses in one incident log). Diff
  boundaries are now snapped to code-point boundaries before serialization
  (patch format unchanged, old history remains readable), and history
  bookkeeping advances even when a capture fails, so one lost diff can no
  longer cascade. Conflict-history recording is non-throwing for the same
  reason — a failed diff no longer ghost-re-presents an already-resolved
  conflict.
- **Pulled tombstones no longer fetch their dead content's chunks.** A
  tombstone retains the chunks of the content it deleted; applying a
  deletion never reads them, but the pull path fetched them anyway — wasted
  bandwidth that the next chunk GC dropped again.

## 0.28.1

Faster mobile-resume recovery. On returning to the foreground, a mobile
device probes the server to revive the sync socket; if the OS hasn't
restored the network stack yet, that probe fails fast and the engine
correctly enters `error` — but the *first* retry was landing at 5s instead
of the intended fast head, delaying recovery (and the flush of local edits)
on every resume.

### Fixed

- **First reconnect retry now fires at 1s, not 5s.** `enterError` recorded
  the failure *before* reading the backoff delay, so the first retry consumed
  `delays[1]` and skipped the fast head entirely. Scheduling now reads the
  current step's delay before advancing, so the first retry lands at the
  table head as intended. The `error` state is still surfaced (accurate
  status reporting); only the recovery latency changed (~5184ms → ~1032ms,
  measured on an Android emulator with the network cut at resume).

### Changed

- **Retry backoff is now a Fibonacci cadence: 1s, 1s, 2s, 3s, 5s, 8s, 13s,
  21s** (was 2s, 5s, 10s, 20s, 30s). Tuned for mobile data safety — a gentle
  early ramp keeps transient-blip recovery near-instant while still backing
  off for a genuinely unreachable server.

## 0.28.0

A first-principles redesign of the conflict subsystem, prompted by a
multi-device data-loss incident: a device that had been offline, then
re-cloned, re-pushed its just-cloned files and stamped its own vector-clock
component onto remote-authored content. The source device's next edits then
classified as *concurrent* instead of *remote-edit*, surfacing ~190 conflict
modals; closing them (×) defaulted to **keep-local**, which pushed the stale
local copies back over the remote. The fix returns to three structural
principles rather than spot-patching the symptoms.

### Fixed

- **A re-clone no longer stamps this device's vclock onto pulled content
  (root cause).** `dbToFile`'s "content already on disk" fast-path returned
  success without recording an integration baseline (`lastSynced`), so a
  re-clone left those paths with no baseline and the next reconcile re-pushed
  them under this device's id — turning the original author's later edits into
  false *concurrent* conflicts. The fast-path now establishes `lastSynced`
  from the FileDoc's vclock (Invariant 3: chunks-equal ⇒ the FileDoc is the
  vclock authority), so a cloned file is never re-pushed and the author's edits
  fast-forward as a clean take-remote. Single sink `establishBaseline()` now
  backs the normal write path, the fast-path, and `adoptDocVclock`.
- **Closing a conflict no longer overwrites the remote with a stale local
  copy.** A conflict modal closed with × / Esc / click-outside now **defers**
  (keeps the conflict for later, changes nothing) instead of defaulting to
  keep-local-and-push. `ConflictChoice` gains an explicit `defer`, and the
  modal adds a "Later" button.
- **Deferred conflicts are durable.** Edit-vs-edit concurrency is now persisted
  in the same transaction as the pull cursor advance (Invariant B), alongside
  the existing delete-vs-edit records, and re-presented next session by
  re-fetching and re-validating the remote revision. Without this, deferring an
  edit-vs-edit conflict would silently lose the remote edit once the cursor
  moved past it.

### Changed

- **Many conflicts are presented as one batch modal instead of a stack.**
  Conflicts are now aggregated and drained serially — never more than one modal
  open at once (the stacked semi-opaque overlays previously turned the screen
  black at ~10+ conflicts). A burst of ≥10 conflicts shows a single batch modal
  offering *keep all local* / *take all remote* (gated behind a confirm) /
  *decide individually* / *defer all*; fewer than 10 are shown one at a time.

No wire-format or schema change. The only persisted-shape addition is a new
`edit-vs-edit` pending-conflict kind (local `_sync/` meta, not replicated;
older builds defensively ignore unknown kinds). Verified on Dev / Dev2 /
Android: normal sync unaffected, the batch modal renders a single overlay,
closing a real concurrent conflict leaves the remote intact and re-presents it
next session, and a re-clone followed by a source edit fast-forwards with no
conflict.

## 0.27.3

### Fixed

- **Folder-structure sync: three structural gaps closed (H-1/H-2/M-1/M-2).** A
  multi-agent review surfaced four findings rooted in three gaps. Case D now
  decides a vault-missing/DB-alive path on the `lastSynced` integration
  baseline first (manifest demoted to a fallback), fixing a silent un-delete
  that re-propagated (H-1, data-loss). Case F's collision tiebreak now derives
  the canonical from device-invariant data instead of vclock key order (H-2).
  `IVaultIO` gained `getFolders` + `abstractType` so the folder namespace is
  handled (file/folder path collisions no longer throw on create; M-1/M-2).

## 0.27.2

A post-release review of v0.27.0/v0.27.1 (a multi-agent pass with adversarial
verification) found no high-severity defects but two medium gaps plus a cluster
of smaller ones. As in v0.26/v0.27 these are not independent bugs but the same
recurring shape — *a config-side path that diverged from its vault-side mirror,
or an invariant enforced on one side of a boundary but not the other* — so they
are closed here as a return to three structural principles rather than spot
fixes. No wire-format or schema change and no re-initialisation of existing
vaults; the only persisted-shape addition is a `configCodecApplied` fingerprint
(absent on existing installs, which therefore keep their current behaviour).

### Fixed

- **Changing a config codec setting no longer silently desyncs live config
  sync.** Toggling config encryption / passphrase / compression only takes
  effect on the next Config Init & Push, but until then live push/pull kept
  running under the new setting against a database built with the old one — worst
  case, turning encryption *off* cleared the provider while the server still held
  encrypted documents, so pulls failed until a full re-Init. A successful Config
  Init now records the codec it applied, and live push/pull/write refuse to run
  when the live codec has drifted from it, with a clear "re-run Config Init &
  Push" message — symmetric with the existing half-built-DB (`configSettingUp`)
  guard, and with vault sync, where a codec change has always demanded a
  re-init rather than a live switch.
- **An interrupted Config Init no longer leaves the shared remote without its
  crypto root.** Init destroyed and recreated the remote config database before
  building the `config:meta` crypto root, so a failure in between left peers
  looking at an existing-but-meta-less database, and a key-derivation failure
  could wipe the remote for nothing. The crypto root is now derived first (a pure
  computation — a failure there touches neither database) and `config:meta` is
  pushed as the very first write after the database is recreated, shrinking the
  window in which the remote exists without an authoritative descriptor to a
  single request. A mid-flight failure still leaves the initiating device
  fail-closed (`configSettingUp`), unchanged.
- **The config pull's "remote recreated elsewhere" self-heal is now durable and
  bounded.** The cursor reset was applied in memory only, so a crash before the
  next batch committed left the stale cursor on disk and re-triggered a full
  re-pull every session; it is now persisted in its own transaction. A second
  seq regression within one run (an unstable or hostile server reporting a
  last_seq below the cursor) is now treated as terminal instead of looping up to
  the batch cap.
- **A structurally malformed config chunk no longer aborts the whole document's
  chunk fetch.** Config pull classified only a hash mismatch as corrupt, while
  vault pull also treats a malformed envelope as corrupt (skip + warn, route to
  repair); the two boundaries now share one `fetchMissingChunks` implementation,
  so a corrupt chunk is handled identically and a malformed config chunk is
  skipped rather than rethrown.

### Security

- **Config Init's encrypted document push is fail-closed.** It previously fell
  back to the raw (plaintext) client when the encrypting-client hook was absent;
  production always wired it, but the fail-open default was asymmetric with the
  fail-closed `wrapConfigClient` / `wrapVaultClient`. An encrypted Init now
  requires the encrypting client and refuses to push plaintext bodies into an
  encrypted config database.

### Internal

- The config codec resolution (the per-field `?? ` / `||` inherit rules) is now
  defined once in `resolveConfigCodec`, removing the scattered inline copies that
  let a mis-paired operator silently break inheritance. The dead
  `reinitForEncryptionChange` (zero callers, and a latent hazard that ran outside
  the operation runner) is removed; the sole config rebuild path is `init()`.

## 0.27.1

Hotfix for v0.27.0: the **first encrypted Config Init was impossible**. Config
Init builds its database (destroy → recreate → reachability probe) *before* it
derives the config crypto provider, but it routed those DB-level ops through the
wrapped client, whose fail-closed guard throws when encryption is enabled and no
provider is unlocked yet — so Init failed with "refusing to build config client
(provisioning incomplete)" before it could create the provider. Config Init and
reinit now run their DB-level ops (destroy / ensureDb / reachability probe) on a
raw, un-wrapped client; the encrypted document push still uses the wrapped
client, by which point the provider exists. Verified on Dev with the provider
cleared (first-Init simulation).

## 0.27.0

Two themes. First, a post-release review of v0.26.1 (a multi-agent pass with
adversarial verification) surfaced ten confirmed issues; they are not
independent bugs but the same recurring shape — *a boundary where an invariant
was enforced on one side but not the other* — closed here as a return to a few
structural principles rather than spot fixes. Second, **config sync gains its
own independent codec settings** (see Added). No wire-format or schema change
and no re-initialisation of existing vaults; the only persisted-shape additions
are a `configSettingUp` flag and the (already-present, now UI-exposed) config
codec overrides — all defaulting to inherit/false, so an untouched install is
unchanged.

### Added

- **Config sync codec is configurable independently of Vault Sync.** The Config
  Sync tab's Step 1 now exposes an E2E-encryption toggle, an optional separate
  passphrase, and a gzip toggle for the config database. Each value falls back
  to the corresponding Vault Sync setting when left unset (no migration — an
  untouched install keeps inheriting), so you can e.g. encrypt the vault while
  keeping config plaintext on a trusted server, or encrypt config under a
  different passphrase. Changes take effect on the next Config Init & Push,
  which now also ratchets the config cipherVersion floor immediately so a
  downgrade is refused without waiting for the next reload.
  Bringing this to real use surfaced three latent defects that had silently
  made config encryption non-functional — all fixed and verified on a live
  two-device fleet:
  - **config Init encrypted documents under a different key than `config:meta`**:
    the push reused the client captured *before* the freshly-derived crypto
    provider was installed, so every config doc was undecryptable on all
    devices. The push now uses a client wrapped with the post-derivation provider.
  - **an empty config passphrase field did not inherit the vault passphrase**
    (`??` treated `""` as an explicit empty value); it now falls through (`||`).
  - **config pull had no seq-regression guard**: after a config Init recreated
    the remote DB, other devices' pull cursors sat above the reset seq and
    silently pulled nothing. Config pull now detects this (like vault pull) and
    self-heals by resetting the cursor and re-pulling from scratch.

### Security

- **An encryption downgrade is refused on every pull path, synchronously.** A
  cipherVersion floor violation (an unsealed body in a v3 vault) is a
  non-retriable policy violation: it now maps to a terminal error in the single
  `classifyError` classifier, so the longpoll path halts immediately instead of
  treating it as a transient error with a 10-second grace window. The catchup
  path already halted — the two paths are now symmetric. A transient decrypt
  failure (key not yet distributed) still backs off and retries. (#enc-1)

### Fixed

- **Remote hard-deletions are now applied durably.** A CouchDB tombstone was
  applied to the vault outside the commit transaction, so a crash between the
  vault delete and the local-tombstone write could lose the file permanently
  with no recovery on restart. Hard-deletions now flow through the same
  `accepted → pending-deletion → drain` path as soft-deletions: committed
  atomically with the cursor advance and retried on apply failure. (#del-1, #del-2)
- **A pull-delete with an unreadable unpushed-edit probe now fails safe-side.**
  The probe's I/O error was swallowed into "no unpushed edits" (= apply the
  deletion); it now surfaces a conflict instead, honouring the "when unsure,
  treat it as a conflict" rule. The error-prone query bus this relied on was
  removed in favour of a direct, safe-wrapped function call. (#err-10)
- **The reconciler no longer persists its manifest/cursor during teardown.** The
  trailing persist was the one DB write not gated on the disposal barrier, so it
  could race `localDb.close()` on unload (DatabaseClosedError). (#err-7)
- **Config Init is now atomic.** It records a `configSettingUp` flag before
  wiping the local config DB and clears it only on success, mirroring vault
  setup (Invariant C); config push/pull/write refuse to run against a config DB
  left half-built by an interrupted init. (#err-9)
- **A persistent push conflict now surfaces the real remote content.** When a
  race-stale entry escalated to a conflict, the modal was handed the local
  document as the "remote" side, showing identical content on both panes; it now
  uses the remote document fetched in the same cycle, or defers to the next
  cycle when fresh remote state isn't available. (#sync-001)
- **Redundant pushes are avoided** for a document whose vector clock advanced
  but whose chunks are byte-identical to the remote (e.g. after a pull-side
  clock merge). (#sync-005)
- A config concurrent-pull notice is fire-and-forget but now logs a rejection
  instead of leaving an unhandled promise. (#err-1)

### Changed

- **Exported diagnostic logs sync again.** v0.26.1 hard-coded a
  `couchsync_log_*.md` exclusion in the sync filter; that special-casing
  contradicted the design rule that sync membership is decided only by the
  user's `syncFilter` / `syncIgnore` (and dotfile) rules, not by built-in
  filename patterns. Choosing an unencrypted vault means trusting the server, so
  the plaintext-exposure concern that motivated the exclusion does not apply, and
  it has been removed.

## 0.26.1

A follow-up integrated review of the v0.26.0 release surfaced 19 confirmed
issues; this patch closes all of them. There is **no wire-format or schema
change and no re-initialisation** — every fix is either consuming state the
vault already records or extending an existing invariant to the boundary where
it was missing. The whole set was verified on a real three-device fleet
(desktop ×2 + Android) against a live cipherVersion-3 vault, plus the Docker
e2e harness (1179 unit + 14 e2e tests).

The theme continues v0.26.0's: *trust decisions belong to the client's known
policy, never to data the untrusted server supplies*, and *every invariant is
enforced symmetrically on both sides of a boundary*.

### Security

- **A re-initialised cipherVersion-3 vault now refuses an encryption
  downgrade.** v0.26.0 sealed file/config bodies into an authenticated `encBody`,
  but the decoder still dispatched on whichever fields the server sent: if a
  curious server dropped `encBody` and served the older path-only (or a plaintext)
  body, the client accepted it unauthenticated — re-opening exactly the vclock
  rollback / chunk-substitution / deleted-resurrection attacks `encBody` was meant
  to close. The decoder now enforces a per-vault cipherVersion **policy floor**:
  in a v3 vault every file/config document must be a sealed `encBody`, and the
  legacy/plaintext paths are rejected. The floor is anchored in client-local state
  on first unlock (trust-on-first-use) and the server cannot lower it by rewriting
  the (server-writable) `vault:meta` — a remote meta below the recorded floor is
  refused before any data flows. Vaults still on cipherVersion 2 keep reading the
  legacy format until they re-init.
- **The config-DB client is now fail-closed**, symmetric with the vault client:
  it refuses to build a plaintext stack when config encryption is enabled but the
  crypto provider has not unlocked, instead of silently writing unencrypted config
  bodies into an encrypted database.
- **The plugin's own `data.json` is excluded from config replication by its real
  install path** (from the manifest) rather than a hardcoded folder name, so a
  renamed install (e.g. a BRAT side-load) no longer risks pushing the plaintext
  CouchDB password and passphrase to the config server.
- **Exported diagnostic logs are no longer synced.** `couchsync_log_*.md` exports
  carry device/OS metadata and internal paths; they are now excluded from vault
  sync so they don't reach the server as plaintext on an unencrypted vault.
- `SECURITY.md` was corrected: rollback of a document to a *genuine prior*
  `encBody` is detected on established devices by the vector-clock classifier, not
  by authentication, and is **not** detected on a fresh Clone (which has no local
  baseline) — the inherent trust-on-first-use window.

### Fixed

- **A malformed chunk no longer loops forever in live sync.** A corrupt chunk was
  classified identically at the Clone/repair boundary but the live-sync boundary
  caught only a hash mismatch, not a structurally malformed envelope — so a
  tampered/bit-rotted chunk retried indefinitely instead of being quarantined.
  Both boundaries now share one classifier.
- **A failed deletion is retried instead of silently un-applying.** A clean remote
  deletion applies the vault delete after the durable commit; if that delete threw
  or the process was killed mid-pull, the deletion was lost (a database tombstone
  with the file still on disk) and never retried. It is now recorded for durable
  re-application, the same net the content-apply path already had.
- **A concurrent remote edit is no longer dropped when the local copy is deleted.**
  The mirror of the v0.26.0 delete-vs-edit fix: a local deletion racing a remote
  edit is now persisted and re-presented after a restart, instead of the remote
  edit being lost once the local deletion had pushed.
- **A pulled deletion over a legacy baseline now surfaces a conflict instead of
  silently overwriting a divergent local edit**, by falling back to the stored
  document as the comparison baseline.
- **Chunk repair re-validates local references before deleting a local chunk**,
  closing the same scan-then-delete race the remote side already guarded against.

### Internal

- Codec error types moved to a dependency-free module so the sync pipeline no
  longer compile-depends on the encryption decorator.
- `ConfigSync`'s optional wiring is now a single options object rather than a long
  positional argument list.

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
