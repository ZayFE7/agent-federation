#!/bin/sh
# 9router container wrapper: pull state from R2 on boot, keep 9router running,
# push state back to R2 on an interval and on shutdown. Survives image updates
# because Northflank stores THIS command, not the image's original entrypoint.
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
DB_PATH="$DATA_DIR/db/data.sqlite"
R2_REMOTE="r2:9router-state"
R2_OBJECT="${R2_OBJECT:-data.sqlite}"
SYNC_INTERVAL="${SYNC_INTERVAL:-180}"
RCLONE_CONF="/tmp/rclone-r2.conf"

mkdir -p "$DATA_DIR/db"

log() { echo "[9router-sync] $*"; }

install_rclone() {
  if command -v rclone >/dev/null 2>&1; then
    return 0
  fi
  log "installing rclone..."
  curl -fsSL https://rclone.org/install.sh | bash >/dev/null 2>&1 || {
    log "rclone install failed; state sync disabled"
    return 1
  }
  return 0
}

write_rclone_conf() {
  if [ -z "$R2_ACCOUNT_ID" ] || [ -z "$R2_ACCESS_KEY_ID" ] || [ -z "$R2_SECRET_ACCESS_KEY" ]; then
    log "R2 env vars missing; skipping sync"
    return 1
  fi
  cat > "$RCLONE_CONF" <<EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = $R2_ACCESS_KEY_ID
secret_access_key = $R2_SECRET_ACCESS_KEY
endpoint = https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com
EOF
  return 0
}

pull_state() {
  log "pulling $R2_OBJECT from R2..."
  rclone --config "$RCLONE_CONF" copy "$R2_REMOTE/$R2_OBJECT" "$DB_PATH" && log "state restored" || log "no remote state yet (first deploy?)"
}

push_state() {
  if [ -f "$DB_PATH" ]; then
    rclone --config "$RCLONE_CONF" copyto "$DB_PATH" "$R2_REMOTE/$R2_OBJECT" >/dev/null 2>&1 && log "state pushed" || log "push failed (will retry)"
  fi
}

SYNC_OK=0
if install_rclone && write_rclone_conf; then
  SYNC_OK=1
  pull_state
  ( while true; do sleep "$SYNC_INTERVAL"; push_state; done ) &
  SYNC_PID=$!
fi

on_shutdown() {
  log "shutdown signal; final state push"
  [ "$SYNC_OK" = "1" ] && push_state
  [ -n "${SYNC_PID:-}" ] && kill "$SYNC_PID" 2>/dev/null || true
  exit 0
}
trap on_shutdown TERM INT

log "starting 9router..."
cd /app
if [ -f cli.js ]; then
  node cli.js --no-browser --skip-update &
elif [ -f src/server.js ]; then
  node src/server.js &
else
  log "ERROR: cannot find 9router entrypoint in /app"
  exit 1
fi
ROUTER_PID=$!

# Wait on 9router; forward signals for graceful final sync
wait "$ROUTER_PID"
on_shutdown
