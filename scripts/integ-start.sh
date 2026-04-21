#!/usr/bin/env bash
#
# integ-start.sh — spin up a CouchDB 3.3 instance for E2E tests.
# Requires Docker. Exits non-zero on failure with a clear message.
#
# Usage:
#     ./scripts/integ-start.sh
#
# Leaves behind:
#     - couchsync-integ-couchdb container on port 5984
#     - admin/admin credentials
#
# Pair with `integ-stop.sh` to tear down afterwards.

set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
    echo "integ-start: docker is not installed or not on PATH." >&2
    echo "Install Docker Desktop (Windows/Mac) or docker.io (Linux) before running E2E tests." >&2
    exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
    echo "integ-start: 'docker compose' plugin missing (requires Docker 20.10+)." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "integ-start: bringing up CouchDB..."
(cd "$PROJECT_ROOT" && docker compose up -d couchdb)

# Use 127.0.0.1 explicitly. On Windows, `localhost` can resolve to the
# IPv6 loopback `::1` first, which Docker Desktop's port forwarder does
# not bind by default — the curl hangs until timeout and the auth-cache
# warnings below never get silenced. Forcing IPv4 keeps behaviour
# consistent across platforms.
COUCH_HOST="http://127.0.0.1:5984"

echo "integ-start: waiting for ${COUCH_HOST}/_up to return 200..."
for i in $(seq 1 60); do
    if curl -fsS "${COUCH_HOST}/_up" >/dev/null 2>&1; then
        echo "integ-start: CouchDB is healthy."
        # Create the three system databases CouchDB expects in "single-node"
        # mode. Without them the logs spam `database_does_not_exist` every
        # few seconds from the auth cache / replicator / global-changes
        # feed. Idempotent — PUT returns 412 if a DB already exists.
        for sysdb in _users _replicator _global_changes; do
            curl -fsS -u admin:admin -X PUT "${COUCH_HOST}/${sysdb}" \
                >/dev/null 2>&1 || true
        done
        exit 0
    fi
    sleep 1
done

echo "integ-start: CouchDB failed to reach healthy state within 60s." >&2
(cd "$PROJECT_ROOT" && docker compose logs couchdb || true) >&2
exit 1
