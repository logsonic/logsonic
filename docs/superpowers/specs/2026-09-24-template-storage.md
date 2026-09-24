# Template-compressed storage experiment

The user selected experiment 2 and requested a branch with no broken user functionality. Implement a usable, opt-in template storage engine. Existing Bleve data and the default for new directories stay unchanged. Do not migrate, delete, or alter live user data.

## Design

`Storage` retains the existing mapping, analyzer, queries, pagination, facets, and source-statistics behavior. Template mode replaces persistent Bleve shards with memory-only Bleve shards rebuilt from immutable compressed segments. This first experiment removes the *persistent* Bleve index; it does not claim to remove the Bleve dependency or search compressed representations directly. Measure startup/RSS implications and document them. Keeping the established evaluator is the compatibility control for later native template postings.

Each segment stores row IDs and complete input field values losslessly. The codec factors repeated string structure into templates and per-row variables, and compresses the result with Zstandard. Template IDs are segment-local and immutable. Preserve raw bytes, whitespace, escaping, leading zeros, Unicode, nested maps/arrays, and timestamps; parsing decisions remain independent from compression. Data that cannot benefit from templating stays in ordinary compressed form.

Use a separate `template-v1` directory under the selected storage root. A process lock prevents concurrent writers. Per-day folders contain monotonically numbered immutable segment files; a segment contains upserts or exact-ID tombstones. Write a temporary file, fsync, rename, and fsync the parent before acknowledging durable writes. Ignore uncommitted temporary files on recovery. Check magic/version/checksum and reject damaged committed segments. Commit memory-index changes under a storage operation lease; block close/remove/retention while a write is in progress. On an unexpected failure after durable commit, fail closed until reopening rather than serving divergent data.

All public StorageInterface operations must work: Store/StoreWithIDs, Search, SearchPage, Facets, List, SourceStats, LegacySourceShard, Clear, GetDocCount, DeleteByIds, DeleteBySource, RemoveDay, IndexDirSize, PruneOlderThan, and Close. Source deletion uses exact stored source identity. Clear/day removal must only remove the engine's data and preserve catalog/config/watch/workspace files. Empty shards remain until explicitly removed, matching current behavior.

Expose `--storage-engine auto|bleve|template` and `LOGSONIC_STORAGE_ENGINE`. Auto opens an existing template directory; otherwise retains Bleve. Explicitly selecting an incompatible engine for an existing directory returns an actionable error; no hidden mixed-engine or in-place conversion. The template mode needs no changes to UI query syntax or ingestion APIs.

## Acceptance

Differential tests compare full rows, IDs, totals, column lists, distributions, facets, and source stats against current storage for text/phrase/field/Boolean/range/wildcard/fuzzy queries, arrays/nested values, source punctuation, projection, ordering, pagination, upserts and deletes. Durability tests cover reopening, partial temp writes, corruption rejection, concurrent operations, and ownership locks. Run the full backend suite, focused race checks, vet, frontend suite/build, and API smoke against template mode. Benchmark both dense and sparse layouts and record size/import/reopen/query costs. Do not enable by default or claim full-scale performance without evidence.
