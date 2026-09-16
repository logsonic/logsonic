#!/usr/bin/env bash
# Build an ad-hoc-signed Logsonic.app for local WKWebView testing.
#
# Usage (from repo root or backend/):
#   scripts/dev-macos-app.sh [logsonic-binary]
#
# If no binary is given, builds ./logsonic in backend/ with the current Go.
# Frontend must already be copied into pkg/static/dist (npm run build:copy).
# Opens the app when done unless LOGSONIC_DEV_NO_OPEN=1. Not for release — it
# uses ad-hoc signing and intentionally skips notarization and Developer ID.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
backend_dir="$(cd "$script_dir/.." && pwd)"
swift_src="$backend_dir/macos/LogsonicApp.swift"
listening_src="$backend_dir/macos/ListeningURL.swift"
dragstrip_src="$backend_dir/macos/DragStrip.swift"
icon_png="$script_dir/app-icon.png"
outdir="$backend_dir/dist-dev"
app="$outdir/Logsonic.app"

if [ "${1:-}" != "" ]; then
  bin="$1"
else
  (cd "$backend_dir" && go build -o logsonic .)
  bin="$backend_dir/logsonic"
fi
[ -f "$bin" ] || { echo "dev-macos-app.sh: no binary at $bin" >&2; exit 1; }
[ -f "$swift_src" ] || { echo "dev-macos-app.sh: missing $swift_src" >&2; exit 1; }
[ -f "$listening_src" ] || { echo "dev-macos-app.sh: missing $listening_src" >&2; exit 1; }
[ -f "$dragstrip_src" ] || { echo "dev-macos-app.sh: missing $dragstrip_src" >&2; exit 1; }
[ -f "$icon_png" ] || { echo "dev-macos-app.sh: missing $icon_png" >&2; exit 1; }
command -v sips >/dev/null || { echo "dev-macos-app.sh: sips is required to build the app icon" >&2; exit 1; }
command -v iconutil >/dev/null || { echo "dev-macos-app.sh: iconutil is required to build the app icon" >&2; exit 1; }

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/logsonic"
chmod 755 "$app/Contents/MacOS/logsonic"

swiftc -O -D DEBUG -framework AppKit -framework WebKit \
  -target "$(uname -m)-apple-macos11" \
  "$listening_src" "$dragstrip_src" "$swift_src" -o "$app/Contents/MacOS/LogsonicApp"
chmod 755 "$app/Contents/MacOS/LogsonicApp"

iconset="$outdir/AppIcon.iconset"
rm -rf "$iconset"
mkdir -p "$iconset"
for sz in 16 32 128 256 512; do
  sips -z "$sz" "$sz" "$icon_png" --out "$iconset/icon_${sz}x${sz}.png" >/dev/null
  sips -z $((sz*2)) $((sz*2)) "$icon_png" --out "$iconset/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
rm -rf "$iconset"
[ -s "$app/Contents/Resources/AppIcon.icns" ] || { echo "dev-macos-app.sh: failed to create AppIcon.icns" >&2; exit 1; }

cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>Logsonic</string>
	<key>CFBundleDisplayName</key>
	<string>LogSonic</string>
	<key>CFBundleIdentifier</key>
	<string>com.logsonic.app.dev</string>
	<key>CFBundleExecutable</key>
	<string>LogsonicApp</string>
	<key>CFBundleVersion</key>
	<string>0.0.0</string>
	<key>CFBundleShortVersionString</key>
	<string>0.0.0</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>LSMinimumSystemVersion</key>
	<string>11.0</string>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.developer-tools</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key>
		<true/>
	</dict>
	<key>LSMultipleInstancesProhibited</key>
	<true/>
	<key>CFBundleDocumentTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeName</key>
			<string>Log file</string>
			<key>CFBundleTypeRole</key>
			<string>Viewer</string>
			<key>LSHandlerRank</key>
			<string>Alternate</string>
			<key>LSItemContentTypes</key>
			<array>
				<string>public.log</string>
				<string>public.plain-text</string>
				<string>public.json</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
PLIST
plutil -lint "$app/Contents/Info.plist" >/dev/null

codesign --force -s - "$app/Contents/MacOS/logsonic"
codesign --force -s - "$app/Contents/MacOS/LogsonicApp"
codesign --force -s - "$app"
echo "built (ad-hoc): $app"
if [ "${LOGSONIC_DEV_NO_OPEN:-0}" != "1" ]; then
  open "$app"
fi
