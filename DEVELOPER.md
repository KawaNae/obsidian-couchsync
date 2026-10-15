# Developing CouchSync

## Build

```bash
npm install
npm run dev        # watch mode
npm run build      # type-check, then a production build
npm run typecheck  # type-check only
```

Both `dev` and `build` write `main.js` (and the other plugin files) to
`<vault>/.obsidian/plugins/obsidian-couchsync/`. The vault is taken from
the `OBSIDIAN_VAULT_PATH` environment variable and defaults to
`~/Develop/Obsidian/Dev` under your home directory. The output directory is
created when it does not exist.

## Tests

| Command | What it runs | Needs CouchDB |
|---|---|---|
| `npm test` | Unit and integration tests (`tests/**/*.test.ts`, without `tests/e2e`) | No |
| `npm run test:e2e` | End-to-end tests against a real CouchDB (`tests/e2e/**/*.test.ts`), one file at a time | Yes |
| `npm run test:all` | Type-check, then both of the above | Yes |
| `npm run bench` | Codec benchmark (`tests/e2e/**/*.bench.ts`); prints `tests/e2e/codec-bench.result.txt` | Yes |

The tests replace the `obsidian` package, which ships only type
definitions, with the stub in `tests/helpers/obsidian-stub.ts`.

## CouchDB for the e2e tests

The e2e tests and the benchmark use the CouchDB 3.3 container defined in
`docker-compose.yml`, on port 5984. The scripts below start and stop it:

```bash
npm run integ:start   # start CouchDB and wait until it is healthy
npm run test:e2e
npm run integ:stop    # stop it and remove its data
npm run integ:reset   # drop and re-create the e2e databases
```

The container keeps no volume, so `integ:stop` leaves nothing behind. The
tests read `COUCHDB_URL`, `COUCHDB_USER` and `COUCHDB_PASSWORD` when set;
otherwise they use the container's address and the credentials in
`docker-compose.yml`.

`integ:start` needs `docker` with the `docker compose` plugin and a running
daemon. It stops with a hint when one of them is missing.

### macOS

Install colima, docker and docker-compose with Homebrew:

```bash
brew install colima docker docker-compose
```

Homebrew's docker-compose is a CLI plugin. Add Homebrew's plugin directory
to `~/.docker/config.json` so that `docker compose` finds it:

```json
{
  "cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]
}
```

On an Intel Mac the directory is `/usr/local/lib/docker/cli-plugins`. Then
start the VM before the tests and stop it afterwards:

```bash
colima start --cpu 2 --memory 2
npm run integ:start
npm run test:e2e
npm run integ:stop
colima stop
```

### Windows

Install Docker Desktop and start it before `npm run integ:start`. The
scripts are bash scripts; run them from Git Bash or WSL.

### Linux

Install `docker.io` (or Docker Engine) with the compose plugin from your
distribution's packages.
