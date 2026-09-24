# Template storage validation — 24 September 2026

Branch: `codex/template-compressed-storage`, based on `6b11a2aaa954a79383fed1a7d7ad5779e2ad994d`.

## Implemented behavior

Opt-in immutable lossless template/Zstandard segments with automatic engine detection on reopen; existing Bleve storage remains the default. The existing query evaluator runs over disposable in-memory Scorch indexes. No production data migration is performed. This is the storage portion of experiment 2: semantic template mining, parser redesign and native compressed-domain query execution are not implemented in this branch.

A common root lock excludes mixed writers even before the first log arrives. Acknowledged segments use file sync, atomic rename and directory sync on supported platforms; corrupt committed segments are rejected. Interrupted day deletion is completed on reopen. Exact IDs preserve upserts, source deletions and tombstones across restarts. Clear and retention preserve unrelated application metadata.

Compatibility testing also exposed and fixed an existing multi-shard query race: field expansion mutated a shared query while Bleve searched shards concurrently. Each field now receives its own query instance, preserving compact binary numeric-range bounds.

## Measurements

Apple M4 Pro, macOS arm64, Go 1.26.6. Each size run contains 123,845 generated access-log events totaling 32.00 MiB of raw text, including line separators. The same event fields and batch sizes are used for both engines. Dense places events on one date; spread distributes them over 365 dates.

Sizes sum every file in the storage directory after closing, including the root lock. These are logical file lengths, not filesystem allocated-block measurements. They exclude the application catalog/configuration files and original imported files. There is no post-close compaction step. These are individual synthetic runs, not statistical latency estimates or a representative real-world corpus. Other local work can affect timings.

| Layout / engine | Disk MiB | Disk/raw | Ingest seconds | Reopen seconds | First query ms |
|---|---:|---:|---:|---:|---:|
| Dense / Bleve | 158.6 | 4.956 | 6.661 | 0.000895 | 94.91 |
| Dense / template | 7.337 | 0.2293 | 8.165 | 5.572 | 90.02 |
| 365 days / Bleve | 270.5 | 8.452 | 194.7 | 1.127 | 261.7 |
| 365 days / template | 13.43 | 0.4196 | 56.52 | 6.879 | 45.59 |

The restart query is `message:timeout`, timestamp descending, 100 rows, distribution disabled, over the entire corpus date range. It asserts all 123,845 matches remain available after reopening. This is one query class; compatibility of other query classes is tested separately.

Template post-reopen live Go heap after garbage collection was **296.9 MiB dense** and **1,007 MiB across 365 days**. This is absolute process Go heap, not RSS, peak memory or a comparison to lazily opened Bleve. An earlier delta-based heap metric was discarded because asynchronously released caches made that baseline unstable. The final benchmark reports absolute heap. This substantial memory cost is why the engine remains opt-in.

A separate 1,000-row codec fixture produced **19,201 bytes with typed gob + Zstandard** and **17,524 bytes with adaptive templates + Zstandard**, including the same envelope: **8.7% additional savings** from templating. Template encoding took about 5.15 ms versus 1.95 ms, allocating 47.4 MB versus 22.1 MB per segment in this five-iteration run. Most overall disk savings therefore come from compression and removing persistent per-document index files, not template factoring alone. Each segment chooses the smaller compressed representation; future encoder reuse could reduce allocation costs.

## Verification

- Full backend `go test ./...`: passed after all product-code changes.
- Focused race tests across storage and server: passed, including codec, query parity, lifecycle, engine locking, failed initialization and the multi-shard query regression.
- `go vet ./...` and backend build: passed.
- Frontend: 29 test files / 337 tests passed; production build passed. Build retains its large-chunk warning.
- Differential storage tests: text, phrase, field, Boolean, numeric range, wildcard and fuzzy queries; arrays/nested fields; exact source identity; projection, ordering, pagination, counts, columns, distributions and facets; source stats, upserts, deletes, retention, Clear and cancellation.
- Recovery tests: typed/raw-byte roundtrip, corruption and malformed metadata rejection, temporary-file recovery, interrupted deletion cleanup, concurrent writes, mixed-engine ownership, reopen and server initialization failure cleanup.
- Isolated final binary on localhost: ingest, search, restart with default `auto`, render stored event in Chromium, field search, JSONL download containing that event, no JavaScript errors, source deletion to zero results. Server was stopped afterward; only scratch data was used.
- Independent review completed; its mixed-writer and interrupted-deletion findings have regression tests and fixes. `git diff --check` passed.

Passing tests establish the exercised behavior, not a guarantee that every possible user workflow is bug-free. No parsing accuracy improvement or 99% first-event result is claimed.

## Reproduce

From `backend/` with Go 1.26.6 and embedded frontend assets built:

```sh
go test ./...
go test -race ./pkg/storage ./pkg/server -run 'Test(Template|StorageEngineLock|NewServerReleasesStorage|AllFields)' -count=1
go vet ./...
go build .
go test ./pkg/storage -run '^$' -bench '^Benchmark(Template)?IndexSize(Dense|Spread)$' -benchtime=1x -count=1
go test ./pkg/storage -run '^$' -bench '^BenchmarkTemplateCodecAblation$' -benchtime=5x -count=1
```

From `frontend/`: `npm test` and `npm run build`. The validation runs used an isolated writable Go cache and `GOPROXY=off` with already-installed dependencies.

## Remaining limits

The complete query index stays in RAM and startup rebuilds it; no memory cap or eviction exists. Deleted/upserted history retains bytes until day removal or Clear; row-level compaction is future work. Windows skips directory fsync, so rename durability across sudden power loss is unverified. Malformed/high-entropy logs can compress poorly. Numeric-run templates are independent of semantic parsing. Keep the engine opt-in while evaluating real datasets, memory budgets and crash behavior on each target OS.
