# now-05 — Distribution parity (winget, Scoop, deb, rpm, AUR)

**Horizon:** Now (v1.8) · **Size:** S–M · **Priority:** P1
**TBD.md ref:** §5 v1.8. Homebrew (macOS) is DONE — do not touch it.
**Read `specs/README.md` first.**

## Goal

`logsonic` installable via the native package manager on Windows (winget, Scoop) and Linux (deb, rpm, AUR). Each package manager is a discovery surface; the incident-triager persona arrives through them.

## Design decisions (made)

- **Everything hangs off goreleaser** (`backend/.goreleaser.yaml` exists and already builds release binaries + the Homebrew tap). Add generators rather than hand-maintained manifests wherever goreleaser supports them: `nfpms` (deb+rpm), `scoops` (Scoop bucket), `winget` (goreleaser's winget publisher), `aurs` (AUR PKGBUILD).
- **Linux/Windows packages ship the CLI/server binary only** — no native shells yet (that's a Later charter). Post-install message prints "run `logsonic` then open the printed URL".
- Repos to create under the `logsonic` GitHub org (same pattern as the existing Homebrew tap): `scoop-bucket`, and an AUR account/SSH key for `logsonic-bin`. winget publishes via PR to `microsoft/winget-pkgs` (goreleaser automates the PR; requires a fork + token).
- deb/rpm: no systemd unit in v1 (LogSonic is a desktop-session tool, not a daemon); install to `/usr/bin/logsonic`, add shell completions if the CLI supports them (check `main.go`; skip if not).

## Current-state anchors

- `backend/.goreleaser.yaml` — read fully first; extend, don't restructure. The Homebrew (`brews`/cask) section is the template for tone/metadata.
- `backend/.release.env.example` — where release tokens are declared. New secrets (winget fork token, AUR SSH key) get documented here, **never committed with values**.
- `RELEASE.md` — the release runbook; every new channel gets a section.
- Version/ldflags: check how the existing builds inject version (goreleaser `builds` block) — packages must show the same version in `logsonic --version` (added by `now-07` — the trust sprint; if this spec is picked up first, implement it there per now-07 task 2, not here).

## Step-by-step

1. Read `.goreleaser.yaml` + `RELEASE.md`; note the release trigger (tag push vs manual).
2. Add `nfpms` block: deb + rpm, license MIT, homepage, description from README's one-liner, maintainer from the git log identity, `bindir: /usr/bin`.
3. Add `scoops` block → `logsonic/scoop-bucket` repo (create it, empty, with README).
4. Add `winget` block → requires `--version` support and a token with a fork of `winget-pkgs`; manifest identity `Logsonic.Logsonic`.
5. Add `aurs` block → `logsonic-bin` package; document the AUR SSH key setup in `RELEASE.md`.
6. Update `.release.env.example` + `RELEASE.md` with the new tokens/steps.
7. Dry-run: `goreleaser release --snapshot --clean --skip=publish` from `backend/` — must produce .deb, .rpm, scoop manifest, winget manifests, PKGBUILD in `dist/` without errors.
8. Update `docs/installation.md` with per-OS install commands (winget install, scoop install, apt/dnf local-file install until a hosted repo exists, `yay -S logsonic-bin`).

## Test cases

| # | Test | Pass criterion |
|---|------|----------------|
| D1 | snapshot dry-run | all artifacts generated, goreleaser exits 0 |
| D2 | deb in Docker: `docker run --rm -v $PWD/dist:/d ubuntu bash -c "apt-get update && apt install -y /d/*amd64.deb && logsonic --version"` | installs, version prints, binary runs |
| D3 | rpm in Docker (fedora image, `dnf install`) | same |
| D4 | scoop manifest JSON | validates against Scoop schema (`scoop install` on a Windows runner or schema-lint) |
| D5 | winget manifests | `winget validate` passes (Windows runner or wingetcreate validate) |
| D6 | PKGBUILD | `namcap` lint clean (Arch container) |
| D7 | `logsonic --version` | matches the tag on all platforms |

## Manual validation

After the first real tagged release: install on one real Windows machine (winget + scoop), one Debian/Ubuntu, one Fedora, one Arch; import a sample log end-to-end on each.

## Acceptance criteria

- [ ] Snapshot dry-run produces all five package types.
- [ ] D2/D3 container installs pass in CI or locally.
- [ ] `RELEASE.md` + `.release.env.example` + `docs/installation.md` updated.
- [ ] Homebrew path untouched and still green in dry-run.

## Out of scope

- Hosted apt/yum repositories (charter-level; GitHub Releases installs are fine for now).
- Native Windows/Linux app shells. systemd units. Chocolatey (winget+scoop cover Windows).
