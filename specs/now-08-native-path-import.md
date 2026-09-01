# now-08 — Native path-based import (+ compressed & rotated files)

**Horizon:** Now (v1.7) · **Size:** M (1–2 weeks) · **Priority:** P0
**TBD.md ref:** §3 principle D1 ("the file is already here"), §5 v1.7, §11 Bundle 2 item 6.
**Owns:** the shared server-side file reader `backend/pkg/ingestfile/`, reused by `now-04` (folder watch initial ingest) and `now-12` (`logsonic open`).
**Read `specs/README.md` first** for dev setup and codebase map.

## Goal

Today every import — including a file dropped on the Dock of the native app — is read by the **webview** and streamed to the server as JSON chunks (`useUpload.ts` → `POST /ingest/logs`, 8 MB per request, 10k lines per request). The macOS shell serves dropped files to the SPA through a custom `logsonicfile://` scheme that loads the whole file with `Data(contentsOf:)` and refuses anything over 512 MB (`LogsonicApp.swift`, `maxNativeDropBytes`). Persona 3's 3 GB dump cannot be dropped at all, and a 400 MB file is JSON-encoded, transferred, decoded, and re-encoded on the same machine.

After this task: the server ingests a file **by absolute path**, streaming from disk, with gzip/zstd detection, rotated-file sets, SSE progress, and cancellation. The native shell (and later the CLI) hands over *paths*. The browser-upload path remains for browser-mode users.

## Design decisions (made — do not re-litigate)

