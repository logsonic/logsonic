# LogSonic work specifications

Executable work specs derived from [`TBD.md`](../TBD.md) (revision 2, 2026-09-01). Each file is **self-contained**: an agent should be able to pick up one spec and complete it without reading the others or having any prior session context.

## Pickup order & status

Now-horizon is split into **v1.7** (six work packages, ≤ 6 weeks) and **v1.8** (six more). Pick in table order unless the "Depends on" column says otherwise.

| Spec | Horizon | Size | Depends on |
|------|---------|------|------------|
| [now-01-self-hosted-fonts.md](now-01-self-hosted-fonts.md) | v1.7 · trust sprint | S | — |
| [now-09-loopback-security.md](now-09-loopback-security.md) | v1.7 · trust sprint (phase 1); v1.8 (phase 2 token) | S + S–M | — |
| [now-07-repo-hygiene.md](now-07-repo-hygiene.md) | v1.7 · trust sprint | S | — |
| [now-11-ci-quality-gate.md](now-11-ci-quality-gate.md) | v1.7 | S–M | now-01 (network audit is meaningful only after the font import is gone) |
| [now-02-faceted-fields-sidebar.md](now-02-faceted-fields-sidebar.md) | v1.7 | M | — (reads the sources catalog once now-10 exists) |
| [now-08-native-path-import.md](now-08-native-path-import.md) | v1.7 | M | — · **owns `pkg/ingestfile`** |
| [now-03-saved-queries-history.md](now-03-saved-queries-history.md) | v1.7 | S | — |
| [macos-b1-visible-nativeness.md](macos-b1-visible-nativeness.md) | v1.7 | M | now-01 (font decision) |
| [now-10-sources-catalog.md](now-10-sources-catalog.md) | v1.8 | M | now-08 (re-import from origin) |
| [now-04-folder-watch.md](now-04-folder-watch.md) | v1.8 | M | now-08 (`pkg/ingestfile` for initial ingest) |
| [now-12-cli-open-and-sample-data.md](now-12-cli-open-and-sample-data.md) | v1.8 | S | now-08 |
| [now-13-diagnostics-doctor.md](now-13-diagnostics-doctor.md) | v1.8 | S–M | `--version` (now-07); now-10 optional |
| [now-06-command-palette.md](now-06-command-palette.md) | v1.8 | M | now-03 (query history surface) |
| [now-05-distribution-parity.md](now-05-distribution-parity.md) | v1.8 | S–M | `--version` (now-07) |
| [macos-b2-menus-finder.md](macos-b2-menus-finder.md) | v1.8 → Next | M | macos-b1, now-06, now-08 (paths-not-bytes) |
| [next-01-otlp-ingest.md](next-01-otlp-ingest.md) | Next | M | — |
| [next-08-log-reader-mode.md](next-08-log-reader-mode.md) | Next | M | now-06 (action registry) |
| [next-10-storage-engine-hardening.md](next-10-storage-engine-hardening.md) | Next | M | now-13 (`OpenErrors`), now-10 (config.json, storage UI) |
| [next-09-query-bar-ux.md](next-09-query-bar-ux.md) | Next | S–M | now-02 (facets for autocomplete), now-07 (`%` fix) |
| [next-02-container-sources.md](next-02-container-sources.md) | Next | M | — |
| [next-03-pattern-clustering.md](next-03-pattern-clustering.md) | Next | L | — |
| [next-04-watchers-notifications.md](next-04-watchers-notifications.md) | Next | M | — |
| [next-05-mcp-depth.md](next-05-mcp-depth.md) | Next | M | now-02, next-03, next-09 (`default_operator`) |
| [next-11-update-check.md](next-11-update-check.md) | Next | S | now-10 (config.json), now-11 (network audit stays green) |
| [macos-b3-ambient-presence.md](macos-b3-ambient-presence.md) | Next | M | macos-b1, next-04, now-12 (minimal SSE listener to extend) |
| [next-06-compare-mode.md](next-06-compare-mode.md) | Next | M | now-02 |
| [next-07-case-files.md](next-07-case-files.md) | Next | M | now-03 |
| [later-charters.md](later-charters.md) | Later | — | Next horizon |

**Depth tiers are deliberate:** Now-horizon and macOS specs are full, executable work specifications. Next-horizon specs are medium detail — architecture and contracts are decided, but some UI detail is left to the implementer. Later items are **one-page charters, not executable specs** — they depend on Next-horizon work landing first and will be expanded when their dependencies exist.

**Shared ownership rules** (so two specs never build the same thing):

