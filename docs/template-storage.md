# Template-compressed storage experiment

LogSonic includes an opt-in storage backend that stores immutable, compressed day segments and rebuilds its search indexes in memory when it starts. It is an experiment for comparing storage size with startup time and memory use. The existing Bleve format remains the default for new storage directories.

## Select an engine

Choose the engine with `--storage-engine` or `LOGSONIC_STORAGE_ENGINE`:

```sh
# Use the existing default behavior: Bleve for a new directory, or detect an
# existing template store in this directory.
logsonic --storage-engine auto --storage /path/to/logsonic-data

# Explicitly opt in for a new, separate experiment directory.
logsonic --storage-engine template --storage /path/to/template-experiment
```

The command-line option takes precedence over the environment variable. With `auto` (the default), a new directory uses Bleve; an existing `template-v1` store is reopened with the template engine. Existing Bleve day indexes continue to open as before.

Template mode refuses a storage root that contains legacy Bleve day indexes. It does not migrate or rewrite them. To try the experiment with existing logs, first choose a separate storage directory and import or copy the source logs into it through LogSonic. Keep the Bleve directory untouched so it remains available with the default engine.

## How it stores and searches rows

Template storage writes complete row values and IDs into immutable segments under `<storage>/template-v1/<day>/`. Repeated string structure around runs of decimal digits is factored into segment-local templates when that makes the encoded segment smaller. The codec compares the templated representation against its ordinary typed representation and keeps the smaller one. Both paths are Zstandard-compressed; numeric, timestamp, and other non-string values retain their typed representation rather than being converted into lossy text.

The compressed segments are the durable data. At startup, LogSonic replays them into memory-only Scorch indexes, which are discarded on close and rebuilt at the next launch. This reuses the established Bleve query evaluator and preserves LogSonic's query syntax, field handling, ordering, pagination, and facets. The experiment removes persistent Bleve index files from the template store; it does not remove the Bleve dependency or search compressed segments directly.

This design trades disk space for work at startup and memory while running. Reopening a large archive must decompress and reindex its rows, and the in-memory index consumes RAM. Measure both against the same corpus and machine before choosing this engine for a long-running archive.

## Deletion and durability

Deleting rows appends exact-ID tombstones. Earlier immutable segments remain until their day is removed or the template store is cleared, so a source delete from a day that still contains other sources can leave old bytes on disk. Removing a day, retention pruning, and Clear remove that day's segment data.

The engine writes and syncs each segment file before renaming it into place. On Windows, directory-handle fsync is skipped because the current implementation cannot sync directory handles there. The durability of the rename across sudden power loss on Windows is therefore unverified; do not treat the Windows path as crash-durable until that behavior is tested or implemented.

## Scope

This implements the storage experiment. It does not change log2grok format detection, add semantic template mining, or establish a 99% parsing-accuracy result. Native template postings and compressed-domain search remain future work. The codec's string templates are reversible storage encodings, independent of parser inference.

The complete index is resident in memory. There is no cache eviction or memory cap yet; an archive larger than available RAM is unsuitable. Repeated updates and deletes grow immutable history until day removal; per-row compaction is not implemented. High-entropy input, small imports and many small segments may exceed raw-input size despite compression. No universal compression ratio is promised.

## Measured results

See [validation and benchmark results](template-storage-validation.md) for the measured corpus, limitations and reproduction commands.
