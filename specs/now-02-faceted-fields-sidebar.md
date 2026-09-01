# now-02 — Faceted fields sidebar (ship issue #10)

**Horizon:** Now (v1.7) · **Size:** M (1–2 weeks) · **Priority:** P0
**TBD.md ref:** §2 (P2 defect: #10 closed-but-unshipped), §5 v1.7, §7 Structure. **Owns** the Bleve value-escaping helper in `lib/utils.ts` (reused by next-08 inspector filters and next-09 autocomplete).
**Read `specs/README.md` first** for dev setup and codebase map.

## Goal

A Splunk-style "Fields" panel: for the current search result, list every parsed field with its distinct top values and counts. Clicking a value adds `field:"value"` to the query (filter); alt-click adds `-field:"value"` (exclude). This is the most-requested analytical feature (GitHub issue #10, closed 2026-04-27 without shipping).

## Architectural decision (made — do not re-litigate)

**Phase 1 computes facets server-side by aggregating over the hits the search already returns — NOT via Bleve terms facets.**

Why: Bleve terms facets on analyzed text fields return *analyzer tokens*, not whole field values (`"connection timeout"` would facet as `connection` and `timeout`). Getting whole-value facets from Bleve requires a keyword-analyzer sub-field in the index mapping — which forces a **reindex of all existing user data**. We deliberately avoid that.

**Accepted limitation (state it in the UI and code comments): top values are computed over the bounded result set of the current query window, not the whole corpus.** The search path already bounds per-index hits (`searchRequest.Size` in `storage/search.go:146`) and post-filters by time. Counts are exact *for the returned window* and labeled as such ("top values in results"). Do NOT "fix" this by scanning the corpus — the Bleve keyword-mapping path is noted as a future optimization in `later-charters.md` and requires a migration plan.

Also decided:

- Facet aggregation runs **inside the existing per-day fan-out** (`storage/search.go:42`): each day-goroutine aggregates its own hits into a local `map[field]map[value]count`, and the collector merges maps. Do not add a second search pass.
- Response caps: max **50 fields**, max **8 values per field** in the HTTP response (UI shows 5, "show more" reveals 8), values truncated to 120 chars with a `truncated: true` flag. Fields starting with `_` (internal: `_id`, `_src`, `_raw`) are excluded except `_src`.
- High-cardinality guard: if a field has more distinct values than 50% of the doc count sampled (e.g. IDs, timestamps), mark it `high_cardinality: true` and return only the distinct count, no values. Skip `timestamp` entirely.
- `_src` is special: once the sources catalog (now-10) exists, the `_src` facet lists **every** source with exact corpus counts from the catalog instead of window-scoped counts; until then it is window-scoped like every other field.
- Facets are **opt-in per request** via `include_facets=true` so the hot search path and MCP `query_logs` pay nothing when they don't need it.

## Current-state anchors

- Search endpoint: `HandleReadAll`, `backend/pkg/server/handlers/logs.go:38` (GET `/api/v1/logs`, params documented in the swaggo block at lines 19–37: `limit, offset, sort_by, sort_order, start_date, end_date, query, _src, fields, include_distribution`).
- Search implementation: `backend/pkg/storage/search.go:42` — per-day-index goroutine fan-out, results merged in the collector loop (lines 207–219).
- Response DTO: `types.LogResponse`, `backend/pkg/types/types.go:256`.
- Storage interface: `backend/pkg/storage/storage.go:26`.
- Frontend query state: `frontend/src/stores/useSearchQueryParams.ts` (state interface line 8, store line 141) — this is where the query string is composed/updated.
- Sidebar slot: `frontend/src/components/Home/SidebarPanel.tsx` hosts panels; `Sidebar/CollapsiblePanel.tsx` is the collapsible wrapper; `Sidebar/ColorRulesPanel.tsx` is the pattern to copy.
- Left rail: `frontend/src/components/Shell/LeftRail.tsx` (add a Fields icon/entry).
- API client + types: `frontend/src/lib/api-client.ts`, `frontend/src/lib/api-types.ts`.

## API contract

Extend GET `/api/v1/logs` (no new endpoint):

Request: add query param `include_facets` (boolean, default `false`).

Response: add an optional top-level field to `LogResponse`:

```jsonc
{
  // ...existing LogResponse fields...
  "facets": {
    "computed_over": 4504,          // hits aggregated (== total hits in window)
    "fields": [
      {
        "name": "level",
        "distinct": 5,
        "high_cardinality": false,
        "values": [
          { "value": "INFO",  "count": 2210, "truncated": false },
          { "value": "DEBUG", "count": 1890, "truncated": false }
        ]
      },
      {
        "name": "tid",
        "distinct": 1841,
        "high_cardinality": true,
        "values": []
      }
    ]
  }
}
```

Go types (add to `pkg/types/types.go`, mirror in `lib/api-types.ts`):

```go
type FacetValue struct {
    Value     string `json:"value"`
    Count     int    `json:"count"`
    Truncated bool   `json:"truncated"`
}
type FacetField struct {
    Name            string       `json:"name"`
    Distinct        int          `json:"distinct"`
    HighCardinality bool         `json:"high_cardinality"`
    Values          []FacetValue `json:"values"`
}
type FacetsResponse struct {
    ComputedOver int          `json:"computed_over"`
    Fields       []FacetField `json:"fields"`
}
```

Update the swaggo annotations on `HandleReadAll` and regenerate Swagger docs.

## Step-by-step

**Backend**

1. `pkg/storage/facets.go` (new): `AggregateFacets(hits []map[string]interface{}) *types.FacetsResponse` — pure function over merged results; unit-testable without Bleve. Implement caps, `_`-field exclusion, `timestamp` skip, high-cardinality rule, value truncation at 120 chars, deterministic ordering (fields by name; values by count desc, then value asc).
2. Wire into the search path: simplest correct integration is to call `AggregateFacets` on the merged result slice in the handler layer (`logs.go`) *after* `Search()` returns and *before* pagination slicing — the merged slice is the full window, pagination happens later in the handler. Confirm by reading `HandleReadAll`; if pagination is applied inside storage, aggregate in the per-day goroutines and merge maps instead.
3. Add `include_facets` param parsing in `HandleReadAll`; populate `LogResponse.Facets` only when true.
4. Swaggo annotations + `swag init` regen (see `docs/development.md`).

**Frontend**

5. `lib/api-types.ts`: add `FacetValue/FacetField/FacetsResponse`; extend `LogResponse` type.
6. `lib/api-client.ts`: pass `include_facets=true` from the main search call (the sidebar is on by default; pass `false` when the panel is collapsed — read collapsed state from the new store).
7. New store `stores/useFacetStore.ts`: holds `facets`, `panelOpen`, `expandedFields: Set<string>`. Follow conventions in `stores/README.md`.
8. New component `components/Home/Sidebar/FieldsPanel.tsx` modeled on `ColorRulesPanel.tsx` inside a `CollapsiblePanel`:
   - Each field row: name (mono), distinct count (dim), chevron to expand.
   - Expanded: top 5 values as rows — value (mono, truncated middle-ellipsis), count right-aligned `tabular-nums`, a subtle horizontal bar proportional to count/max.
   - Click value → append ` +field:"value"` to the query in `useSearchQueryParamsStore` and re-run search. Alt/⌥-click → append ` -field:"value"`. If the exact clause is already present, clicking removes it (toggle).
   - "Show more" reveals values 6–8. High-cardinality fields render "1,841 distinct values" with no value list.
   - Header shows "top values in results" caption (the accepted-limitation label).
9. Register the panel in `SidebarPanel.tsx` + add a `Layers`/`ListFilter` lucide icon entry in `Shell/LeftRail.tsx`.
10. Query composition: values must be escaped for Bleve query-string syntax — wrap in double quotes and backslash-escape embedded `"` and `\`. Put this in a helper in `lib/utils.ts` with unit tests (this is the classic bug source).

## Test cases

**Backend unit (`pkg/storage/facets_test.go`):**

| # | Case | Pass criterion |
|---|------|----------------|
| B1 | 3 docs, fields level/service | correct counts, sorted by count desc then value asc |
| B2 | field with 200 distinct values over 210 docs | `high_cardinality: true`, empty values, distinct=200 |
| B3 | `_id`, `_raw` present | excluded; `_src` included |
| B4 | `timestamp` field | never appears |
| B5 | value of 500 chars | truncated to 120, `truncated: true` |
| B6 | 80 fields present | response capped at 50 fields |
| B7 | empty hit slice | `computed_over: 0`, empty fields, no panic |
| B8 | mixed value types (float64 from JSON logs) | stringified consistently, no panic |

**Backend handler (`handlers` test or curl-level):**

| # | Case | Pass criterion |
|---|------|----------------|
| H1 | `GET /api/v1/logs?include_facets=true&query=level:ERROR` | `facets` present; every value count ≤ total hits |
| H2 | same without `include_facets` | `facets` absent (omitempty), response byte-identical to pre-change shape |
| H3 | facets + `_src` filter + time range | facets respect all filters |

**Frontend unit (vitest):** escaping helper — value with spaces → quoted; embedded quote → escaped; toggle removes existing clause.

**E2E (new `frontend/e2e-facets.mjs`, copy the harness from `e2e-test.mjs`):** import `sample-logs/linux-syslog.log` → open Fields panel → assert `level` (or equivalent parsed field) appears with counts → click top value → search re-runs and result count drops to that value's count → alt-click another value → query contains `-field:"…"`.

## Manual validation

1. Import `sample-logs/apache.log` + `sample-logs/linux-syslog.log` together; confirm the panel shows union of both files' fields and `_src` facets show both sources.
2. Import `sample-logs/app-json.log` (JSON logs → numeric fields); confirm no crash and sane display.
3. Performance: import `sample-logs/bgl-supercomputer.log` (large); search `*` over full range with panel open; search latency shown in the status bar should not grow more than ~20% vs `include_facets=false`. If it does, aggregate in the fan-out goroutines (step 2 alternative).
4. Collapsed panel → network tab shows `include_facets=false`.

## Acceptance criteria

- [ ] Fields panel lists parsed fields with top values + counts for the current query window, labeled "top values in results".
- [ ] Click filters, alt-click excludes, second click toggles off; queries are correctly escaped.
- [ ] `include_facets=false` path is byte-identical to today's response.
- [ ] All test tables above green; Swagger regenerated; `api-types.ts` in sync.
- [ ] GitHub issue #10 referenced in the PR description ("ships #10").

## Out of scope

- Whole-corpus facet counts / Bleve keyword-mapping reindex (future optimization, `later-charters.md`).
- Facet-driven autosuggest in the search bar.
- MCP exposure of facets (spec `next-05-mcp-depth.md`).
