# next-06 — Compare mode (time-range / source diff)

**Horizon:** Next · **Size:** M · **Priority:** P2. Medium-depth spec.
**Depends on:** now-02 (facets), ideally next-03 (patterns make the diff meaningful).
**Read `specs/README.md` first.**

## Goal

Answer "what's different about today?" directly: compare window A vs window B (or source A vs source B) and show what appeared, disappeared, and changed frequency — at the pattern level when clustering is available, at the facet level always.

## Design decisions (made)

- **Compare = two parallel analyses + a client-side diff of their summaries.** No new storage or index work: endpoint `GET /api/v1/compare` runs the existing facet (and, when available, pattern) computations for both windows server-side and returns both summaries plus computed deltas. Server computes the deltas (single source of truth for the math); UI renders.
- Delta model per pattern/facet-value: `{key, count_a, count_b, ratio, status: new|gone|up|down|flat}` — `new` = absent in A; `up/down` = ratio beyond ±50% with min count 5 (thresholds constant, documented); sorted by |log ratio|·max(count) so big movers top the list.
- UI entry: a "Compare" action (palette + a button near the date-range picker). Compare panel: A/B range pickers (B defaults to "same duration immediately before A"), optional per-side source filter, then three sections — New in B, Gone in B, Changed — each row clickable to run the underlying query scoped to the right window.
- Cap: same 1M-row bounds as patterns; `truncated` flags per side.

## Anchors

Facets (now-02) + patterns (next-03) computation paths; date-range UI `frontend/src/components/DateRangePicker/`; `useSearchQueryParamsStore` (window/source state — compare state gets its OWN store, `useCompareStore`, so it can't corrupt normal search state).

## Test cases

Unit (delta math, pure): D1 value in both → ratio/status correct at threshold edges (49% vs 51%); D2 absent in A → `new`; D3 absent in B → `gone`; D4 below min-count → excluded; D5 ordering stable/deterministic. Handler: both windows respect their own filters; source-vs-source with same time window; truncation flags. E2E: import apache.log; compare first half of its time range vs second half; assert sections render and clicking a "new" row runs a search bounded to window B.

## Acceptance criteria

- [ ] Compare panel answers appeared/disappeared/changed for both time-vs-time and source-vs-source.
- [ ] Delta math unit-tested at edges; deterministic ordering.
- [ ] Zero impact on normal search state (separate store).

## Out of scope

Statistical significance testing, saved comparisons, >2-way compare.
