#!/usr/bin/env bash
# prod-watch.sh — hot-reload wrapper for Paperclip
#
# Runs a build, starts the production server + sidecars, and watches for
# source changes. On change it notifies the running server via the
# /api/system/hot-restart endpoint, waits for the server process to exit,
# rebuilds, and restarts.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

SERVER_PORT="${PAPERCLIP_PORT:-3100}"
HOT_RESTART_URL="http://127.0.0.1:${SERVER_PORT}/api/system/hot-restart"

WATCH_DIRS=(
  "$ROOT_DIR/server/src"
  "$ROOT_DIR/ui/src"
  "$ROOT_DIR/packages"
)

IGNORE_PATTERNS=(
  "node_modules"
  "dist"
  ".git"
  "*.map"
)

SERVER_PID=""
SIDECAR_PIDS=()

cleanup() {
  echo "[prod-watch] Shutting down..."
  for pid in "${SIDECAR_PIDS[@]+"${SIDECAR_PIDS[@]}"}"; do
    kill "$pid" 2>/dev/null || true
  done
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

build() {
  echo "[prod-watch] Building..."
  if pnpm build; then
    echo "[prod-watch] Build complete."
    return 0
  else
    echo "[prod-watch] Build FAILED — waiting for next change to retry."
    return 1
  fi
}

start_server() {
  echo "[prod-watch] Starting server..."
  node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js &
  SERVER_PID=$!
  echo "[prod-watch] Server started (pid=$SERVER_PID)"
}

start_sidecars() {
  SIDECAR_PIDS=()

  if [[ -f "$HOME/asmar-inc/scripts/loop-locks.sh" ]]; then
    bash "$HOME/asmar-inc/scripts/loop-locks.sh" &
    SIDECAR_PIDS+=($!)
  fi

  if [[ -f "$HOME/asmar-inc/scripts/loop-ci.sh" ]]; then
    bash "$HOME/asmar-inc/scripts/loop-ci.sh" &
    SIDECAR_PIDS+=($!)
  fi

  if [[ -f "$HOME/asmar-inc/scripts/loop-worktrees.sh" ]]; then
    bash "$HOME/asmar-inc/scripts/loop-worktrees.sh" &
    SIDECAR_PIDS+=($!)
  fi
}

stop_sidecars() {
  for pid in "${SIDECAR_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  SIDECAR_PIDS=()
}

wait_for_server_exit() {
  if [[ -n "$SERVER_PID" ]]; then
    echo "[prod-watch] Waiting for server (pid=$SERVER_PID) to exit..."
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
    echo "[prod-watch] Server exited."
  fi
}

notify_restart() {
  echo "[prod-watch] Notifying server of pending restart..."
  curl -s -X POST "$HOT_RESTART_URL" >/dev/null 2>&1 || true
}

# Build fswatch exclusion args
build_fswatch_args() {
  local args=()
  for pattern in "${IGNORE_PATTERNS[@]}"; do
    args+=(-e "$pattern")
  done
  printf '%s\n' "${args[@]}"
}

# Polling fallback when fswatch is not available
poll_for_changes() {
  local last_hash=""
  while true; do
    local current_hash
    current_hash=$(find "${WATCH_DIRS[@]}" \
      -not -path "*/node_modules/*" \
      -not -path "*/dist/*" \
      -not -path "*/.git/*" \
      -not -name "*.map" \
      -type f \
      -newer "$ROOT_DIR/server/dist/index.js" \
      2>/dev/null | sort | head -20 | md5 2>/dev/null || md5sum 2>/dev/null || echo "")

    if [[ -n "$current_hash" && "$current_hash" != "$last_hash" && -n "$last_hash" ]]; then
      echo "CHANGE_DETECTED"
      return
    fi
    last_hash="$current_hash"
    sleep 2
  done
}

watch_for_changes() {
  if command -v fswatch &>/dev/null; then
    local fswatch_args
    fswatch_args=($(build_fswatch_args))
    fswatch -1 -r "${fswatch_args[@]}" "${WATCH_DIRS[@]}" 2>/dev/null
  else
    echo "[prod-watch] fswatch not found; falling back to polling"
    poll_for_changes
  fi
}

# Check if source files are newer than the build output
sources_changed_since_build() {
  local build_marker="$ROOT_DIR/server/dist/index.js"
  [[ ! -f "$build_marker" ]] && return 0
  local newer
  newer=$(find "${WATCH_DIRS[@]}" \
    -not -path "*/node_modules/*" \
    -not -path "*/dist/*" \
    -not -path "*/.git/*" \
    -not -name "*.map" \
    -type f \
    -newer "$build_marker" \
    2>/dev/null | head -1)
  [[ -n "$newer" ]]
}

# --- Main loop ---

if ! build; then
  echo "[prod-watch] Initial build failed. Watching for changes to retry..."
else
  start_server
  start_sidecars
fi

echo "[prod-watch] Watching for changes..."

while true; do
  watch_for_changes

  echo ""
  echo "[prod-watch] Change detected."

  # Only notify/stop if server is running
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    notify_restart
    wait_for_server_exit
    stop_sidecars
  fi

  if ! build; then
    echo "[prod-watch] Watching for changes to retry..."
    continue
  fi

  # Rebuild if more changes arrived during the build
  while sources_changed_since_build; do
    echo "[prod-watch] Additional changes detected during build, rebuilding..."
    if ! build; then
      break
    fi
  done

  # Only start if build succeeded
  if [[ -f "$ROOT_DIR/server/dist/index.js" ]]; then
    start_server
    start_sidecars
  fi

  echo "[prod-watch] Watching for changes..."
done
