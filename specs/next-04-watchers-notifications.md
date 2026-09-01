# next-04 — Watchers & local notifications

**Horizon:** Next · **Size:** M · **Priority:** P1. Medium-depth spec.
**Consumed by:** macos-b3 (native notification surface).
**Read `specs/README.md` first.**

## Goal

"Tell me when `level:ERROR` shows up in the tail." A watcher = a named query evaluated against **incoming live rows** (tails, watches, container sources, OTLP); hits emit events on the live SSE stream and increment counters; surfaces are the browser (toast + badge) and, on macOS, native notifications (macos-b3).

## Design decisions (made)

- **Evaluate at the live hub, pre-index.** Rows already flow through one publication point in `handlers/live.go`; watchers filter there against parsed rows. Do NOT implement by polling the search API — that's the amateur version (latency, load, missed rows during rotation).
- **Matching engine: compile the watcher's query to a Bleve query and run it against an in-memory single-doc match** — Bleve supports memory-only index matching but per-row indexing is too slow at high throughput. Decision: implement a small evaluator for the SUPPORTED SUBSET: conjunctions of `field:value`, `field:"phrase"`, negations, and bare terms (substring on message). Reject unsupported syntax at watcher-creation time with a clear error listing what's allowed. Subset covers the actual use cases (level:ERROR, service:api + timeout); full Bleve parity is explicitly not attempted.
- CRUD + persistence: `GET/POST /api/v1/watchers`, `DELETE /api/v1/watchers/{id}`, `POST .../pause|resume`; persisted in `<storage>/watchers.json` (same pattern as watches/workspaces). Watcher: `{id, name, query, sources?: [], throttle_seconds: 30, paused, created_at, hit_count, last_hit}`.
- Event: new SSE event type `watch_alert` on the existing `/api/v1/live/events` stream: `{watcher_id, name, query, count_in_burst, sample_row, at}` — throttled per watcher (`throttle_seconds` coalescing window; count accumulates in the burst). This is the contract macos-b3 builds against — freeze it first.
- Browser surface: toast (existing `use-toast`) + a bell icon in `StatusBar` with unseen count; click → apply watcher query. Watcher management UI in `pages/settings/` next to folder-watches.

## Anchors

`handlers/live.go` (hub/publication — find the single point rows pass through), SSE route `server.go:233`, event DTOs `types.go:125-148` (add `watch_alert` beside them), `pkg/workspaces/store.go` (persistence pattern), `hooks/useLogStream.ts` (browser SSE consumption — add the new event type), `Shell/StatusBar.tsx`, `hooks/use-toast.ts`.

## Test cases

Unit (evaluator): E1 `level:ERROR` matches/rejects; E2 phrase with spaces; E3 negation; E4 conjunction; E5 bare-term substring on message; E6 unsupported syntax (`wildcards`, OR, ranges) rejected at parse with helpful message; E7 case handling documented + tested (decide: field values case-insensitive match — consistent with Bleve's default analyzer behavior). Hub: H1 10k rows/s with 5 watchers — throughput within 10% of no-watcher baseline (benchmark); H2 throttling: 100 hits in window → 1 event with count=100; H3 paused watcher emits nothing; H4 restart → watchers reload, hit_counts persist. E2E: create watcher in UI → `logsonic tail` a file → append matching line → toast appears + bell increments → click bell → query applied.

## Acceptance criteria

- [ ] Alerts fire from live rows with coalescing; zero search-API polling.
- [ ] `watch_alert` SSE contract documented in `docs/live-streaming.md` (macos-b3 depends on it).
- [ ] Throughput benchmark recorded; unsupported queries fail fast at creation.

## Out of scope

Historical/scheduled alerting on indexed data, alert channels beyond toast/native (no email/slack — local-first), alert history browsing beyond hit_count/last_hit.
