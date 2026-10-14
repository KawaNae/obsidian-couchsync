# CouchSync settings reference

This is the accurate settings/usage reference for CouchSync. Open the
plugin settings in Obsidian (**Settings → CouchSync**). The UI has five
tabs, in this order: **CouchDB**, **Vault Sync**, **Config Sync**,
**History**, and **Maintenance**.

## How the connection is gated

The vault connection moves through these states, and the UI enables actions
accordingly:

`editing` → `tested` → `setupDone` → `syncing`

- In the **CouchDB** tab you enter the server connection, press **Test**,
  then **Apply**. This marks the server as tested; changing the URI,
  username or password sets the vault state back to `editing`.
- In **Vault Sync → Step 2** you press **Check**, then **Apply**, reaching
  `tested`.
- **Init** or **Clone** moves you to `setupDone`. While either runs, the
  state is `settingUp`; if it fails or is interrupted, it stays there:
  Init and Clone remain enabled to retry, and Live Sync stays disabled.
- Enabling **Live Sync** moves you to `syncing`. While syncing, the server
  connection, the vault database and the vault encryption settings are
  locked.

Vault sync is **continuous** once Live Sync is on. **Init**, **Clone**, and
config-sync operations are the manual, full-DB actions.

---

## CouchDB tab

The server connection shared by vault and config sync, plus a view of the
server.

**Server Connection**
- **Server URI**, **Username**, **Password** (`couchdbUri`, `couchdbUser`,
  `couchdbPassword`).
- **Test Connection** (**Test**) verifies reachability and credentials;
  **Apply** saves them. Apply needs a passed Test, and is refused while a
  config operation runs (nothing is saved then).

**Server Info** and **Databases** (shown after Test + Apply)
- Server version, UUID and features.
- The non-system databases with document count, size and last update. The
  vault and config databases in use are marked `(connected)`.
- **Delete** on any other database — a confirm dialog, then a
  type-the-name-to-confirm dialog.
- When the server rejected the credentials, CouchSync stops contacting it
  and the tab shows **Authentication error** with a **Retry** button.

---

## Vault Sync tab

The main tab, organized as steps.

**Device Name**
- **Device name** + **Apply** — required. Lowercase letters, numbers, and
  hyphens only, 2–30 characters (e.g. `desktop`, `iphone-pro`). This is the
  device's vector-clock key, so it must be unique per device. Renaming keeps
  the old name in `previousDeviceIds` (the last 10).

**Step 1: Encryption**
- **E2E encryption** (`encryptionEnabled`, default **off**) + **Passphrase**
  (`encryptionPassphrase`, shown while encryption is on). Encrypts note
  contents and file paths with AES-256-GCM. Turning encryption off clears
  the passphrase.
- **Compress chunks (gzip)** (`compressionEnabled`, default **on**).

  Both are editable unless Live Sync is on. Changing either after setup
  sets the state back to `tested`, so Init or Clone must run again before
  Live Sync.

  Encryption × compression gives the four codec modes: `raw`, `gzip`,
  `encrypt`, `gzip+encrypt`. The mode is fixed at **Init** and recorded in the
  server's `vault:meta`; Clone adopts whatever the server declares.

