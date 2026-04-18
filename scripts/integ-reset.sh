#!/usr/bin/env bash
#
# integ-reset.sh — drop all non-system databases in the running CouchDB,
# leaving a clean slate between E2E test files.
#
# Usage:
#     ./scripts/integ-reset.sh [vault_db_name] [config_db_name]
#
# Defaults: couchsync-e2e-vault and couchsync-e2e-config.

set -euo pipefail

VAULT_DB="${1:-couchsync-e2e-vault}"
CONFIG_DB="${2:-couchsync-e2e-config}"
BASE="${COUCHDB_URL:-http://admin:admin@localhost:5984}"

drop_if_exists() {
    local db="$1"
    if curl -fsS -o /dev/null -X HEAD "$BASE/$db"; then
        echo "integ-reset: dropping $db..."
        curl -fsS -X DELETE "$BASE/$db" >/dev/null
    fi
}

create_if_missing() {
    local db="$1"
    echo "integ-reset: creating $db..."
    curl -fsS -X PUT "$BASE/$db" >/dev/null
}

drop_if_exists "$VAULT_DB"
drop_if_exists "$CONFIG_DB"
create_if_missing "$VAULT_DB"
create_if_missing "$CONFIG_DB"

echo "integ-reset: done."
