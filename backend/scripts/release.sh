#!/usr/bin/env bash
# Local release driver for LogSonic.
#
# Usage:
#   backend/scripts/release.sh                 # full release (requires tag + env)
#   backend/scripts/release.sh --snapshot      # dry-run, no publish
#   backend/scripts/release.sh --skip-publish  # signed build, no GitHub upload
#
# Env vars loaded from backend/.release.env (gitignored). See backend/scripts/SIGNING.md.
# Note: Local signing uses Keychain identity (no P12 needed). Notarization is optional.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND="$REPO_ROOT/backend"
FRONTEND="$REPO_ROOT/frontend"
ENV_FILE="$BACKEND/.release.env"

err() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
info() { printf '\033[32m==>\033[0m %s\n' "$1"; }

MODE="release"
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --snapshot)     MODE="snapshot"; EXTRA_ARGS+=("--snapshot") ;;
    --skip-publish) EXTRA_ARGS+=("--skip=publish") ;;
    *)              EXTRA_ARGS+=("$arg") ;;
  esac
done

command -v goreleaser >/dev/null || err "goreleaser not installed (brew install goreleaser)"
command -v npm        >/dev/null || err "npm not installed"

if [ "$MODE" = "release" ]; then
  if [ ! -f "$ENV_FILE" ]; then
    err ".release.env not found at $ENV_FILE — see backend/scripts/SIGNING.md"
  fi
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a

  : "${GITHUB_TOKEN:?GITHUB_TOKEN not set}"
  : "${HOMEBREW_TAP_TOKEN:?HOMEBREW_TAP_TOKEN not set}"
fi

info "building frontend"
cd "$FRONTEND"
npm ci
npm run build
npm run build:copy

info "running goreleaser ($MODE)"
cd "$BACKEND"
goreleaser release --clean "${EXTRA_ARGS[@]}"

info "done. Artifacts in $BACKEND/dist/"
