#!/usr/bin/env bash
# Codesign wrapper invoked from GoReleaser build/universal_binaries post-hooks
# (see .goreleaser.yaml). NOT used with a binary_signs/signs block — that path
# was dropped (commit a36ebe7) because it registers detached Signature artifacts
# that goreleaser then fails to upload, since codesign embeds the signature in
# the binary rather than writing a separate file.
#
# GoReleaser runs its own $/${} variable expansion on every inline arg string
# before exec, which clobbers a literal $1 inside an inline `sh -c '...'` script
# to empty. So the Mach-O guard has to live in an external file like this one,
# where $1 is a genuine shell positional (GoReleaser passes {{ .Path }} as a
# normal arg and does not expand inside the file).
#
# The post-hook fires for every built binary (linux/windows/darwin). codesign
# only applies to Mach-O; running it on ELF/PE just attaches stray macOS xattrs,
# so we skip non-Mach-O artifacts.
set -euo pipefail

artifact="${1:?sign-macos.sh: missing artifact path}"
identity="${MACOS_SIGN_IDENTITY:-Developer ID Application: Akash Goswami (CW36P52426)}"

if file -b "$artifact" | grep -q "Mach-O"; then
  codesign --force --options=runtime --sign "$identity" --timestamp "$artifact"
fi
