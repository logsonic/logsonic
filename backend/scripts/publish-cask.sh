#!/usr/bin/env bash
# Publish/update the Homebrew CASK for the signed + notarized + stapled macOS .app.
#
# Why this exists outside GoReleaser: GoReleaser builds the Linux/Windows archives,
# but the macOS .app zip is an out-of-band artifact produced by scripts/app-macos.sh
# *after* notarization — GoReleaser never sees it, so it can't generate the cask.
# This renders Casks/logsonic.rb and pushes it to the tap so a plain
# `brew install logsonic` (no --cask, no sudo) drops Logsonic.app into /Applications
# and symlinks the `logsonic` CLI into the Homebrew prefix.
#
# The tap must contain ONLY this cask named `logsonic` and NO same-named formula:
# a formula would shadow the cask and make `brew install logsonic` resolve to it
# (breaking macOS). We stopped generating the formula (see .goreleaser.yaml), and
# this script deletes any stale Formula/logsonic.rb left by earlier releases.
#
# Usage: publish-cask.sh <zip> <version>
#   <version> is the bare version WITHOUT a leading 'v' (e.g. 1.2.3). The release
#   tag is assumed to be v<version>, matching release.sh's artifact naming.
#
# Env: HOMEBREW_TAP_TOKEN — write access to logsonic/homebrew-logsonic.
set -euo pipefail

zip="${1:?publish-cask.sh: missing zip path}"
version="${2:?publish-cask.sh: missing version}"
: "${HOMEBREW_TAP_TOKEN:?HOMEBREW_TAP_TOKEN not set}"

[ -f "$zip" ] || { echo "publish-cask.sh: no zip at $zip" >&2; exit 1; }

tap_owner="logsonic"
tap_repo="homebrew-logsonic"
# Storage dir to clean up on `brew uninstall --zap` — must match
# defaultStoragePath() in main.go (macOS branch).
data_dir="~/Library/Application Support/Logsonic"

sha=$(shasum -a 256 "$zip" | awk '{print $1}')

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git clone --depth 1 \
  "https://x-access-token:${HOMEBREW_TAP_TOKEN}@github.com/${tap_owner}/${tap_repo}.git" \
  "$work/tap"

# Drop any stale formula — it would shadow the cask and break `brew install logsonic`.
git -C "$work/tap" rm -q --ignore-unmatch Formula/logsonic.rb

mkdir -p "$work/tap/Casks"
cat > "$work/tap/Casks/logsonic.rb" <<RUBY
cask "logsonic" do
  version "${version}"
  sha256 "${sha}"

  url "https://github.com/logsonic/logsonic/releases/download/v#{version}/logsonic_#{version}_macos.zip"
  name "LogSonic"
  desc "Desktop-first log analytics with full-text search and Grok parsing"
  homepage "https://github.com/logsonic/logsonic"

  depends_on macos: :big_sur

  app "Logsonic.app"
  binary "#{appdir}/Logsonic.app/Contents/MacOS/logsonic", target: "logsonic"

  zap trash: "${data_dir}"

  caveats <<~EOS
    LogSonic stores its search index under:
      ${data_dir}
    This directory grows with the logs you ingest. To cap it, run logsonic with
    --retention-days N (or set RETENTION_DAYS). To delete all indexed data when
    uninstalling, run:
      brew uninstall --zap logsonic
  EOS
end
RUBY

cd "$work/tap"
git -c user.name=goreleaserbot -c user.email=bot@goreleaser.com add Casks/logsonic.rb
# Nothing to commit if the cask is byte-identical (e.g. a re-run) — don't fail.
if git -c user.name=goreleaserbot -c user.email=bot@goreleaser.com diff --cached --quiet; then
  echo "cask already up to date for v${version}"
  exit 0
fi
git -c user.name=goreleaserbot -c user.email=bot@goreleaser.com \
  commit -m "cask update for logsonic version v${version}"
git push origin HEAD:main
echo "published cask for v${version}"
