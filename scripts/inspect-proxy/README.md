# inspect-proxy

Read-only credential broker for inspecting a remote CouchDB from an AI coding
agent (Claude Code, Cursor, etc.) without ever exposing the credential to the
agent's shell or filesystem.

## Why

`scripts/.env` is the obvious place to keep CouchSync admin credentials for dev
scripts, but anything in this repo's working tree is readable by an AI agent
running in the same workspace. This broker decouples capability from secret:

- The agent can hit `http://127.0.0.1:9999/...` freely and inspect the DB
- The credential lives only inside the broker process (started in a separate
  shell that the agent doesn't share)
- The broker is GET/HEAD-only (capability-scoped to read-only)
- A per-startup `X-Inspect-Token` gates access (revoked by stopping the broker)

## Architecture

```
agent shell                user shell
-----------                ----------
$ curl -H "X-Inspect-Token: T..." \    bw unlock --raw → $env:BW_SESSION
       http://127.0.0.1:9999/...       bw get password CouchSync → in-process
                  │                              │
                  │                    .\start-broker.ps1
                  │                              │
                  │                    inspect-proxy.py (listens 127.0.0.1:9999)
                  │                              │
                  ▼                              ▼
          ┌──────────────────────────────────────────┐
          │  Authorization: Basic <…>                │
          │  HTTPS GET <COUCHSYNC_URI>/<path>        │
          └──────────────────────────────────────────┘
                              │
                              ▼
                       remote CouchDB
```

## Prereq

- Python 3.x in `PATH`
- Bitwarden CLI (`bw`) in `PATH`, `bw login` done once (works against
  bitwarden.com or self-hosted Vaultwarden — `bw config server <url>`)
- Vault item with username + password + URI of the CouchDB admin
  - Default item name: `CouchSync` (override with `$env:COUCHSYNC_VAULT_ITEM`)
  - Required fields: `username`, `password`, and at least one URI entry
    containing the full base URL (e.g. `https://your-couchdb-host:6984`)
  - The script fetches the item by exact name via `bw get item` and then
    parses its JSON, so URI lookup is unambiguous (unlike `bw get uri`,
    which matches by URI substring across the entire vault)

## Usage

### Start the broker (in a user-controlled shell)

```powershell
cd <repo>\scripts\inspect-proxy
.\start-broker.ps1
```

You will be prompted for the Bitwarden master password (only if `BW_SESSION`
isn't already set in the shell). The broker prints an `X-Inspect-Token` to
stdout/stderr — copy that value.

### Use from the agent

Hand the token to the agent (e.g. paste into chat). The agent then makes calls
like:

```bash
TOKEN='<paste-token-here>'
curl -H "X-Inspect-Token: $TOKEN" http://127.0.0.1:9999/_all_dbs
curl -H "X-Inspect-Token: $TOKEN" http://127.0.0.1:9999/<db-name>/_all_docs?limit=10
curl -H "X-Inspect-Token: $TOKEN" \
     "http://127.0.0.1:9999/<db-name>/_changes?feed=longpoll&since=now&heartbeat=3000&timeout=20000"
```

Write attempts are rejected with 405:

```bash
curl -X PUT -H "X-Inspect-Token: $TOKEN" http://127.0.0.1:9999/test
# → 405 Method Not Allowed (read-only broker)
```

### Stop / revoke

`Ctrl-C` in the broker shell. The token becomes invalid (re-issued on next
start). Credential is wiped from the shell env.

## Security model

| Threat | Mitigation |
|---|---|
| Agent reading the credential off disk | Credential never touches disk; only present in `start-broker.ps1` process and child broker process memory |
| Agent calling write endpoints | Method whitelist (`GET`, `HEAD` only) returns 405 |
| Other processes on `127.0.0.1` hitting the broker | `X-Inspect-Token` gating; same-OS-user processes can in principle observe the token if it leaks via stderr redirection — keep the broker shell foreground |
| Long-lived access | Broker stop = immediate revocation; token is regenerated per start |
| Credential rotation | Update once in the Bitwarden vault; next broker start picks up the new value |

## Limitations

- Process memory dump (`procdump` etc.) on the user's machine still exposes the
  credential. Compromise of the OS user defeats the broker. The point is to
  raise the bar for agent-induced incidents, not stop a determined attacker
  with full local access.
- The broker shell environment briefly holds the password in env vars. They are
  cleared on broker exit but a `procdump` of the launching shell during that
  window would still capture them.
- Bitwarden master password entry hygiene (terminal history, screen recording)
  is the user's responsibility.

## Customisation

- Listen port: set `BROKER_PORT` env var before launching (default `9999`).
- Allowed methods: edit `ALLOWED_METHODS` in `inspect-proxy.py`. Keep it
  read-only unless you have a strong reason.
- Vault item name: change the `bw get … CouchSync` lines in `start-broker.ps1`.
