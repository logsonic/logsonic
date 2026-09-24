# next-03 — Pattern clustering (Drain-style template mining)

**Horizon:** Next · **Size:** L · **Priority:** P1. Medium-depth spec.
**Read `specs/README.md` first.**

## Goal

"3,000,000 lines → 42 patterns." A Patterns view that mines log-message templates (`Connection to <*> failed after <*> ms`), shows count + first/last seen + trend per pattern, sorted by count or novelty, with drill-down to matching rows. Kills the large-dump problem; feeds the `get_log_patterns` MCP tool (next-05).

## Design decisions (made)

- **Algorithm: Drain** (fixed-depth parse tree over tokenized messages; similarity threshold ~0.5; depth 4; max 100 children/node). Implement in pure Go (`backend/pkg/patterns/`) — the algorithm is ~300 lines; do NOT vendor a library (none is maintained for Go at quality). Cite the Drain paper (He et al., ICWS 2017) in the package doc.
- **Mining is on-demand over a query window, not at ingest.** Rationale: ingest-time mining would require storing/migrating cluster state per index and slows the hot path; on-demand mining over the (already bounded) search window is stateless, always fresh, and respects filters. Accepted cost: repeated mining on repeated views — mitigate with a small LRU keyed by (query, range, sources) with 60 s TTL.
- Input field: `message` (the free-text remainder after Grok parsing); fall back to the raw line when absent. Numbers, hex ids, quoted strings, and IP/email tokens (the smart-decoder regexes in `pkg/tokenizer/tokenizer.go:18` are the precedent) are masked to `<*>` BEFORE tree insertion — masking quality is 80% of output quality; make the masker its own tested unit.
- API: `GET /api/v1/patterns?query=&start_date=&end_date=&_src=&sort=count|novelty&limit=100` → `{computed_over, truncated, patterns: [{id, template, count, percent, first_seen, last_seen, trend: [12 bucket counts], example}]}`. `novelty` = patterns whose first_seen is inside the last 20% of the window, then by count. Mining cap: 1M rows per request (`truncated: true` beyond); runs inside the existing per-day fan-out collector (mine after merge, single-threaded is fine — Drain is O(n·depth)).
- UI: a "Patterns" toggle within the results area (tab alongside the table — placement matches `SourceTabs`/viewer header patterns). Row: template (mono, `<*>` rendered as a dim chip), count + %, sparkline trend, first/last seen. Click → runs a search for that pattern's rows (store pattern→example matcher: convert template to a phrase query of its constant tokens — accept imprecision, document it in a tooltip).

## Anchors

`storage/search.go:42` fan-out collector (mining hook point), `pkg/tokenizer/tokenizer.go:18` (masking regex precedent), `handlers/logs.go` (param parsing style), viewer header/tab components (`LogViewer/LogViewerHeader.tsx`, `SourceTabs.tsx`), `dataviz`-grade sparkline in Recharts (histogram precedent `LogDistributionChart.tsx`).

## Test cases

Unit (`pkg/patterns`): P1 identical lines → 1 pattern, count N; P2 `user 42 logged in` / `user 97 logged in` → `user <*> logged in`; P3 masking matrix (ints, floats, hex, uuid, ip, email, quoted strings); P4 dissimilar lines stay separate (threshold respected); P5 100k synthetic lines from 20 templates → exactly 20 patterns recovered ≥99% purity; P6 determinism (same input → same templates across runs); P7 1M-line benchmark < 5 s on dev hardware (Go benchmark, not CI-gated). Handler: params respected; cache TTL; truncation flag. E2E: import `sample-logs/bgl-supercomputer.log` → Patterns view loads < a few seconds → top pattern drill-down filters the table.

## Acceptance criteria

- [ ] BGL sample (real supercomputer log) reduces to a two-digit pattern count with sane templates (manual eyeball + snapshot test of top-10 templates as a golden file).
- [ ] Unit matrix green; benchmark recorded in PR.
- [ ] MCP consumption unblocked: response shape agreed with `next-05` (same JSON).

## Out of scope

Ingest-time incremental clustering, cross-window pattern identity (ids are per-mine), anomaly scoring beyond `novelty` sort, non-message-field clustering.
