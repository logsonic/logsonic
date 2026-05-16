# LogSonic Release Strategy

End-to-end plan for shipping signed `.dmg` (macOS), signed `.exe` installer (Windows), Linux archives, and a Homebrew tap. GoReleaser remains the orchestrator; this doc fills in the wrapping, signing, notarization, and distribution gaps the current `backend/.goreleaser.yaml` does not cover.

---

## 1. Current state

- Build: GoReleaser produces stripped `tar.gz` archives for darwin/linux/windows × amd64/arm64/386 at `backend/.goreleaser.yaml`.
- Frontend: Vite build copied into [backend/pkg/static/dist/](backend/pkg/static/dist/) and embedded via `go:embed`.
- Runtime: [backend/main.go](backend/main.go) is a CLI that binds `localhost:8080` and prints "open this URL in your browser" — no native window, no menubar item, no auto-launch.
- Signing: none. No `.app` bundle, no `.dmg`, no Windows installer, no notarization.
- CI: no `.github/workflows` — releases are run manually from a dev machine.
- Distribution: GitHub Releases only. Issue [#1](https://github.com/<OWNER>/logsonic/issues/1) tracks Homebrew.

### Today's manual flow

This is the current end-to-end recipe. Run from a dev machine until CI takes over (§9). Produces unsigned `tar.gz` / `zip` archives attached to a GitHub Release.

**Prerequisites**

- [GoReleaser](https://goreleaser.com/install/) installed (`brew install goreleaser`).
- A GitHub token with `repo` scope exported as `GITHUB_TOKEN`.

**Steps**

1. Build the frontend (it gets embedded into the Go binary):
   ```bash
   cd frontend
   npm ci
   npm run build
   npm run build:copy
   cd ..
   ```

2. Tag the release:
   ```bash
   git tag -a v0.X.0 -m "Release v0.X.0"
   git push origin v0.X.0
   ```

3. Run GoReleaser from the `backend/` directory:
   ```bash
   cd backend
   goreleaser release --clean
   ```

   For a dry-run (no publish):
   ```bash
   cd backend
   goreleaser release --snapshot --clean
   ```

The GoReleaser config lives at [`backend/.goreleaser.yaml`](backend/.goreleaser.yaml) and builds for Linux, Windows, and macOS.

## 2. Target artifacts (per release)

| Platform | Artifact | Signed | Notes |
|---|---|---|---|
| macOS arm64 | `LogSonic-x.y.z-arm64.dmg` | Developer ID + notarized | Contains `LogSonic.app` |
| macOS amd64 | `LogSonic-x.y.z-amd64.dmg` | Developer ID + notarized | Contains `LogSonic.app` |
| macOS universal | `LogSonic-x.y.z-universal.dmg` (optional) | Developer ID + notarized | `lipo`-merged binary |
| Windows x64 | `LogSonic-x.y.z-setup-x64.exe` (NSIS) | Authenticode | Includes tray launcher |
| Windows x64 | `LogSonic-x.y.z-x64.zip` | Authenticode (binary) | Portable |
| Linux x64/arm64 | `logsonic_x.y.z_linux_<arch>.tar.gz` | GPG (optional) | Portable, used by `install.sh` |
| Linux x64/arm64 | `logsonic_x.y.z_<arch>.deb` | GPG | Debian/Ubuntu/Mint |
| Linux x64/arm64 | `logsonic-x.y.z.<arch>.rpm` | GPG | Fedora/RHEL/openSUSE |
| Linux x64/arm64 | `LogSonic-x.y.z-<arch>.AppImage` | GPG (embedded) | Distro-agnostic GUI |
| Installer script | `install.sh` (macOS + Linux) | cosign blob (optional) | `curl \| sh` one-liner |
| Installer script | `install.ps1` (Windows) | Authenticode (optional) | `irm \| iex` one-liner |
| Homebrew | Formula in `homebrew-logsonic` tap | — | Cask for `.app`, formula for CLI |
| Checksums | `LogSonic-x.y.z-checksums.txt` | sigstore/cosign | All artifacts |

---

## 3. Native-app wrapper (prerequisite for `.dmg` and signed `.exe`)

The binary today is headless. To make a real double-click app we add a small wrapper around `main.go` that:

1. Starts the existing HTTP server in a goroutine (refactor [backend/main.go](backend/main.go) so `Start()` is non-blocking or runs in its own goroutine).
2. Opens the default browser to `http://localhost:<port>` (try `os/exec` with `open`/`xdg-open`/`rundll32 url.dll,FileProtocolHandler`, or use [`pkg/browser`](https://github.com/pkg/browser)).
3. Adds a menubar/tray icon with **Open LogSonic**, **Storage folder…**, **About**, **Quit** — use [`fyne.io/systray`](https://github.com/fyne-io/systray) (pure-Go, cross-platform, no CGO needed on macOS/Windows for systray itself but Linux needs `libayatana-appindicator`).
4. On `Quit`, gracefully shuts down the chi server.

Suggested layout:

```
backend/
  cmd/
    logsonic/      # existing CLI entrypoint (headless, for `brew install logsonic`)
    logsonic-app/  # new GUI wrapper entrypoint (for .app / .exe)
  pkg/...
```

Two GoReleaser `builds:` entries — one per entrypoint — keeps the CLI path clean for Homebrew formula users who don't want a tray icon.

---

## 4. macOS: `.app` bundle, `.dmg`, signing, notarization

### 4a. `.app` bundle

GoReleaser's `app_bundles:` (v2) produces an `.app` from a build target. Required pieces:

- `Info.plist` with `CFBundleIdentifier = <REVERSE_DOMAIN>.logsonic` (e.g. `io.logsonic.app`), `LSUIElement = true` (menubar app, no Dock icon), `LSMinimumSystemVersion = 11.0`.
- App icon `.icns` (1024px source → `iconutil -c icns`).
- Binary at `LogSonic.app/Contents/MacOS/LogSonic`.

### 4b. Signing

Apple Developer ID is **mandatory** for notarization. Steps:

1. Enroll in Apple Developer Program ($99/yr) with a dedicated Apple ID.
2. In Apple Developer portal: create a **Developer ID Application** certificate. Download and import into the macOS Keychain on the signing machine.
3. Export the cert + private key as a `.p12` file (for CI use).
4. Sign with hardened runtime:
   ```bash
   codesign --force --deep --options runtime \
     --sign "Developer ID Application: <YOUR_NAME> (<TEAMID>)" \
     --entitlements entitlements.plist \
     LogSonic.app
   ```
   `entitlements.plist` should include `com.apple.security.cs.allow-jit` only if needed (Bleve does not need it; leave minimal).

### 4c. Notarization

Required so Gatekeeper does not block first-launch.

1. Create an **app-specific password** at appleid.apple.com (or use API key via `notarytool --key`).
2. Build the `.dmg` first (see 4d), then:
   ```bash
   xcrun notarytool submit LogSonic-x.y.z-arm64.dmg \
     --apple-id "<YOUR_APPLE_ID>" \
     --team-id "<TEAMID>" \
     --password "$APP_SPECIFIC_PASSWORD" \
     --wait
   xcrun stapler staple LogSonic-x.y.z-arm64.dmg
   ```

GoReleaser has first-class hooks for both signing and notarization via [`notarize:`](https://goreleaser.com/customization/notarize/) (v2.5+) and [`signs:`](https://goreleaser.com/customization/sign/). Concretely:

```yaml
notarize:
  macos:
    - enabled: '{{ isEnvSet "MACOS_SIGN_P12" }}'
      sign:
        certificate: "{{ .Env.MACOS_SIGN_P12 }}"   # base64 .p12
        password: "{{ .Env.MACOS_SIGN_PASSWORD }}"
      notarize:
        issuer_id: "{{ .Env.MACOS_NOTARY_ISSUER_ID }}"
        key_id: "{{ .Env.MACOS_NOTARY_KEY_ID }}"
        key: "{{ .Env.MACOS_NOTARY_KEY }}"          # base64 .p8
        wait: true
```

### 4d. `.dmg` packaging

Options:
- **`create-dmg`** (npm/shell, simplest): drag-to-Applications layout, custom background, icon position.
- **GoReleaser `dmg:` block** (built-in, recommended): generates a clean DMG with the `.app` inside and an `/Applications` symlink.

Sign the DMG itself (`codesign --sign … LogSonic-x.y.z-arm64.dmg`) before submitting to notarytool — DMGs are notarizable as a single ticket that staples to both the DMG and the contained `.app`.

---

## 5. Windows: installer, signing

### 5a. Installer

Use **NSIS** (mature, scriptable) or **WiX/MSI** (corporate-friendly). Recommended: NSIS via GoReleaser's [`msi:`](https://goreleaser.com/customization/msi/) or a separate `nsis` step. The installer should:

- Drop `logsonic-app.exe` (tray wrapper) into `%ProgramFiles%\LogSonic\`.
- Create Start-menu shortcut + optional Desktop shortcut.
- Register an uninstaller.
- Optionally register a Firewall rule for `localhost:8080`.
- Optionally start on login (registry `Run` key, opt-in checkbox).

### 5b. Authenticode signing

Three realistic paths, cheapest first:

| Option | Cost | Notes |
|---|---|---|
| **Azure Trusted Signing** | ~$10/mo | Microsoft's new managed cert service. Validation is simpler than EV. Works from GitHub Actions via `azure/trusted-signing-action`. **Recommended.** |
| OV cert (DigiCert/Sectigo/SSL.com) | $200–400/yr | Cheaper but SmartScreen still warns until reputation builds (weeks). |
| EV cert (token or cloud HSM) | $400–700/yr | Instant SmartScreen reputation. Most painful procurement. |

Sign with `signtool`:
```cmd
signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 ^
  /sha1 <thumbprint> logsonic-app.exe
signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 ^
  /sha1 <thumbprint> LogSonic-x.y.z-setup-x64.exe
```

Sign **both** the inner `.exe` and the installer.

GoReleaser hooks: [`signs:` with `artifacts: binary` and `artifacts: installer`].

---

## 6. Linux

Linux is a first-class target. Three artifact tracks, all built from the same GoReleaser run:

### 6a. Portable archives (`tar.gz`)

Already produced. Useful for `curl | sh` installs (see §7) and for users who just want a binary in `~/.local/bin`. Build both the headless CLI (`logsonic`) and the tray app (`logsonic-app`) — Linux gets both, packaged together.

### 6b. Distro packages (`.deb`, `.rpm`)

Use GoReleaser's [`nfpms:`](https://goreleaser.com/customization/nfpm/) block — no extra tooling, builds both formats from the same Go binary.

```yaml
nfpms:
  - id: logsonic
    package_name: logsonic
    vendor: <YOUR_NAME>
    homepage: https://github.com/<OWNER>/logsonic
    maintainer: <YOUR_NAME> <<YOUR_EMAIL>>
    description: Desktop-first log analytics with full-text search and Grok parsing
    license: MIT
    formats: [deb, rpm]
    bindir: /usr/bin
    contents:
      - src: packaging/linux/logsonic.desktop
        dst: /usr/share/applications/logsonic.desktop
      - src: packaging/linux/logsonic.png
        dst: /usr/share/icons/hicolor/512x512/apps/logsonic.png
      - src: packaging/linux/systemd-user.service
        dst: /usr/lib/systemd/user/logsonic.service
    dependencies:
      - libayatana-appindicator3-1  # only for tray on GNOME/Ubuntu
    recommends:
      - libgtk-3-0
    rpm:
      group: Applications/System
    deb:
      lintian_overrides:
        - statically-linked-binary  # Go binaries are static; expected
```

`logsonic.desktop` makes the tray app show up in app launchers (GNOME, KDE). `systemd-user.service` lets users `systemctl --user enable logsonic` to auto-start the server.

Distribution: attach `.deb` and `.rpm` to GitHub Releases. Optional later — host an `apt` repo (e.g., via Cloudsmith free tier or GitHub Pages with `apt-ftparchive`) and an `yum`/`dnf` repo so users can `apt install logsonic` directly.

### 6c. AppImage (single-file GUI app)

For users on distros where `.deb`/`.rpm` is awkward (Arch, NixOS, OpenSUSE, immutable distros). AppImage bundles the tray app + libraries into one executable file.

Use [`appimagetool`](https://github.com/AppImage/AppImageKit) directly in a post-build hook, or [`appimage-builder`](https://github.com/AppImageCrafters/appimage-builder) for a declarative spec. Not natively supported by GoReleaser, but works fine as an `after:hooks:` step.

Naming: `LogSonic-x.y.z-x86_64.AppImage`, `LogSonic-x.y.z-aarch64.AppImage`.

### 6d. Snap / Flatpak

Skip for now. Snap requires a Canonical account and `snapcraft.yaml` overhead; Flatpak needs a manifest in `flathub/flathub` repo with separate review. Add only if there's user demand — `.deb`/`.rpm`/AppImage cover ~95% of Linux desktop users.

### 6e. Linux signing (provenance only)

Linux has no Gatekeeper/SmartScreen equivalent — package managers verify GPG signatures, AppImages can carry an embedded GPG signature.

- For `.deb`/`.rpm`: sign with GPG via `nfpm`'s `passphrase`/`key_file` options. Publish the public key on the repo README and the future apt/yum repo.
- For AppImages: `appimagetool --sign` with the same GPG key.
- For `tar.gz` and checksums: sigstore/cosign keyless signing in CI gives provenance without long-lived secrets.

---

## 7. Curl-pipe installer (`install.sh`)

The standard pattern users expect: `curl -fsSL https://raw.githubusercontent.com/<OWNER>/logsonic/main/install.sh | sh`. Eventually point at a short URL (`https://logsonic.io/install.sh` or `https://get.logsonic.io`) once a domain exists.

The script lives at the repo root as `install.sh` and supports macOS + Linux.

### 7a. Behavior

1. Detect OS (`darwin`/`linux`) and arch (`amd64`/`arm64`/`386`) via `uname`.
2. Fetch latest release tag from GitHub API (`/repos/<OWNER>/logsonic/releases/latest`), or honor `LOGSONIC_VERSION=vX.Y.Z` from env.
3. Download the matching `.tar.gz` from GitHub Releases.
4. Download `checksums.txt` and verify SHA-256 with `shasum -a 256` / `sha256sum`.
5. Optionally verify cosign signature on the checksum file if `cosign` is available (best-effort, not required).
6. Extract to a temp dir, move `logsonic` (and `logsonic-app` on Linux) into the install dir.
7. Install dir resolution: `LOGSONIC_INSTALL_DIR` env > `/usr/local/bin` if writable > `$HOME/.local/bin` (and warn if not on `$PATH`).
8. On Linux only: also install `.desktop` file and icon under `$XDG_DATA_HOME` if installing to `$HOME`.
9. Print next-steps: how to run, where storage lives, how to uninstall.

### 7b. Script skeleton

Save as `install.sh` at repo root. POSIX `sh` (not bash-only), runs on stock macOS and Alpine.

```sh
#!/bin/sh
set -eu

REPO="<OWNER>/logsonic"
INSTALL_DIR="${LOGSONIC_INSTALL_DIR:-}"
VERSION="${LOGSONIC_VERSION:-latest}"

err() { printf 'error: %s\n' "$1" >&2; exit 1; }
info() { printf '==> %s\n' "$1"; }

need() { command -v "$1" >/dev/null 2>&1 || err "missing required tool: $1"; }
need curl
need tar
need uname

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$OS" in
  darwin|linux) ;;
  *) err "unsupported OS: $OS (Windows: use the .exe installer)" ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  i386|i686) ARCH=386 ;;
  *) err "unsupported arch: $ARCH" ;;
esac

if [ "$VERSION" = "latest" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')"
  [ -n "$VERSION" ] || err "could not resolve latest version"
fi
VERSION_NUM="${VERSION#v}"

ASSET="logsonic_${VERSION_NUM}_${OS}_${ARCH}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
CHECKSUMS_URL="https://github.com/${REPO}/releases/download/${VERSION}/logsonic_${VERSION_NUM}_checksums.txt"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

info "downloading ${ASSET}"
curl -fsSL "$URL" -o "$TMP/$ASSET"
curl -fsSL "$CHECKSUMS_URL" -o "$TMP/checksums.txt"

info "verifying checksum"
EXPECTED="$(grep " $ASSET\$" "$TMP/checksums.txt" | awk '{print $1}')"
[ -n "$EXPECTED" ] || err "checksum entry for $ASSET not found"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')"
else
  ACTUAL="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
fi
[ "$EXPECTED" = "$ACTUAL" ] || err "checksum mismatch"

info "extracting"
tar -xzf "$TMP/$ASSET" -C "$TMP"

if [ -z "$INSTALL_DIR" ]; then
  if [ -w /usr/local/bin ] 2>/dev/null; then
    INSTALL_DIR=/usr/local/bin
  else
    INSTALL_DIR="$HOME/.local/bin"
    mkdir -p "$INSTALL_DIR"
  fi
fi

info "installing to ${INSTALL_DIR}"
install -m 0755 "$TMP/logsonic" "$INSTALL_DIR/logsonic"
if [ -f "$TMP/logsonic-app" ]; then
  install -m 0755 "$TMP/logsonic-app" "$INSTALL_DIR/logsonic-app"
fi

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf 'warning: %s is not on $PATH — add it to your shell rc.\n' "$INSTALL_DIR" >&2 ;;
esac

info "installed logsonic ${VERSION}"
printf '\nNext: run \033[1mlogsonic\033[0m, then open http://localhost:8080\n'
printf 'Storage lives at ~/.logsonic (override with -storage or STORAGE_PATH).\n'
printf 'Uninstall: rm %s/logsonic\n' "$INSTALL_DIR"
```

### 7c. Supply-chain hardening

`curl | sh` is convenient but carries a real risk if the script is ever compromised. Mitigations:

- **Pin the script in the README to a versioned URL** (e.g., `…/v1.0.0/install.sh`) so a future malicious `main` doesn't get pulled by everyone.
- **Publish checksums of the script itself** in each release's notes.
- **Sign the script with cosign** in CI; document the `cosign verify-blob` command in the README for paranoid users.
- **Document the `wget … && less install.sh && sh install.sh` alternative** prominently — gives users a chance to read before executing.
- **Mirror the script via `gh-pages` / a CDN** only after a domain is set up; until then, use the GitHub raw URL pinned to a tag.

### 7d. Windows equivalent (`install.ps1`)

For symmetry, a PowerShell one-liner: `irm https://raw.githubusercontent.com/<OWNER>/logsonic/main/install.ps1 | iex`. Same logic — detect arch, download `.zip` (not the NSIS installer, which is for GUI users), verify SHA-256, drop into `$env:LOCALAPPDATA\Programs\LogSonic`, add to PATH. Optional, low priority; most Windows users will use the signed `.exe` installer.

---

## 8. Homebrew distribution

Two artifacts make sense:

### 8a. CLI formula (`Formula/logsonic.rb`)

For users who want the headless CLI (`logsonic -port 8080`). GoReleaser's [`brews:`](https://goreleaser.com/customization/homebrew/) writes this automatically from a darwin/linux build into a tap repo.

Repo to create: **`<OWNER>/homebrew-logsonic`** (the `homebrew-` prefix is required for `brew tap` to work).

Config snippet to add to `.goreleaser.yaml`:
```yaml
brews:
  - name: logsonic
    repository:
      owner: <OWNER>
      name: homebrew-logsonic
      token: "{{ .Env.HOMEBREW_TAP_TOKEN }}"
    homepage: "https://github.com/<OWNER>/logsonic"
    description: "Desktop-first log analytics with full-text search and Grok parsing"
    license: "MIT"
    test: |
      system "#{bin}/logsonic", "-help"
    install: |
      bin.install "logsonic"
```

Install path for users: `brew tap <OWNER>/logsonic && brew install logsonic`.

### 8b. Cask (`Casks/logsonic.rb`)

For users who want the menubar `.app`. Casks point at the signed, notarized `.dmg`. Add to the same tap repo:

```yaml
homebrew_casks:
  - name: logsonic
    repository:
      owner: <OWNER>
      name: homebrew-logsonic
    binary: LogSonic
    app: LogSonic.app
    homepage: "https://github.com/<OWNER>/logsonic"
    description: "LogSonic desktop app"
```

Install: `brew install --cask logsonic`.

### 8c. Path to homebrew-core (later)

Once the project hits ~30 GitHub stars and has a stable release cadence, submit the formula to [homebrew/homebrew-core](https://github.com/Homebrew/homebrew-core). Acceptance criteria: notable, maintained, stable versioning, no GUI-only dependency for the formula (the cask path is separate via homebrew-cask). Until then, a personal tap is the right move and closes issue #1.

---

## 9. GitHub Actions CI/CD

Move releases off the dev machine. Single workflow `.github/workflows/release.yml` triggered by tag `v*`:

```
jobs:
  build-frontend:        # npm ci && build && build:copy → upload artifact
  release:
    needs: build-frontend
    runs-on: macos-14    # macOS for codesign + notarytool
    steps:
      - download frontend artifact into backend/pkg/static/dist/
      - install Go, GoReleaser
      - import Developer ID cert from secret (base64 .p12)
      - run: goreleaser release --clean
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          HOMEBREW_TAP_TOKEN: ${{ secrets.HOMEBREW_TAP_TOKEN }}   # PAT with repo scope
          MACOS_SIGN_P12: ${{ secrets.MACOS_SIGN_P12 }}
          MACOS_SIGN_PASSWORD: ${{ secrets.MACOS_SIGN_PASSWORD }}
          MACOS_NOTARY_KEY: ${{ secrets.MACOS_NOTARY_KEY }}
          MACOS_NOTARY_KEY_ID: ${{ secrets.MACOS_NOTARY_KEY_ID }}
          MACOS_NOTARY_ISSUER_ID: ${{ secrets.MACOS_NOTARY_ISSUER_ID }}
          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
          AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
```

Windows signing is the awkward part: NSIS + signtool needs a Windows runner. Two options:
- Split into a second job on `windows-latest`, sign with Azure Trusted Signing action, upload as a release asset.
- Or do everything on macOS and call out to Azure Trusted Signing's REST API to sign the Windows binaries remotely (works, but more code).

The pragmatic split: macOS job builds + signs Mac + Linux + Homebrew tap; Windows job builds + signs Windows installer; a final job stitches checksums.

---

## 10. Code-signing strategies for open-source projects

You asked specifically about this. The realistic options:

1. **Self-fund + use the project as a write-off.** $99/yr Apple + ~$120/yr Azure Trusted Signing = ~$220/yr. Smallest path, full control.
2. **SignPath Foundation** — free Authenticode code signing for OSS projects ([signpath.org/foundation](https://signpath.org/foundation)). They hold the certificate, you submit builds via their GitHub Action. Eligibility: OSS license (MIT works), public repo, no monetization tied to the signed binaries. Strongest free option for Windows.
3. **MacOS notarization has no free equivalent.** Apple does not offer a foundation program. Some OSS projects sidestep this by distributing through Homebrew Cask (which uses a Developer-signed binary if provided, or falls back to `xattr -d com.apple.quarantine`) and leaving the `.dmg` unsigned with install instructions. Acceptable for a beta; not great for non-technical users.
4. **GitHub Sponsors / Open Collective to cover certs.** Several OSS projects (e.g., Inkscape, Krita) fund their signing certs this way.
5. **sigstore/cosign for checksums** — free, keyless signing of release artifacts via OIDC. Does not replace OS signing (Gatekeeper/SmartScreen ignore it) but proves provenance for security-conscious users and integrates well with SLSA.
6. **Reproducible builds + transparency** — publishing build steps + checksums + sigstore attestations lets users verify what they download, partially compensating for unsigned binaries.

Recommended combination for LogSonic if you want to minimize spend: **Apple Developer ID ($99/yr, unavoidable) + SignPath Foundation (free for Windows) + sigstore on checksums (free).**

---

## 11. Versioning + release checklist

Switch from manual `git tag` to a checklist-driven flow:

- [ ] Bump version in [frontend/package.json](frontend/package.json) and any `version` constant in Go (or read from `runtime/debug.ReadBuildInfo`).
- [ ] Update `CHANGELOG.md` (GoReleaser already generates one from commits, but a hand-curated highlights section reads better).
- [ ] Run `cd frontend && npm ci && npm run build && npm run build:copy`.
- [ ] Smoke-test the embedded binary: `cd backend && go run ./cmd/logsonic-app` — confirm tray icon, browser open, server up.
- [ ] `git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push origin vX.Y.Z`.
- [ ] Watch the GitHub Action; verify all artifacts uploaded, Homebrew tap PR auto-created/merged.
- [ ] Download the `.dmg` and `.exe` on a clean machine — no Gatekeeper/SmartScreen warning.
- [ ] `brew tap <OWNER>/logsonic && brew install --cask logsonic` on a clean macOS — confirm app launches.
- [ ] Close issue #1 once Homebrew install path is live.

---

## 12. Suggested rollout order

1. **Refactor `main.go` → `cmd/logsonic` (headless) + `cmd/logsonic-app` (tray wrapper).** Pure-Go change, no signing infra needed yet. Validates the product shape.
2. **Wire GoReleaser for `.app` + `.dmg`, NSIS installer, and Linux `tar.gz` + `.deb` + `.rpm` (all unsigned).** Test artifacts on real machines with manual Gatekeeper / SmartScreen bypass.
3. **Add `install.sh` at repo root.** Works against unsigned tar.gz on macOS + Linux; closes the "easy install" gap without waiting on signing infra.
4. **Add Homebrew tap repo + `brews:` config.** Cheap win that closes issue #1; CLI formula works without any signing.
5. **Add Apple Developer ID + notarization.** Removes Gatekeeper friction for the cask path and the `.dmg`.
6. **Add Windows signing** (SignPath Foundation if eligible, else Azure Trusted Signing).
7. **Add AppImage + GPG-signed `.deb`/`.rpm`.** Optional polish; expands Linux coverage to distros where `.deb`/`.rpm` is awkward.
8. **Move everything to GitHub Actions.** Last step — automate only once each piece works manually.

Steps 1–4 are doable this week. Step 5 waits on Apple Developer enrollment (1–2 day approval). Step 6 timing depends on SignPath approval (~1–2 weeks) or Azure setup (~1 day). Step 7 can run in parallel with 5/6.
