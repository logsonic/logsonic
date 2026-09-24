# next-10 — Storage engine hardening (lazy open, any-field cursor sort, migrations, crash safety)

**Horizon:** Next · **Size:** M · **Priority:** P1. Medium-depth spec.
**TBD.md ref:** §2 P1 (legacy `Search()` materialization), §2 note (dead LevelDB config), §3 principle D3/D6, §8 budgets.
**Read `specs/README.md` first.**

## Goal

The storage layer is one Bleve scorch index per calendar day, all opened eagerly at startup, with a bounded search-after page path (`SearchPage`) for timestamp sorts and an unbounded legacy path (`Search()`, `Size = 1_000_000` per index) for everything else. Four hardening moves make it hold up to a multi-year archive and a 10M-row corpus: lazy open with idle close, cursor-paged sort on any field (delete `Search()`), an index-format version with a migration runner, and proven crash safety.

## Design decisions (made)

- **Lazy open + LRU idle-close.** `NewStorage` only *lists* `logs-*.bleve` directories (cheap) and records their dates; indices open on first use (`getOrCreateIndex` already does this for writes). An LRU (cap: `max(8, NumCPU*2)` open indices, configurable `-max-open-indices`) closes the least-recently-used index when the cap is exceeded, never one currently leased by a search or write (reference count on the lease already implied by `s.mu.RLock` in `SearchPage` — make it explicit with a `lease()`/`release()` pair). Startup budget: < 800 ms with 365 indices (§8). Corrupt-index detection moves to first open and is reported through `now-13`'s `OpenErrors()`.
- **Any-field cursor sort.** `SearchPage` accepts `SortBy` = any stored field: sort order `[field (as string, or as number when the field is numeric in the mapping), timestamp, _seq, docID]` so search-after remains total. Numeric detection: the stored value type in the first hit (Bleve's `SortField` `Type` auto works for stored fields; verify) — fall back to string. Missing values sort last in both directions (`Missing: last`). Delete `storage.Search()`, its `Size = 1_000_000` path, and the handler branch at `handlers/logs.go:261–263`; `HandleReadAll` always uses `SearchPage`. The `LogResponse` shape does not change.
- **Drop the dead LevelDB keys.** scorch reads only scorch-specific keys from the config map (e.g. `path`, merge/persister tunables) and ignores `block_size`, `write_buffer_size`, `lru_cache_capacity`, `bloom_filter_bits_per_key`, `compression`. Remove those keys and the `goleveldb` import; keep a (possibly empty) `map[string]interface{}` so scorch tunables can be added later with intent: `bleve.NewUsing(path, mapping, scorch.Name, scorch.Name, scorchConfig)`. Also delete the unused `server.Config.WorkDir` (now-08 notes it).
- **Format version + migration runner.** `<storage>/FORMAT` (a small JSON: `{version: 2, created_by: "1.8.0"}`); each index dir gets a `.logsonic-meta.json` (`{format: 2, mapping_hash}`) written on creation. On startup: if `FORMAT` is missing → treat as version 1 (today's layout) and write it; a `migrations` table maps `from → to` steps (v1→v2 is a no-op that writes the meta files; the first real migration will be `L6`'s keyword sub-fields). Migrations run **before** the listener binds, with progress on stdout and a `MIGRATING` state in `/info` if we ever need long ones; refuse to open storage created by a *newer* version (clear message pointing to the release page). The existing `timestampIsIndexed` compatibility path stays, but the meta file lets it skip the mapping introspection.
- **Crash safety, proven.** Test: write 100k rows in 10k batches; `SIGKILL` the process mid-batch (test spawns the server binary); reopen; assert doc counts are consistent (every batch either fully present or absent — scorch commits per batch) and `SearchPage` returns without error. Also atomic write (temp + `rename`) for every JSON state file we own (`workspaces`, `sources.json`, `watches.json`, `watchers.json`, `config.json`) via one helper `pkg/atomicfile`.
- **Compaction hook.** Expose `POST /api/v1/storage/compact` that calls scorch's merge planner (force-merge) per index when the server is idle (no jobs/tails) — behind a UI button in Storage settings (`now-10` hid it until now). Measure before/after size in the test; document that it is optional.

## Anchors

`storage/storage.go` (`NewStorage`, `getOrCreateIndex`, `kvConfig`, `buildIndexMapping`, `Close`), `storage/search.go` (delete), `storage/search_page.go` (`timestampSort`, lease semantics), `handlers/logs.go:225–270` (branch), `index_size_benchmark_test.go` (extend for spread + startup), `now-13` (`OpenErrors`), `now-10` (storage settings UI, config.json).

## Test cases

L1 startup with 365 empty-ish indices: < 800 ms, ≤ 0 opened until first query; L2 LRU: cap 8, touch 12 dates → 8 open, oldest closed, a leased index never closed mid-search (race test with `-race`); L3 sort by `status` (numeric) asc/desc over 3 day-indices with paging → globally ordered, stable across pages, no duplicates/gaps; L4 sort by `service` (string) with missing values → missing last; L5 `Search()` gone: `grep -r "\.Search(" pkg/` finds only `SearchPage`; L6 `FORMAT` absent → written as v1→v2; newer version → refuses with message; L7 SIGKILL test; L8 atomicfile: crash between write and rename leaves the old file intact (simulate by failing rename); L9 compaction reduces size on a fragmented index and is a no-op on a fresh one. Bench: search p95 numbers before/after for §8.

## Acceptance criteria

- [ ] Legacy `Search()` deleted; every sort bounded; `LogResponse` unchanged.
- [ ] Lazy open + LRU with lease safety under `-race`; startup budget met.
- [ ] Format version + migration runner in place with the v1→v2 no-op; newer-version refusal tested.
- [ ] Crash-safety test in CI (nightly if slow); atomic writes everywhere.

## Out of scope

Changing the day-sharding scheme (monthly/size-based rollover — revisit with data from the bench), keyword sub-fields (`L6`), encryption at rest.
