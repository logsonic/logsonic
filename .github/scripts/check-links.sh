#!/usr/bin/env bash
# Verify that every relative Markdown link in the repo's docs resolves to a
# file, relative to the linking file's own directory. External links
# (http/https/mailto) are not checked here -- that's lychee, phase 2.
#
# Usage: .github/scripts/check-links.sh [file-or-dir ...]
# Default set: README.md ROADMAP.md CONTRIBUTING.md TBD.md ISSUES.md RELEASE.md
# docs/*.md specs/*.md mcp/*.md
set -uo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  files=()
  for f in README.md ROADMAP.md CONTRIBUTING.md TBD.md ISSUES.md RELEASE.md docs/*.md specs/*.md mcp/*.md; do
    [ -f "$f" ] && files+=("$f")
  done
fi

missing=0
checked=0
for f in "${files[@]}"; do
  dir="$(dirname "$f")"
  # Markdown links: ](target) where target is not a URL scheme and not a pure anchor.
  while IFS= read -r target; do
    [ -z "$target" ] && continue
    case "$target" in
      http://*|https://*|mailto:*|\#*) continue ;;
    esac
    path="${target%%#*}"     # strip an anchor
    path="${path%% *}"       # strip a trailing "title"
    [ -z "$path" ] && continue
    checked=$((checked + 1))
    if [ ! -e "$dir/$path" ]; then
      echo "MISSING: $f -> $target"
      missing=$((missing + 1))
    fi
  done < <(
    # Drop fenced code blocks and inline code spans first: they often quote
    # grep patterns or example links that are not real links.
    awk '/^```/ { fence = !fence; next } !fence { print }' "$f" \
      | sed -e 's/`[^`]*`//g' \
      | grep -o '\]([^)]*)' | sed -e 's/^](//' -e 's/)$//'
  )
done

echo "checked $checked relative links in ${#files[@]} files; $missing missing"
[ "$missing" -eq 0 ]
