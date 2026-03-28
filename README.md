# CouchSync

Simplified CouchDB-only vault sync for Obsidian. Fork of [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync), focused on CouchDB reliability.

## Features

- **CouchDB sync** — Real-time vault synchronization via CouchDB
- **End-to-end encryption** — Notes are encrypted before leaving your device
- **Conflict resolution** — Automatically merges simple conflicts, manual resolution for complex ones
- **Customization sync** — Sync settings, snippets, themes, and plugins across devices

## Setup

### 1. Prepare CouchDB

Set up a CouchDB instance. Options include:

- [CouchDB on fly.io](docs/setup_flyio.md) (recommended for beginners)
- [Manual CouchDB setup](docs/setup_own_server.md)
- Docker: `docker run -d -p 5984:5984 -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=password couchdb`

### 2. Install the plugin

Install from Obsidian Community Plugins (search "CouchSync"), or manually copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/obsidian-couchsync/` directory.

### 3. Configure

Open Settings > CouchSync and enter your CouchDB server URL and credentials.

## Development

```bash
npm install
npm run dev    # Watch mode, outputs to dev vault
npm run build  # Production build
```

Built files are output to `{OBSIDIAN_VAULT_PATH}/.obsidian/plugins/obsidian-couchsync/`.

Set the `OBSIDIAN_VAULT_PATH` environment variable to your vault path. Defaults to `C:\Obsidian\Dev`.

## License

MIT
