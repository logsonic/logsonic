# now-13 — Diagnostics bundle and `logsonic doctor`

**Horizon:** Now (v1.8) · **Size:** S–M · **Priority:** P1
**TBD.md ref:** §2 P1 (silently skipped indices), §3 principle D8 (explainable when it fails), §4 north-star "diagnostics attach rate".
**Depends on:** `--version` (`now-05`/trust sprint); reads the catalog when `now-10` exists (optional).
**Read `specs/README.md` first.**

## Goal

GitHub issue #17 was "doesn't work" plus screenshots. A solo maintainer cannot debug that. Separately, `storage.NewStorage` silently `continue`s past any day-index that fails to open (`storage.go:75`), so data can vanish without a trace. This task gives every failure a name and every bug report a bundle.

## Design decisions (made)

- **Startup index report.** `NewStorage` records every open failure as `IndexOpenError{Date, Path, Err}` on the `Storage` struct instead of dropping it; logs one line per failure; exposes `OpenErrors()`. `/info` gains `storage_info.index_errors: [{date, path, error}]` and `storage_info.health: ok|degraded`. The frontend StatusBar shows an amber "N indices unreadable" chip when degraded, click → Settings → About with details and the doctor instructions.
- **`logsonic doctor [--json] [--redact] [--rebuild-catalog] [--quarantine]`**: prints (to stdout, human by default, JSON with `--json`):
  - version, commit, build date, Go version, OS/arch, `LOGSONIC_*` env (values redacted), whether launched from the app bundle (`LOGSONIC_PARENT_PID`),
  - storage path, total bytes, per-day index list with docs/bytes/open-status (uses `Storage.OpenErrors()` — runs against the storage dir *without* a running server, opening indices read-only; if a server is running on the storage dir, doctor talks to it via `/info` instead of opening indices — detect via the `session.token`/lock file from `now-09` or a `.lock` we add in `pkg/storage`),
  - listening URL / port / Host allow-list / token status (from `/info` when running),
  - pattern catalog summary (count, custom count),
  - last 200 lines of the server log — the server appends its stdout/stderr to `<storage>/logs/server.log` with 5 MB × 3 rotation (new: today output goes only to the console / the app's log window),
  - active tails/watches/jobs (from the API when running).
  - `--quarantine` moves unreadable index directories to `<storage>/quarantine/<date>-<ts>/` so the server starts clean (never deletes). `--rebuild-catalog` calls `now-10`'s rebuild.
  - `--redact` replaces the user's home directory and any path segments after it with `~/…`, and blanks hostnames.
- **In-app "Copy diagnostics"** (Settings → About): calls `GET /api/v1/diagnostics?redact=true`, which returns the same JSON the CLI prints; the button copies it as fenced Markdown ready to paste into an issue. Native app: also a "Save Diagnostics…" (`NSSavePanel`) item in the LogSonic menu.
- **Issue template** `.github/ISSUE_TEMPLATE/bug.yml` with a required "Diagnostics" field and the one-line instruction `logsonic doctor --redact` or the About-page button.
- **Error copy standard** (applies to every new error message from this spec on): *what* failed, *which* file/line/pattern/field, *what to do*. Example: `Index 2026-08-30 could not be opened (segment checksum mismatch). Run: logsonic doctor --quarantine`.

## Anchors

`storage/storage.go` (`NewStorage` load loop, struct), `handlers/info.go` (response struct + cache), `types.SystemInfoResponse`, `main.go` (subcommands, `printUsage`), `server.go` `Start` (where to tee stdout/stderr into the rotating file), `LogsonicApp.swift` (menu; the app already captures the child's output — the file is the server's own copy), `pages/settings/About.tsx`, `Shell/StatusBar.tsx`.

## API contract

```
GET /api/v1/diagnostics?redact=true|false → DiagnosticsReport (JSON)
/info: storage_info.index_errors[], storage_info.health
```

`DiagnosticsReport` struct in `pkg/types`; the CLI and the HTTP handler share one builder in `pkg/diagnostics/`.

## Step-by-step

1. `Storage.openErrors` + `OpenErrors()`; log line per failure; unit test with a deliberately corrupted index dir (write garbage into a copied `.bleve`).
2. `/info` fields + StatusBar chip + About details.
3. Rotating server log file (`<storage>/logs/server.log`) via a small `io.MultiWriter` in `server.Start`; keep console output unchanged.
4. `pkg/diagnostics/` builder (running-server and offline modes) + redaction; `doctor_cli.go`; `HandleDiagnostics`.
5. `--quarantine`, `--rebuild-catalog`.
6. Issue template; docs (`docs/getting-started.md` "When something goes wrong").

## Test cases

| # | Case | Pass criterion |
|---|------|----------------|
| X1 | corrupt one day-index → `NewStorage` | other indices load; `OpenErrors()` has one entry; log line present |
| X2 | `/info` on that storage | `health: degraded`, `index_errors` populated |
| X3 | `logsonic doctor --json` offline on that storage | report lists the bad index with the error text |
| X4 | `logsonic doctor` while server runs on the same storage | uses the API (no double-open), includes listening URL + Host allow-list |
| X5 | `--quarantine` | bad dir moved (not deleted); next start `health: ok` |
| X6 | `--redact` | no home-dir path or hostname in output (assert with regex) |
| X7 | server log rotation | 3 × 5 MB cap holds under a synthetic flood |
| X8 | E2E: corrupt index → StatusBar chip → About page shows details → "Copy diagnostics" copies fenced Markdown | as stated |

## Acceptance criteria

- [ ] No index failure is silent: X1–X3 green; StatusBar chip visible.
- [ ] `doctor` works offline and online; redaction verified.
- [ ] Issue template requires diagnostics; docs updated.

## Out of scope

Automatic index repair (Bleve has no repair API; quarantine + re-import is the path), crash reporting upload (non-goal: no network), performance profiling output (`pprof` remains a dev flag if added later).
