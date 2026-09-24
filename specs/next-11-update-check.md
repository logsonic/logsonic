# next-11 — Opt-in update check (the one sanctioned network call)

**Horizon:** Next · **Size:** S · **Priority:** P2. Medium-depth spec.
**TBD.md ref:** §3 principle D2, §9 threat table (update check), §11 Bundle 2 item 5 / Bundle 3 item 10, §12 non-goals.
**Read `specs/README.md` first.**

## Goal

Desktop users of the `.app` fall behind the CLI silently. A check for updates is table stakes for a desktop app — and it is the *only* network call LogSonic will ever make, so its policy matters more than its code: **off by default, explicit, anonymous, visible.**

## Design decisions (made)

- **Off by default.** No request is ever made unless the user enables "Check for updates" in Settings → About (persisted server-side in `<storage>/config.json`, `update_check: {enabled: false, last_checked, last_result}`) **or** triggers a manual check (menu item "Check for Updates…" / About button). Enabling shows the exact request that will be made and the text "This is the only network request LogSonic can make."
- **The request:** one `GET https://api.github.com/repos/logsonic/logsonic/releases/latest` with `User-Agent: logsonic/<version>` and `Accept: application/vnd.github+json`; no other headers, no query parameters, no cookies. Timeout 5 s. Compare `tag_name` (SemVer) to the running version. Automatic checks at most once per 24 h, only while the UI is open, jittered.
- **Where it runs:** the **server** does the HTTP call (Go, `net/http`), never the webview (keeps CSP `connect-src 'self'` intact and keeps browser fingerprints out of it). `GET /api/v1/update/check` (manual, performs the request) and `GET /api/v1/update/status` (cached result). The network-audit E2E (`now-11`) asserts the SPA still makes zero non-loopback requests; the server-side call is exercised in a separate test against an `httptest` server (the real endpoint is never hit in CI).
- **Result surface:** About page and, when newer: a dismissible StatusBar chip "v1.9.0 available" → opens the release notes URL in the system browser and shows the platform-appropriate command (`brew upgrade logsonic`, `winget upgrade …`, download link). **No self-replacing binary in this spec.** Sparkle (or a hand-rolled updater) is a later decision that requires this policy first; the macOS menu item "Check for Updates…" (`macos-b2`) calls this endpoint.
- **Air-gapped mode:** if `-offline` (new flag, also `LOGSONIC_OFFLINE=1`) is set, the endpoints return `{disabled: "offline"}` and the toggle is greyed out with the flag named — so Persona 1 can prove nothing can ever leave, even if someone flips the toggle.

## Anchors

`main.go` (flags, `printUsage`), `server.go` (`Config`), `now-10`'s `config.json`, `pages/settings/About.tsx`, `Shell/StatusBar.tsx`, `LogsonicApp.swift` (menu item → `evaluateJavaScript` action `check-updates` in the registry), `docs/configuration.md` (`-offline`), `README.md` FAQ ("Is my data sent to any servers?" — update the answer to name this exception precisely).

## Test cases

U1 default config → no request made during a 30 s run under an outbound-connection recorder (`httptest` proxy or `net/http` `Transport` stub counting dials); U2 manual check → exactly one GET with the specified headers; U3 newer tag → status `available` with version + URL; same/older → `up_to_date`; U4 network error → `error` with message, no retry storm (next automatic attempt ≥ 24 h); U5 `-offline` → 200 `{disabled:"offline"}` and no dial even on manual; U6 E2E network audit still zero SPA-originated external requests with the feature enabled; U7 About page copy shows the exact URL.

## Acceptance criteria

- [ ] Zero requests unless enabled or manually triggered; `-offline` hard-disables.
- [ ] README/FAQ and `docs/configuration.md` state the policy in one sentence each.
- [ ] Menu item + About + StatusBar chip wired; no auto-install.

## Out of scope

Downloading or installing updates, Sparkle/appcast signing, release-notes rendering in-app, checking for CLI vs app mismatch beyond the version string.
