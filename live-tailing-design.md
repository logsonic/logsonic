# Live Tailing - Design & Implementation Plan

> Status: **design reviewed, implementation deferred.** No live-tail code exists yet.
> Re-verify file and line references before editing; this proposal was reviewed against the current worktree.

## Goal

Add real-time monitoring for a log source and render newly parsed rows in the web UI without turning the table into a per-line render loop.

Supported v1 sources:
- Server-side file follow with `tail -f` semantics.
- STDIN piped through the CLI.

The UI must include Pause / Resume while ingestion and indexing continue in the background.

## Product Decisions

| Question | Decision |
|---|---|
| Transport | **SSE** for server-to-browser row delivery |
| Start trigger | **CLI only** for v1 |
| UI start button | Deferred |
| Pause semantics | **Freeze + continue-from-now** |
| Live display retention | Capped in-memory ring buffer, search remains the durable source |

Pause means the server stops sending rows to that subscriber. On resume, the subscriber continues from the newest row and receives a count like "N lines arrived while paused; still searchable." It does not replay missed rows from the search index.

## Why SSE

- The stream is one-way: server to browser.
- Browser `EventSource` gives reconnect behavior without frontend dependencies.
- Pause and resume are infrequent control calls and fit ordinary `POST` endpoints.
- It keeps the feature smaller than a WebSocket stack while matching the actual data flow.

## Critical Constraints

### 1. Root Middleware Cannot Wrap Long-Lived Requests

`backend/pkg/server/server.go` currently applies these to all routes with `r.Use`:
- `middleware.Timeout(cfg.Timeout)` at 60 seconds.
- `middleware.ThrottleBacklog(10, 50, 5*time.Second)`.

Both are wrong for SSE and long-lived STDIN ingest. Timeout will close the stream after 60 seconds. ThrottleBacklog is worse: a small number of held-open streams can consume the global in-flight request budget and starve regular API calls.

chi parent middleware applies to mounted routes and subrouters, so moving live endpoints into a subgroup is not enough if the root still has these middleware.

**Required route shape:**

```go
r.Use(RequestID, RealIP, logger wrapper, Recoverer, security headers, CORS)

// Long-lived endpoints outside Timeout/ThrottleBacklog.
r.Get("/api/v1/live/events", h.HandleLiveEvents)
r.Post("/api/v1/live/stdin", h.HandleLiveStdin)

// Normal REST API inside Timeout/ThrottleBacklog.
r.Group(func(r chi.Router) {
    r.Use(middleware.Timeout(cfg.Timeout))
    r.Use(middleware.ThrottleBacklog(10, 50, 5*time.Second))
    r.Route("/api/v1", func(r chi.Router) {
        // existing routes plus pause/resume controls
    })
})
```

Register API routes before the catch-all static handler. The current `server.go` registers `r.HandleFunc("/*", serveWithMimeType)` before `r.Route("/api/v1", ...)`; if that remains, test live routes explicitly so the catch-all does not shadow them.

### 2. Timestamp Resolution Must Be Stateful Per Source

`backend/pkg/server/handlers/decode.go::postProcess` calls `buildResolution`, then creates a new `timeresolve.Resolver` for every ingest request. That is acceptable for chunked batch import only because chunks are relatively large and session sequencing is separate.

Live tailing must not re-sniff every tiny flush. `timeresolve.Resolver` owns carry-forward and rollover state, so recreating it per flush can produce wrong timestamps around missing timestamp fields and date rollover.

**Required extraction:**
- Keep the existing batch behavior intact.
- Extract the per-line conversion loop into a helper that accepts:
  - decoded `[]l2g.LineResult`,
  - `types.IngestSessionOptions`,
  - a prebuilt `*timeresolve.Resolver`,
  - a persistent `*atomic.Int64`,
  - the resolved synthetic timestamp settings.
- Build the live source resolver once from an initial sample, then let the source goroutine own it.

`timeresolve.Resolver` is mutable. Do not share one resolver across goroutines.

### 3. Document ID Uniqueness Depends On Long-Lived Sequencing

`backend/pkg/storage/storage.go::Store` derives the doc ID from:

```go
fmt.Sprintf("%d-%s-%d", timestamp.UnixNano(), source, seqID)
```

If a live stream recreated its sequence counter on browser reconnect, rows sharing a timestamp and source could overwrite existing documents.

**Required ownership rule:** the producer owns `_seq`, not the viewer. A file tailer or STDIN upload creates exactly one long-lived `atomic.Int64` for that source. Browser reconnects, pause, resume, and tab reloads must never reset it.

### 4. Search Polling Is Not A Live Transport

`backend/pkg/storage/search.go::Search` sets `searchRequest.Size = 1_000_000` per shard and filters exact time ranges in memory. Polling that endpoint for live rows would repeatedly rescan large shard windows.

