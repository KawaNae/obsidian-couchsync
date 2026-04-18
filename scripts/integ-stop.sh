#!/usr/bin/env bash
#
# integ-stop.sh — tear down the CouchDB instance started by integ-start.sh.

set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
    echo "integ-stop: docker is not installed — nothing to stop." >&2
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "integ-stop: stopping CouchDB..."
(cd "$PROJECT_ROOT" && docker compose down -v)
echo "integ-stop: done."