- `backend/pkg/ingestfile/` (open a file by path, sniff gzip/zstd, line iterator, rotation sets) is owned by **now-08**; now-04, now-12, and next-07 call it.
- The actions registry `frontend/src/lib/actions.ts` is owned by **now-06**; macos-b2 menus, next-08 key map, and next-11's "Check for Updates" dispatch into it.
- The sources catalog `backend/pkg/catalog/` is owned by **now-10**; `/info`, StatusBar, `_src` facets (now-02), MCP `log_info` read from it.
- The SSE hub in `handlers/live.go` is the only publication point for live events; new event types (`ingest_progress` now-08, `ui_focus` now-12, `watch_alert` next-04) are added beside the existing ones in `types.go`, never on a second endpoint.
- The Bleve value-escaping helper in `lib/utils.ts` is owned by **now-02**; next-09 autocomplete and next-08 inspector filters reuse it.

---

## Shared environment rules (read before starting ANY spec)

These rules are non-obvious and will cost you an hour if skipped.

### Dev setup — always run backend and frontend as separate processes

Never use the embedded build (`npm run build:copy` + single binary) for development or testing. It hides frontend errors and forces a full rebuild per change. Embedded builds are for release verification only — and for the network-audit / smoke E2E in CI (now-11), which deliberately test the shipped artifact.

```bash
# 1. ALWAYS kill stale processes first:
lsof -ti:8080 | xargs kill 2>/dev/null; lsof -ti:8081 | xargs kill 2>/dev/null

# 2. Backend — MUST be on port 8080 (frontend dev has NO proxy and calls
#    http://localhost:8080 directly, hardcoded in frontend/src/lib/api-client.ts:25):
cd backend && go run . -port 8080
# NOTE: `go run .` (whole package), NEVER `go run main.go` — the main package has
# sibling files (tail_cli.go, parentwatch.go); `go run main.go` fails with
# "undefined: runTailCommand"-style errors. (docs/development.md still shows the
# wrong form — now-07 fixes it.)

# 3. Frontend — MUST override PORT (vite.config.ts defaults to 8080 and collides):
cd frontend && PORT=8081 npm run dev

# 4. Open the app at the FRONTEND port: http://localhost:8081
```

### Tests

```bash
cd backend && go test ./...          # Go unit tests (14 test files today)
cd frontend && npx vitest run        # frontend unit tests (10 test files today)
cd frontend && npm run lint          # eslint
# E2E: node scripts in frontend/ follow the pattern of e2e-test.mjs /
# e2e-comprehensive.mjs / e2e-bgl-import.mjs (Playwright-style .mjs drivers).
# They expect backend on 8080 + frontend on 8081, started as above.
# There is NO CI yet — now-11 adds it. Until then, run the above before every PR.
```

Sample data for manual testing lives in `sample-logs/` (apache.log, linux-syslog.log, java-stacktrace.log, docker.log, app-json.log, bgl-supercomputer.log ≈ large-file case, …).

### Codebase map (anchors used across specs)

**Backend** (Go 1.26 per `go.mod`, chi/v5, Bleve v2.5 scorch):

