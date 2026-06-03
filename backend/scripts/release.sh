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
EXTRA_ARGS=""
for arg in "$@"; do
  case "$arg" in
    --snapshot)     MODE="snapshot"; EXTRA_ARGS="$EXTRA_ARGS --snapshot" ;;
    --skip-publish) EXTRA_ARGS="$EXTRA_ARGS --skip=publish" ;;
    *)              EXTRA_ARGS="$EXTRA_ARGS $arg" ;;
  esac
done
EXTRA_ARGS="${EXTRA_ARGS# }"  # trim leading space

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
# shellcheck disable=SC2086
goreleaser release --clean $EXTRA_ARGS

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
  local failed=0

  # Use glob patterns to find darwin binaries (robust to GoReleaser path changes).
  for bin in dist/logsonic_darwin_*/logsonic dist/logsonic-universal_*/logsonic; do
    [ -f "$bin" ] || { info "notarize: missing $bin, skipping"; continue; }

    # Verify binary is signed before notarizing.
    if ! codesign -v "$bin" 2>/dev/null; then
      echo "ERROR: $bin is not signed (codesign validation failed)" >&2
      failed=1
      continue
    fi

    info "notarizing $bin"
    local zip="$tmp/$(basename "$(dirname "$bin")").zip"
    /usr/bin/ditto -c -k --keepParent "$bin" "$zip"

    # Submit and capture the result (status, not just success/failure).
    local result
    result=$(xcrun notarytool submit "$zip" \
      --key "$MACOS_NOTARY_KEY" \
      --key-id "$MACOS_NOTARY_KEY_ID" \
      --issuer "$MACOS_NOTARY_ISSUER_ID" \
      --wait 2>&1)

    # Check the status line in the output.
    if echo "$result" | grep -q "status: Accepted"; then
      info "notarization accepted: $bin"
    elif echo "$result" | grep -q "status: Invalid"; then
      echo "WARNING: notarization returned 'Invalid' for $bin (may be duplicate submission or other issue)" >&2
      echo "Full result: $result" >&2
      # Don't fail the release, but warn — Invalid often means already notarized or caching issue.
    else
      echo "ERROR: notarization failed for $bin" >&2
      echo "Result: $result" >&2
      failed=1
    fi
  done

  [ $failed -eq 0 ] || err "notarization failed for one or more binaries"
}

notarize_darwin

# Wrap the universal darwin binary in a signed + notarized + STAPLED installer
# .pkg, attach it to the GitHub release, and publish a Homebrew cask pointing at
# it. macOS ships ONLY this way — there is no darwin .tar.gz (a bare binary can't
# be stapled, so it forces an online Gatekeeper check and trips a dialog on
# Finder-extracted downloads). The stapled .pkg carries its notarization ticket,
# so install works offline with no dialog. See scripts/pkg-macos.sh and
# scripts/publish-cask.sh. Skipped on snapshot and when tooling/creds are absent.
build_macos_pkg() {
  if [ "$MODE" = "snapshot" ]; then
    info "skipping .pkg build (snapshot mode)"
    return
  fi
  command -v pkgbuild >/dev/null || { info "skipping .pkg (pkgbuild not available — not macOS?)"; return; }

  local ubin="dist/logsonic-universal_darwin_all/logsonic"
  [ -f "$ubin" ] || { info "skipping .pkg (universal binary not found at $ubin)"; return; }

  local version; version="$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//')"
  [ -n "$version" ] || err "build_macos_pkg: cannot determine version from git tags"

  info "building macOS installer .pkg"
  scripts/pkg-macos.sh "$ubin" "$version" dist
  local pkg="dist/logsonic_${version}_macos.pkg"

  # Attach to the GitHub release + publish the Homebrew cask, unless publishing
  # was skipped.
  if [[ "$EXTRA_ARGS" == *"--skip=publish"* ]]; then
    info "publish skipped — .pkg left at $BACKEND/$pkg (not uploaded, cask not published)"
  elif command -v gh >/dev/null; then
    local tag; tag="$(git describe --tags --abbrev=0)"
    info "uploading $pkg to release $tag"
    gh release upload "$tag" "$pkg" --clobber

    # Publish the cask AFTER the .pkg is live, so its download URL resolves.
    if [ -n "${HOMEBREW_TAP_TOKEN:-}" ]; then
      info "publishing Homebrew cask for $version"
      scripts/publish-cask.sh "$pkg" "$version"
    else
      info "HOMEBREW_TAP_TOKEN not set — cask NOT published; macOS brew install --cask will be stale" >&2
    fi
  else
    info "gh not installed — .pkg built at $BACKEND/$pkg but NOT uploaded; cask not published" >&2
  fi
}
build_macos_pkg

info "done. Artifacts in $BACKEND/dist/"
