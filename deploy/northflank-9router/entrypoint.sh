#!/bin/sh
# 9router container wrapper: restore state from the federation worker vault,
# run 9router, push state back on an interval and on shutdown. Survives image
# updates because Northflank stores THIS command, not the image's entrypoint.
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
DB_PATH="$DATA_DIR/db/data.sqlite"
SYNC_INTERVAL="${SYNC_INTERVAL:-180}"

mkdir -p "$DATA_DIR/db"
log() { echo "[9router-sync] $*"; }

if [ -z "${VAULT_URL:-}" ] || [ -z "${STATE_KEY:-}" ]; then
  log "WARNING: VAULT_URL/STATE_KEY not set; running without state sync"
else
  log "restoring state from vault..."
  node /sync.mjs pull || log "pull failed or empty; starting fresh"
  node /sync.mjs loop &
  SYNC_PID=$!
fi

on_shutdown() {
  log "shutdown; final state push"
  [ -n "${SYNC_PID:-}" ] && kill "$SYNC_PID" 2>/dev/null || true
  [ -n "${VAULT_URL:-}" ] && node /sync.mjs push || true
  exit 0
}
trap on_shutdown TERM INT

log "starting 9router..."
cd /app
PORT="${PORT:-20128}"
export HOST="${HOST:-0.0.0.0}"
if [ -f cli.js ]; then
  node cli.js --no-browser --skip-update --port "$PORT" &
elif [ -f src/server.js ]; then
  node src/server.js &
else
  log "ERROR: cannot find 9router entrypoint in /app"
  exit 1
fi
ROUTER_PID=$!

wait "$ROUTER_PID"
on_shutdown
