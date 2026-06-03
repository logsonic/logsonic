#!/usr/bin/env bash
# Build a signed + notarized + STAPLED macOS .app bundle for logsonic, and zip it
# for distribution.
#
# Why a .app (vs the old .pkg): a .app can carry a stapled notarization ticket
# (so it's trusted offline, no Gatekeeper dialog), it shows up in /Applications
# as users expect, and Homebrew installs it via a cask `app` stanza WITHOUT sudo
# (a .pkg always needs admin). The bundle's Info.plist sets LSEnvironment
# LOGSONIC_APP=1, which LaunchServices injects on double-click so the binary
# opens the browser and auto-selects a free port — but NOT when the same binary
# is run from a terminal (e.g. the Homebrew-symlinked `logsonic`).
#
# Usage: app-macos.sh <universal-binary> <version> <out-dir> [icon-png]
#
# Requires a "Developer ID Application" identity in the Keychain. Notarize+staple
# is skipped (leaving a signed-but-unstapled .app) when the MACOS_NOTARY_* env
# vars are absent, matching release.sh's optional-notarization behavior.
set -euo pipefail

bin="${1:?app-macos.sh: missing universal binary path}"
version="${2:?app-macos.sh: missing version}"
outdir="${3:?app-macos.sh: missing output dir}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
# App icon source: the square "blitz" mark only (no wordmark). Defaults to the
# committed SVG, with a pre-rendered PNG as the no-librsvg fallback. We do NOT
# use the wide logo.png — squished into a square icon it distorts badly.
icon_src="${4:-$script_dir/app-icon.svg}"
icon_png_fallback="$script_dir/app-icon.png"

sign_id="${MACOS_SIGN_IDENTITY:-Developer ID Application: Akash Goswami (CW36P52426)}"
identifier="com.logsonic.app"

[ -f "$bin" ] || { echo "app-macos.sh: no binary at $bin" >&2; exit 1; }

mkdir -p "$outdir"
app="$outdir/Logsonic.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

# Payload: the universal binary becomes the bundle executable.
cp "$bin" "$app/Contents/MacOS/logsonic"
chmod 755 "$app/Contents/MacOS/logsonic"

# Build AppIcon.icns. Prefer rendering each iconset size straight from the SVG
# (crisp at every resolution); fall back to downscaling the pre-rendered PNG when
# librsvg (rsvg-convert) isn't installed, so the build never hard-depends on it.
icon_plist_entry=""
if command -v sips >/dev/null && command -v iconutil >/dev/null; then
  iconset=$(mktemp -d)/AppIcon.iconset
  mkdir -p "$iconset"
  render_ok=1
  if [[ "$icon_src" == *.svg ]] && command -v rsvg-convert >/dev/null; then
    for sz in 16 32 64 128 256 512; do
      rsvg-convert -w "$sz"        -h "$sz"        "$icon_src" -o "$iconset/icon_${sz}x${sz}.png"     || render_ok=0
      rsvg-convert -w $((sz*2))    -h $((sz*2))    "$icon_src" -o "$iconset/icon_${sz}x${sz}@2x.png"  || render_ok=0
    done
  else
    # Raster fallback: use the supplied PNG, or the committed pre-rendered icon.
    src_png="$icon_src"; [[ "$src_png" == *.svg ]] && src_png="$icon_png_fallback"
    if [ -f "$src_png" ]; then
      for sz in 16 32 64 128 256 512; do
        sips -z "$sz" "$sz"         "$src_png" --out "$iconset/icon_${sz}x${sz}.png"     >/dev/null
        sips -z $((sz*2)) $((sz*2)) "$src_png" --out "$iconset/icon_${sz}x${sz}@2x.png" >/dev/null
      done
    else
      render_ok=0
    fi
  fi
  if [ "$render_ok" = 1 ]; then
    iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
    icon_plist_entry='
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>'
  fi
fi

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>Logsonic</string>
	<key>CFBundleDisplayName</key>
	<string>LogSonic</string>
	<key>CFBundleIdentifier</key>
	<string>${identifier}</string>
	<key>CFBundleExecutable</key>
	<string>logsonic</string>
	<key>CFBundleVersion</key>
	<string>${version}</string>
	<key>CFBundleShortVersionString</key>
	<string>${version}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>LSMinimumSystemVersion</key>
	<string>11.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>${icon_plist_entry}
	<key>LSEnvironment</key>
	<dict>
		<key>LOGSONIC_APP</key>
		<string>1</string>
	</dict>
</dict>
</plist>
PLIST

# Sign inner executable first, then the bundle (Apple discourages --deep).
codesign --force --options runtime --timestamp --sign "$sign_id" "$app/Contents/MacOS/logsonic"
codesign --force --options runtime --timestamp --sign "$sign_id" "$app"
codesign --verify --strict --verbose=2 "$app"
echo "built + signed: $app"

# Notarize the .app and staple the ticket so it validates OFFLINE.
if [ -n "${MACOS_NOTARY_ISSUER_ID:-}" ] && [ -n "${MACOS_NOTARY_KEY_ID:-}" ] && [ -n "${MACOS_NOTARY_KEY:-}" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  echo "notarizing $app"
  /usr/bin/ditto -c -k --keepParent "$app" "$tmp/notarize.zip"
  result=$(xcrun notarytool submit "$tmp/notarize.zip" \
    --key "$MACOS_NOTARY_KEY" \
    --key-id "$MACOS_NOTARY_KEY_ID" \
    --issuer "$MACOS_NOTARY_ISSUER_ID" \
    --wait 2>&1)
  if ! echo "$result" | grep -q "status: Accepted"; then
    echo "ERROR: .app notarization did not return Accepted" >&2
    echo "$result" >&2
    exit 1
  fi
  xcrun stapler staple "$app"
  echo "notarized + stapled: $app"
else
  echo "WARNING: MACOS_NOTARY_* not set — .app is signed but NOT notarized/stapled" >&2
fi

# Zip the (stapled) .app for distribution. ditto --keepParent preserves the
# Logsonic.app/ top level and the stapled ticket travels inside the bundle.
zip="$outdir/logsonic_${version}_macos.zip"
rm -f "$zip"
/usr/bin/ditto -c -k --keepParent "$app" "$zip"
echo "zipped: $zip"

echo "$zip"
