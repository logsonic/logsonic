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

# Validate secrets file permissions before sourcing (applies to all modes).
if [ -f "$ENV_FILE" ]; then
  uid=$(id -u)
  file_uid=$(stat -f%Uu "$ENV_FILE")
  [ "$file_uid" = "$uid" ] || err ".release.env is owned by another user (UID $file_uid, you are $uid)"

  perms=$(stat -f%Lp "$ENV_FILE")
  [ "${perms: -2}" = "00" ] || err ".release.env is world/group-readable ($perms, should be 600)"

  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

if [ "$MODE" = "release" ]; then
  [ -f "$ENV_FILE" ] || err ".release.env not found at $ENV_FILE — see backend/scripts/SIGNING.md"
  : "${GITHUB_TOKEN:?GITHUB_TOKEN not set}"
  : "${HOMEBREW_TAP_TOKEN:?HOMEBREW_TAP_TOKEN not set}"
fi

# Validate notary key file if present.
if [ -n "${MACOS_NOTARY_KEY:-}" ] && [ -f "$MACOS_NOTARY_KEY" ]; then
  uid=$(id -u)
  file_uid=$(stat -f%Uu "$MACOS_NOTARY_KEY")
  [ "$file_uid" = "$uid" ] || err "MACOS_NOTARY_KEY is owned by another user (UID $file_uid, you are $uid)"

  perms=$(stat -f%Lp "$MACOS_NOTARY_KEY")
  [ "$perms" = "600" ] || err "MACOS_NOTARY_KEY has insecure permissions ($perms, should be 600)"
fi

info "building frontend"
cd "$FRONTEND"
# --ignore-scripts blocks lifecycle scripts in every transitive package
# during install. Verified the lockfile has zero install/postinstall scripts
# today; if a dep adds one later, this opts us out by default. Native deps
# that genuinely need scripts can be re-enabled per-package with `npm rebuild`.
npm ci --ignore-scripts
npm run build
npm run build:copy

info "running goreleaser ($MODE)"
cd "$BACKEND"
goreleaser release --clean "${EXTRA_ARGS[@]}"

# Notarize the signed darwin binaries with Apple. notarytool accepts .zip/.pkg/.dmg,
# so we zip each signed binary, submit, and let Apple register the binary's CD hash
# with its online ticket service — the existing .tar.gz archives become Gatekeeper-valid
# without re-archiving or stapling (stapling only works on .pkg/.dmg/.app bundles).
# Skipped on snapshot and when notary creds aren't present.
notarize_darwin() {
  if [ "$MODE" = "snapshot" ]; then
    info "skipping notarization (snapshot mode)"
    return
  fi
  if [ -z "${MACOS_NOTARY_ISSUER_ID:-}" ] || [ -z "${MACOS_NOTARY_KEY_ID:-}" ] || [ -z "${MACOS_NOTARY_KEY:-}" ]; then
    info "skipping notarization (MACOS_NOTARY_* env vars not set)"
    return
  fi
  command -v xcrun >/dev/null || { info "skipping notarization (xcrun not available)"; return; }

  local tmp; tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN

  # Use glob patterns to find darwin binaries (robust to GoReleaser path changes).
  for bin in dist/logsonic_darwin_*/logsonic dist/logsonic-universal_*/logsonic; do
    [ -f "$bin" ] || { info "notarize: missing $bin, skipping"; continue; }
    info "notarizing $bin"
    local zip="$tmp/$(basename "$(dirname "$bin")").zip"
    /usr/bin/ditto -c -k --keepParent "$bin" "$zip"
    xcrun notarytool submit "$zip" \
      --key "$MACOS_NOTARY_KEY" \
      --key-id "$MACOS_NOTARY_KEY_ID" \
      --issuer "$MACOS_NOTARY_ISSUER_ID" \
      --wait
  done
}

notarize_darwin

info "done. Artifacts in $BACKEND/dist/"
