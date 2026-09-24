# now-12 — `logsonic open` and first-run sample data

**Horizon:** Now (v1.8) · **Size:** S · **Priority:** P1
**TBD.md ref:** §3 principles D7 (CLI citizen) and D3, §4 north-star "time to first search", §7 Feel (empty state).
**Depends on:** `now-08` (`pkg/ingestfile` + `POST /ingest/file`).
**Read `specs/README.md` first.**

## Goal

Two on-ramps that make LogSonic the reflexive destination for a log:

1. **`logsonic open <file...>`** — from any terminal, hand one or more paths (or a glob) to the running instance; launch it if needed; focus the window. `--tail` follows instead of importing. This is the lnav muscle-memory hook for developers who live in terminals.
2. **"Try with sample logs"** on the first-run empty state — one click imports a bundled, license-clean sample so a new user sees a populated, searchable UI within 15 seconds instead of hunting for a file.

## Design decisions (made)

- **CLI verb:** `logsonic open [--tail] [--pattern NAME] [--source NAME] [--url URL] <path>...`. Behavior: resolve each path to absolute (shell globs already expanded by the shell; on Windows expand `*` ourselves with `filepath.Glob`), `POST /api/v1/ingest/start` with `pattern: "auto"` (a new session option meaning "run log2grok detection on the first 200 lines server-side" — implement it in `HandleIngestStart` by sampling via `ingestfile` before compiling the decoder; `--pattern` overrides), (*Corrected 2026-09-16, phase 1:* `/ingest/start` has no file yet — the CLI and the wizard both send it afterwards — so "auto" is implemented as deferred detection: the session compiles no decoder, and the first batch (a chunk or the path job's first 10k lines) detects from its first 200 lines and locks the winner; a failed detection is sticky for the session. `--tail` keeps the tail subcommand's default pattern unless `--pattern` is given: a live source compiles at start.) then `POST /ingest/file` per path, then print progress lines to stderr from the SSE stream (`ingest_progress`) until `done`, then print the UI URL with the query hash for the source. With `--tail`, call `POST /live/files` instead (existing). Exit code 0 on success, 1 on any failure, 2 on usage.
- **Launch-if-needed:** if `GET /ping` fails on the resolved URL: on macOS, `open -a Logsonic --args --open-files <paths>` when the app bundle exists (the shell already implements `application(_:openFiles:)`, which now hands paths to `ingest/file` per `now-08`); otherwise start the server in the background the way `-open` does (`exec.Command(self, "-open")` detached) and retry `ping` for up to 10 s. Print exactly what was done. (*Corrected 2026-09-16, phase 1:* the app is launched **bare** (`open -g -a Logsonic`) and only when `--url` is the default — it binds its own port and ignores `--url`; passing the paths would put them in the import wizard *and* the CLI would import them through the API, two imports. Any other URL gets `logsonic -host H -port P -auto-port=false` detached, inheriting `STORAGE_PATH`; `-open` only with the CLI's `--open`.)
- **Focus the window:** the server exposes `POST /api/v1/ui/focus` which publishes an SSE event `ui_focus {route?}` (a broadcast event: it must bypass the per-source subscriber filter in `handlers/live.go` — use the `publishBroadcast` helper now-08 adds); the macOS shell listens (Bundle 3's `LiveFeed`, or until then a minimal SSE listener) and calls `makeKeyAndOrderFront` + navigates. In browser mode the CLI prints the URL and, with `--open`, opens it.
- **Sample data:** bundle **one** file, `sample-logs/apache.log`-sized (≤ 1 MB) with a permissive license (LogHub samples are MIT — verify and record in `sample-logs/README.md`), embedded in the Go binary via `go:embed` under `pkg/samples/`. `POST /api/v1/samples/{name}/import` writes nothing to the user's disk: it opens the embedded bytes through `ingestfile` (add an `OpenReader(io.Reader, name)` constructor) with a fixed known-good pattern and `_src = "sample.apache"`. (*Corrected 2026-09-16, phase 1:* verified — loghub is **not** MIT; its README grants use "for research or academic work" with a citation request and names no licence, so `apache.log` cannot be shipped in the binary. The bundled sample is the repository's own synthetic `nginx-access.log` (MIT, 500 lines, 61 KB) under `_src = "sample.nginx-access"`; `sample-logs/README.md` records both.) The empty state shows the button only when the catalog is empty; the Sources panel shows a "sample" badge with one-click delete (`now-10`).
- **Empty-state copy** (four verbs, in this order): *Drop a log file here* · *Try with sample logs* · *Stream a file: `tail -f app.log | logsonic tail -`* (with copy button) · *Connect an agent* (→ MCP setup). Keep it to one screen; no marketing.

## Anchors

`backend/main.go` (subcommand dispatch: `mcp`, `tail`) and `tail_cli.go` (client-side HTTP helpers, `decodeAPIResponse`, signal handling — copy the style), `handlers/ingest.go` (`HandleIngestStart`), `handlers/live.go` (hub for `ui_focus`), `LogsonicApp.swift` (`application(_:openFiles:)`, `applicationShouldHandleReopen`), the empty state in `components/Home/LogViewer/LogViewerTable.tsx` (grep `FileUp` / "Import" empty rendering), `sample-logs/README.md`.

## API contract

```
POST /api/v1/ui/focus            body {route?: "/#/..."}  → 204   (SSE "ui_focus")
GET  /api/v1/samples             → { samples: [{name, description, lines, license}] }
POST /api/v1/samples/{name}/import → 202 {job_id}  (progress via ingest_progress)
IngestSessionOptions.pattern = "auto"  (server-side detection)
```

## Step-by-step

1. `pattern: "auto"` in `HandleIngestStart` (sample first 200 lines via `ingestfile`, run the same detection `HandleParse` autosuggest uses, lock the winner).
2. `backend/open_cli.go`: `runOpenCommand(args) int`; SSE progress printer; launch-if-needed; `--tail` delegation. Register in `main.go`; update `printUsage` and `docs/configuration.md` "CLI subcommands".
3. `pkg/samples/` embed + handler + routes; empty-state button; Sources "sample" badge.
4. `ui_focus` event + Swift listener (minimal `URLSession` SSE reader — becomes `LiveFeed.swift` in `macos-b3`; write it so b3 can extend it, not replace it).
5. Docs: README "Open a log from the terminal" one-liner; `docs/getting-started.md` sample section.

## Test cases

| # | Case | Pass criterion |
|---|------|----------------|
| O1 | `logsonic open sample-logs/apache.log` with server running | rows searchable; stderr shows progress + final URL; exit 0 |
| O2 | two paths + `--source combined` | one source, both files, ordered |
| O3 | server not running (test harness: unreachable URL, no app) | spawns a background server, retries, succeeds; prints what it did |
| O4 | `--tail` | live source started; Ctrl-C stops it (as `tail -f`) |
| O5 | `--pattern apache` vs `auto` on `apache.log` | same field set |
| O6 | missing file | exit 1, message names the path |
| O7 | `POST /samples/apache/import` on empty storage | catalog has `sample.apache`; empty state gone; rows searchable |
| O8 | E2E: fresh storage → empty state shows four verbs → click sample → results within 15 s (timed) | as stated |
| O9 | macOS manual: `logsonic open x.log` while app is in background → window comes to front and shows the import | as stated |

## Acceptance criteria

- [ ] O1–O8 green; O9 verified on arm64.
- [ ] `time to first search` with sample data measured < 15 s on the reference laptop (record in PR).
- [ ] No sample bytes written outside the index; sample license recorded.
- [ ] CLI docs + `printUsage` updated.

## Out of scope

Shell completions (with `now-05`), `logsonic search` CLI (MCP + UI cover it; revisit if asked), Windows "Open with" registration (`L5`).