Live rows must flow through an in-process hub after successful persistence. Normal search remains the source of truth for rows skipped by pause, overflow, reconnect, or UI ring-buffer eviction.

Bleve/scorch `Batch()` is synchronous in this code path: once `Store` returns, rows are searchable. Publish after `Store` succeeds.

### 5. Live Rows Must Match Existing Row Shape

The frontend already relies on:
- `timestamp` as the displayed and default sort field.
- `_id` returned by search for stable row identity.
- `_seq` as an internal sort tie-breaker in backend search results, stripped before returning normal search responses.

Live-published rows should include `_id` so the UI can key, expand, and select rows by document ID. Today `Store` computes doc IDs internally and does not return them, so live ingest should either:
- refactor storage to return stored IDs, or
- use a shared doc ID helper before both storage and publish.

Avoid recomputing the ID in two places with subtly different conversions.

## Backend Design

### Core Objects

Add a tail manager in `package handlers` and attach it to `Services`.

Suggested shape:
- `TailManager`
  - map of active sources by source ID.
  - pub/sub hub for subscribers.
  - start/stop methods for file and STDIN sources.
  - shutdown method called from `Server.Start()` cleanup context.
- `TailSource`
  - source ID and display source name.
  - `*l2g.Decoder`.
  - one `*timeresolve.Resolver`.
  - one `*atomic.Int64`.
  - one goroutine that owns reading, decoding, resolving, storing, and publishing.
- `Subscriber`
  - subscriber ID.
  - bounded channel for outbound batches.
  - paused flag and skipped counters.

Do not reuse the existing `IngestSession` lifecycle for live tailing. `IngestSession` expires after 60 minutes and is shaped around request/response batch import.

### Source Lifecycle

File follow:
1. CLI calls a normal start endpoint with file path and parse options.
2. Server validates and starts a `TailSource`.
3. Tail source reads an initial sample to build timestamp resolution.
4. Tail source follows the file with a rotation-aware tailer.
5. Tail source stops on explicit stop, read error, or server shutdown.

STDIN:
1. CLI opens a long-lived chunked `POST /api/v1/live/stdin`.
2. Server creates a `TailSource` for that request.
3. Request body lines are read until EOF, client disconnect, or server shutdown.
4. EOF closes that source cleanly.

Use `github.com/nxadm/tail` for file follow unless a repository constraint appears during implementation.

### Decode And Publish Loop

For each coalesced read batch:
1. Decode lines with the source decoder.
2. Convert decoded results with the source-owned resolver and seq.
3. Store rows with `h.storage.Store`.
4. Invalidate the info cache after successful storage.
5. Publish rows to the live hub only after storage succeeds.

If storage fails, report an error event to subscribers and keep or stop the source based on error class. For v1, stopping the source on storage failure is simpler and defensible.

### Hub Semantics

The hub is display-only and must never block ingestion.

Recommended defaults:
- Per-subscriber buffered channel sized by batches, not individual lines.
- Drop-on-overflow for that subscriber only.
- Track dropped row count and send a `skipped` event when delivery resumes.
- Coalesce outbound SSE batches at about 250ms or a maximum row count, whichever comes first.
- Send heartbeat comments every 20s: `: ping\n\n`.

Because publish happens after durable storage, dropping from the live channel is acceptable.

## HTTP API

Keep endpoint names explicit and versioned.

### `GET /api/v1/live/events`

Held-open SSE endpoint, outside timeout and throttle.

Query parameters:
- `source_id` optional. Empty means subscribe to all active live sources.

Events:
- `hello`: `{ "subscriber_id": "...", "source_ids": [...] }`
- `rows`: `{ "source_id": "...", "rows": [...] }`
- `skipped`: `{ "source_id": "...", "count": 123, "reason": "paused|overflow|reconnect" }`
- `source_status`: `{ "source_id": "...", "status": "started|stopped|error", "message": "..." }`

