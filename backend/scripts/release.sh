#!/usr/bin/env bash
# Local release driver for LogSonic.
#
# Usage:
#   backend/scripts/release.sh                 # full signed release (requires tag + env)
#   backend/scripts/release.sh --snapshot      # dry-run, no signing, no publish
#   backend/scripts/release.sh --skip-publish  # signed build, no GitHub upload
#
# Env vars loaded from backend/.release.env (gitignored). See SIGNING.md.

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

  : "${MACOS_SIGN_P12:?MACOS_SIGN_P12 not set}"
  : "${MACOS_SIGN_PASSWORD:?MACOS_SIGN_PASSWORD not set}"
  : "${MACOS_NOTARY_ISSUER_ID:?MACOS_NOTARY_ISSUER_ID not set}"
  : "${MACOS_NOTARY_KEY_ID:?MACOS_NOTARY_KEY_ID not set}"
  : "${MACOS_NOTARY_KEY:?MACOS_NOTARY_KEY not set (path to AuthKey_*.p8)}"
  : "${GITHUB_TOKEN:?GITHUB_TOKEN not set}"
  : "${HOMEBREW_TAP_TOKEN:?HOMEBREW_TAP_TOKEN not set}"

  [ -f "$MACOS_SIGN_P12" ]   || err "MACOS_SIGN_P12 path does not exist: $MACOS_SIGN_P12"
  [ -f "$MACOS_NOTARY_KEY" ] || err "MACOS_NOTARY_KEY path does not exist: $MACOS_NOTARY_KEY"
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
