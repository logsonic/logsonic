#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

HOST="${HOST:-localhost}"
PORT="${PORT:-8080}"
PORT="${PORT#:}"
AIR_BIN="${AIR_BIN:-$HOME/go/bin/air}"

if [[ ! "$PORT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: PORT must be numeric, got '$PORT'." >&2
  exit 1
fi

if [[ ! -x "$AIR_BIN" ]]; then
  if command -v air >/dev/null 2>&1; then
    AIR_BIN="$(command -v air)"
  else
    echo "ERROR: air is not installed. Run: go install github.com/air-verse/air@latest" >&2
    exit 1
  fi
fi

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi

  local probe_host="$HOST"
  if [[ "$probe_host" == "0.0.0.0" || "$probe_host" == "::" ]]; then
    probe_host="127.0.0.1"
  fi

  if command -v nc >/dev/null 2>&1; then
    nc -z "$probe_host" "$PORT" >/dev/null 2>&1
    return
  fi

  (echo >/dev/tcp/"$probe_host"/"$PORT") >/dev/null 2>&1
}

if port_in_use; then
  echo "ERROR: port $PORT is already in use." >&2
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
  fi
  echo "Stop the process using it or run with a different port, for example: PORT=8081 ./scripts/dev.sh" >&2
  exit 1
fi

mkdir -p tmp

PORT="$PORT" HOST="$HOST" LOGSONIC_AUTO_PORT=0 LOGSONIC_APP=0 "$AIR_BIN" -c .air.toml -build.args_bin "-auto-port=false"