Set:
- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`
- `X-Accel-Buffering: no`

Flush with `http.Flusher`; return if the request context is cancelled.

### `POST /api/v1/live/subscribers/{subscriber_id}/pause`

Ordinary JSON endpoint inside the normal throttled group.

Effect: mark that subscriber paused. Ingestion continues.

### `POST /api/v1/live/subscribers/{subscriber_id}/resume`

Ordinary JSON endpoint inside the normal throttled group.

Effect: mark that subscriber active and send the accumulated skipped count.

### `POST /api/v1/live/files`

Ordinary JSON endpoint inside the normal throttled group.

Called by `logsonic tail -f /path/to/file ...` to start a server-side file follow.

Body should reuse existing ingest options where possible:
- `source`
- `name`
- `pattern`
- `custom_patterns`
- `smart_decoder`
- timestamp overrides / `timestamp_config`
- `meta`
- `path`

Return `{ "source_id": "...", "status": "started" }`.

### `POST /api/v1/live/stdin`

Long-lived chunked request outside timeout and throttle.

Query parameters or headers carry the same parse options as the file endpoint. Prefer a small JSON metadata prelude only if implementation complexity stays low; otherwise use query params for v1 and document shell quoting carefully.

The response can remain open until EOF and return a final JSON summary. It does not need to be SSE.

## CLI

Add a `logsonic tail` subcommand alongside the existing `logsonic mcp` branch in `backend/main.go`.

```sh
logsonic tail -f /path/to/file [--url http://localhost:8080] [--source NAME] [--pattern NAME | --grok '...']
cmd | logsonic tail - [--url http://localhost:8080] [--source NAME] [--pattern NAME | --grok '...']
```

Defaults:
- `--url` falls back to `LOGSONIC_URL`, then `http://localhost:8080`.
- `--source` defaults to the file basename for `-f` and `stdin` for `-`.
- Pattern selection should mirror import as closely as possible. If no pattern is provided, use `DEFAULT_PATTERN` only if that is acceptable for current CLI behavior; otherwise fail clearly and ask for `--pattern` or `--grok`.

CLI responsibilities:
- For `-f`, send a start request and print the returned source ID.
- For `-`, stream stdin to `/api/v1/live/stdin` and exit nonzero on server error.
- Do not open the browser.

## Frontend Design

Add live mode without mutating `useLogResultStore.logData.logs`.

Suggested pieces:
- `useLogStream` hook owns `EventSource` lifecycle and closes it on cleanup.
- `useLiveLogStore` stores:
  - `enabled`
  - `connected`
  - `subscriberId`
  - `rows`
  - `skippedCount`
  - `paused`
  - `sourceStatuses`
- A capped ring buffer, about 1000 rows for v1.
- Batched store updates per 250ms or `requestAnimationFrame`, not one update per SSE message.

Table integration:
- In live mode, pass live rows as the table data source instead of `logData.logs`.
- Disable `PaginationControls`.
- Lock sort to `timestamp desc`.
- Disable manual sorting changes while live mode is enabled.
- Freeze `autofitColumns`; it currently runs on `logData` changes and via `ResizeObserver`.
- Use `_id` as TanStack row ID via `getRowId`. Current selection reads `logs[parseInt(id)]`, which is unsafe when rows are prepended.
- Clear or migrate `rowSelection` when entering live mode.

Header integration:
- Add a Live toggle and Pause / Resume control in `LogViewerHeader.tsx`.
- Use the existing compact button style patterns from `LogSearch.tsx`.
- Surface skipped rows as concise status text, not a modal.

Keep the current non-virtualized table for v1. `react-window` and `react-virtualized-auto-sizer` are already dependencies, but virtualization is a separate change because row expansion, selection, resizing, and sticky headers all need coordinated work.

## Testing Plan

Backend unit tests:
- `postProcess` parity after helper extraction.
- Live helper preserves resolver carry/rollover across multiple batches.
- Source-owned seq does not reset across subscriber reconnect.
- Hub pause/resume increments skipped counts and never blocks publish.
- Middleware route test proves SSE and STDIN endpoints are not wrapped by Timeout/ThrottleBacklog while normal API routes still are.

Backend integration tests:
- Start a file tail source, append lines, verify rows are stored and published.
- Simulate subscriber disconnect/reconnect and verify no doc ID collision.
- STDIN request EOF closes the source cleanly.

Frontend tests:
- `useLogStream` closes `EventSource` on unmount.
- Live store ring buffer drops oldest rows and increments skipped count.
- Live table uses `_id` row IDs.
- Pagination and sorting controls are disabled in live mode.

Manual end-to-end:
- `logsonic tail -f sample.log`, append lines, verify UI updates smoothly.
- `cmd | logsonic tail -`, verify stdin lines appear and become searchable.
- Pause for several seconds under load, resume, verify skipped count and searchability.
- Kill/reload browser tab, verify reconnect starts from now and ingestion continues.
- Rotate the tailed file and verify follow behavior.

## Implementation Order

1. Refactor `server.go` middleware so only normal REST routes get Timeout and ThrottleBacklog.
2. Extract the decode post-processing helper while preserving existing batch ingest behavior.
3. Add a shared storage/doc ID helper or return stored IDs so live rows can include `_id`.
4. Implement `TailManager`, `TailSource`, subscriber hub, and shutdown wiring.
5. Add SSE, pause/resume, file start, and STDIN endpoints.
6. Add the `logsonic tail` CLI subcommand.
7. Add frontend live store, `useLogStream`, header controls, table data switching, and live-mode guards.
8. Run backend, frontend, and manual end-to-end tests.

## Open Items

- UI-initiated tail start.
- Source stop/restart controls in the UI.
- Authentication is currently out of scope because LogSonic is local-first and existing APIs are unauthenticated.
- Backpressure thresholds after real high-volume testing.
- Virtualized live table.