**Step 2: Database** (needs the CouchDB tab's Test + Apply)
- **Vault Database Name** (`couchdbDbName`, default `obsidian`).
- **Check Database** (**Check**) — verifies the database exists, or creates
  it, and shows its document count. **Apply** saves the name and needs a
  passed Check.

**Step 3: Setup**
- **Init** (first device) — ⚠️ **destructive**: recreates the remote vault
  database from this vault and seeds it. Every other device has to Clone
  again; a device that notices the re-created database stops its live sync.
- **Clone** (subsequent devices) — pulls the whole remote into a fresh local
  DB and writes the vault files; prompts for the passphrase if the vault is
  encrypted. It reads the database before changing anything and refuses an
  empty one. A database found empty (by Step 2's Check or an earlier Init or
  Clone) does not disable it; the description then points to Init.
- Both first check what they can without changing anything (the server
  answers, the passphrase, for Clone a database that is not empty), then
  ask for confirmation, naming the database, its document count and the
  vault's encryption and compression. Cancel changes nothing: live sync
  and the setup state stay as they were.

**Step 4: Sync**
- **Live Sync** — toggle continuous sync on/off. Enabled after Init or
  Clone has completed.

**Filters** (device-local; other devices may use different filters)
- **Sync filter (RegExp)** (`syncFilter`) / **Ignore filter (RegExp)**
  (`syncIgnore`) — include/exclude patterns for vault paths.
- **Max file size (MB)** (`maxFileSizeMB`, default **50**; `0` = skip all
  files).
- **Skipped large files** — files skipped for exceeding the size limit.
  **Forget** removes one from the list without syncing it.

---

## Config Sync tab (optional)

Replicates `.obsidian/` configuration through a **separate** CouchDB database
on the **same** server. The server credentials come from the CouchDB tab, and
the device name from Vault Sync (shown read-only here). Encryption and
compression are config sync's own (Step 1). Steps 2–4 need the CouchDB tab's
Test + Apply.

Config sync is **manual** (button-driven), not real-time.

**Step 1: Encryption & compression** — what the **next Create** builds the
config database with. Push and Pull always use the encryption, compression
and passphrase of the config database this device created or joined, so
changing Step 1 does not stop config sync. When Step 1 differs from the
current database, the step says so.
- **E2E encryption** (`configEncryptionEnabled`) and **Compress (gzip)**
  (`configCompressionEnabled`) — while never toggled, each inherits the
  Vault Sync value; toggling stores an independent value.
- **Passphrase** (`configEncryptionPassphrase`, shown while encryption is
  on) — what the next Create encrypts with. Left empty, Create uses the
  Vault Sync passphrase. Create and Join do not write to this field. An
  encrypting Create with no passphrase at all stops before anything is
  deleted.

**Step 2: Database**
- **Config Database Name** (`couchdbConfigDbName`) — must be **different**
  from the vault database name. Use distinct names across device pools to
  keep `.obsidian/` independent while sharing a vault.
- **Check Database** (**Check**) — verifies the database exists, or creates
  it.
- **Apply** — saves the name and switches config sync to that database
  without a reload. A non-empty name needs a passed Check; applying an
  empty name **disables** config sync. Apply is refused while a config
  operation runs (nothing is saved then).

**Step 3: Setup**
- **Create** (first device) — ⚠️ **destructive**: deletes the config
  database on the server and re-creates it empty, with a new root
  (`config:meta`) built from Step 1. The confirm dialog shows how many
  documents the server holds and whether `config:meta` exists (or that the
  server could not be read), the encryption, compression and cipher version
  Create will build — with a warning when that is weaker than the current
  database — and that every other device must Join again. Create does not
  send content; run **Push** afterwards.
- **Join** (every other device) — syncs with the existing database's own
  encryption and compression. It changes neither the server nor Step 1.
  For an encrypted database it tries the passphrase this device kept for
  that database, then Step 1's, then the Vault Sync passphrase, and asks
  only when none unlocks it. Join asks for confirmation before adopting an
  unencrypted database, or an older cipher version, for a database this
  device knew as encrypted. Run **Pull** afterwards.
- The passphrase of an encrypted config database is kept with that
  database (per server and database name, in `configBindings`) when Create
  or Join succeeds. Push and Pull unlock with that value alone, so Step 1
  and the Vault Sync passphrase can change without stopping config sync.
- A status line above the buttons shows this device's relation to the
  config database, using the results of the last operation (Push, Pull,
  Join, Create) and of the last check. The filter tree's listing of the
  server counts as a check, and a successful check does not clear a failed
  operation. In order of priority it shows: rejected credentials, an
  unfinished Create, the last failure (e.g. `Last Join: …`), `Not joined
  yet`, then that the device is joined and ready.

**Step 4: Sync**
- **Filter** — what this device syncs, by meaning. The same selection
  applies to Push (send) and Pull (write), and is device-local
  (`configSyncPolicy`).
  - **Don't sync plugin code (JavaScript)** (default **on**) — never sends
    or receives plugin `main.js` / manifest files.
  - **Portable settings** (default on): app settings, core plugin settings,
    community plugin settings (`data.json`), themes, snippets.
  - **Installation state** (default off): community plugin code and the
    enabled-plugin lists.
  - Workspace/layout files are always excluded. On mobile, desktop-only
    plugins are never received.
  - The tree lists config on this device and on the server. When it cannot
    list the server, it says `Showing this device's config only — see Step
    3.`
  - A file takes part only where this device also writes it: a plugin's
    `data.json` is neither sent nor written where the plugin is not
    installed, and a desktop-only plugin's files are neither sent nor
    written on mobile.
- **Push** (**Push ↑**) — lists the changes this device made to the
  selected files since it last pushed or pulled them, one row per JSON key
  (per plugin in `community-plugins.json`) or per file, all checked; the
  push button sends the checked ones. Each key shows the shared value and
  this device's; for a plugin's `data.json`, which may hold API keys or
  tokens, the values appear only after **Show values**. Unchecked rows stay
  this device's own: an unchecked key is not sent and later Pulls do not
  change it (it is listed under **Kept on this device**, and in later Push
  lists it is unchecked and marked `kept on this device`; checking it sends
  it and shares it again); an unchecked file stops syncing on this device
  (an override in the tree above, where it can be turned back on). Cancel
  sends nothing. A file the server changed since this device's last Pull is
  held: the notice asks to run Pull & Reload, then Push again.
- **Kept on this device** (`configSyncPolicy.deviceOnlyKeys`, shown when
  there are any) — the keys left out of a Push, per file. **Share again**
  removes one; if this device's value differs from the shared one, the
  next Push lists it.
- **Pull & Reload** (**Pull & Reload ↓**) — pulls, merges the selected files
  with this device's changes (JSON settings key by key), backs up the files
  it overwrites to `backups/config/` in the plugin's folder, then reloads
  Obsidian. When no file changes, it shows `No config files changed; no
  reload needed.` and does not reload. A failed Pull does not reload.
- **Pull & Overwrite** (**Overwrite ↓**) — makes the selected files exactly
  the shared config, without merging: changes not pushed are lost, selected
  files the server does not have are deleted, and **Kept on this device** is
  emptied (file overrides in the tree stay). Files that do not take part on
  this device (left out by the tree, a plugin not installed here, a
  desktop-only plugin on mobile, the workspace layout, CouchSync's own
  folder) are not touched. A confirmation lists the files to delete and to
  write; Cancel changes nothing. The files are backed up to
  `backups/config/`, then Obsidian reloads. When the server has no config
  for the selection, nothing is changed.
- Both Pulls stop a community plugin before writing or deleting its files,
  so it cannot save its in-memory settings over them before the reload.
- After another config database's Pull wrote this vault's config, Push and
  Pull on this database merge as after a Join: the shared values win, keys
  only this device has stay.
- Push and Pull on a device that has not joined stop and ask it to Join.
  When another device ran Create, they stop and ask this device to Join
  again.

Every failed config operation shows a notice and writes a log line naming
the cause and the fix, e.g. `CouchSync: Config Pull failed — …`.

---

## History tab

**Sync Timing**
- **Sync debounce (seconds)** (`syncDebounceMs`, default **2** s) — how long
  to wait after the last edit before syncing the file.
- **Sync minimum interval (seconds)** (`syncMinIntervalMs`, default **0** =
  disabled) — minimum time between consecutive syncs of the same file.

**Diff History** — CouchSync keeps a local diff history of file changes
(independent of CouchDB).
- **Retention period (days)** (`historyRetentionDays`, default **30**).
- **Debounce interval (seconds)** (`historyDebounceMs`, default **5** s).
- **Minimum interval (seconds)** (`historyMinIntervalMs`, default **60** s) —
  minimum time between consecutive saves for the same file.
- **Exclude patterns** (`historyExcludePatterns`) — globs excluded from
  history, one per line.
- **Clear all history**.

> `historyMaxStorageMB` (default **500**) exists in settings but has no UI
> control and is not used yet.

---

## Maintenance tab

- **Status Indicator** — on mobile only: **Align**, **Bottom (px)**,
  **Horizontal offset (px)** (`mobileStatus`).
- **Logging**
  - **Verbose notice** (`verboseNotice`, default off) — also show
    debug/info-level logs in the console and as notices.
  - **Log retention (days)** (`logRetentionDays`, default **7**) and **Max
    log storage (MB)** (`logMaxStorageMB`, default **50**; `0` = no size
    cap). Logs persist in IndexedDB.
  - **Log buffer** statistics, **Export logs**, **Clear stored logs**,
    **Delete local log database**.
- **Migration** — **Clean up legacy configs from vault DB**: deletes
  leftover `config:*` documents from the vault database.
- **Diagnostics** — **Chunk consistency report**: compares local and
  remote chunk inventories; the result offers a repair action.
- **Recovery** — **Restart sync**.
- **Reset** — **Delete local vault database** and **Delete local config
  database** (local only; the remote is not touched). After deleting the
  local config database the device is no longer joined: press Join in
  Config Sync, then Pull.

---

## Important notes

- **Codec modes** = `encryptionEnabled` × `compressionEnabled`, chosen at
  **Init**, recorded in `vault:meta`. On Clone, the **server's** declared mode
  wins. `gzip+encrypt` is recommended for untrusted servers. The config
  database's codec is chosen at **Create** and recorded in `config:meta`;
  Join adopts it.
- **Auth** is HTTP Basic only — there is no JWT, Cloudant API-key, or
  setup-URI flow.
- **Secrets in `data.json`:** the CouchDB password, the encryption
  passphrases and the passphrases kept for config databases are stored in
  **plaintext** in the vault's plugin data. See
  [../SECURITY.md](../SECURITY.md).
