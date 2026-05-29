# CouchSync settings reference

This is the accurate settings/usage reference for CouchSync. Open the
plugin settings in Obsidian (**Settings → CouchSync**). The UI has five
tabs: **Vault Sync**, **Config Sync**, **History**, **Maintenance**, and
**CouchDB**.

## How the connection is gated

The connection moves through four states, and the UI enables actions
accordingly:

`editing` → `tested` → `setupDone` → `syncing`

- You edit connection settings, then **Test Connection**.
- After a successful test you **Apply**, reaching `tested`.
- **Init** or **Clone** moves you to `setupDone`.
- Enabling **Live Sync** moves you to `syncing`.

Vault sync is **continuous** once Live Sync is on. **Init**, **Clone**, and
config-sync operations are the manual, full-DB actions.

---

## Vault Sync tab

The main tab, organized as steps.

- **Device name** — required. Lowercase letters, numbers, and hyphens only,
  2–30 characters (e.g. `desktop`, `iphone-pro`). This is the device's
  vector-clock key, so it must be unique per device. Renaming preserves the
  old name in history.

**Step 1 — Encryption & compression**
- **Enable end-to-end encryption** (`encryptionEnabled`, default **off**) +
  **passphrase** (`encryptionPassphrase`). Encrypts note contents and file
  paths with AES-256-GCM. Encryption cannot be changed while syncing; turning
  it on/off requires re-running Init/Clone across the device pool.
- **Compress chunks (gzip)** (`compressionEnabled`, default **on**).

  Encryption × compression gives the four codec modes: `raw`, `gzip`,
  `encrypt`, `gzip+encrypt`. The mode is fixed at **Init** and recorded in the
  server's `vault:meta`; Clone adopts whatever the server declares.

**Step 2 — Connection**
- **CouchDB URL**, **Username**, **Password**, **Vault database name**
  (`couchdbDbName`, default `obsidian`).
- **Test Connection** verifies reachability/credentials; **Apply** saves.

**Step 3 — Init / Clone**
- **Init** (first device) — ⚠️ **destructive**: recreates the remote vault
  database from this vault and seeds it.
- **Clone** (subsequent devices) — pulls the whole remote into a fresh local
  DB and writes the vault files; prompts for the passphrase if the vault is
  encrypted.

**Step 4 — Live Sync**
- Toggle continuous sync on/off.

**Filters**
- **Sync filter** (`syncFilter`) / **Sync ignore** (`syncIgnore`) — regex
  include/exclude for vault paths.
- **Max file size** (`maxFileSizeMB`, default **50** MB; `0` = skip all
  files).

---

## Config Sync tab (optional)

Replicates `.obsidian/` configuration through a **separate** CouchDB database
on the **same** server. Credentials and encryption are **inherited** from the
Vault Sync tab (shown read-only here). This tab is gated on Vault Sync having
been tested.

- **Config database name** (`couchdbConfigDbName`) — empty **disables** config
  sync. Must be **different** from the vault database name. Use distinct names
  across device pools to keep `.obsidian/` independent while sharing a vault.
- **Actions** — Init & Push / Push / Pull & Reload. Config sync is
  **manual** (button-driven), not real-time.
- **Config sync paths** (`configSyncPaths`) — which `.obsidian/` paths a Pull
  writes back locally.

---

## History tab

CouchSync keeps a local diff history of file changes (independent of CouchDB).

- **Sync debounce** (`syncDebounceMs`, default **2000** ms) — how long to wait
  after an edit before pushing.
- **Sync min interval** (`syncMinIntervalMs`, default **0** = disabled) —
  minimum gap between push cycles.
- **History retention** (`historyRetentionDays`, default **30** days).
- **History debounce** (`historyDebounceMs`, default **5000** ms).
- **History min interval** (`historyMinIntervalMs`, default **60000** ms).
- **History exclude patterns** (`historyExcludePatterns`) — globs excluded
  from history capture.
- **Clear all history**.

> `historyMaxStorageMB` (default **500**) exists in settings but has no UI
> control yet.

---

## Maintenance tab

- **Verbose notices** (`verboseNotice`, default off) — surface debug-level
  notices.
- **Log retention** (`logRetentionDays`, default **7** days) and **log
  storage cap** (`logMaxStorageMB`, default **50** MB; `0` = no size cap).
  Logs persist in IndexedDB.
- **Mobile status position** — on mobile only.
- **Export / clear logs**, **chunk consistency report**, **restart sync**.
- **Delete local databases** — vault / config / log DBs (local only; does not
  touch the remote).
- **Legacy config cleanup**.

---

## CouchDB tab

A status/admin view of the configured CouchDB server.

- Server info and the list of non-system databases.
- **Delete a database** — a two-step, type-to-confirm action.

---

## Important notes

- **Codec modes** = `encryptionEnabled` × `compressionEnabled`, chosen at
  **Init**, recorded in `vault:meta`. On Clone, the **server's** declared mode
  wins. `gzip+encrypt` is recommended for untrusted servers.
- **Auth** is HTTP Basic only — there is no JWT, Cloudant API-key, or
  setup-URI flow.
- **Secrets in `data.json`:** the CouchDB password and the encryption
  passphrase are stored in **plaintext** in the vault's plugin data. See
  [../SECURITY.md](../SECURITY.md).
- **Config-side codec overrides** (`configEncryptionEnabled`,
  `configCompressionEnabled`, …) exist internally but are **not** surfaced in
  the UI yet (planned follow-up).
