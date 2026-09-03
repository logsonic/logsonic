#!/usr/bin/env bash
# Validate the native standalone app without release credentials.
#
# By default this type-checks both release architectures, builds an ad-hoc app,
# validates its bundle/signatures, and smoke-tests the bundled CLI. Set
# LOGSONIC_APP_UI_SMOKE=1 to also launch the real AppKit/WKWebView wrapper,
# exercise its API, and verify that quitting does not leave the child running.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "test-macos-app.sh: skipped (requires macOS)"
  exit 0
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
backend_dir="$(cd "$script_dir/.." && pwd)"
swift_src="$backend_dir/macos/LogsonicApp.swift"
listening_src="$backend_dir/macos/ListeningURL.swift"
url_tests="$backend_dir/macos/ListeningURLTests.swift"
dragstrip_src="$backend_dir/macos/DragStrip.swift"
dragstrip_tests="$backend_dir/macos/DragStripTests.swift"
tmp_dir="$(mktemp -d)"
wrapper_pid=""

cleanup() {
  if [ -n "$wrapper_pid" ] && kill -0 "$wrapper_pid" 2>/dev/null; then
    osascript -e 'tell application id "com.logsonic.app.dev" to quit' >/dev/null 2>&1 || \
      kill -TERM "$wrapper_pid" 2>/dev/null || true
    wait "$wrapper_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

command -v swiftc >/dev/null || { echo "test-macos-app.sh: swiftc not found" >&2; exit 1; }
command -v codesign >/dev/null || { echo "test-macos-app.sh: codesign not found" >&2; exit 1; }

echo "running ListeningURL unit + throughput tests"
swiftc -O "$listening_src" "$url_tests" -o "$tmp_dir/listening-url-tests"
"$tmp_dir/listening-url-tests"

echo "running DragStrip unit tests"
swiftc -O "$dragstrip_src" "$dragstrip_tests" -o "$tmp_dir/dragstrip-tests"
"$tmp_dir/dragstrip-tests"

echo "type-checking standalone launcher (arm64 + x86_64)"
for arch in arm64 x86_64; do
  swiftc -typecheck -O -framework AppKit -framework WebKit \
    -target "$arch-apple-macos11" "$listening_src" "$dragstrip_src" "$swift_src"
done

echo "building bundled backend"
(cd "$backend_dir" && go build -trimpath -o "$tmp_dir/logsonic" .)

echo "building ad-hoc standalone app"
LOGSONIC_DEV_NO_OPEN=1 "$script_dir/dev-macos-app.sh" "$tmp_dir/logsonic"
app="$backend_dir/dist-dev/Logsonic.app"
launcher="$app/Contents/MacOS/LogsonicApp"
server="$app/Contents/MacOS/logsonic"

plutil -lint "$app/Contents/Info.plist"
[ "$(plutil -extract CFBundleExecutable raw "$app/Contents/Info.plist")" = "LogsonicApp" ]
[ "$(plutil -extract LSMinimumSystemVersion raw "$app/Contents/Info.plist")" = "11.0" ]
[ "$(plutil -extract LSApplicationCategoryType raw "$app/Contents/Info.plist")" = "public.app-category.developer-tools" ]
[ "$(plutil -extract LSMultipleInstancesProhibited raw "$app/Contents/Info.plist")" = "true" ]
codesign --verify --strict --verbose=2 "$app"
codesign --verify --strict --verbose=2 "$launcher"
codesign --verify --strict --verbose=2 "$server"

"$launcher" --help >"$tmp_dir/launcher-help.txt" 2>&1
rg -q -- "--browser" "$tmp_dir/launcher-help.txt"
"$server" -help >"$tmp_dir/server-help.txt" 2>&1
rg -q -- "-browser" "$tmp_dir/server-help.txt"

# The production packager must fail closed when notarization is unavailable.
if env -u MACOS_NOTARY_ISSUER_ID -u MACOS_NOTARY_KEY_ID -u MACOS_NOTARY_KEY \
  "$script_dir/app-macos.sh" "$server" 1.2.3 "$tmp_dir/release" \
  >"$tmp_dir/release-guard.out" 2>"$tmp_dir/release-guard.err"; then
  echo "test-macos-app.sh: release packager accepted missing notarization credentials" >&2
  exit 1
fi
rg -q "refusing to create an unnotarized release app" "$tmp_dir/release-guard.err"

if [ "${LOGSONIC_APP_UI_SMOKE:-0}" = "1" ]; then
  command -v ruby >/dev/null || { echo "test-macos-app.sh: ruby is required for UI smoke port selection" >&2; exit 1; }
  command -v curl >/dev/null || { echo "test-macos-app.sh: curl is required for UI smoke" >&2; exit 1; }
  command -v osascript >/dev/null || { echo "test-macos-app.sh: osascript is required for UI smoke shutdown" >&2; exit 1; }
  command -v lsof >/dev/null || { echo "test-macos-app.sh: lsof is required for UI smoke listener checks" >&2; exit 1; }

  port="$(ruby -rsocket -e 's = TCPServer.new("127.0.0.1", 0); puts s.addr[1]; s.close')"
  storage="$tmp_dir/storage"
  mkdir -p "$storage"
  echo "launching standalone app UI on loopback port $port"
  HOST="0.0.0.0" PORT="$port" STORAGE_PATH="$storage" "$launcher" \
    >"$tmp_dir/launcher.out" 2>"$tmp_dir/launcher.err" &
  wrapper_pid=$!

  ready=0
  for _ in {1..200}; do
    if curl -fsS "http://127.0.0.1:$port/api/v1/info" >"$tmp_dir/info.json" 2>/dev/null; then
      ready=1
      break
    fi
    if ! kill -0 "$wrapper_pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  [ "$ready" = "1" ] || {
    echo "test-macos-app.sh: standalone API did not become ready" >&2
    sed -n '1,160p' "$tmp_dir/launcher.err" >&2
    exit 1
  }

  # HOST=0.0.0.0 above is intentional: the wrapper must override it and keep
  # the unauthenticated desktop API private to loopback.
  child_pid="$(pgrep -P "$wrapper_pid" -f '/Contents/MacOS/logsonic' | head -1)"
  [ -n "$child_pid" ] || { echo "test-macos-app.sh: backend child process not found" >&2; exit 1; }
  listener="$(lsof -Pan -p "$child_pid" -iTCP -sTCP:LISTEN 2>/dev/null || true)"
  printf '%s\n' "$listener" | rg -q "127\.0\.0\.1:$port \(LISTEN\)"
  if printf '%s\n' "$listener" | rg -q "(\*|0\.0\.0\.0):$port \(LISTEN\)"; then
    echo "test-macos-app.sh: standalone API is listening on all interfaces" >&2
    exit 1
  fi
  lan_ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  if [ -n "$lan_ip" ] && curl -fsS --connect-timeout 1 "http://$lan_ip:$port/api/v1/info" >/dev/null 2>&1; then
    echo "test-macos-app.sh: standalone API is reachable on the LAN interface" >&2
    exit 1
  fi

  # Use the same AppKit termination path as Cmd+Q. A Unix SIGTERM would bypass
  # applicationShouldTerminate and would not test the child-drain contract.
  osascript -e 'tell application id "com.logsonic.app.dev" to quit'
  wait "$wrapper_pid"
  wrapper_pid=""
  if curl -fsS --connect-timeout 1 "http://127.0.0.1:$port/api/v1/info" >/dev/null 2>&1; then
    echo "test-macos-app.sh: backend child survived app shutdown" >&2
    exit 1
  fi
fi

echo "standalone macOS app validation passed"
