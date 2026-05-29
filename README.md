# CouchSync

Simplified CouchDB-only vault sync for Obsidian. Fork of [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync), focused on CouchDB reliability.

> **Pre-1.0.** This is an early, personal project. Migration between major
> versions is **destructive** (no automated upgrade). See
> [Upgrading](#upgrading) and the [CHANGELOG](CHANGELOG.md).

## Features

- **CouchDB sync** — Continuous, bidirectional vault sync via CouchDB. Once
  Live Sync is enabled, local edits push and remote changes pull in near
  real time (CouchDB `_changes` longpoll + a debounced local change tracker).
- **End-to-end encryption (optional)** — AES-256-GCM with PBKDF2 (600k
  iterations) key derivation. When enabled, note contents **and file paths**
  are encrypted before leaving the device. Off by default; the passphrase is
  set at Init. See [SECURITY.md](SECURITY.md).
- **Four codec modes** — `raw`, `gzip`, `encrypt`, `gzip+encrypt`, chosen at
  Init and recorded server-side. `gzip+encrypt` is recommended for untrusted
  servers.
- **Conflict handling** — Sync relations are classified by vector clock +
  content-addressed chunks. Identical content with diverged clocks reconciles
  silently; genuinely concurrent, divergent edits open a side-by-side dialog
  where you choose **keep local** or **take remote**. There is no text-level
  auto-merge.
- **Config sync (optional, manual)** — Replicate `.obsidian/` settings,
  snippets, themes, and plugin files through a separate CouchDB database.
  Button-driven (Init / Push / Pull), not real-time. Opt-in: only active when
  a config DB name is set.

## Setup

### 1. Prepare CouchDB

Run a CouchDB instance — Docker is the simplest:

```bash
docker run -d -p 5984:5984 \
  -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=password \
  --name couchdb couchdb
```

CouchSync creates the vault database itself on first connect, so you only
need the server reachable with valid admin credentials.

**Enable CORS** (required — Obsidian talks to CouchDB from a sandboxed
origin). Either use Fauxton (`http://localhost:5984/_utils` → Configuration →
CORS → enable, "All domains"), or set it via the REST API:

```bash
B="http://admin:password@localhost:5984"
curl -X PUT $B/_node/_local/_config/httpd/enable_cors -d '"true"'
curl -X PUT $B/_node/_local/_config/cors/credentials -d '"true"'
curl -X PUT $B/_node/_local/_config/cors/origins \
  -d '"app://obsidian.md,capacitor://localhost,http://localhost"'
curl -X PUT $B/_node/_local/_config/cors/methods \
  -d '"GET,PUT,POST,HEAD,DELETE"'
curl -X PUT $B/_node/_local/_config/cors/headers \
  -d '"accept,authorization,content-type,origin,referer"'
```

**Mobile note:** iOS/Android require HTTPS with a valid (non-self-signed)
certificate — plain `http://` and self-signed certs will not connect. Put
CouchDB behind a reverse proxy (nginx/Caddy) with a real certificate for
mobile use.

### 2. Install the plugin

Install from Obsidian Community Plugins (search "CouchSync"), or manually copy
`main.js`, `manifest.json`, and `styles.css` into your vault's
`.obsidian/plugins/obsidian-couchsync/` directory.

### 3. Configure and start syncing

Open **Settings → CouchSync → Vault Sync** and work top to bottom:

1. **Device name** — a short identifier for this device (lowercase letters,
   numbers, and hyphens; 2–30 chars, e.g. `desktop`, `iphone`). Required; it
   is this device's vector-clock key.
2. **Encryption (optional)** — enable end-to-end encryption and set a
   passphrase, and/or toggle gzip compression (on by default).
3. **Connection** — enter the CouchDB URL, username, password, and vault
   database name, then **Test Connection** → **Apply**.
4. **Init or Clone:**
   - On the **first** device, run **Init**. ⚠️ This is **destructive** to the
     remote database — it recreates it from this vault. The codec mode
     (encryption/compression) is fixed here.
   - On **every other** device, run **Clone** (it prompts for the passphrase
     if the vault is encrypted).
5. **Enable Live Sync** to start continuous syncing.

Encrypted vaults need the **same passphrase on every device**. The codec mode
chosen at Init is recorded on the server, and Clone adopts it automatically.

For the full settings reference, see [docs/SETTINGS.md](docs/SETTINGS.md).

## Security

CouchSync can encrypt note contents and file paths end-to-end (AES-256-GCM).
The threat model, the four codec modes, what encryption does and does **not**
protect (e.g. the passphrase is stored in plaintext in `data.json`), and the
on-wire envelope format are documented in [SECURITY.md](SECURITY.md). Read it
before trusting an untrusted server.

## Upgrading

There is **no automated upgrade** between major data-layer versions —
document identity changed, so old and new vaults cannot interoperate.
Migrating is destructive:

1. Stop sync on every device.
2. Recreate (or empty) the remote database.
3. Run **Init** on one device, choosing the codec mode.
4. Run **Clone** on the rest (same passphrase if encrypted).

See the [CHANGELOG](CHANGELOG.md) for per-version breaking changes.

## Development

```bash
npm install
npm run dev    # Watch mode, outputs to dev vault
npm run build  # Type-check + production build
npm test       # Unit + integration tests (vitest)
```

Built files are written to
`{OBSIDIAN_VAULT_PATH}/.obsidian/plugins/obsidian-couchsync/`. Set the
`OBSIDIAN_VAULT_PATH` environment variable to your vault path (defaults to
`C:\Obsidian\Dev`).

## License

MIT
