#!/usr/bin/env bash
# Build a signed + notarized + STAPLED macOS installer .pkg for the logsonic CLI.
#
# Why a .pkg at all: logsonic ships as a bare Mach-O. You cannot staple a
# notarization ticket to a lone binary — stapling only works on .app/.dmg/.pkg —
# so a freshly downloaded binary forces every Mac to do an ONLINE Gatekeeper
# check on first launch. That check fails offline and trips a scary "cannot be
# opened" dialog when the .tar.gz is extracted via Finder/Archive Utility (which
# propagates the com.apple.quarantine xattr). Wrapping the universal binary in a
# stapled .pkg makes the notarization ticket travel WITH the download: the
# installer validates offline, shows no dialog, and the file it drops at
# /usr/local/bin/logsonic is itself already Developer ID-signed + notarized.
#
# Usage: pkg-macos.sh <universal-binary> <version> <out-dir>
#
# Requires a "Developer ID Installer" identity in the Keychain (distinct from the
# "Developer ID Application" identity used to sign the binary). Notarize+staple is
# skipped — leaving a signed-but-unstapled pkg — when the MACOS_NOTARY_* env vars
# are absent, matching the optional-notarization behavior in release.sh.
set -euo pipefail

bin="${1:?pkg-macos.sh: missing universal binary path}"
version="${2:?pkg-macos.sh: missing version}"
outdir="${3:?pkg-macos.sh: missing output dir}"

installer_id="${MACOS_INSTALLER_IDENTITY:-Developer ID Installer: Akash Goswami (CW36P52426)}"
identifier="com.logsonic.cli"

[ -f "$bin" ] || { echo "pkg-macos.sh: no binary at $bin" >&2; exit 1; }

# Stage the payload. The staging root maps onto --install-location, so a single
# 'logsonic' at the root of $stage lands at /usr/local/bin/logsonic.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp "$bin" "$stage/logsonic"
chmod 755 "$stage/logsonic"

mkdir -p "$outdir"
pkg="$outdir/logsonic_${version}_macos.pkg"

# Build and sign the component package in one step.
pkgbuild \
  --root "$stage" \
  --identifier "$identifier" \
  --version "$version" \
  --install-location /usr/local/bin \
  --sign "$installer_id" \
  "$pkg"
echo "built + signed: $pkg"

# Notarize the pkg and staple the ticket so it is valid OFFLINE.
if [ -n "${MACOS_NOTARY_ISSUER_ID:-}" ] && [ -n "${MACOS_NOTARY_KEY_ID:-}" ] && [ -n "${MACOS_NOTARY_KEY:-}" ]; then
  echo "notarizing $pkg"
  result=$(xcrun notarytool submit "$pkg" \
    --key "$MACOS_NOTARY_KEY" \
    --key-id "$MACOS_NOTARY_KEY_ID" \
    --issuer "$MACOS_NOTARY_ISSUER_ID" \
    --wait 2>&1)
  if ! echo "$result" | grep -q "status: Accepted"; then
    echo "ERROR: pkg notarization did not return Accepted" >&2
    echo "$result" >&2
    exit 1
  fi
  xcrun stapler staple "$pkg"
  echo "notarized + stapled: $pkg"
else
  echo "WARNING: MACOS_NOTARY_* not set — pkg is signed but NOT notarized/stapled" >&2
fi

echo "$pkg"
