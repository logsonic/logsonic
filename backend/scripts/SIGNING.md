# LogSonic — macOS signing + Homebrew tap setup

End-to-end setup for shipping signed macOS binaries via GoReleaser, plus the Homebrew tap. Do this once; then every release is `git tag … && backend/scripts/release.sh`.

**Values you will need:**

| Value | Setting |
|---|---|
| Apple Developer ID | `<your Apple ID email>` |
| Team ID | `<your 10-char Team ID>` |
| Signing identity | `Developer ID Application: <Your Name> (<Team ID>)` |

---

## 1. Developer ID Application certificate

Install and verify on your Mac (`security find-identity -v -p codesigning` should show 1 valid identity). Import the Apple intermediate CA (`Developer ID Certification Authority` G2) from <https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer>.

---

## 2. Local signing (Keychain)

Local releases sign directly from your Keychain using `codesign`. GoReleaser's `signs:` block calls `codesign` with the Developer ID identity, which accesses the private key in your login Keychain.

For **local releases** (your machine), this is it — no `.p12` needed.

For **CI/GitHub Actions**, you would export the cert + key as `.p12` and decode it at job start, but that's covered in a separate CI workflow (RELEASE.md §9).

---

## 3. Create a notarytool API key (App Store Connect)

Apple's `notarytool` validates binaries with Apple's servers. It requires an API key, not your Apple ID password.

1. Go to <https://appstoreconnect.apple.com/access/integrations/api>.
2. Click **+** under **Active**. Name it `logsonic-notarize`. Access: **Developer**.
3. Download the `AuthKey_XXXXXXXXXX.p8` — **you only get one chance**. Save to `~/.config/logsonic/notary.p8` and `chmod 600` it.
4. Note the **Key ID** (10 chars) and the **Issuer ID** (UUID at the top of the Keys page).

---

## 4. Create the Homebrew tap repo

GoReleaser pushes the formula to a repo named `homebrew-<tapname>` under your GitHub user/org.

1. Create an empty public repo: <https://github.com/new> → owner `logsonic`, name `homebrew-logsonic`, public, no README.
2. Create a **fine-grained Personal Access Token** with write access to that one repo: <https://github.com/settings/personal-access-tokens/new>.
   - Resource owner: `logsonic`
   - Repositories: only `homebrew-logsonic`
   - Permissions: **Contents: Read and write**, **Metadata: Read-only**
   - Copy the token — that's `HOMEBREW_TAP_TOKEN`.

---

## 5. GitHub token for the release itself

A standard `GITHUB_TOKEN` with `repo` scope: <https://github.com/settings/tokens>.

---

## 6. Wire env vars into `backend/.release.env`

Create `backend/.release.env` (gitignored):

```sh
# Apple notarization (optional for local releases, needed for full signed distribution)
export MACOS_NOTARY_ISSUER_ID="<UUID from App Store Connect>"
export MACOS_NOTARY_KEY_ID="<10-char Key ID>"
export MACOS_NOTARY_KEY="$HOME/.config/logsonic/notary.p8"

# GitHub
export GITHUB_TOKEN="<token from step 5>"
export HOMEBREW_TAP_TOKEN="<token from step 4>"
```

`chmod 600 backend/.release.env` once written.

---

## 7. Dry-run

Snapshot build (no signing, no publish):

```bash
backend/scripts/release.sh --snapshot
```

Then run a real signed build without uploading to GitHub:

```bash
backend/scripts/release.sh --skip-publish
```

Verify the macOS binary is signed:

```bash
tar -xzf backend/dist/logsonic_*_darwin_arm64.tar.gz -C /tmp logsonic
codesign -dvvv /tmp/logsonic
```

---

## 8. Cut a real release

```bash
git tag -a v1.0.3 -m "Release v1.0.3"
git push origin v1.0.3
backend/scripts/release.sh
```

GoReleaser will:
- Build all platforms
- Sign the darwin binaries locally via `codesign`
- Upload archives + checksums to <https://github.com/logsonic/logsonic/releases>
- Open a commit on `logsonic/homebrew-logsonic` updating `Formula/logsonic.rb`

Users install with:

```bash
brew install logsonic/logsonic/logsonic
```

---

## Troubleshooting

- **`codesign: The specified item could not be found in the keychain`** — the Developer ID cert or key is missing from login keychain. Reimport the `.cer` (double-click in Finder).
- **`find-identity` shows the cert but 0 valid identities** — missing Apple intermediate CA. Download and import `DeveloperIDG2CA.cer` from <https://www.apple.com/certificateauthority/>.
- **GoReleaser signs OK but notarization errors** — notarize is optional for `.tar.gz` distribution (Gatekeeper validates via online hash lookup). For now, Homebrew users get the signed but not-stapled binary, which is acceptable for CLI distribution.
