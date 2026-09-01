# now-09 — Loopback security (Host allow-list, CSP, per-launch token)

**Horizon:** Now (v1.7 phase 1; v1.8 phase 2) · **Size:** S (phase 1, a day) + S–M (phase 2) · **Priority:** P0
**TBD.md ref:** §2 P0 (DNS rebinding), §3 principle D2, §9 trust & security model.
**Read `specs/README.md` first.**

## Goal

LogSonic's API and MCP endpoint are unauthenticated and bound to `127.0.0.1`. That is *not* sufficient privacy on a real machine:

1. **DNS rebinding** — a web page at `attacker.example` whose DNS record flips to `127.0.0.1` is loaded by the user's browser and can then `fetch("http://attacker.example:8080/api/v1/logs?query=password")` **same-origin**; CORS never applies because the origin matches. LogSonic's auto-port scans 8080–8179, so the port is guessable. Nothing in `server.go` checks `r.Host`.
2. **Other local users** on a multi-user host share loopback; any UID can read the index over HTTP.

Phase 1 (v1.7) closes (1) and adds defense-in-depth headers. Phase 2 (v1.8) closes (2) with a per-launch token minted by the shell/CLI.

## Design decisions (made)

**Phase 1**

- **Host allow-list middleware**, mounted on the root router *before* MCP, live routes, API, and the SPA catch-all. **Loopback binds (the default, the app, `logsonic -open`):** allowed hosts are `localhost`, `127.0.0.1`, `[::1]`, `::1`, each with or without `:<port>`; comparison is case-insensitive on the host part. **Non-loopback binds (`-host 0.0.0.0`; the Docker image sets `HOST=0.0.0.0`):** a browser on the LAN sends `Host: myserver:8080`, or a container-mapped hostname the server cannot resolve to its own interfaces, so the allow-list is **opt-in** there: `-allowed-hosts host1,host2` (env `LOGSONIC_ALLOWED_HOSTS`) enables it with exactly those names (+ loopback); without the flag the check is skipped and a one-time startup warning says so. A LAN bind is already an explicit, documented choice; this keeps Docker working unchanged while making the hardening available. Reject with **HTTP 421 Misdirected Request** and a JSON `ErrorResponse{Code:"HOST_NOT_ALLOWED"}`; log the rejected Host once per minute (not per request) to avoid log spam.
- **`Content-Security-Policy`** on HTML responses (the SPA): `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`. Tailwind/Radix need inline styles; scripts must not. Verify the Vite build emits no inline scripts (it does not by default). This also makes the "no network calls" promise browser-enforced.
- **Mutating routes with a body require JSON**: middleware under `/api/v1` rejects `POST/PUT/PATCH` requests **that carry a body** (`Content-Length > 0` or chunked) whose `Content-Type` is not `application/json` (415) — except the stream/multipart routes that legitimately differ (`/live/stdin`, future case-file import). Body-less `DELETE`s (`/logs`, `/logs/ids`, `/workspaces/{id}`) and body-less POSTs (`/live/subscribers/{id}/pause`) are untouched. Form-encoded cross-site POSTs die here.
- Keep CORS as is (it is correct for the dev split, `frontend:8081 → backend:8080`).

**Phase 2 (v1.8)**

- **Per-launch bearer token.** The server generates a 32-byte random token at start unless `LOGSONIC_TOKEN` is provided; prints `Server listening on http://127.0.0.1:8080/?token=…` only when `-open`/app mode (so the browser lands authenticated) and writes the token to `<storage>/session.token` (0600) for the CLI and MCP stdio to read. Accepted as `Authorization: Bearer`, as a `token` query param on the initial SPA load (which sets a `SameSite=Strict` cookie and redirects to strip it from the URL), and as a cookie thereafter. `--no-auth` disables it (dev). The macOS shell passes the token to the child via `LOGSONIC_TOKEN` and injects it into `__LOGSONIC_NATIVE__.token`; `ListeningURL.swift` learns the query form. MCP: the Streamable-HTTP endpoint requires the header; the `logsonic mcp` stdio bridge reads `session.token`; the MCP setup page shows the header in the generated client config.
- SSE (`EventSource`) cannot set headers → the cookie path covers it in browsers; the Swift `LiveFeed` (macos-b3) sends the header.

