# now-10 — Sources catalog, Sources panel, Storage settings

**Horizon:** Now (v1.8) · **Size:** M · **Priority:** P1
**TBD.md ref:** §2 P2 (source scan), §3 principles D6/D8, §5 v1.8, §7 Structure.
**Read `specs/README.md` first.**

## Goal

Three things a desktop log tool must let you do that LogSonic cannot today: **see what you have** (which sources, from where, how many rows, which pattern), **delete one source** (today: clear *everything*, or hand-select rows), and **manage storage** (retention is a CLI flag; per-day sizes are invisible). Underneath, replace `GetSourceNames()` — which scans up to 1M docs per day-index on every `/info` cache miss, and the cache is invalidated at six call sites — with a persisted catalog.

## Design decisions (made)

- **Catalog file:** `<storage>/sources.json`, atomic write (temp + rename), schema-versioned. Entry: `{name, origin: {kind: file|stdin|tail|watch|otlp|case, path?, host?}, pattern_name, pattern?, rows, bytes_raw, first_ts, last_ts, days: ["2026-08-30", …], created_at, updated_at, imports: [{at, rows, path, job_id?}]}`. Keyed by `name` (== `_src`).
- **Maintained on the write path, not by scanning:** `StoreWithIDs` callers (chunk ingest, path import, live tail, watch, OTLP) report `(source, rows, minTS, maxTS, bytes)` per batch through one `catalog.Record(...)` call in the handler layer (not inside storage — storage stays a dumb index). Debounced flush every 2 s and on shutdown.
- **Rebuild = truth reconciliation.** `catalog.Rebuild()` recomputes rows/days per source from the indices using **Bleve size-0 count queries per (source, day)** — O(sources × days) tiny queries, never a doc scan — and is run: at startup when the file is missing or its version is old, by `logsonic doctor --rebuild-catalog`, and after any operation that bypasses the write path (retention prune, `Clear`, `DeleteByIds`). The current scan-based `GetSourceNames()` is deleted.
- **Delete a source:** `DELETE /api/v1/sources/{name}` — for each day in the entry, run a term query on `_src` with the storage's existing `DeleteByIds` in batches of 5k (search-after over IDs only), then remove the entry; day-indices that reach zero docs are closed and removed from disk. Returns `{rows_deleted, days_touched}`. UI confirm shows the row count and origin path; the action is not undoable — say so in the dialog.
- **Rename:** UI-level only in v1 — rename updates the catalog and stores an `aliases` list; the index keeps the old `_src` value; search resolves aliases when building the `_src` filter. (Rewriting `_src` across millions of docs is a reindex; charter-level.)
- **Re-import from origin:** button enabled when `origin.path` exists and is readable → deletes the source then calls `POST /ingest/file` (`now-08`) with the recorded pattern. Two-step with a single confirm.
- **Storage settings page** (`/settings/storage`): retention days (persisted server-side in `<storage>/config.json`, overriding the CLI flag when set; the CLI flag becomes the *default*), per-day rows + bytes table with delete-day, total size, "Compact now" (no-op until `next-10` adds it — hide), "Reveal in Finder / Show in Explorer" (native only; browser mode shows the path with a copy button).
- **Consumers switch to the catalog:** `/info` `source_names` (and adds `sources` with counts), `StatusBar` source count, `SourceTabs`, `now-02` `_src` facet values, MCP `log_info`.

## Anchors

`storage/search.go` `GetSourceNames` (delete), `storage/storage.go` (`DeleteByIds`, `GetDocCount`, `PruneOlderThan`, `Clear`), `handlers/info.go` (cache + `InvalidateInfoCache` call sites — grep), `handlers/ingest.go` / `live.go` (write paths), `pkg/workspaces/store.go` (file persistence pattern), `server.go` (`startRetention` reads `cfg.RetentionDays` — make it consult the config file), `Shell/LeftRail.tsx`, `Home/SourceTabs.tsx`, `pages/settings/SettingsLayout.tsx` (NAV list), `stores/useSystemInfoStore.ts`.

## API contract

```
GET    /api/v1/sources                 → { sources: [SourceEntry] }
GET    /api/v1/sources/{name}          → SourceEntry
DELETE /api/v1/sources/{name}          → { rows_deleted, days_touched }
PATCH  /api/v1/sources/{name}          → body {display_name?} → SourceEntry
POST   /api/v1/sources/{name}/reimport → 202 {job_id}   (requires origin.path)
POST   /api/v1/sources/rebuild         → { sources: [...] }
GET    /api/v1/storage                 → { retention_days, days: [{date, rows, bytes}], total_bytes, path }
PUT    /api/v1/storage                 → body {retention_days} → same
DELETE /api/v1/storage/days/{date}     → { rows_deleted }
```

`/info` keeps `source_names` for compatibility and adds `sources: [{name, rows}]`.

## Step-by-step

1. `pkg/catalog/`: `catalog.go` (load/save/record/rebuild/delete/rename), `catalog_test.go`.
2. Wire `Record` into the four write paths; wire `Rebuild` after prune/clear/delete-by-ids; start/flush in `server.go` beside `StartLive`.
3. Handlers `handlers/sources.go`, `handlers/storage.go`; routes; swaggo; regen. Delete `GetSourceNames`; update `/info`.
4. Frontend: `api-types.ts`/`api-client.ts`; `stores/useSourcesStore.ts`; `components/Home/Sidebar/SourcesPanel.tsx` (rail icon `Database`); `pages/settings/Storage.tsx`; StatusBar/SourceTabs/facets switch to the store.
5. `docs/getting-started.md` "Managing sources"; `docs/configuration.md` (retention precedence: UI setting > flag > env).

## Test cases

| # | Case | Pass criterion |
|---|------|----------------|
| C1 | ingest 2 files → catalog has 2 entries with correct rows/first/last/days | exact |
| C2 | restart → catalog loads without rebuild; delete the file → restart → rebuilt from indices, same numbers | exact |
| C3 | `DELETE /sources/a` with 3 days, 30k rows | rows gone, other source intact, day with zero docs removed from disk, catalog updated |
| C4 | delete during an active tail of the same source | 409 with a clear message |
| C5 | retention prune → catalog days shrink | reconciled |
| C6 | `/info` on a 1M-row corpus | no `_src:*` scan (add a storage call counter in test); p95 < 20 ms warm |
| C7 | rename → alias → search with old and new name both work | as stated |
| C8 | `PUT /storage {retention_days: 7}` → restart with `-retention-days 30` | 7 wins; documented precedence |
| C9 | E2E: import two samples → Sources panel shows both → delete one → StatusBar count and facets update without reload | as stated |

## Acceptance criteria

- [ ] `GetSourceNames` scan removed; all consumers on the catalog; C6 measured.
- [ ] Per-source delete, re-import, rename, retention-in-UI, delete-day all green with confirms.
- [ ] Catalog rebuild is idempotent and exact (C2).
- [ ] Swagger + `api-types.ts` in sync; docs updated.

## Out of scope

Rewriting `_src` in the index (rename is alias-based), compaction (`next-10`), per-source retention (charter L1), dedupe on re-import beyond delete-then-import.
