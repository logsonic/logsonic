# now-04 — Folder watch / auto-ingest

**Horizon:** Now (v1.8) · **Size:** M (1–2 weeks) · **Priority:** P1
**TBD.md ref:** §5 v1.8 (ambient value), §4 retention thesis. **Depends on:** now-08 (`pkg/ingestfile` — the server-side file reader; do not write a second one).
**Read `specs/README.md` first** for dev setup and codebase map.

## Goal

The user points LogSonic at a directory (e.g. `~/logs`); LogSonic ingests matching files that appear or grow, using a per-watch Grok pattern (or auto-detect), without the user touching the Import flow again. This is the first "ambient value" feature — the reason the app stays running between incidents.

## Design decisions (made)

- **Initial ingest of a newly discovered file goes through `pkg/ingestfile` (now-08)** — same reader, same gzip/zstd sniffing, same rotation-set logic — via the internal function behind `POST /ingest/file`, so a `.gz` that lands in the watched folder just works.
- **Reuse the live-tail file-follow machinery, not the import-session machinery, for growth.** `logsonic tail -f` already follows server-side files and indexes in the background (`backend/tail_cli.go`, `handlers/live.go`, `POST /api/v1/live/files`). A watched file that grows is exactly a tailed file. New files detected in the folder are ingested from offset 0 through the same path.
- **fsnotify for detection, with a polling fallback.** Use `github.com/fsnotify/fsnotify` on the watched directory (non-recursive in v1; recursive is a config flag defaulting to false). Because fsnotify misses events on some network mounts, run a reconciliation sweep every 60 s that compares directory listing + sizes against known state. The sweep is the source of truth; fsnotify is the low-latency hint.
- **Watch configs persist server-side** in a JSON file `<storage>/watches.json` (same pattern as `pkg/workspaces/store.go`) so watches survive restarts and exist independently of any browser session.
- **Dedup / resume:** track per-file `(path, inode/fileID, offset)` in the watch state. On restart, resume from stored offset if the file is unchanged (same inode, size ≥ offset); re-ingest from 0 if rotated (new inode) — standard tail rotation semantics, which `live.go` may already implement for `-f`; reuse if so.
- **Pattern selection:** each watch stores either `"auto"` (log2grok detection per new file, same as import) or a fixed saved Grok pattern name. Mixed folders default to `"auto"`.
- **Safety caps:** default include glob `*.log`, configurable; per-file size cap reuses the bounded-import limits from the existing import path (commit `c284235` added bounding/cancel — find and reuse those constants); max 100 tracked files per watch, oldest-mtime files skipped beyond that with a logged warning.
- Source naming: `watch.<dirname>.<filename>` to keep `_src` facet-friendly and collision-free.

## Current-state anchors

- Live file-follow: `POST /api/v1/live/files` handler `HandleLiveFileStart`, stop via `DELETE /api/v1/live/sources/{sourceID}` (`backend/pkg/server/server.go:277-280`); implementation in `backend/pkg/server/handlers/live.go` (887 lines — read the file-follow + rotation logic before writing any new follow code); request DTO `LiveFileRequest` (`pkg/types/types.go:107`).
- Import session bounding: `handlers/ingest.go` + `IngestSessionOptions` (`types.go:11`) — reuse size caps.
- Grok auto-detect: `handlers/grok.go`, `handlers/parse.go`, log2grok config loaded in `server.go:86`.
- Persistence pattern to copy: `backend/pkg/workspaces/store.go`.
- Services wiring: `handlers.NewHandler` (`handlers/handlers.go`), background start hooks in `server.go:330-335` (`StartSessionCleanup`, `StartLive`, `startRetention`) — the watch manager starts the same way and must stop on the same context cancel.
- Frontend settings page scaffold: `frontend/src/pages/settings/`. **Native folder picker already works:** `runOpenPanelWith` in `LogsonicApp.swift` presents `NSOpenPanel` with `canChooseDirectories` when the HTML input has `webkitdirectory` — use that attribute on the add-watch form; no shell change needed.

## API contract

New REST group under `/api/v1` (register in `server.go` inside the timeout group, BEFORE the SPA catch-all at line 294):

```
GET    /api/v1/watches            → { "watches": [Watch] }
POST   /api/v1/watches            → create; body WatchRequest; 201 + Watch
DELETE /api/v1/watches/{id}       → stop + forget (indexed data stays)
POST   /api/v1/watches/{id}/pause  → pause detection/ingest
POST   /api/v1/watches/{id}/resume
```

