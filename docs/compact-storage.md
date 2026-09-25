# Compact storage

LogSonic stores each day of logs in its own Bleve index, `logs-<day>.bleve`. The original format keeps a full copy of every row inside Bleve's stored fields, compressed one row at a time. Compact storage keeps the same Bleve index for searching but stores the rows next to it in compressed blocks, and shrinks the per-day metadata that dominated small days. New days use compact storage; days written by older versions keep working and are converted in the background.

Search behaves the same in both formats. The same index, query parser, analyzers, sort order, facets and chart are used; the automated oracle compares every answer the UI requests between the two formats (see [Validation](#validation)).

## What changes on disk

A compact day directory looks like this:

```
logs-2026-09-24.bleve/
  index_meta.json
  store/            Bleve (Scorch) index: terms, doc values, a row pointer per document
  rows/
    00000000000000000001-1024.zst   sealed block of 1024 rows (Zstandard)
    00000000000000000002-1024.zst
    open.wal                        rows of the block still filling
```

- **The index stores no row data.** Every field is indexed exactly as before, with the same analyzers and doc values. Only one small stored field remains: `_blk`, the row block holding the document's row.
- **Rows are compressed together.** Rows are appended to `open.wal` and fsynced before their documents are indexed. Every 1024 rows are sealed into an immutable Zstandard block. Compressing many similar lines together is what makes rows small; Bleve compresses each stored row on its own.
- **Finished days are finalized.** A day before today that has not been written for two minutes is merged into one index segment, its rows are sealed, and its `store/root.bolt` is rewritten with 4 KiB pages. Scorch creates that file with the operating system's page size (16 KiB on Apple silicon), so every day, even one holding a single row, used 256 KiB; finalized days use 64 KiB.

Reading a page of results looks up each hit's block (the last 64 decoded blocks are cached) and turns the row back into exactly the fields Bleve would have returned from a legacy day. Phrase queries verify candidates against the row in the same way.

Deleting rows reclaims their space: after a delete, blocks no document points at are removed, and blocks where most rows are gone have their remaining rows rewritten. Deleting or re-importing a source therefore does not leave its old rows on disk.

## Converting existing days

When LogSonic starts on a storage directory with legacy days, a background pass converts them one at a time, oldest first:

1. It waits 30 seconds after startup, and skips today and any day written in the last two minutes, so imports and live tails are never raced.
2. It builds the compact copy next to the day (`logs-<day>.bleve.new`) from the legacy day's stored fields, keeping every document ID, and checks that the document counts match.
3. It swaps the copy in with two renames (`logs-<day>.bleve` → `.old`, `.new` → `logs-<day>.bleve`) and deletes the old directory.

The legacy day stays searchable until the swap. While one day is being converted it exists twice on disk, so conversion needs free space for that day's compact copy (about two thirds of its legacy size); days are converted one at a time. If the day receives a write, delete or removal while its copy is being built, the copy is discarded and the day is retried on a later pass. A crash at any point leaves exactly one complete version of each day; startup finishes or rolls back an interrupted swap before any day is opened. The pass repeats every 10 minutes, so yesterday's day is converted after midnight.

**Settings → Storage** shows the progress in one line while days remain ("Converting 2026-03-01 to compact storage: 12 of 40 days done, 1.2 GB freed. Search keeps working meanwhile."), refreshes it every five seconds, and reports a failed attempt, which is retried. `GET /api/v1/storage` returns the same information as `optimization`, plus each day's `format`.

## Settings

| Variable | Effect |
|---|---|
| `LOGSONIC_STORAGE_MIGRATION=off` | Do not convert legacy days. They stay fully usable; new days are still compact. |
| `LOGSONIC_STORAGE_FORMAT=legacy` | Write new days in the legacy format and do not convert anything. Compact days already on disk stay readable. |

Downgrading: versions before compact storage cannot read compact days. They still list the days and their row counts (and show `_blk` as a column), but searches return no rows, after scanning every match, which is slow on large days. To keep a storage directory readable by an older version, run with `LOGSONIC_STORAGE_FORMAT=legacy` from the start.

## Durability

- Row blocks and the swap during conversion are written with a file sync, rename and directory sync, like the rest of LogSonic's metadata.
- WAL appends use `fsync(2)`. On macOS `os.File.Sync` issues `F_FULLFSYNC`, which cost about 4 ms per live-tail flush; plain `fsync` survives any process crash. After a power loss, documents whose rows had not reached the disk are removed when their day is reopened, so search never shows rows it cannot display.
- Windows skips directory syncs, as elsewhere in LogSonic.

## Validation

- **Storage parity** (`go test ./pkg/storage -run Parity`): legacy and compact stores given the same rows return identical results for text, phrase, field, Boolean, numeric-range, wildcard and fuzzy queries, arrays, nested fields, source names with punctuation, projection, pagination, facets, source statistics, upserts, deletes, retention, Clear and reopening.
- **Sample logs** (`go test ./pkg/server -run TestSampleLogsCompactStorageMatchesLegacy`): each file in `sample-logs/` is imported with automatic parsing into a legacy and a compact server, and every `/api/v1/logs` answer (two pages each of all rows, a free word, a phrase, a field value, its negation, a numeric range, with chart and facets) plus the rebuilt sources catalog must be identical after import, after finalizing, after converting the legacy directory, and after a restart. By default six representative files run; `LOGSONIC_SAMPLE_GLOB='*.log'` runs all eighteen (the nightly workflow does).
- **Recovery and concurrency** (`go test ./pkg/storage -run 'Compact|Migrat|Recover'`, also under `-race`): WAL replay after a crash and a torn final frame, removal of documents whose rows were lost, a missing block not hanging search, space reclaimed by deletes and re-imports, conversion retried when the day changes, interrupted swaps recovered, today left alone, and writes, searches, deletes and conversion running together.

## Measurements

Apple M4 Pro, macOS, Go 1.26.6; single runs, not statistical estimates.

**All 18 sample logs** (3.6 MB of real and synthetic logs spread over 664 days):

| | Size on disk | × raw |
|---|---:|---:|
| Legacy | 200 MB | 55.8× |
| Compact, imported and finalized | 64 MB | 17.8× |
| Legacy directory after conversion | 65 MB | 18.1× |

Most of the remaining size is the 64 KiB metadata file per day: these logs average 5 KB per day.

**1 GiB synthetic access log** (3.9 million rows on one day, one row per ~22 ms). Queries use `SearchPage` as the UI does, sorted by time, 100 rows; medians of three runs after reopening.

| | Legacy | Compact |
|---|---:|---:|
| Size on disk | 4,338 MiB (4.24× raw) | **2,824 MiB (2.76× raw, −35%)** |
| Import | 207–217 s | 229 s (+6–10%) |
| Finalize the day (background) | — | 48 s |
| Convert the legacy day (background) | — | 338 s → 2,899 MiB |
| Reopen | instant | instant |
| Whole day, match all, with chart | 6.29 s | 6.10 s |
| One hour, `message:timeout`, with chart | 280 ms | 284 ms |
| One row, `url:123457` | 1.3 ms | 0.9 ms |
| Numeric range `bytes:>=65000` | 140 ms | 123 ms |
| Page 50 of the whole day | 13.9 s | 13.0 s |
| Phrase matching every row in one hour | 3.57 s | 3.02 s |
| Selective phrase | 2.2 ms | 1.8 ms |
| Free text, one hour | 141 ms | 146 ms |
| Facets, one hour (20,000-row sample) | 3.55 s | 3.55 s |

On the converted legacy day the same queries matched these timings, except the one-row lookup (10 ms) and the selective phrase (25 ms); both stay well below anything a user notices. Whole-day searches and deep pages cost the same in both formats: they are bounded by the search path (sorting all matches, the chart facet, offset paging), not by storage.

`BenchmarkIndexSize*` in `pkg/storage` reproduces the size comparison: run it once as is and once with `LOGSONIC_STORAGE_FORMAT=legacy`; `LOGSONIC_SIZE_BENCH_MB=1024` sets the size.
