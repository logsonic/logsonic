#!/usr/bin/env bash
# Start an embedded LogSonic binary on scratch storage, run the network-audit
# and smoke E2E scripts against it, stop it. Exit non-zero if either fails.
#
# Usage: .github/scripts/run-e2e.sh <path-to-embedded-binary> [port]
# The binary must have been built after `npm run build:copy` so it serves the
# real SPA (the network audit is meaningless against the CI placeholder).
set -uo pipefail

bin="${1:?run-e2e.sh: missing path to embedded binary}"
port="${2:-8080}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
storage="$(mktemp -d)"
log="$storage/server.log"

"$bin" -host 127.0.0.1 -port "$port" -auto-port=false -storage "$storage/store" >"$log" 2>&1 &
pid=$!
cleanup() {
  kill -INT "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -rf "$storage"
}
trap cleanup EXIT

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$port/api/v1/ping" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
if ! curl -fsS "http://127.0.0.1:$port/api/v1/ping" >/dev/null 2>&1; then
  echo "run-e2e.sh: server did not come up on :$port"; cat "$log"; exit 1
fi

status=0
export E2E_BASE_URL="http://127.0.0.1:$port"
export E2E_API_URL="http://127.0.0.1:$port/api/v1"

echo "== network audit =="
node "$root/frontend/e2e-network-audit.mjs" || status=1

echo "== smoke =="
node "$root/frontend/e2e-test.mjs" || status=1

if [ "$status" -ne 0 ]; then
  echo "== server log =="; tail -50 "$log"
fi
exit "$status"