- **Endpoint:** `POST /api/v1/ingest/file` — claim the existing dead code (verified 2026-09-01: no handler references it): `types.IngestFileRequest` (`pkg/types/types.go`, `LogFileName` + `SessionID`) and `ingestFile()` in `frontend/src/lib/api-client.ts` (currently unrouted). `server.Config.WorkDir` ("directory where log files are stored") is likewise set in `main.go` and never read — delete it; this endpoint takes absolute paths, not `WorkDir`-relative names. Rename the DTO field to `path` (keep `log_file_name` as a deprecated alias for one release: accept both, document `path`).
- **Session model is reused, not replaced.** The caller first does `POST /ingest/start` with `IngestSessionOptions` exactly as the wizard does (pattern, timestamp config, multiline, meta `_src`), then `POST /ingest/file {session_id, path}`. The server runs the same decode → `postProcess` → `StoreWithIDs` pipeline the chunk endpoint uses (`handlers/ingest.go`), so parsing behavior is byte-identical between browser upload and path import. `POST /ingest/end` closes the session as today. This keeps the wizard's preview/detect steps (which read the first 1 MB in the browser) unchanged — the wizard only swaps the *upload* step.
- **Preview by path too:** add `POST /api/v1/parse/preview-file {path, bytes?}` returning the first N (default 100) lines so the native flow never needs webview file access. The wizard uses it when a native path is available; otherwise it keeps `readFilePreview`.
- **Asynchronous with progress.** `POST /ingest/file` returns `202 {job_id}` immediately; progress arrives on the existing live SSE stream (`GET /api/v1/live/events`) as a new event type `ingest_progress {job_id, session_id, path, bytes_read, bytes_total, lines, rows_stored, rows_failed, rate_lines_per_s, state: running|done|cancelled|error, error?}` emitted at most every 250 ms and on state change. `DELETE /api/v1/ingest/jobs/{job_id}` cancels. `GET /api/v1/ingest/jobs` lists active jobs (for reconnecting UIs). Reuse the hub in `handlers/live.go` for publication; do not add a second SSE endpoint. **Note for implementers:** subscribers are created with a source filter (`Subscribe(sourceFilter)`) and rows are routed per source in `publishRows`; `ingest_progress` is a job event, not a row event — it must reach every subscriber regardless of their source filter (add a `publishBroadcast(event)` beside `publishStatus` rather than threading it through the row path).
- **Reader package `backend/pkg/ingestfile/`** (pure, no HTTP): `Open(path) (*Reader, Info, error)` — detects compression by **magic bytes** (gzip `1f 8b`, zstd `28 b5 2f fd`; extension is only a hint), exposes a line iterator with the same physical-line limit as chunk ingest (`MaxIngestLineBytes`, 2 MiB) and BOM stripping, reports `bytes_read` of the *compressed* stream for progress (uncompressed size is unknown for gzip), and supports cancellation via context. Add `github.com/klauspost/compress` for zstd + faster gzip (pure Go, widely used).
- **Rotated sets:** `ExpandRotation(path)` returns the ordered set for a base file: `app.log.9.gz … app.log.1 (.gz) → app.log`, and `app-2026-08-31.log`-style date suffixes sorted ascending. Rule: numeric suffix descending = oldest first; date suffix ascending; the unsuffixed file last. Opt-in per request via `"include_rotated": true`; all members share one `_src` (the base name) and one session so `_seq` is monotonic across members.
- **Path policy** (same stance as `now-04`): any absolute path the server process can read. Reject relative paths, reject directories (this endpoint is for files; directories go to folder watch), resolve symlinks and **echo the canonical path** in the job so the user sees what was actually read. Windows paths (`C:\…`, UNC) must work — use `filepath` throughout, never string-split on `/`.
- **Bounds:** per-line 2 MiB (existing), no total-size cap (this is the point), but a hard **per-job wall-clock ceiling of 6 h** and cancellation on server shutdown (jobs are attached to the server's cleanup context). Memory stays bounded by the batch size (10k lines per `StoreWithIDs` call, matching chunk ingest).
- **Native shell change (macOS):** `openNativeFiles` and the drop/`openFiles` paths call `deliverNativePaths(paths)` which sets `window.__logsonicPendingNativeFiles = {paths: [...]}` and dispatches the existing `logsonic-native-files` event with a `paths` field. The Import wizard, when it sees `paths`, uses `preview-file` + `ingest/file` instead of `File` objects. `NativeFileSchemeHandler` stays for browser-mode fallback only; delete `maxNativeDropBytes`. Drop the `["log","txt","json"]` extension guard (the server sniffs).

## Current-state anchors

- Chunk ingest pipeline: `handlers/ingest.go` — `HandleIngestStart`, `HandleIngest` (decode + `postProcess` + `StoreWithIDs`), `HandleIngestEnd`, `sessionMap`, limits at the top of the file.
- Live hub for SSE publication: `handlers/live.go` (`publishRows`, `publishStatus`, `writeSSE`); event DTOs `types.go:107–148`.
- Dead code to claim: `types.IngestFileRequest` (`types.go`), `ingestFile()` (`api-client.ts:131`).
- Wizard upload step: `components/Import/hooks/useUpload.ts`; file reading: `components/Import/LocalFileImport/FileSelectionService.ts` (`readFilePreview`, `streamFileChunks`); native handoff: `window.__logsonicPendingNativeFiles` consumed somewhere under `components/Import/` (grep `logsonic-native-files`).
- macOS shell: `LogsonicApp.swift` — `NativeFileSchemeHandler` (lines 73–117), `openNativeFiles` (~829), `deliverNativeFiles` (~860), `maxNativeDropBytes` (38).
- Route registration: `server.go` inside the `/api/v1` timeout group. **The file endpoint itself returns in milliseconds (202)**, so it can live inside the timeout group; the *job* runs on its own goroutine.

## API contract

```
POST /api/v1/ingest/file
  body: { "session_id": "…", "path": "/abs/path/app.log", "include_rotated": false }
  202: { "status": "accepted", "job_id": "…", "path": "/canonical/path", "members": ["…"] }
  400: ErrorResponse (relative path, directory, unreadable, bad session)
GET  /api/v1/ingest/jobs           → { "jobs": [IngestJob] }
DELETE /api/v1/ingest/jobs/{id}    → 200 { "status": "cancelling" } | 404
POST /api/v1/parse/preview-file
  body: { "path": "...", "lines": 100 }
  200: { "lines": ["…"], "approx_lines": 123456, "compressed": "gzip"|"zstd"|"", "size_bytes": n }
SSE event "ingest_progress": IngestJob (see decision list for fields)
```

Go types go in `pkg/types/types.go` (`IngestFileRequest` updated, `IngestJob`, `PreviewFileRequest/Response`); mirror in `api-types.ts`; swaggo annotations + regen.

## Step-by-step

1. `pkg/ingestfile/`: `reader.go` (open, sniff, line iterator, limits, ctx cancel), `rotation.go` (`ExpandRotation`), `reader_test.go`, `rotation_test.go`. Add the compress dependency.
2. `handlers/ingest_file.go`: job registry (`map[jobID]*job`, mutex), `HandleIngestFile` (validate → resolve → spawn goroutine → 202), `HandleListIngestJobs`, `HandleCancelIngestJob`, `HandlePreviewFile`. The goroutine reads batches of 10k lines and calls the *same* decode/store function `HandleIngest` uses — refactor that body into `ingestLines(session, lines) (processed, failed, err)` so both paths share it. Publish `ingest_progress` via the hub. Attach jobs to the cleanup ctx (`StartLive` pattern).
3. Routes in `server.go`; swaggo; regen.
4. Frontend: `api-types.ts`, `api-client.ts` (fix `ingestFile`, add jobs + preview-file), `useLogStream.ts` learns `ingest_progress`, `useImportStore` gets `nativePaths`, wizard step components branch on native paths; `UploadingStep.tsx` renders progress from SSE (rows/s, bytes, ETA, current member) with a Cancel that calls the job DELETE.
5. macOS shell: paths instead of scheme URLs (see decision list); remove the size cap and extension guard; keep the scheme handler for `--browser` mode.
6. Docs: `docs/getting-started.md` (native drop of large/compressed files), `docs/configuration.md` (no new flags), `docs/live-streaming.md` (new SSE event).

## Test cases

**`pkg/ingestfile` (unit, `t.TempDir()`):**

| # | Case | Pass criterion |
|---|------|----------------|
| R1 | plain file, 3 lines, CRLF + BOM | 3 lines, BOM stripped, `\r` stripped |
| R2 | gzip with `.log` extension (wrong ext) | sniffed as gzip; lines correct |
| R3 | zstd | lines correct |
| R4 | line > 2 MiB | error names the line number |
| R5 | ctx cancelled mid-read | iterator returns ctx error within one batch |
| R6 | `ExpandRotation("app.log")` with `app.log`, `app.log.1`, `app.log.2.gz`, `app.log.10` | order: `.10, .2.gz, .1, app.log` |
| R7 | date-suffixed set | ascending date order, base last |
| R8 | relative path / directory / missing | typed errors |
| R9 | symlink → canonical path echoed | `Info.CanonicalPath` resolved |

**Handler / integration:**

| # | Case | Pass criterion |
|---|------|----------------|
| H1 | start session → ingest/file (10k-line fixture) → poll SSE | `done`, `rows_stored == 10000`, rows searchable, `_seq` monotonic |
| H2 | same fixture via chunk upload and via path | identical docs (compare `_raw`, fields, timestamps) — the parity test |
| H3 | cancel at ~50 % | state `cancelled`; no further rows; session still closable |
| H4 | `include_rotated` with 3 members | one `_src`, ordered `_seq`, `members` echoed |
| H5 | 200 MB generated file | memory RSS delta < 150 MB during the job (measure with `runtime.MemStats` in test or `ps`) |
| H6 | server shutdown during job | job cancelled; indices close cleanly; no panic |
| H7 | Windows-style path on Windows CI (or `filepath` unit test) | accepted |
| H8 | preview-file on gzip | first 100 lines decoded; `compressed: "gzip"` |

**E2E:** drop `sample-logs/bgl-supercomputer.log` gzipped (`gzip -k`) through the native path in the wizard (dev harness can call the API directly) → progress renders → rows searchable → `_src` correct.

**macOS manual:** drag a 1 GB file onto the Dock → import starts within 1 s, progress visible, cancel works, no memory spike in Activity Monitor; Finder "Open With" on a `.gz` works; `--browser` mode still uses the scheme handler.

## Manual validation

1. Time-to-first-rows on a 1 GB file (budget §8: < 10 s) — record the number in the PR.
2. Compare storage size and doc counts of chunk-upload vs path import of the same file (must match).
3. Kill the server mid-import (`kill -9`) → restart → `logsonic doctor` (once `now-13` exists) or `/info` shows consistent counts; no duplicate rows after re-import of the same file? (Doc IDs are timestamp+source+seq; a re-import of the same file is a *duplicate by design* today — document that; `now-10` adds source-level delete.)

## Acceptance criteria

- [ ] Path import and chunk upload produce identical documents (H2).
- [ ] gzip, zstd, rotated sets, cancellation, progress over SSE all green.
- [ ] Native app drops a > 512 MB file successfully; cap and extension guard removed.
- [ ] Memory bounded (H5); no new external network calls; Swagger + `api-types.ts` in sync.
- [ ] `pkg/ingestfile` has no HTTP imports (it is the shared reader for `now-04`/`now-12`).

## Out of scope

Folder/directory ingestion (`now-04`), `logsonic open` CLI (`now-12`), remote paths (S3/SSH — plugin charter), tar archives, encrypted files, dedupe on re-import (`now-10`).
