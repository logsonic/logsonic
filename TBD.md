# LogSonic — Product Roadmap & TBD

> **Positioning: "The local log brain — for you and your agents."**
> Not a lightweight ELK, not a log viewer: the private, indexed, queryable memory of everything your systems say — readable by humans through a fast UI and by AI through MCP.

Prepared 2026-09-01 from repo state at commit `cba6287`, live GitHub issue state, and the v1.6 release. **Revision 2** (same day) after a code-level review against the "world-class desktop-first" bar — see the changelog below.
Companion artifact (rendered version): https://claude.ai/code/artifact/ce5041ee-db5a-4e6d-be28-b39100133fd2

> **Executable work specs live in [`specs/`](specs/README.md)** — one self-contained spec per roadmap item (architecture decisions, step-by-step tasks, API contracts, and test cases), sized for a smaller agent to pick up. Start with [`specs/README.md`](specs/README.md) for the pickup-order table and mandatory dev-environment rules.

## Work progress log

Tracks what has actually been implemented against the pickup order in `specs/README.md`, so the next work session (human or agent) knows where to resume. Entries are dated and reference the spec + commit. Anything not listed here is **not started**. Issues found while implementing are logged in [`ISSUES.md`](ISSUES.md), not here.

| Date | Spec | Status | Summary |
|------|------|--------|---------|
| 2026-09-01 | [now-01](specs/now-01-self-hosted-fonts.md) | ✅ Done | Google Fonts import removed; `--ls-font-sans`/`--ls-font-mono` and the Tailwind `fontFamily` config now resolve to the platform system stack. Verified zero `googleapis`/`gstatic` references in source, `index.html`, and a production build's `dist/`; all 177 frontend unit tests pass; eslint clean on every changed line. Commit `8250556` on `dev` (local only, not pushed). Verified by: grep of source and built `dist/`, vitest, per-file eslint. Review 2026-09-01: the lint noise it reported was a config conflict, fixed in `7641db7` (which also realigned this commit's `fontFamily` block to the house quote style) — see ISSUES.md. |
| 2026-09-01 | [now-09](specs/now-09-loopback-security.md) | 🟡 Partial (phase 1/2) | Host-header allow-list (421 on a disallowed `Host`, mounted before MCP/live/API/SPA), opt-in `-allowed-hosts`/`LOGSONIC_ALLOWED_HOSTS` for non-loopback binds so Docker/LAN are unaffected by default, `Content-Security-Policy` on the HTML document only, and a JSON-only requirement on mutating `/api/v1` requests that carry a body. `docs/configuration.md` gained a "Security model" section; `docs/installation.md` notes the Docker interaction. 12 new tests in `backend/pkg/server/hostcheck_test.go`. Commits `81bbeaa` + `1842921` on `dev` (local only). **Review 2026-09-01:** the CSP's `connect-src 'self'` blocked two native-shell fetches; `1842921` adds `blob: logsonicfile:`. Verified by: Go tests; browser (embedded build in Chrome with a `securitypolicyviolation` listener: no violations during search/theme/export interactions, load-time blocks ruled out functionally since the page and histogram rendered; `blob:` confirmed failing-then-passing); **manual-pending** for `logsonicfile:` (dev app built and launched, wizard state not observable without desktop-control permission — exact step in ISSUES.md). **S7 closed 2026-09-02** by now-11 phase 2a, commit `e54a868`: `frontend/e2e-network-audit.mjs` now asserts zero `securitypolicyviolation` events via `page.addInitScript`, run against the embedded build with a negative control proving the listener fires. Open acceptance boxes: phase 2 token (v1.8; see ISSUES.md — its own acceptance criteria name `now-12`/`now-13`, both unstarted, so its "Depends on: —" in `specs/README.md` is accurate for phase 1 only), S4c Docker curl (not run, no Docker daemon on this machine). |
| 2026-09-02 | [now-07](specs/now-07-repo-hygiene.md) | 🟡 Partial (6/7 tasks) | Tasks 1–3, 5–7 done in three separable commits on `dev` (`e407e66` `%` double-decode fix; `13b3bc1` `--version` + `/info` build identity + StatusBar/About prefer the server version + Swagger regen; `aeeed47` README link, `ROADMAP.md`, `Architecture.md` removal, `go run .` doc fix; the task-6 note for `docs/installation.md` was added to `specs/macos-b3-ambient-presence.md`). Verified by: HTTP-level regression test for `%`/`%20` on the bounded search path (the legacy non-timestamp-sort path is fixed by the same edit and covered by existing storage tests, not by this test); `--version` output from a dev build and an ldflags build pasted in the commit; link check script over README/docs/ROADMAP; `.DS_Store` confirmed untracked + ignored. **Task 4 (reconcile GitHub #10) deliberately not done** — creating a public issue is an outward-facing action; exact commands in ISSUES.md for the supervisor. Note: the spec's "one commit per package" was split three ways on purpose (P1 fix, feature, docs) so the P1 is cherry-pickable. |
| 2026-09-02 | [now-11](specs/now-11-ci-quality-gate.md) | 🟡 Partial (phase 2a/2) | **Phase 1 (2026-09-02):** `.github/workflows/ci.yml` (go / web / swift / snapshot / e2e jobs), `docs.yml` + `check-links.sh`, `run-e2e.sh`, and `frontend/e2e-network-audit.mjs` (the automated proof of principle D2). Commit `0687d74` (corrected here — this row previously cited `9aa91c9`, which does not exist in this repo's history; found while amending this row for phase 2a); preceded by `13167ea` clearing the staticcheck baseline (incl. removing the deprecated spoofable `RealIP` middleware — safe because `grep -rn RemoteAddr backend/` finds no reader outside chi's request logger). Verified by: YAML parsed; **every job's commands run locally** — staticcheck/race/swag-drift/govulncheck green, vitest + coverage (48.25 % statements baseline), `test-macos-app.sh` green, `goreleaser build --snapshot --id logsonic` green, `run-e2e.sh` green (audit: 34 requests, one origin, zero off-box; smoke 30/30), `check-links.sh` 101/101. Deliberate non-blocking gates: `tsc` (415 pre-existing errors) and eslint-on-changed-files (6,272 pre-existing) report counts to the job summary. RELEASE.md §1 was also updated in `0687d74` (line 13 now describes CI in full) — unrecorded at the time; noted here so phase 2a's acceptance-box check isn't mistaken for new work. **Phase 2a (2026-09-02):** `api-types.ts` mirror check (`.github/scripts/check-api-types.mjs` + `check-api-types.test.mjs`, warn-only, wired into `ci.yml` as its own job) and the lychee external-link check (`.github/lychee.toml` + a new `external-links` job in `docs.yml`, lychee 0.24.2 pinned and downloaded as a release binary). Also closed now-09's open S7 box: `e2e-network-audit.mjs` now asserts zero `securitypolicyviolation` events via `page.addInitScript` (present before the page's own scripts run, so load-time CSP blocks count too, not just interaction-time ones) — the pre-existing `page.on('request')` audit can't see a request the CSP blocked before it reached the network layer. Commit `e54a868`; preceded by two separate safe-fix commits found while building the checks — `347136a` (5 pre-existing Go↔TS field-mirror gaps: `ParseRequest.multi`, `AutosuggestResult.{coverage,timestamp_field,timestamp_layout,timestamp_source}`) and `ffd4643` (dead link `signpath.org/foundation` → `signpath.org` in `RELEASE.md`, found by lychee). Verified by: `node --test check-api-types.test.mjs` 5/5; `node check-api-types.mjs` 129/129 fields present; `lychee` 152 OK / 0 errors / 5 excluded against the same file set `check-links.sh` uses; `check-links.sh` 108/0 (unaffected); vitest 191/191 unchanged; tsc 415 unchanged baseline; eslint zero errors on every added line in both touched frontend files (verified by re-running eslint correctly rooted in `frontend/` — an earlier run from the wrong cwd had shown spurious no-undef errors on lines using `document`/`window`, which was a mistake in how the check was invoked, not a real regression); `actionlint` clean on `docs.yml` (`ci.yml`'s one hit is pre-existing, a line not touched here); embedded build + live server + `e2e-network-audit.mjs`: 34 requests, one origin, zero CSP violations, **plus a negative control** (a throwaway script forcing `fetch('https://example.com/')` against the same live server produced exactly one `connect-src` violation event, proving the new listener actually fires rather than being a silent no-op). **Workflows still unexecuted** — nothing is pushed; first run needs a push or PR (ISSUES.md). **Phase 2b not started, deliberately deferred (see commit `e54a868` for the reasoning):** nightly bench harness + `nightly.yml` (needs a 10M-line corpus generator and the §8 scenario runner — sized as its own package); the doc-command executor (`docs/development.md`'s `go run .` / `npm run dev` commands are long-running servers, so "execute them" needs a start→probe→kill design, not a tiny script). The "lint-delta gate" item from this row's previous draft is dropped — it was never in the now-11 spec. **Test table (phase 2a):** Q4 verified directly — a scratch copy of `types.go` with an added `zz_probe` field produced the `::warning::` line (with `GITHUB_ACTIONS=1`) and the plain form (without), exit 0 both times, confirming the warn branch isn't dead code. Q6 external half: lychee's failure path was seen for real before the two fixes (the 404s this session fixed), and is 0-error/exit-0 after; the relative-link half of Q6 is phase 1. Q2 CSP half: covered by the negative control described above; the request-audit's own non-loopback-request exit path (`page.on('request')`) was not re-exercised this session — that half's phase-1 verification stands. Q1/Q3/Q7 remain phase-1 claims pending an actual CI run (nothing pushed). Q5 is phase 2b (bench harness not built). |
| 2026-09-02 | [now-08](specs/now-08-native-path-import.md) | 🟡 Partial (phase 1/~4) | Backend-only: `POST /api/v1/ingest/file` reads a file by absolute path (gzip/zstd sniffed by magic bytes, rotated sets oldest-first via `include_rotated`) and stores it through the same `ingestBatch` pipeline the chunk-upload route uses, so the two routes are byte-identical (parity-tested). Synchronous in this phase — 200 with totals when done — registered outside the API timeout group next to `/live/stdin` so a large file doesn't 504; the spec's async job + SSE progress model is phase 2. `Config.WorkDir` (dead) deleted per spec. New `pkg/ingestfile` package has no HTTP imports, as required, for `now-04`/`now-12` to reuse. Commit `3ce78bc`. **Found uncommitted in the tree at pickup** — the implementation (reader package, handler, tests, the spec's own phase-split note) was already present with no TBD/ISSUES row and no commit; authorship isn't verifiable from the repo. Reviewed line-by-line, verified, and completed rather than discarded — see the commit message for the full disclosure. Two bugs found and fixed during that review: `api-client.ts`'s `ingestFile()` posted to a nonexistent `/ingestFile` route typed as the wrong response (live tsc error, confirmed by baseline diff: 416 vs. 415); and the new route sat outside the now-09 JSON-only CSRF middleware, reachable via a cross-origin `text/plain` form post with no preflight — fixed by applying `requireJSONBody` to the route directly and reordering session validation before the filesystem is touched (closes a secondary path-existence oracle). Verified by: `go build/vet/test/test -race` all green from `backend/`; `gofmt -l` clean; `go mod tidy` no-op; `swag init` re-diffed against committed docs, byte-identical; `npx vitest run` 191/191 unchanged; `npx eslint` on touched files, zero errors on touched lines (30 pre-existing baseline elsewhere); `npx tsc -b` back to the 415-error baseline. Test-table coverage: R1–R9 (`pkg/ingestfile`) and H2/H4 (handler parity + rotation/errors) all green. **Deferred (phase 2+, per spec's own phase split):** H1/H3/H5/H6/H7/H8 (job registry, SSE `ingest_progress`, cancellation, memory-at-scale, server-shutdown, Windows-path CI, `POST /parse/preview-file`), the macOS shell path handoff (`deliverNativePaths`, dropping the 512 MB cap and extension guard), wizard UI wiring to call the new endpoint, and the docs updates in spec step 6 (`docs/getting-started.md`, `docs/configuration.md`, `docs/live-streaming.md`) — none currently mention this endpoint, so nothing is stale. Native app drops are unaffected; `logsonicfile://` still handles them exactly as before. |
| 2026-09-02 | [now-02](specs/now-02-faceted-fields-sidebar.md) | 🟡 Partial (phase 2/3) | **Phase 2 (2026-09-02):** Fields panel shipped — third sidebar tab + rail entry, top-5/8 values with counts and bars, click → `+field:"value"`, ⌥-click → `-field:"value"`, second click removes, polarity switch replaces the twin; caption states coverage and sampling; unqueryable field names render non-clickable. `lib/query-clauses.ts` (14 unit tests), `useFacetStore`, `refreshSearchMetadata()` extracted from `useSearchLogs` so facets ride the deferred request only while the panel is open. Verified by: vitest 191/191; new self-seeding `e2e-facets.mjs` 10/10 on the dev split and via `run-e2e.sh` against a fresh embedded build (now part of the CI e2e job); smoke 30/30; tsc unchanged; lint delta zero except one added import in `SidebarPanel.tsx`'s pre-rule import block. Remaining (phase 3): `facets_only` for MCP (`next-05` handoff), latency budget at 100k+ rows, `_src` counts from the catalog after `now-10`. **Phase 1:** Backend: `include_facets=true` on `GET /api/v1/logs` returns the field/value summary (`computed_over`, `sampled`, per-field distinct + top-8 values, caps per spec) via a bounded 20k-row scan in `storage.Facets` — a recorded deviation from the spec's fan-out assumption, since the live `SearchPage` path only yields one page. DTOs in `pkg/types` + `api-types.ts`, Swagger regenerated, `mcp/SKILLS.md` documents the param. Commit `55975d1`. Verified by: storage unit tests B1–B8 + small-window + multi-batch exactness; HTTP tests H1/H2 (off path byte-equal modulo timings, no `facets` key)/H3; `go test -race`; BGL sample timing 5 ms → 13 ms — but that sample is 2k rows, not large (the spec and `specs/README.md` mislabelled it), so the spec's ≤20 % latency budget is untested at scale; phase 2 measures at 100k+ rows. Known trade-off: the scan holds the storage read lock for its whole duration (commented in `facets.go`; lease-per-batch queued for `next-10`). **Found and logged:** `SearchPage` duplicates rows at search-after seams when ≥50 rows share a timestamp (reproducer skipped in `search_page_seams_test.go`, ISSUES.md). Phase 2 not started: `useFacetStore`, `FieldsPanel.tsx`, rail entry, the Bleve value-escaping helper + tests, E2E `e2e-facets.mjs`, `facets_only` for MCP. |

## Revision 2 changelog (2026-09-01)

What changed versus revision 1, and why. Everything below is grounded in a read of the current code, not in general product taste.

- **§2 defects grew from 3 to 11.** New, code-verified findings: an unauthenticated loopback API with no Host-header check (DNS-rebinding exposure, P0), queries containing `%` are mangled by a double URL-decode (P1), non-timestamp sorts still fall back to a search path that materializes up to 1M documents per day-index (P1), corrupt day-indices are skipped silently at startup (P1), the source list is computed by scanning up to 1M documents per index (P2), no `--version` flag, window frame not persisted, and a stale claim in the macOS Bundle 2 spec (document types and native open panels *already exist*).
- **New §3 "Desktop-first principles"** — eight measurable principles that define what "world-class desktop-first" means for this product, so every later item can be judged against them.
- **Now horizon split into v1.7 and v1.8** (six work packages each) — revision 1 had seven Now items for a solo maintainer and was about to grow to thirteen. Distribution parity, ⌘K, folder watch, and repo hygiene beyond the trust fixes moved to v1.8. **New Now items:** native path-based import with compressed-file support (the 512 MB dock cap and browser-mediated upload are the biggest desktop-first gap), loopback security hardening, a sources catalog with per-source management, a CI quality gate, a `logsonic open` CLI verb plus bundled sample data for first-run, and a diagnostics/doctor command.
- **New Next items:** log reader mode (keyboard navigation, context view, wrap, copy/export formats), query-bar UX (AND-default as an explicit `default_operator` parameter, inline parse errors, field/value autocomplete), storage engine hardening (lazy index open, idle close, cursor-paged sort on any field, index migration versioning), and an opt-in update check (the one sanctioned network call).
- **New §8 performance budgets, §9 trust & security model, §10 engineering quality gates.** Budgets are provisional until the bench harness records a baseline.
- **§7 macOS spec corrected:** the "already native" list now credits document-type association, native open/save panels via `WKUIDelegate`, the single-instance lock, and Reveal-in-Finder; Bundle 2 is re-scoped to what is actually missing.
- Spec count in `specs/` grows from 18 to 28; stale anchors fixed (Go version, `go run main.go`, dead `IngestFileRequest`/`ingestFile()` code claimed by the path-import spec).

---

## Table of contents

1. [Current state (v1.6)](#1-current-state-v16)
2. [Known defects found during review](#2-known-defects-found-during-review)
3. [Desktop-first principles](#3-desktop-first-principles)
4. [Product-market fit thesis](#4-product-market-fit-thesis)
5. [Roadmap — three horizons](#5-roadmap--three-horizons)
6. [Feature backlog by theme](#6-feature-backlog-by-theme)
7. [UI refinement spec](#7-ui-refinement-spec)
8. [Performance budgets](#8-performance-budgets)
9. [Trust & security model](#9-trust--security-model)
10. [Engineering quality gates](#10-engineering-quality-gates)
11. [macOS native adaptation spec](#11-macos-native-adaptation-spec)
12. [Explicit non-goals](#12-explicit-non-goals)
13. [First five moves](#13-first-five-moves)

---

## 1. Current state (v1.6)

A strong base to build on:

- **Backend:** single Go binary (Go 1.26) — chi/v5 router, Bleve full-text index (scorch, one index per calendar day), Grok auto-detection via log2grok, CloudWatch import (AWS SDK v2), bounded/cancellable large-file imports (16 MB / 10k lines per request, 2 MB per line), multiline folding, smart timestamp resolution, bounded search-after paging on timestamp with facet-computed histograms, retention by age (CLI flag only).
- **Frontend:** React 18 + TypeScript + Vite + Zustand + Radix UI + Tailwind + Recharts; v2 shell (left rail, status bar, `--ls-*` design-token system), workspaces, color rules, event histogram, JSONL export, dark/light themes, virtualized long tables, per-file import wizard with timestamp preview.
- **Live tail:** `logsonic tail` from stdin or server-side files, pause/resume of the browser feed while indexing continues in the background.
- **AI:** MCP server (Streamable HTTP at `/mcp` + stdio subcommand) for Claude / Cursor / Windsurf with 11 tools + agent playbook (`mcp/SKILLS.md`).
- **macOS:** signed, notarized, stapled universal `Logsonic.app` — AppKit shell (`backend/macos/LogsonicApp.swift`, ~1,000 lines) hosting the embedded UI in a WKWebView; child-process server lifecycle with SIGINT → SIGTERM → SIGKILL escalation; single-instance lock; dock drag-drop and Finder "Open With" import (512 MB guard via `NativeFileSchemeHandler`); native open/save panels; blob-download interception; open-in-browser escape hatch; server-log console; automatic loopback port selection; Reveal Index in Finder. Distributed via Homebrew cask.

**Engineering-quality snapshot (verified 2026-09-01):** 14 Go test files, 10 vitest files, three ad-hoc Playwright-style `.mjs` E2E drivers, **no CI workflows** (`RELEASE.md` §1 says so itself), releases run manually from a dev machine via `backend/scripts/release.sh`. Bench: one Go benchmark for index size amplification. No `--version` flag.

**Issue tracker status (verified 2026-09-01):** zero open issues. All historical asks shipped (mass import #15, pattern saving #16, Homebrew #1, Docker build #30, multiline #28, import progress #19) — **except #10 (field extraction), which was closed but never shipped.** See §2. Issue #17 ("doesn't work", screenshots only) is the archetype the diagnostics work in §5 exists to prevent.

## 2. Known defects found during review

Severity: **P0** breaks a headline promise; **P1** wrong or unbounded behavior a user will hit; **P2** friction or stale state. "Verified" = reproduced in this session; "code-read" = established from the source without executing.

| Pri | Defect | Detail |
|-----|--------|--------|
| **P0** | Google Fonts import breaks the core promise | `frontend/src/index.css:1` does `@import url('https://fonts.googleapis.com/...')` for Geist / Geist Mono. This contradicts the README headline "No telemetry. No cloud. No network calls.", fails a packet-capture audit, and silently degrades typography offline — including inside the native WKWebView. Fix: self-host the font files (vendored woff2 + `@font-face`) **or** adopt the platform system stack (recommended; see §7). Spec `now-01`. |
| **P0** | Unauthenticated loopback API has no Host-header check (DNS-rebinding exposure) | `backend/pkg/server/server.go` binds `127.0.0.1` and restricts CORS to `http://localhost:*` / `http://127.0.0.1:*` — which blocks the *naive* cross-origin read. But CORS does not protect against **DNS rebinding**: a page on `attacker.example` whose DNS flips to `127.0.0.1` is served *same-origin* on the guessable port range (8080–8179, auto-port), and can read every search result, workspace, and `/mcp` tool without CORS ever applying. Nothing validates `r.Host`. Persona 1 (regulated / air-gapped) will fail an audit on this. Fix (S): a Host allow-list middleware (`localhost`, `127.0.0.1`, `[::1]`, with the bound port) returning 421 for everything else, applied to `/api`, `/mcp`, and the SPA; opt-in via `-allowed-hosts` for non-loopback binds so the Docker image (`HOST=0.0.0.0`) keeps working. Follow-up: a per-launch bearer token minted by the native shell / CLI (§9). Code-read. Spec `now-09`. |
| **P1** | Queries containing `%` are mangled | `storage/search.go` and `storage/search_page.go` (`buildPageQuery`) call `url.PathUnescape` on a query string that `net/http` has **already decoded**. Verified at the storage layer: `message:"100%"` → `invalid URL escape "%\""`, which `HandleReadAll` maps to **HTTP 500** (`invalid query encoding`); `cpu:>95%` → same; `message:"a%20b"` silently becomes `message:"a b"`. Fix: delete the unescape (chi/net-http already decoded the param); add a regression test with `%` literals. Spec `now-07` (hygiene) carries the one-line fix; `next-09` (query UX) carries the inline error surfacing. |
| **P1** | Non-timestamp sorts fall back to full materialization | `handlers/logs.go:230` uses the bounded `SearchPage` only when `sort_by == "timestamp"`; any other sort calls legacy `storage.Search()` (`search.go:42`), which requests `Size = 1_000_000` with `Fields = ["*"]` per day-index, parses every timestamp with `dateparse.ParseAny`, merges everything in memory, then paginates in the handler. Clicking a column header to sort on a 10M-row corpus is an OOM path. Code-read. Fix: cursor-paged sort on any stored field in `SearchPage` (timestamp + `_seq` + doc-ID tie-breakers) and delete `Search()`. Spec `next-10`. |
| **P1** | Corrupt or version-incompatible day-indices vanish silently | `storage/storage.go:75` — `NewStorage` does `continue // Skip this index if it can't be opened` with no log line, no UI signal, no count mismatch surfaced. A user whose Tuesday index failed to open sees Tuesday's logs disappear and has no way to learn why. Code-read. Fix: record open failures in a startup report, surface them in `/info` + StatusBar, and give `logsonic doctor` a repair/quarantine path. Spec `now-13`. |
| **P1** | Dead README link | README links `docs/production-readiness-plan.md`, which does not exist anywhere in git history (never committed). Remove the link or commit the doc. Spec `now-07`. |
| **P2** | Issue #10 closed but unshipped | The Splunk-style field-extraction / faceted-sidebar feature was closed with "will keep you posted" but no facets panel exists in the frontend (`components/Home/Sidebar/` contains only `ColorRulesPanel.tsx`). Anyone checking the tracker believes it exists. Reopen it or ship it (§5, v1.7). Spec `now-02`. |
| **P2** | Source list is computed by scanning documents | `storage/search.go` `GetSourceNames()` runs `_src:*` with `Size = 1000000` on **every** index and collects hits — O(total docs) per `/info` cache miss, and the cache is invalidated at six call sites (every ingest end, clear, delete). On a 10M-row corpus the status bar's "N sources indexed" costs a full scan after every import. Fix: a persisted sources catalog. Spec `now-10`. |
| **P2** | No `--version` flag | goreleaser injects `main.version`/`commit`/`date` via ldflags but `main.go` never reads them; `logsonic --version` prints the usage error. winget validation and bug reports both need it. Spec `now-05` already lists it; `now-13` (doctor) consumes it. |
| **P2** | Native window frame and state not persisted | `LogsonicApp.swift` `buildWindow()` creates a 1280×800 centered window every launch — no `setFrameAutosaveName`, no restore of the last workspace/query. A Mac app that forgets its window is the first thing a user notices. Spec `macos-b1` (one line) + `next-08` (session restore). |
| **P2** | Stale spec claims about the macOS shell | Revision-1 `macos-b2` said file-type association and native open panels were missing. They exist: `Info.plist` already declares `CFBundleDocumentTypes` for `public.log` / `public.plain-text` / `public.json`, `application(_:openFiles:)` is implemented, and `runOpenPanelWith` already gives every HTML file input a native `NSOpenPanel`. What is actually missing: `.gz` / `.jsonl` / `.ndjson` UTIs, the hard-coded `["log","txt","json"]` extension guard in `openNativeFiles`, a Services entry, Open Recent, and a **path-not-bytes** bridge so dropped files are read by the server instead of round-tripped through the webview. Fixed in this revision; see §11. |

Also noted (not defects, but confusing): `NewStorage` passes a LevelDB `kvConfig` (`block_size`, `write_buffer_size`, `bloom_filter_bits_per_key`, `compression`) to `bleve.NewUsing(..., "scorch", goleveldb.Name, ...)`; scorch has its own segment format and reads only scorch-specific keys from that map, so the LevelDB keys and the `goleveldb` import are dead — `next-10` drops them. `server.Config.WorkDir` is populated in `main.go` and never read. `docs/Architecture.md` is a stub that predates workspaces, live tail, and the native app; `docs/System_Architecture.md` is the real one — `now-07` reconciles them.

## 3. Desktop-first principles

"Desktop-first" is not "we have a Mac app." It is a set of promises a user can feel in the first minute and rely on for years. Every roadmap item below cites the principle it serves. These are the bar for "world-class"; §8–§10 make them measurable.

| # | Principle | What it means concretely | Where it is honored |
|---|-----------|--------------------------|---------------------|
| **D1** | **The file is already here.** | The log is on the user's disk. Never round-trip bytes through a browser, a JSON encoder, or a 512 MB memory buffer to reach a server sitting on the same machine. Import by *path*; support the formats disks actually hold (`.gz`, rotated `app.log.1`, `.jsonl`). A 3 GB dump is a normal Tuesday. | `now-08` native path import; `now-04` folder watch; `macos-b2` path bridge |
| **D2** | **Private by construction, not by promise.** | Zero non-loopback network calls, verified by an automated test, not a README sentence. The loopback server is hardened against the attacks loopback servers actually face (DNS rebinding, other local users). The one sanctioned exception (update check) is opt-in and visibly labeled. | `now-01`, `now-09`, `next-11`, §9 |
| **D3** | **Instant, then correct.** | Cold launch to interactive UI under 1.5 s; first rows of a dropped file visible within seconds while the rest indexes; every search bounded so nothing can OOM the machine. Perceived speed *is* the aesthetic. | §8 budgets; `next-10` storage hardening; existing bounded paging |
| **D4** | **Keyboard-complete.** | A whole investigation — import, search, filter, inspect, copy, export — without touching the mouse. `⌘K` for commands, `/` for search, `j/k/↑/↓` for rows, `Enter` to inspect, `⌘C` copies the row as text, `⌘⇧C` as JSON. | `now-06` palette; `next-08` reader mode; `macos-b2` menus |
| **D5** | **Native where it shows, shared where it doesn't.** | Titlebar, menus, shortcuts, file dialogs, notifications, window memory, dock badge, Services — native. Business logic, rendering, and state — one web codebase. The `__LOGSONIC_NATIVE__` contract is the seam. | §11 bundles; `L5` other shells |
| **D6** | **Remembers everything you did, forgets nothing you own.** | Relaunch restores the window, the workspace, the query, the sidebar width. Data never disappears silently: a corrupt index is reported, not skipped; deleting a source is an explicit, reversible-looking action with a confirm. | `next-08` session restore; `now-13` doctor; `now-10` sources |
| **D7** | **A CLI citizen, not just a GUI.** | `logsonic open app.log`, `tail -f x \| logsonic tail -`, `logsonic doctor`, `logsonic --version`. Developers live in terminals; the app should be one verb away from wherever they are. | `now-12` CLI open; `now-13` doctor; `now-05` `--version` |
| **D8** | **Explainable when it fails.** | Every error names the file, line, pattern, or field it choked on and what to do next. A "doesn't work" bug report should be impossible to file without a diagnostics bundle one click away. | `now-13` diagnostics; `next-09` inline query errors; §10 |

## 4. Product-market fit thesis

### The wedge

LogSonic's own README comparison table tells the story: **no other tool combines fully-local + real GUI + indexed full-text search + MCP access for AI agents.**

- lnav — local + indexed, but terminal-only, no MCP.
- Logdy — local GUI, but no indexing, no MCP.
- GoAccess — web logs only.
- Datadog / ELK — not local, heavy.

That four-way intersection is the wedge, and the **MCP corner is appreciating fastest** because agentic debugging is becoming the default developer workflow.

### Personas

1. **The constrained engineer** — regulated / air-gapped environments where logs legally cannot leave the machine. Pays for certainty; needs "no network calls" to be literally true (hence the two P0s above) and needs the loopback server to survive a security review (§9).
2. **The AI-native developer** — runs Claude Code / Cursor all day and wants agents to read local logs during debugging. LogSonic is the context provider. Fastest-growing persona.
3. **The incident triager** — SRE / backend engineer handed a 3 GB log dump at 2 a.m. Wants answers without standing up ELK. Arrives via search / package manager, judges the product in the first 60 seconds. **Today this persona cannot drop that 3 GB file on the dock at all** (512 MB cap) — D1 is their principle.

### The honest PMF risk: retention

Log triage is episodic. People install LogSonic during an incident, are delighted, then forget it exists until the next one — a painkiller with no daily habit. The roadmap answers this directly:

- Every horizon includes at least one **ambient-value feature** that keeps LogSonic running and useful *between* incidents: folder watch (v1.8), watchers/notifications + menu-bar tail heartbeat (Next), metrics-from-logs dashboard (Later).
- MCP usage is inherently ambient — an agent that queries logs daily keeps the product alive even when the human forgets it.
- `logsonic open <file>` (v1.8) makes the app the muscle-memory destination for *every* log a developer opens, not only incident dumps.

### North-star metrics

| Metric | Target | What it measures |
|--------|--------|------------------|
| Time to first search | < 60 s from app open to first result on the user's own file; < 15 s with bundled sample data | Activation; onboarding quality |
| Weekly active investigations | Sessions with ≥ 1 query over the user's own data | Retention; the ambient features exist to move this |
| MCP queries / week | Agent-originated searches | Wedge depth — the differentiator being *used*, not just admired |
| Diagnostics-bundle attach rate on bug reports | > 80 % of issues include `logsonic doctor` output | Supportability for a solo maintainer (D8) |

## 5. Roadmap — three horizons

### NOW — v1.7 (0–6 weeks) · theme: trust, fields, the file is already here

Six work packages, ordered by pickup. Everything here either repairs a promise or removes the largest desktop-first gap.

Specs: [trust sprint = fonts](specs/now-01-self-hosted-fonts.md) + [loopback security](specs/now-09-loopback-security.md) + [hygiene](specs/now-07-repo-hygiene.md) · [CI gate](specs/now-11-ci-quality-gate.md) · [facets](specs/now-02-faceted-fields-sidebar.md) · [native path import](specs/now-08-native-path-import.md) · [saved queries](specs/now-03-saved-queries-history.md) · [macOS B1](specs/macos-b1-visible-nativeness.md)

| Pri | Item | Detail | Principle |
|-----|------|--------|-----------|
| P0 | **Trust sprint** (three S items, one PR-week) | (a) Self-host fonts / system stack — the one-line trust fix (§2). (b) **Loopback security**: Host allow-list middleware on `/api`, `/mcp`, and the SPA; a `Content-Security-Policy` header for the embedded UI; a regression test that a request with `Host: evil.example` gets 421. (c) **Hygiene**: dead README link, the `%` double-decode fix (`url.PathUnescape` removal + test), reconcile #10, `--version`, Go-version and `go run main.go` doc fixes, publish `ROADMAP.md`, reconcile the two architecture docs. | D2, D8 |
| P0 | **CI quality gate** | GitHub Actions: Go tests + `go vet` + `staticcheck`, vitest + eslint + `tsc --noEmit`, Swift shell compile check on a macOS runner, goreleaser snapshot dry-run, **an automated "zero non-loopback requests" test** on the embedded build (Playwright request interception — replaces now-01's manual DevTools step), and one E2E smoke (import sample → search → export). Required on PRs to `main`. Baseline coverage is *recorded*, not invented, then ratcheted. | D2, §10 |
| P0 | **Field extraction & faceted sidebar (ship #10)** | Splunk-style panel: every parsed field listed with top values + counts; click a value to filter, alt/right-click to exclude. Computed over the bounded result window (decision recorded in the spec; whole-corpus facets are charter L6). Reads `_src` values from the sources catalog once `now-10` lands. | D4 |
| P0 | **Native path-based import + compressed files** | The server ingests a file **by absolute path** (`POST /api/v1/ingest/file` — claims the dead `IngestFileRequest` type and the unrouted `ingestFile()` client call): streamed from disk, no JSON chunking, gzip (`.gz`) and zstd (`.zst`) detected by magic bytes, rotated-file globs (`app.log`, `app.log.1`, `app.log.2.gz`) ingested as one source in the right order, progress over SSE, cancellable. The macOS shell passes **paths** (not `logsonicfile://` bytes) for dock drops, Finder "Open With", and `NSOpenPanel` picks, which retires the 512 MB cap and the whole-file `Data(contentsOf:)` read. The browser-upload path stays for the browser UI. Owns the shared server-side file reader (`pkg/ingestfile`) that folder watch (`now-04`) and `logsonic open` (`now-12`) reuse. | **D1**, D3 |
| P1 | **Saved queries + query history** | ↑/↓ recall in the search bar, star-to-save, persisted in the workspace (Zustand store + existing workspace persistence). Cheap; converts one-off users into returning ones. | D4, D6 |
| P1 | **macOS Bundle 1 — visible nativeness** | Unified titlebar, native-detection contract, follow-system appearance with no white flash, **window frame autosave** (`setFrameAutosaveName`, one line, added in this revision). Shell + CSS only. | D5, D6 |

### NOW — v1.8 (6–14 weeks) · theme: habit, sources, the CLI citizen

Specs: [sources catalog](specs/now-10-sources-catalog.md) · [folder watch](specs/now-04-folder-watch.md) · [⌘K palette](specs/now-06-command-palette.md) · [CLI open + sample data](specs/now-12-cli-open-and-sample-data.md) · [diagnostics / doctor](specs/now-13-diagnostics-doctor.md) · [distribution](specs/now-05-distribution-parity.md)

| Pri | Item | Detail | Principle |
|-----|------|--------|-----------|
| P1 | **Sources catalog & management** | A persisted `<storage>/sources.json` maintained at ingest/tail/watch time: per source — name, origin (file path / stdin / watch / OTLP), pattern used, row count, first/last timestamp, bytes, imported-at. Replaces the 1M-doc `GetSourceNames()` scan (§2). New **Sources panel** in the left rail: list with counts and provenance, **delete a single source** (delete-by-`_src` per day-index, with confirm + row count), re-import from origin path, rename. Feeds StatusBar, `_src` facets, MCP `log_info`. Also the home of a **Storage settings page**: retention days (currently CLI-only), per-day sizes, delete a day, Reveal in Finder. | D6, D8 |
| P1 | **Folder watch / auto-ingest** | Point LogSonic at `~/logs` or `/var/log`; new and changed files auto-ingest with the saved Grok pattern (fsnotify + reconciliation sweep; initial ingest via `pkg/ingestfile`, growth via the live-tail follower). First ambient-value feature — the reason the app stays running. Native folder picker already works via `runOpenPanelWith`. | D1, D6 |
| P1 | **`logsonic open` + bundled sample data** | `logsonic open <file...> [--tail] [--pattern NAME]` hands paths to the running instance (or launches it) and focuses the window — the lnav-style one-verb entry from any terminal. First-run empty state gains **"Try with sample logs"** (one click imports a bundled, license-clean sample so the product proves itself in 15 s), alongside drop-a-file / tail / connect-an-agent. Uses `pkg/ingestfile`. | **D7**, D3 |
| P1 | **Diagnostics & `logsonic doctor`** | `logsonic doctor` (and Settings → About → "Copy diagnostics"): version/commit/OS/arch, storage path + sizes, index open report (**surfaces the silently-skipped indices from §2**), port/bind status, Host-check status, last 200 server-log lines, pattern catalog summary — redacting paths on request. Startup index failures also appear as a StatusBar warning with a "details" link. Issue template asks for the bundle. | **D8**, D6 |
| P2 | **⌘K command palette** | Sources, saved queries, actions (import, export, theme, density), search history in one surface (cmdk is already a dependency). The search bar already advertises ⌘K — make it the app's spine. Action registry is shared with native menus (Bundle 2). | D4 |
| P2 | **Distribution parity** | Homebrew is done. Add winget + Scoop (Windows), deb/rpm/AUR (Linux). goreleaser is already in place, so each is mostly packaging config. `--version` from the trust sprint is a prerequisite. | D7 |

### NEXT — v2.x (3–9 months) · theme: every log's local destination

Specs: [OTLP](specs/next-01-otlp-ingest.md) · [containers](specs/next-02-container-sources.md) · [patterns](specs/next-03-pattern-clustering.md) · [watchers](specs/next-04-watchers-notifications.md) · [MCP depth](specs/next-05-mcp-depth.md) · [compare](specs/next-06-compare-mode.md) · [case files](specs/next-07-case-files.md) · [reader mode](specs/next-08-log-reader-mode.md) · [query UX](specs/next-09-query-bar-ux.md) · [storage hardening](specs/next-10-storage-engine-hardening.md) · [update check](specs/next-11-update-check.md)

| Pri | Item | Detail | Principle |
|-----|------|--------|-----------|
| P0 | **OTLP log ingest endpoint** | Accept OpenTelemetry logs (OTLP/HTTP JSON + protobuf) on the loopback port at the standard `/v1/logs` path. Every modern stack emits OTel; LogSonic becomes the zero-config local OTel sink for development. **The strategic bet of the year** — moves LogSonic from "file tool" to "destination." Map OTel resource/attributes onto the existing field model; severity → level; trace_id/span_id stored for later correlation. | D1 |
| P0 | **Log reader mode** | The `less`/lnav half of the product the table lacks: **keyboard row navigation** (`j/k/↑/↓`, `Enter` inspects, `⌘↑/↓` first/last, `n/N` next/prev match), **context view** ("show 50 lines around this row" in original `_seq` order for its `_src`, regardless of the current filter — the eternal "what happened just before this?" question), **wrap toggle**, **row inspector** replacing accordion rows, **copy actions** (row as text / JSON / all selected as Markdown table) and **export formats** (CSV, JSONL, Markdown — today JSONL only), plus **session restore** (last workspace/query/sidebar on relaunch). | **D4**, D6 |
| P1 | **Storage engine hardening** | Lazy index open + LRU idle-close (a two-year syslog archive opens 700 indices at startup today), startup-time budget, **cursor-paged sort on any field in `SearchPage` and deletion of legacy `Search()`** (§2 P1), index-format version file + migration runner (the code already special-cases "legacy shards"), removal of dead LevelDB config, crash-safety test (`kill -9` mid-batch → reopen → counts consistent), atomic writes for every JSON state file. | D3, D6 |
| P1 | **Query-bar UX** | AND-default for bare terms exposed as an explicit `default_operator=and|or` request parameter (UI defaults to `and`, MCP keeps `or` unless the agent asks — no silent server rewrite; `mcp/SKILLS.md` documents the parameter), **inline parse errors** (Bleve's message rendered under the bar, with the offending span highlighted), **field-name and value autocomplete** fed by the facets endpoint, and a Bleve-escaping helper shared with facets. Stays inside the "no new DSL" non-goal: these are ergonomics for the existing syntax. | D4, D8 |
| P1 | **Container sources** | First-class `docker logs` / `kubectl logs` following with per-container source labels — extends the existing tail architecture. The modern equivalent of tailing a file; where Persona 3 actually lives. | D1 |
| P1 | **Pattern clustering (Drain-style template mining)** | "3,000,000 lines → 42 patterns," sorted by novelty/count, with drill-down to matching rows. New backend package + a Patterns tab in the UI. Kills the large-dump problem, and is the perfect MCP tool (`get_log_patterns`) for agents that can't read 3M lines. | D3 |
| P1 | **Watchers & local notifications** | "Notify me when `level:error` matches during tail." Query-evaluated-on-tail + native notification bridge (macOS: `UNUserNotificationCenter` + dock badge, §11). Second ambient-value feature. | D5, D6 |
| P1 | **MCP depth** | Aggregation tools (count-by-field, histogram, top-K), `get_log_patterns`, saved queries exposed as MCP resources, an `investigate` prompt template. Goal: the best log backend an agent has ever had. | — |
| P2 | **Opt-in update check** | The one sanctioned network call: off by default, a visible toggle in Settings and in the native app menu ("Check for Updates…"), a single GET to the GitHub Releases API, no identifiers sent, result shown in-app with the `brew upgrade` / download command. Precedes any Sparkle decision. | **D2** |
| P2 | **Compare mode** | Diff two time ranges or two sources: what appeared, what disappeared, what changed frequency. "What's different about today?" is the eternal incident question. | — |
| P2 | **Case files** | Export an investigation — filtered logs, queries, annotations, histogram state — as a single shareable bundle another LogSonic instance can open. Sharing without a server. | D6 |

### LATER — v3 (9–24 months) · theme: teams & sustainability

Charters (pre-spec): [specs/later-charters.md](specs/later-charters.md)

| Pri | Item | Detail |
|-----|------|--------|
| BET | **Team edition (open-core)** | Self-hosted shared instance: auth, shared workspaces and case files, retention policies, maybe SSO. The free single-user app is the funnel; the team server is the business. Local-first stays sacred — "self-hosted," never "our cloud." The per-launch token from §9 is the seed of its auth story. |
| BET | **Metrics-from-logs** | Derive counters and rates from queries ("5xx per minute"), pin them to a small always-on dashboard. Third ambient feature; makes LogSonic glanceable daily, not just searchable during incidents. |
| P2 | **Trace correlation** | When a `trace_id`-shaped field exists, one click links all rows of the trace across sources. Cheap once OTLP ingest exists. |
| P2 | **Parser/source plugin system** | Community-added sources (journald, syslog listeners, S3) and exotic formats without forking. Solo-maintainer leverage. |
| P2 | **Windows & Linux native shells** | Port the macOS AppKit-shell pattern (WebView2 on Windows, WebKitGTK on Linux) once macOS proves the native experience matters. The `__LOGSONIC_NATIVE__` contract is formalized first. |
| P2 | **Whole-corpus facets** | Keyword sub-fields + reindex migration, only if window-scoped facets prove insufficient (charter L6). Depends on the migration runner from `next-10`. |

## 6. Feature backlog by theme

Effort is relative to the current codebase: **S** ≈ days, **M** ≈ 1–2 weeks, **L** ≈ a month+ of solo time.

| Feature | Theme | Effort | Impact / implementation note | Horizon |
|---------|-------|:------:|------------------------------|:-------:|
| Self-hosted fonts | Trust | S | Credibility of core promise; one CSS change (system stack) | v1.7 |
| Loopback security (Host allow-list, CSP) | Trust | S | Closes DNS rebinding; audit-passable loopback server | v1.7 |
| Repo hygiene incl. `%` query fix, `--version` | Trust | S | Correctness + supportability | v1.7 |
| CI quality gate + network-audit test | Quality | S–M | Protects every later item; automates the "no network calls" proof | v1.7 |
| Faceted fields sidebar | Analysis | M | Top historical ask; window-scoped aggregation + new rail panel | v1.7 |
| Native path import + gz/zst + rotated files | Ingestion | M | Retires the 512 MB cap; 3 GB dumps become normal; shared file reader | v1.7 |
| Saved queries + history | Analysis | S | Habit formation; Zustand + workspace persistence | v1.7 |
| macOS B1 + window autosave | Native | M | Highest polish-per-hour in the codebase | v1.7 |
| Sources catalog + Sources panel + Storage settings | Data mgmt | M | Kills the doc scan; per-source delete; retention in the UI | v1.8 |
| Folder watch / auto-ingest | Ingestion | M | Ambient value; fsnotify + shared reader + tail follower | v1.8 |
| `logsonic open` + sample data | CLI / onboarding | S | Terminal muscle memory; 15-second first value | v1.8 |
| Diagnostics + `logsonic doctor` | Support | S–M | Surfaces skipped indices; makes "doesn't work" reports actionable | v1.8 |
| Command palette (⌘K) | UI | M | Keyboard-first triage; shared action registry | v1.8 |
| winget / Scoop / deb / rpm / AUR | Distribution | S–M | Discovery on non-Mac platforms; goreleaser already in place | v1.8 |
| OTLP log ingest | Ingestion | M | Strategic: file tool → destination | Next |
| Log reader mode (keyboard, context, copy/export, restore) | UI | M | The `less` half of the product; D4/D6 | Next |
| Storage engine hardening | Storage | M | Lazy open, any-field cursor sort, migrations, crash safety | Next |
| Query-bar UX (default_operator, inline errors, autocomplete) | UI | S–M | Removes the two documented query footguns without a new DSL | Next |
| Docker / k8s log sources | Ingestion | M | Where modern logs actually are | Next |
| Pattern clustering (Drain) | Analysis | L | Kills the 3M-line problem; feeds MCP | Next |
| Watchers + notifications | Ambient | M | Between-incident presence | Next |
| MCP aggregations + patterns | AI | M | Deepens the differentiator | Next |
| Opt-in update check | Trust / native | S | The one sanctioned network call, explicit and off by default | Next |
| Compare mode (time/source diff) | Analysis | M | "What changed?" answered directly | Next |
| Case-file export/import | Sharing | M | Serverless collaboration | Next |
| Team edition (self-hosted, auth) | Business | L | Monetization without cloud betrayal | Later |
| Metrics-from-logs dashboard | Ambient | L | Daily glanceability | Later |
| Trace correlation | Analysis | M | Completes the OTel story | Later |
| Plugin system | Platform | L | Community leverage for a solo maintainer | Later |
| Windows / Linux native shells | Distribution | L | Native parity once macOS proves it | Later |

## 7. UI refinement spec

**Principle: a precision instrument, not a dashboard — more Linear than Grafana.**

The v2 shell (left rail, `--ls-*` token system, status bar) is already close to good. A third from-scratch redesign would be churn; what the interface needs is an editing pass. Everything below is a **delta to existing components**, not a restart.

### Type & density

- **Self-host Geist, or (recommended) adopt the platform stack.** System stack (`-apple-system` / `Segoe UI` / etc.) for chrome, `ui-monospace` (SF Mono / Menlo / Consolas) for log data. Free P0 fix, faster first paint, native feel on every OS.
- **Density modes.** Comfortable / compact / dense row heights on `LogViewerTable`, persisted per workspace. Log triage is a density-maximizing activity; a single density wastes vertical space in long sessions.
- **Mono for data, sans for chrome — strictly.** Timestamps, IDs, field values, counts in mono with `font-variant-numeric: tabular-nums`; labels, buttons, empty states in sans. The current table mixes these; this split is what makes "sleek" legible.
- **Wrap toggle.** Long messages (stack traces, JSON) either truncate with middle-ellipsis or wrap; the toggle lives in the viewer header and persists per workspace (`next-08`).

### Structure

- **⌘K command palette as the front door.** Sources, saved queries, actions (import, export, theme toggle, density), and search history in one surface.
- **Fields facet panel joins the left rail** (the #10 feature is a UI feature as much as a backend one): collapsible panel, top-5 values per field with counts, click-to-filter, alt-click-to-exclude, "show all values" drill-down.
- **Sources panel joins the left rail** (`now-10`): every source with row count, origin path, pattern, first/last seen; per-source delete/re-import/rename; a storage footer with retention control.
- **Row inspector instead of accordion rows.** Replace `ExpandedRow.tsx`'s in-table expansion with a right-hand inspector panel (⌘-click for split view): pretty JSON view, raw line, per-field copy buttons, and "filter by this value" / "exclude this value" on every field, plus **"Show context"** (`next-08`). Keeps table scroll position stable during inspection.
- **Context view** (`next-08`): from any row, open the 50 (configurable) rows before and after it in original `_seq` order for that `_src`, ignoring the current filter, with the anchor row pinned and highlighted. Escape returns to the filtered view at the same scroll position.
- **Histogram upgrade** (`LogDistributionChart.tsx`): stack bars by level (error red / warn amber / info blue using the existing `--ls-*-soft` tokens), brush-select to zoom the time range, faint total sparkline in the `StatusBar` when the chart is collapsed.
- **Trim table chrome.** Drop per-cell vertical borders (the current grid reads as a spreadsheet); keep row separators only and let column alignment carry structure. Hide low-value auto-columns (`_ID`, `DAY`, `MONTH`, `TID` duplicates) by default behind the column picker.

### Query bar (`next-09`)

- **Bare terms AND by default in the UI** via `default_operator=and`; a small `AND|OR` toggle at the bar's right edge. The two documented footguns ("`error api` is OR", "`-foo` alone is a no-op") disappear for humans without changing agent semantics.
- **Inline parse errors** rendered under the bar (never a toast), with the offending span highlighted and a one-line hint ("quote values containing `:`").
- **Autocomplete**: field names after typing a letter, values after `field:` (top values from the facets endpoint), operators after a space. Tab accepts, Esc dismisses; never steals Enter.

### Keyboard model (`next-08`, `now-06`, `macos-b2`)

| Key | Action |
|-----|--------|
| `/` | Focus search · `⌘K` command palette · `Esc` blur / close |
| `↑/↓`, `j/k` | Move row focus · `⌘↑/⌘↓` first/last row · `PgUp/PgDn` page |
| `Enter` / `Space` | Open inspector for focused row · `Esc` close |
| `n` / `N` | Next / previous highlighted match in the message column |
| `c` | Show context for focused row |
| `⌘C` | Copy focused row as text · `⌘⇧C` as JSON · with selection: Markdown table |
| `⌘E` | Export current view · `⌘O` import · `⌘1/2/3` toggle histogram / fields / sources |
| `⌘←/⌘→` | Previous / next page · `⌘⌥←/→` previous / next workspace |

Focus is always visible (2 px accent ring, tokens only). Every shortcut has a menu-bar equivalent when native (`macos-b2`) so it is discoverable.

### Feel

- **Empty state = drop target.** First-run screen is one large drop zone offering four verbs: drop a file, **try sample logs**, `logsonic tail`, connect an agent (MCP setup link). Time-to-first-search lives or dies here.
- **Motion budget: 120 ms, opacity/transform only,** honoring `prefers-reduced-motion`. Panels slide; rows never animate. Perceived speed *is* the aesthetic.
- **Level chips everywhere.** The single-letter level column (D/I/W/E/V) becomes small tinted chips using the existing soft tokens — the one place color is spent; everything else stays neutral so errors pop.
- **Progress that tells the truth.** Import and watch progress show rows/s, bytes/s, ETA, and *the current file*; errors name the line number and the pattern that failed (D8).

### Accessibility baseline (all horizons)

- Every interactive element reachable by keyboard with a visible focus ring; the table is a proper ARIA grid with row/cell roles.
- Contrast ≥ 4.5:1 for text on both themes (tokens are audited once, in `now-11`'s a11y lint step).
- Level color is never the only signal (chip text + icon).
- VoiceOver announces palette, inspector, and toasts as dialogs / live regions.
- `prefers-reduced-motion` and `prefers-color-scheme` respected; a high-contrast token set is a follow-up.

## 8. Performance budgets

**Provisional until the bench harness (`now-11`) records a baseline on the reference machines** (Apple M-series laptop, 16 GB; a 4-core x86 Linux VM, 8 GB). Budgets are enforced as CI regressions (±15 % against the recorded baseline), not absolute gates, until two releases of data exist.

| Scenario | Budget | Measured by |
|----------|--------|-------------|
| App cold launch → UI interactive (native app) | < 1.5 s | Shell timestamp at `didFinish` minus process start |
| Backend start → `Server listening` with 365 day-indices on disk | < 800 ms | `next-10` lazy open; Go benchmark |
| Drop 1 GB uncompressed file → first rows searchable | < 10 s | `now-08` streaming import; E2E timer |
| Import throughput, Apache-style lines, one file, one core | ≥ 100k lines/s | Go benchmark over `sample-logs/bgl-supercomputer.log` |
| Search: term query, 10M rows, page of 100, p95 | < 300 ms | Go benchmark on generated corpus |
| Search: term query + facets, 10M rows, p95 | < 600 ms | same, `include_facets=true` |
| Histogram (100 buckets) over 10M rows | < 400 ms | same |
| Sort by non-timestamp field, 10M rows, page 1 | < 500 ms, bounded memory | `next-10`; the current path is unbounded |
| Idle memory (server + app, 1M rows indexed) | < 200 MB RSS | `/info` memory stats + `ps` in E2E |
| Index amplification (index bytes / raw bytes) | ≤ 1.3× | existing `BenchmarkIndexSizeDense` |
| Live tail sustained ingest with UI open | ≥ 20k rows/s without dropped UI frames | `next-04` benchmark + Playwright frame timing |
| UI: scroll 100k virtualized rows | 60 fps, no long tasks > 50 ms | Playwright tracing |

## 9. Trust & security model

LogSonic's promise is "your logs never leave the machine." That is a *network* promise and a *loopback* promise; both need to be engineered, not asserted.

### Threat model for a loopback log server

| Threat | Today | Fix | Horizon |
|--------|-------|-----|---------|
| **DNS rebinding** — remote page resolves its hostname to `127.0.0.1` and reads the API same-origin, bypassing CORS | Unmitigated; port range 8080–8179 is guessable | Host-header allow-list middleware (`localhost`, `127.0.0.1`, `[::1]`, IPv6-bracketed, with or without the bound port) → HTTP 421; applied before every route including `/mcp` and the SPA | v1.7 (`now-09`) |
| **Other local users** on a shared machine can reach `127.0.0.1:<port>` | Unmitigated (documented as "explicit CLI-only choice" for LAN, but loopback is shared across UIDs) | Per-launch bearer token: the native shell / CLI mints it, passes it to the child via env, injects it into the webview (`__LOGSONIC_NATIVE__.token`) and the MCP config; browser mode prints the tokenized URL. Off when `-host` is loopback and `--no-auth` is passed (dev convenience). | v1.8 (`now-09` phase 2) |
| **Cross-site request forgery** against state-changing routes (clear, delete, watches) | CORS blocks reads; simple POSTs with form encodings could still be sent | Require `Content-Type: application/json` on mutating routes (reject form encodings), plus the Host check | v1.7 |
| **Malicious log content** rendering as HTML | React escapes by default; `QueryHelperPopover` uses `dangerouslySetInnerHTML` on static help text only | CSP header (`default-src 'self'`) on the SPA; a test that a log line containing `<img onerror>` renders as text | v1.7 |
| **Path-based ingest reads any file the user can read** | N/A yet | Same stance as folder watch: any absolute readable path (the CLI already can); never follow symlinked directories in recursive modes; the response echoes the canonical path so the user sees exactly what was read | v1.7 (`now-08`) |
| **Update check leaks identity** | No update check exists | Opt-in, off by default; single anonymous GET; no UA identifiers beyond the product/version; shown as "the only network call LogSonic can make" in Settings | Next (`next-11`) |
| **Supply chain** | Dependabot fixes appear in history; no CI verification | CI runs `govulncheck` + `npm audit --audit-level=high`; goreleaser SBOM | v1.7 (`now-11`) |

### Verifiable "no network calls"

- CI test (`now-11`): launch the embedded build, drive an import → search → export session under Playwright with request interception; **assert zero requests to non-loopback hosts**. This replaces revision 1's manual DevTools audit.
- `logsonic doctor` prints the allow-list and the token status so a security reviewer can confirm the configuration without reading code.

## 10. Engineering quality gates

What a solo maintainer needs to move fast *without* the "doesn't work" class of issues.

- **CI on every PR** (`now-11`): Go (`go vet`, `staticcheck`, `go test -race ./...`), frontend (`tsc --noEmit`, eslint, vitest), Swift shell compile on `macos-latest` (no signing), goreleaser `--snapshot` on Linux, network-audit E2E, one smoke E2E, `govulncheck` + `npm audit`. Target wall time < 10 min.
- **Nightly**: bench harness recording §8 budgets to a JSON artifact; index-size benchmark; the full E2E set.
- **Release**: the existing manual `release.sh` stays until the CI signing story (Windows Authenticode, macOS notary secrets in Actions) is designed; CI *does* build the unsigned snapshot so packaging regressions surface before tag day.
- **Test pyramid targets** (ratcheted from the recorded baseline, never invented): every new endpoint ships with a handler test; every new store with a vitest; every new spec with an E2E row; Swift logic that can be pure (drag-strip decision, stay-alive decision, SSE parser, Open Recent store) has unit tests in the existing `ListeningURLTests` style.
- **API discipline**: Swagger regenerated in CI and diffed (fails the build if annotations drifted); `api-types.ts` mirrors checked by a script that parses both.
- **Docs discipline**: link checker on `README.md` + `docs/`; `docs/development.md` commands are executed by CI (`go run .`, not `go run main.go`).

## 11. macOS native adaptation spec

The AppKit shell (`backend/macos/LogsonicApp.swift`) already does the hard, invisible work well. What's missing is the **visible layer** of nativeness.

### Already native (keep)

- Child-process server lifecycle with clean SIGINT shutdown (drains HTTP, closes indices), escalating to SIGTERM/SIGKILL; up to three automatic restarts.
- Dock presence + responsive app (the reason the shell exists); single-instance lock with activation of the running instance.
- Dock drag-drop **and Finder "Open With"** import (`CFBundleDocumentTypes` for `public.log` / `public.plain-text` / `public.json`; `application(_:openFiles:)`), with the 512 MB guard (`NativeFileSchemeHandler`, custom URL scheme) — the guard is retired by `now-08`.
- Native `NSOpenPanel` for every HTML file input (`runOpenPanelWith`) and `NSSavePanel` for downloads; blob-download interception → native save.
- Server-log console window; View → Open in Browser / Copy Server URL / Reveal Index in Finder; Edit menu with standard clipboard items.
- Automatic loopback port selection; 127.0.0.1 binding (private by default).
- Signed + notarized + stapled universal binary; Homebrew distribution.

### Proposed (in sequencing order)

Specs: [Bundle 1](specs/macos-b1-visible-nativeness.md) · [Bundle 2](specs/macos-b2-menus-finder.md) · [Bundle 3](specs/macos-b3-ambient-presence.md)

**Bundle 1 — "visible nativeness" (v1.7; shell + CSS only, no backend work):**

1. **Unified titlebar.** `titlebarAppearsTransparent = true` + `.fullSizeContentView`, traffic lights inset over the app's own header. The web header (`components/Home/Header.tsx`) reserves ~78 px of left padding when native and marks itself a drag region; the shell forwards titlebar drags to `performDrag(with:)`. This one change is 60% of "feels native."
2. **Native detection contract.** Shell injects `window.__LOGSONIC_NATIVE__ = { platform: 'macos', shellVersion, token? }` via a `WKUserScript` at document start; the frontend adds `.is-native-macos` on `<html>` and keys everything off that class: titlebar inset padding, hiding browser-redundant chrome (e.g., the open-in-browser icon).
3. **Follow system appearance.** Observe `NSApp.effectiveAppearance` (KVO) in the shell and post theme changes to the SPA (default "auto"; manual in-app override preserved). Also set the WKWebView non-drawing background to the token color to kill white flashes on launch in dark mode.
4. **Window memory.** `window.setFrameAutosaveName("main")` (one line; §2 P2) and restore of the last route/workspace on relaunch (frontend, `next-08`).

**Bundle 2 — menus, paths, and Finder integration (v1.8 → Next):**

5. **Real menu bar.** File → Import… (⌘O), Open Recent, Export (⌘E), New Window (⌘N — a second WKWebView on the same server; workspaces make this useful); View → Toggle Theme, Density, Histogram/Fields/Sources (⌘1/⌘2/⌘3), Open in Browser; Go → Search (⌘K), Next/Prev Match (⌘G); LogSonic → Check for Updates… (`next-11`). Menu items dispatch into the shared actions registry via `evaluateJavaScript`; shortcuts must work while the webview has focus.
6. **Paths, not bytes.** Dock drops, Finder opens, `NSOpenPanel` picks, and `logsonic open` all hand **absolute paths** to `POST /api/v1/ingest/file` (`now-08`) instead of registering `logsonicfile://` byte streams — the 512 MB cap and the whole-file read go away; a 3 GB drop shows progress within a second. `logsonicfile://` stays only for the browser-mode fallback.
7. **Finish file-type association.** Add `.gz`, `.jsonl`, `.ndjson`, `.log.N` to the document types and drop the `["log","txt","json"]` guard in `openNativeFiles`; add a Services entry ("Analyze with LogSonic"); Open Recent from `UserDefaults`.

**Bundle 3 — ambient presence (lands with watchers, Next):**

8. **Menu-bar extra (`NSStatusItem`).** Live-tail heartbeat: source names, rows/sec, pause/resume, error count since last glance. This is the ambient-presence strategy (§4) in native clothing.
9. **Notifications + dock badge.** Watchers deliver via `UNUserNotificationCenter`; the dock icon badges the unseen-error count during tails; click-through deep-links to the matching query.
10. **Self-update.** Only after `next-11`'s opt-in check exists and its policy is accepted: Sparkle with EdDSA-signed appcast, or keep the "brew upgrade available" prompt. The check is the policy decision; Sparkle is the convenience.

## 12. Explicit non-goals

Deliberately **off** the roadmap:

- **A hosted cloud service** — betrays the wedge; "self-hosted" is the ceiling.
- **A query DSL beyond the current shorthand** — agents + facets beat query languages for these personas. (`default_operator`, inline errors, and autocomplete are ergonomics for the *existing* syntax, not a new language.)
- **Mobile apps.**
- **A bundled local LLM** — MCP already delegates intelligence to the user's own agent. Stay the context provider, not the AI.
- **Any network call that is not the opt-in update check** — no telemetry, no crash upload, no font CDN, no "anonymous usage stats."
- **Localization** before v3 — English UI; log content is bytes and is never transformed.

## 13. First five moves

1. **Ship the trust sprint** — system fonts, Host allow-list + CSP, the `%` query fix, README link, `--version`. One week; the core promise becomes airtight *and* auditable.
2. **Stand up the CI gate** with the network-audit test — so every move after this one is protected, and the "no network calls" claim is proven on every PR.
3. **Build native path import** — the 3 GB drop, gzip, rotated files; the macOS shell passes paths. The single largest gap between "has a Mac app" and "desktop-first."
4. **Build the faceted fields sidebar** — the unshipped #10; the largest gap between what users expect and what exists.
5. **Land macOS Bundle 1** — titlebar, native-detection contract, appearance-follow, window memory. Highest polish-per-hour in the codebase.

Then v1.8: sources catalog, folder watch, `logsonic open` + sample data, doctor, ⌘K, distribution — in that order.