- `backend/pkg/server/server.go` — router construction. Middleware chain: RequestID → RealIP → logger (skips `/ping`) → Recoverer → security headers → CORS (`http://localhost:*`, `http://127.0.0.1:*`). **No Host-header validation, no CSP** (now-09). MCP mounted at `/mcp`. Long-lived live-tail routes (`GET /api/v1/live/events` SSE, `POST /api/v1/live/stdin`) are registered OUTSIDE the timeout/throttle group. API route table under `/api/v1` inside the timeout+throttle group. **SPA catch-all `r.HandleFunc("/*", …)` last — anything not registered before it is swallowed by the SPA.** `Start()` binds synchronously (auto-port scans 8080–8179), prints `Server listening on <url>`, starts session cleanup, live manager, and retention (`RetentionDays`, CLI/env only — now-10 moves it to `config.json`).
- `backend/pkg/server/handlers/` — one file per area: `logs.go` (`HandleReadAll` — bounded `SearchPage` when `sort_by == "timestamp"`, **legacy unbounded `storage.Search()` otherwise** — next-10 removes it), `ingest.go` (session-based: `/ingest/start` → `/ingest/logs` → `/ingest/end`; limits 16 MB / 10k lines / 2 MiB per line at the top of the file), `live.go` (887 lines, tail hub/subscribers — the single SSE publication point), `workspaces.go`, `grok.go`, `info.go` (cached; cache invalidated at six call sites; calls the O(docs) `GetSourceNames` — now-10), `handlers.go` (`Services` struct, `NewHandler`).
- `backend/pkg/types/types.go` — all request/response DTOs. `IngestFileRequest` exists but is **unrouted** (now-08 claims it). Live-tail event types near `LiveHelloEvent`/`LiveRowsEvent`/`LiveSkippedEvent`/`LiveSourceStatusEvent`.
- `backend/pkg/storage/storage.go` — `StorageInterface` (`Store`, `StoreWithIDs`, `Search`, `SearchPage`, `List`, `GetSourceNames`, `Clear`, `BaseDir`, `GetDocCount`, `DeleteByIds`, `PruneOlderThan`). **One Bleve index per calendar day**, `logs-YYYY-MM-DD.bleve`, all opened eagerly in `NewStorage` (failures silently `continue`d — now-13); `getOrCreateIndex`; `BuildDocID` = `<unixnano>-<source>-<seq>`; `buildIndexMapping` (timestamp indexed, `_raw` text, `_seq` stored-only, `_all` disabled). The LevelDB `kvConfig` passed to scorch is ignored (next-10 deletes it).
- `backend/pkg/storage/search_page.go` — `SearchPage()`: the bounded path. Index alias over the selected days, `timestampSort` (timestamp, `_seq`, docID), search-after batches of 1000, `MaxSearchPageSize = 1000`, date-range facet for the histogram (100 buckets), legacy-shard compatibility scan when timestamps were not indexed. **Any new aggregate (facets, context, patterns, compare) follows this shape.** `buildPageQuery` has the `url.PathUnescape` double-decode bug (now-07).
- `backend/pkg/storage/search.go` — legacy `Search()` (per-day goroutine fan-out, `Size = 1_000_000`) and `GetSourceNames()` (doc scan). Both scheduled for deletion; do not build on them.
- `backend/pkg/storage/optimized_query.go`, `index_document.go` — query rewrites (stored-field phrase verification, compact numeric terms) and the slimmed document builder. Read before touching mappings.
- `backend/pkg/mcp/server.go` — MCP tools: `ping`, `log_info`, `query_logs`, `list_grok_patterns`, `test_grok_pattern`, `logsonic_url`, `log_distribution`, `list_workspaces`, `open_workspace`, `create_workspace`, `workspace_url`. Streamable-HTTP transport at `/mcp`; `logsonic mcp` is the stdio bridge. Tool handlers call the local REST API via a base-URL provider.
- `backend/pkg/workspaces/store.go` — file-backed workspace persistence (the pattern every new JSON state file copies; next-10 adds `pkg/atomicfile`).
- `backend/pkg/timeresolve/` — timestamp inference; `backend/pkg/tokenizer/` — smart-decoder regexes (masking precedent for next-03).
- `backend/main.go` + `tail_cli.go` + `parentwatch.go` — CLI entry (`mcp`, `tail` subcommands; flags `-host -port -storage -open -browser -auto-port -retention-days`; **no `--version`** — now-07), parent-process watchdog. Default storage: `~/Library/Application Support/Logsonic` / `%APPDATA%\Logsonic` / `$XDG_DATA_HOME/logsonic`.
- Swagger: handlers carry `// @Summary` etc. annotations; docs are generated into `backend/docs/`. **New/changed endpoints must update annotations and regenerate** (`swag init -g pkg/server/server.go`; now-11 checks drift in CI).
- Release: `backend/.goreleaser.yaml`, `backend/scripts/` (incl. `app-macos.sh`, `release.sh`, `sign-macos.sh`), `RELEASE.md`. **No CI workflows exist** (now-11).

**Frontend** (React 18, TS, Vite, Zustand, Radix, Tailwind, cmdk already a dependency):

