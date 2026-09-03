#!/usr/bin/env bash
# Doc-command executor (spec: specs/now-11-ci-quality-gate.md, phase 2,
# "executes the code blocks tagged bash in docs/development.md that start
# with `go run .` / `npm` to prove the documented commands work").
#
# This is deliberately NOT a markdown-block parser: docs/development.md has
# many fenced bash blocks (test invocations, swagger regen, curl examples)
# that are already exercised elsewhere (ci.yml's go/web jobs) or aren't
# finite (they need another server already running). The class of bug this
# script exists to catch is narrower and more specific: a *dev bootstrap*
# command silently rotting out from under a new contributor -- this repo's
# own now-07 finding was docs/development.md instructing `go run main.go`,
# which fails outright (the main package has sibling files). So this script
# runs, literally, the four `go run .` / `npm` lines in docs/development.md
# that a first-time contributor would hit before ever touching a test
# runner: `npm ci`, `go run . -port 8080 -auto-port=false`,
# `PORT=8081 npm run dev`, `npm run test`. Each is grepped verbatim out of
# docs/development.md before it runs (see below), so if the doc's wording of
# any of these four changes, this script fails loudly on the mismatch rather
# than silently testing a command the doc no longer names -- but the mapping
# from "grep target" to "command to actually run" is still hand-maintained
# here, the same tradeoff check-links.sh and check-api-types.mjs both accept
# for the same "tiny script, not a framework" reason.
#
# Two of the four are one-shot and run to completion under a timeout; two
# start long-running dev servers and are polled for a real response, then
# killed by PORT (not by the launching shell's PID) -- `go run` and
# `npm run dev` each fork a child that does the actual listening (the
# compiled binary; the vite process), so killing the wrapper PID orphans a
# still-listening grandchild (observed by hand: the subshell died, `go run`
# and its compiled child both lived on in `ps`, still bound to :8080).
# `lsof -ti:<port>` finds the process that is actually bound to the port,
# which is the one that must die -- like WORKFLOW.md's own preflight
# (`lsof -ti:8080 -ti:8081 | xargs kill`), this kills whatever is on that
# port, not necessarily a process this script started.
#
# Prerequisite: `go run .` doesn't compile until backend/pkg/static/dist
# exists at least once (//go:embed all:dist; gitignored, doesn't exist on a
# fresh clone) -- see docs/development.md's own "First-time setup" section,
# added alongside this script after reproducing the compile failure by hand.
# This script performs that real build (npm run build && npm run
# build:copy), not a placeholder index.html the way ci.yml's other Go jobs
# do -- a placeholder here would mask exactly the bug this script exists to
# find.
#
# Usage: .github/scripts/check-dev-commands.sh
set -uo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
DEV_DOC="$root/docs/development.md"
BACKEND_PORT=8080
FRONTEND_PORT=8081
# A from-scratch `go build .` (empty GOMODCACHE/GOCACHE, downloading Bleve +
# the full dependency tree) measured 41s on an M-series laptop; doubled for
# runner variance (the first CI run has no restorable setup-go cache either,
# since nothing has ever been pushed) and rounded up.
POLL_TIMEOUT_BACKEND=180
POLL_TIMEOUT_FRONTEND=60
STORAGE="$(mktemp -d)"    # never point a dev-command check at the real index

failures=0

check_doc_says() {
  # check_doc_says <literal command text>: a pure predicate (no side
  # effects) -- true iff docs/development.md still contains this exact
  # line. Callers are responsible for reporting and counting the failure;
  # keeping this a predicate avoids double-counting a single doc-drift
  # failure as two.
  grep -qF "$1" "$DEV_DOC"
}

kill_port() {
  # kill_port <port>: SIGTERM the process bound to <port>, escalating to
  # SIGKILL after a few seconds if it hasn't let go.
  local port="$1"
  lsof -ti:"$port" 2>/dev/null | xargs -r kill 2>/dev/null
  for _ in 1 2 3 4 5; do
    lsof -ti:"$port" >/dev/null 2>&1 || return 0
    sleep 1
  done
  lsof -ti:"$port" 2>/dev/null | xargs -r kill -9 2>/dev/null
}

# shellcheck disable=SC2329  # invoked indirectly via `trap cleanup EXIT`
cleanup() {
  kill_port "$BACKEND_PORT"
  kill_port "$FRONTEND_PORT"
  rm -rf "$STORAGE"
}
trap cleanup EXIT

# A dev server left running from an earlier invocation on this machine (or a
# self-hosted runner reused across jobs) would answer the poll below in
# place of the command actually being tested, so a real bind failure in
# `go run .` could pass silently -- WORKFLOW.md's own preflight calls this
# out ("stale dev servers cause false failures"); this is that same class,
# just a false success instead of a false failure. Clear both ports before
# anything starts, not just on the way out.
kill_port "$BACKEND_PORT"
kill_port "$FRONTEND_PORT"

poll() {
  # poll <url> <timeout-seconds>
  local url="$1" timeout="$2" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if curl -sf -o /dev/null "$url"; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

echo "== First-time setup (prerequisite for go run .): npm ci && npm run build && npm run build:copy =="
if ! check_doc_says "npm ci"; then
  echo "  FAIL: docs/development.md no longer contains: npm ci"
  failures=$((failures + 1))
elif (cd "$root/frontend" && npm ci && npm run build && npm run build:copy); then
  echo "  ok: npm ci"
else
  echo "  FAIL: npm ci / npm run build / npm run build:copy"
  failures=$((failures + 1))
fi

echo "== docs/development.md: go run . -port 8080 -auto-port=false =="
if [ "$failures" -ne 0 ]; then
  echo "  skipped: prerequisite build failed"
elif ! check_doc_says "go run . -port 8080 -auto-port=false"; then
  echo "  FAIL: docs/development.md no longer contains: go run . -port 8080 -auto-port=false"
  failures=$((failures + 1))
else
  (cd "$root/backend" && STORAGE_PATH="$STORAGE/backend-store" go run . -port "$BACKEND_PORT" -auto-port=false) &
  if poll "http://localhost:$BACKEND_PORT/api/v1/ping" "$POLL_TIMEOUT_BACKEND"; then
    echo "  ok: server answered /api/v1/ping"
  else
    echo "  FAIL: no response on :$BACKEND_PORT within ${POLL_TIMEOUT_BACKEND}s"
    failures=$((failures + 1))
  fi
  kill_port "$BACKEND_PORT"
fi

echo "== docs/development.md: PORT=8081 npm run dev =="
if ! check_doc_says "PORT=8081 npm run dev"; then
  echo "  FAIL: docs/development.md no longer contains: PORT=8081 npm run dev"
  failures=$((failures + 1))
else
  (cd "$root/frontend" && PORT="$FRONTEND_PORT" npm run dev) &
  if poll "http://localhost:$FRONTEND_PORT/" "$POLL_TIMEOUT_FRONTEND"; then
    echo "  ok: dev server answered /"
  else
    echo "  FAIL: no response on :$FRONTEND_PORT within ${POLL_TIMEOUT_FRONTEND}s"
    failures=$((failures + 1))
  fi
  kill_port "$FRONTEND_PORT"
fi

echo "== docs/development.md: npm run test =="
if ! check_doc_says "npm run test"; then
  echo "  FAIL: docs/development.md no longer contains: npm run test"
  failures=$((failures + 1))
elif (cd "$root/frontend" && npm run test); then
  echo "  ok: npm run test"
else
  echo "  FAIL: npm run test"
  failures=$((failures + 1))
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "all documented dev commands ran successfully"
else
  echo "$failures documented dev command(s) failed"
fi
exit "$failures"