```go
type WatchRequest struct {
    Dir       string `json:"dir"`                 // absolute path, must exist, must be a dir
    Glob      string `json:"glob,omitempty"`      // default "*.log"
    Pattern   string `json:"pattern,omitempty"`   // "" or "auto" => auto-detect; else saved grok name
    Recursive bool   `json:"recursive,omitempty"` // default false
}
type Watch struct {
    ID        string      `json:"id"`
    WatchRequest
    Paused    bool        `json:"paused"`
    CreatedAt time.Time   `json:"created_at"`
    Files     []WatchFile `json:"files"` // status snapshot
}
type WatchFile struct {
    Path      string `json:"path"`
    Offset    int64  `json:"offset"`
    Size      int64  `json:"size"`
    State     string `json:"state"` // pending|ingesting|following|skipped|error
    Error     string `json:"error,omitempty"`
}
```

Validation errors → existing `types.ErrorResponse`. Reject non-absolute paths and paths that resolve outside the user's home + explicitly-allowed roots? **Decision: allow any absolute readable path** (this is a local, loopback-bound, single-user tool; the CLI can already read anything the user can) — but never follow symlinked directories out of the watch dir when `recursive`.

## Step-by-step

1. New package `backend/pkg/watch/`: `manager.go` (lifecycle: load `watches.json`, start goroutine per watch, fsnotify + 60 s sweep, context-cancel stop), `state.go` (per-file offset/inode tracking + JSON persistence, atomic write-rename), `manager_test.go`.
2. Ingest path: for a new/pending file, run detection (unless fixed pattern), then stream through the same parse+`StoreWithIDs` path the live tail uses; then hand the file to the follow loop. Read `live.go` first — if its file-follower is reusable as a library call, call it; do not fork a second follower implementation.
3. Handlers: `backend/pkg/server/handlers/watches.go` with swaggo annotations; wire routes in `server.go`; start/stop the manager beside `StartLive` (`server.go:332`) sharing `cleanupCtx`.
4. Swagger regen.
5. Frontend: `lib/api-types.ts` + `lib/api-client.ts` additions; new page section in `pages/settings/` ("Watched folders"): list with per-watch status (files, states, offsets), add-watch form (dir path text input + glob + pattern dropdown fed from the existing grok list call), pause/resume/delete. Native folder picker arrives with macos-b2; a text input is acceptable now.
6. StatusBar (`Shell/StatusBar.tsx`): if any watch is active, show a small `Eye`/`FolderSearch` indicator with tooltip "Watching N folders".

## Test cases

**Backend (`pkg/watch/manager_test.go` — use `t.TempDir()`):**

| # | Case | Pass criterion |
|---|------|----------------|
| W1 | create watch on dir with 2 matching files | both ingested; doc count > 0; states reach `following` |
| W2 | append lines to a followed file | new lines searchable within sweep interval (poll the search API in the test) |
| W3 | new file appears after watch starts | detected and ingested |
| W4 | non-matching file (`.txt` vs `*.log`) | ignored |
| W5 | file rotated (rename + recreate) | re-ingested from 0; no duplicate docs from the pre-rotation content (BuildDocID dedup, `storage.go:197`) |
| W6 | restart manager (stop, new manager, same state file) | offsets resume; no re-ingest of unchanged files |
| W7 | pause → append → resume | appended lines ingested after resume, not before |
| W8 | delete watch | goroutines exit (use goroutine-leak check), state file entry removed, indexed data intact |
| W9 | dir with 150 matching files | 100 tracked, warning logged |
| W10 | dir deleted while watched | watch errors gracefully, no panic, state=`error` |

**Handler level:** POST invalid dir → 400 `ErrorResponse`; GET reflects live states; pause/resume/delete return the expected shapes.

**E2E:** create a temp dir, add a watch via UI settings page, drop `sample-logs/apache.log` into the dir (copy), assert rows searchable in UI and `_src` starts with `watch.`.

## Manual validation

1. Watch a real dir; `echo 'test line' >> watched/app.log` several times; confirm searchability latency ≤ sweep interval.
2. Restart the backend; confirm watches resume without duplicate ingestion (search for a unique line — 1 hit, not 2).
3. macOS: watch a dir on an external volume to exercise the polling fallback.

## Acceptance criteria

- [ ] Watches persist across restarts, resume offsets, and survive rotation without duplicating documents.
- [ ] All W1–W10 green; no goroutine leaks; `go test ./...` green.
- [ ] Settings UI can create/pause/resume/delete watches and shows per-file states.
- [ ] Follow logic is shared with live-tail, not duplicated (PR must state which functions were reused).

## Out of scope

- Recursive watching default-on, network-mount tuning, journald/syslog listeners (`next-02`, plugin charter).
- Notifications on watch errors (next-04). Directory drops on the Dock (macos-b2 `watch-directory` action).