- `frontend/src/lib/api-client.ts` — `API_BASE_URL` (dev: hardcoded `http://localhost:8080`; prod: same-origin). All fetch helpers live here (`ingestFile()` exists but hits an unrouted endpoint — now-08).
- `frontend/src/lib/api-types.ts` — TS mirrors of backend DTOs. Update in lockstep with `pkg/types/types.go` (now-11 adds a mirror check).
- `frontend/src/stores/` — Zustand: `useSearchQueryParams.ts` (query/time-range/sources/columns/pagination state + `triggerSearch`), `useLogResultStore.ts` (current results), `useWorkspaceStore.ts` (`buildWorkspaceFromState`, `applyWorkspaceToCurrentState`, `isWorkspaceDirty`), `useThemeStore.ts` (`'light' | 'dark'`, persisted), `useColorRuleStore.ts`, `useImportStore.ts`, `useLiveLogStore.ts`, `useSystemInfoStore.ts`. Store conventions documented in `frontend/src/stores/README.md`.
- `frontend/src/hooks/useSearchLogs.ts` — assembles `LogQueryParams` (projects to `selectedColumns` after the first page; fetches distribution in a deferred second request). `useLogStream.ts` — SSE consumer (add new event types here). `useSearchParser.tsx` — query tokenizer + highlighter (chips in next-09, `n/N` in next-08).
- `frontend/src/components/Home/` — `LogSearch.tsx` (search bar; owns the `/` and ⌘K listeners today), `Header.tsx` (theme toggle, storage, clear-all AlertDialog, MCP/bot, external-link buttons), `LogDistributionChart.tsx` (Recharts histogram, lazy), `SourceTabs.tsx`, `WorkspaceMenu.tsx`, `ExpandedRow.tsx` (accordion row — replaced by the inspector in next-08), `LogExportButton.tsx` (JSONL only — next-08 adds CSV/Markdown/raw), `PaginationControls.tsx`, `SidebarPanel.tsx`, `Sidebar/CollapsiblePanel.tsx`, `Sidebar/ColorRulesPanel.tsx` (the panel to copy for Fields/Sources), `LogViewer/LogViewerTable.tsx` (TanStack table + windowed rows, DnD columns, row selection + delete; **no keyboard row navigation** — next-08).
- `frontend/src/components/Shell/` — `LeftRail.tsx` (Logs, Filters, Row coloring, Import, Settings), `StatusBar.tsx` (connection dot, sources, events, last query ms, hits, storage, version).
- `frontend/src/components/Import/` — wizard (`LocalFileImport/FileSelectionService.ts` reads files in the browser: 1 MB preview, 4 MB read ranges, 8 MB request chunks; `hooks/useUpload.ts` drives `/ingest/*`). Native drops arrive via the `logsonic-native-files` window event with `logsonicfile://` URLs (now-08 switches to paths).
- `frontend/src/index.css` — design tokens (`--ls-*` system, light + dark), **line 1 currently imports Geist from Google Fonts (now-01)**.
- `frontend/src/pages/` — `Home.tsx` (shell layout: brand cell, topbar, rail, sidebar, main), `Import.tsx`, `settings/` (`SettingsLayout.tsx` NAV: patterns, mcp, about — now-10 adds storage).

**macOS shell** (AppKit + WKWebView, Swift, target macOS 11):

- `backend/macos/LogsonicApp.swift` — the entire native shell (~1,000 lines). **Already present** (do not re-spec): child-process lifecycle (SIGINT → SIGTERM → SIGKILL, up to 3 restarts), single-instance `flock` + activation of the running instance, `application(_:openFiles:)` and `openFile`, dock drag-drop via `NativeFileSchemeHandler` (`logsonicfile://`, 512 MB cap, whole-file `Data(contentsOf:)` — retired by now-08), `runOpenPanelWith` (native `NSOpenPanel` for every HTML file input, directories allowed when the input asks), `NSSavePanel` for downloads + blob-download JS hook, JS alert/confirm/prompt as sheets, external links → system browser, console window with colored server log, `StatusPill`, menus (App: Hide/Quit; File: Close; Edit: standard + Copy All Logs; View: Reload, Open in Browser, Copy Server URL, Server Log, Reveal Index in Finder), `/info` fetch for the storage dir. **Missing:** frame autosave, unified titlebar, native contract injection, appearance follow, action-registry menus, paths-not-bytes, status item, notifications, token plumbing.
- `backend/macos/ListeningURL.swift` (+ `ListeningURLTests.swift`) — parses "Server listening on …" from child stdout; the only Swift unit tests today (pattern to copy).
- Build: `backend/scripts/app-macos.sh` (swiftc per-arch + lipo; writes `Info.plist` **including `CFBundleDocumentTypes` for `public.log`, `public.plain-text`, `public.json`** and `LSMultipleInstancesProhibited`). Signing identity/team: see maintainer notes; app is signed, notarized, stapled, shipped via Homebrew cask.

### Conventions

- Backend errors return `types.ErrorResponse` JSON; match existing handler style in the file you touch. Error text follows now-13's standard: *what* failed, *which* file/line/pattern/field, *what to do*.
- Frontend state changes go through Zustand stores, not component state, when shared across components.
- Every new JSON state file under `<storage>` is written atomically (temp + rename) and carries a `version` field.
- New SSE event types go in `types.go` beside the existing live events and are documented in `docs/live-streaming.md`.
- Match existing code style; comment only non-obvious constraints.
- Do not commit unless the task says to. Never touch `.release.env`.
