#!/usr/bin/env bash
# Print the Developer ID Application identity used for release signing.
set -euo pipefail

if [ -n "${MACOS_SIGN_IDENTITY:-}" ]; then
  printf '%s\n' "$MACOS_SIGN_IDENTITY"
  exit 0
fi

command -v security >/dev/null || {
  echo "signing-identity.sh: security tool not found" >&2
  exit 1
}

identities="$(security find-identity -v -p codesigning 2>/dev/null \
  | awk -F '"' '/Developer ID Application:/ { print $2 }')"
count="$(printf '%s\n' "$identities" | sed '/^$/d' | wc -l | tr -d ' ')"
if [ "$count" != "1" ]; then
  echo "signing-identity.sh: expected exactly one Developer ID Application identity, found $count; set MACOS_SIGN_IDENTITY explicitly" >&2
  exit 1
fi

printf '%s\n' "$identities"
