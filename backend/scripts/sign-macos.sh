#!/usr/bin/env bash
# Codesign wrapper for GoReleaser's binary_signs.
#
# GoReleaser runs its own $/${} variable expansion on every inline arg string
# before exec, which clobbers a literal $1 inside an inline `sh -c '...'` script
# to empty. So the Mach-O guard has to live in an external file like this one,
# where $1 is a genuine shell positional (GoReleaser passes ${artifact} as a
# normal arg and does not expand inside the file).
#
# binary_signs hands us every built binary (linux/windows/darwin). codesign only
# applies to Mach-O; running it on ELF/PE just attaches stray macOS xattrs, so we
# skip non-Mach-O artifacts.
set -euo pipefail

artifact="${1:?sign-macos.sh: missing artifact path}"
identity="${MACOS_SIGN_IDENTITY:-Developer ID Application: Akash Goswami (CW36P52426)}"

if file -b "$artifact" | grep -q "Mach-O"; then
  codesign --force --options=runtime --sign "$identity" --timestamp "$artifact"
fi