## Anchors

`server.go` middleware chain (security headers block, CORS block, router construction); `main.go` (`-host` resolution, `printUsage`); `ListeningURL.swift` (+ tests) for the URL/token parse; `pages/settings/McpSetup.tsx` (config snippet); `mcp/README.md`; `docs/configuration.md`.

## Step-by-step

**Phase 1:** 1. `pkg/server/hostcheck.go` — `allowedHosts(cfg) []string`, `HostAllowlist(next)`, the `-allowed-hosts` flag/env in `main.go`, unit tests. 2. CSP + JSON-only middleware in `server.go`. 3. Tests. 4. `docs/configuration.md` "Security model" section (what is checked, what 421 means, how LAN binds behave). **Phase 2:** 5. Token generation/verification middleware; cookie exchange on `/`; `session.token` file. 6. Shell + CLI + MCP plumbing. 7. Settings → About shows "Session token: set / disabled". 8. Docs + release note (breaking for scripts that curl the API — document `Authorization` header and `--no-auth`).

## Test cases

| # | Case | Pass criterion |
|---|------|----------------|
| S1 | `GET /api/v1/ping` with `Host: localhost:8080` / `127.0.0.1:8080` / `[::1]:8080` / no port | 200 |
| S2 | `Host: evil.example` / `Host: evil.example:8080` / `Host: 127.0.0.1.evil.example` | 421 JSON |
| S3 | same for `/mcp`, `/api/v1/live/events`, `/` (SPA) | 421 on all three |
| S4 | `-host 0.0.0.0` without `-allowed-hosts` → `Host: <lan-ip>:8080`, `Host: myserver:8080`, `Host: evil.example` | all 200; one warning line at startup (check is skipped) |
| S4b | `-host 0.0.0.0 -allowed-hosts myserver` → `Host: myserver:8080` / `Host: localhost:8080` | 200 · `Host: evil.example` → 421 |
| S4c | Docker: `docker run -p 8080:8080 logsonic` → `curl -H "Host: localhost:8080"` from the host | 200 (documented in `docs/installation.md` Docker section) |
| S5 | HTML response carries CSP; JSON responses don't need it | header present on `/`, absent on `/api/v1/ping` |
| S6 | `POST /api/v1/workspaces` with a body and `Content-Type: application/x-www-form-urlencoded` | 415 |
| S6b | `DELETE /api/v1/logs`, `DELETE /api/v1/workspaces/{id}`, `POST /live/subscribers/{id}/pause` (no body, no Content-Type) | unchanged (200/204) |
| S7 | E2E: embedded build under Playwright with CSP → app fully functional (no CSP violations in console) | zero `Refused to…` console errors |
| S8 | (phase 2) no token → 401 on API/MCP; `?token=` on `/` sets cookie and redirects; cookie works for SSE; `--no-auth` bypasses | as stated |
| S9 | (phase 2) `ListeningURLTests` parse `http://127.0.0.1:8081/?token=abc` | host/port/token extracted |
| S10 | Regression: dev split (frontend 8081 → backend 8080) still works with CORS | manual + E2E harness |

## Acceptance criteria

- [ ] Phase 1: S1–S7 green; `docs/configuration.md` documents the model; no behavior change for legitimate localhost clients.
- [ ] Phase 2: S8–S10 green; app, CLI (`tail`, `open`, `doctor`), MCP stdio, and browser mode all work without manual token handling; release notes call out `--no-auth`.
- [ ] `logsonic doctor` (`now-13`) reports allow-list + token status.

## Out of scope

TLS on loopback (no benefit), OS keychain storage of the token (file 0600 is the norm for local tools), multi-user auth (charter L1).
