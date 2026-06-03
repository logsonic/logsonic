# LogSonic — macOS signing + Homebrew tap setup

End-to-end setup for shipping signed macOS binaries via GoReleaser, plus the Homebrew tap. Do this once; then every release is `git tag … && backend/scripts/release.sh`.

**Values you will need:**

| Value | Setting |
|---|---|
| Apple Developer ID | `<your Apple ID email>` |
| Team ID | `<your 10-char Team ID>` |
| Signing identity | `Developer ID Application: <Your Name> (<Team ID>)` |

---

## 1. Developer ID certificate (one)

Only **one** Developer ID cert is needed, issued from the Apple Developer portal:

- **Developer ID Application** — signs both the Mach-O binary (`scripts/sign-macos.sh`) and the `.app` bundle (`scripts/app-macos.sh`). `security find-identity -v -p codesigning` should show it.

(No "Developer ID Installer" cert is required anymore — that was for the old `.pkg` path, which has been replaced by a `.app` + Homebrew cask.)

macOS ships as a signed + notarized + **stapled** `Logsonic.app`, zipped as `logsonic_<version>_macos.zip`. A `.app` can carry a stapled notarization ticket (a bare Mach-O cannot), so it's trusted offline — no Gatekeeper dialog on a Finder-extracted or offline download. `scripts/publish-cask.sh` renders `Casks/logsonic.rb` in the tap (and deletes any stale `Formula/logsonic.rb`) so a plain `brew install logsonic` (no `--cask`, no sudo) drops the app into `/Applications` and symlinks the `logsonic` CLI into the Homebrew prefix. There is no Homebrew formula and no darwin `.tar.gz` — Linux/Windows install via the `.tar.gz`/`.zip`, Docker, or source.

Import the Apple intermediate CA (`Developer ID Certification Authority` G2) from <https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer>.

---

## 2. Local signing (Keychain)

Local releases sign directly from your Keychain using `codesign`. GoReleaser's build and `universal_binaries` **post-hooks** invoke [`scripts/sign-macos.sh`](sign-macos.sh), which calls `codesign` with the Developer ID identity (accessing the private key in your login Keychain) on the Mach-O binaries only. (We deliberately avoid a `binary_signs`/`signs` block — it registers detached signature artifacts that fail to upload, since `codesign` embeds the signature in the binary.)

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

Create a **fine-grained Personal Access Token** scoped to only the `logsonic/logsonic` repo: <https://github.com/settings/personal-access-tokens/new>.

- Resource owner: `logsonic`
- Repositories: only `logsonic`
- Permissions: **Contents: Read and write** (uploads release assets), **Metadata: Read-only**
- Expiration: 90 days (rotate; set a calendar reminder)

Avoid classic PATs with `repo` scope — they grant write to every repo you own, so a leak from a release laptop is catastrophic. The fine-grained token here can only touch the one repo it publishes releases to.

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

Verify the macOS binary is signed (there is no darwin `.tar.gz` — check the universal binary GoReleaser produced):

```bash
codesign -dvvv backend/dist/logsonic-universal_darwin_all/logsonic
```

After a non-snapshot `--skip-publish` run, also sanity-check the `.app` (built but not uploaded):

```bash
codesign --verify --strict --verbose=2 backend/dist/Logsonic.app   # → "valid on disk"
spctl -a -t exec -vvv backend/dist/Logsonic.app                    # → "accepted ... Notarized Developer ID"
xcrun stapler validate backend/dist/Logsonic.app                   # → "The validate action worked!"
```

---

## 8. Cut a real release

```bash
git tag -a v1.0.3 -m "Release v1.0.3"
git push origin v1.0.3
backend/scripts/release.sh
```

`release.sh` will:
- Build all platforms (GoReleaser); sign the darwin binaries locally via `codesign`
- Upload the Linux `.tar.gz` + Windows `.zip` + checksums to <https://github.com/logsonic/logsonic/releases>
- Notarize the darwin binaries, then build + notarize + staple `Logsonic.app`, zip it to `logsonic_<version>_macos.zip`, upload it, and publish `Casks/logsonic.rb` to the tap (`scripts/publish-cask.sh`, which also removes any stale `Formula/logsonic.rb`)

macOS users install with (the cask resolves automatically — no `--cask` needed):

```bash
brew tap logsonic/logsonic
brew install logsonic
```

Linux/Windows: download the `.tar.gz`/`.zip` from the release, use Docker, or build from source.

---

## Troubleshooting

- **`codesign: The specified item could not be found in the keychain`** — the Developer ID cert or key is missing from login keychain. Reimport the `.cer` (double-click in Finder).
- **`find-identity` shows the cert but 0 valid identities** — missing Apple intermediate CA. Download and import `DeveloperIDG2CA.cer` from <https://www.apple.com/certificateauthority/>.
- **Notarization returns "Invalid" status** — two common causes: (1) the binary is **not properly Developer ID-signed** (e.g. it's adhoc/linker-signed) — Apple rejects anything not signed with hardened runtime + a Developer ID cert; verify with `codesign -dvv <binary>` that the Authority is `Developer ID Application`, not `adhoc`; or (2) the binary hash was already submitted from a prior run (Apple caches submissions). Pull the detailed log with `xcrun notarytool log <submission-id> --key … --key-id … --issuer …` to see the exact reason. For a clean release, tag a fresh commit and run `release.sh` once.
- **Logsonic.app shows a Gatekeeper warning** — means notarize+staple didn't complete (the `MACOS_NOTARY_*` env vars were absent, or notarization returned non-Accepted). The `.app` is then signed but not stapled, so it forces an online check. Fix the notary creds and re-cut; verify with `xcrun stapler validate <app>` and `spctl -a -t exec -vvv <app>`.
- **`brew install logsonic` is stale / 404 on macOS** — the cask wasn't published. Either `HOMEBREW_TAP_TOKEN` was unset during `release.sh`, or `publish-cask.sh` ran before the zip finished uploading. Re-run `scripts/publish-cask.sh backend/dist/logsonic_<version>_macos.zip <version>` once the release asset is live.
- **`brew install logsonic` installs a formula instead of the cask** — a stale `Formula/logsonic.rb` is still in the tap and shadows the cask. `publish-cask.sh` deletes it on every run; if one lingers from before, remove it from `logsonic/homebrew-logsonic` manually. The tap must contain only `Casks/logsonic.rb`.
