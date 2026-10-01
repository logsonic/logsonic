# Automatic mixed-format ingestion

Automatic mode routes each logical record separately. A file does not need one format throughout, and a failed first sample does not permanently disable detection.

1. Try the stream's cached parsers.
2. Discover additional parsers from a bounded sample of unmatched records, then apply them to the remaining records in the batch.
3. Keep every unresolved record as a raw row with its source, sequence, timestamp fallback, and original logical-record text. A parser miss does not reject the import.

For example, an import containing 20 Apache access records, two SSH syslog records and one opaque fragment can store 23 rows: the two known families receive their own fields; the fragment remains searchable. Multiple templates and literal exceptions can coexist in one template-storage segment. Storage encoding never requires a parser match.

## Automatic and explicit choices

Browser detection supplies a preview and label, while automatic uploads send `pattern: "auto"` instead of freezing that preview's first pattern. Ingest sessions, path imports, reimports, automatic watches, and live sources explicitly configured with `pattern: "auto"` keep learning from later batches. Selecting or testing a manual/custom pattern switches the browser import to that explicit pattern. Explicit patterns and timestamp overrides retain their established semantics.

Automatic rows include `_parse_status` (`parsed` or `raw`). Successfully parsed rows also include `_parse_pattern`. Use `_parse_status:raw` to find exceptions. Both parsed and raw rows retain `_raw`; metadata cannot replace it. `_raw` describes the logical record after any multiline folding, whose existing space-joining behavior remains unchanged. The ingest API's processed/failed counters describe parsing outcomes; failed-to-parse rows are still stored.

A message-only or anonymous-field catch-all is not installed as a reusable parser. Timestamp-only matches may preserve valid time captures provisionally while discovery continues to seek richer fields. They are not cached as a parser that could hide later formats. The source catalog retains `pattern: "auto"` for reimport, with the first structured format used only as a display label.

Automatic timestamp resolution carries state across chunks. It can switch from synthetic time to real timestamps when a later known record appears, and handles a yearless January record after December without changing explicitly stated years or user overrides. Earlier raw rows are not retrospectively reparsed.

## Mixed records and multiline traces

Automatic multiline detection must account for the sample's physical lines: a syslog header appearing among access logs is not sufficient evidence that every other line is a continuation. Inferred header rules carry `auto_detected: true` through preview, upload and persisted options. They join recognized Java/Python stack or indented continuation lines; independent later formats and opaque fragments start new records. Explicit header rules retain their original behavior, including treating nonmatching lines as continuations. Choosing a multiline preset or editing its header in the UI makes that choice explicit.

This conservative rule favors retaining record boundaries when evidence is ambiguous. Arbitrary custom multiline formats can still use the existing explicit controls; a leading indentation is itself continuation evidence, not a guarantee about the author's intent.

## Bounded work

Each stream caches at most 16 compiled parsers, evicting the oldest when a new family arrives. Each batch uses at most one single-format discovery and one multi-format discovery, evaluating at most 16 candidate parsers. Each discovery sample contains at most 200 distinct lines and 64 KiB; lines over 16 KiB are excluded from inference but retained and tried against cached parsers.

A bounded cache remembers up to 256 exact opaque misses for one minute, so identical noise does not repeat inference in every chunk. Cached parsers are always tried first, and new content remains eligible for discovery. These bounds control work without permanently locking a stream to its first sample. A family outside a batch's inference budget may remain raw until a later batch; no universal first-line or 99% semantic-accuracy claim is made.

## Compatibility validation

Regression coverage includes mixed families in the same batch and later chunks, raw-only initial input, blanks and unusual bytes, explicit pattern behavior, pending multiline records, live sources, automatic watches, timestamp rollover, bounded inference and concurrent decoder access. HTTP lifecycle tests run against both Bleve and template engines, including source identity, search totals, restart, persisted automatic options, reimport and deletion. Codec tests cover heterogeneous templates and literal values together with exact recovery after reopening.

Validation on 24 September 2026: full backend suite, focused race suite and `go vet` passed. Frontend validation passed 344 tests across 30 files, TypeScript checking, the production build and the API-type consistency check (174 fields). The build retains its existing large-chunk warning.

Two real headless-Chromium uploads against a disposable template store passed without choosing a format:

- 20 Apache records + two SSH syslog records + one opaque fragment produced 23 rows, with 22 parsed and one raw, preserving every input record.
- 123 physical lines whose preview contained only stack traces produced 40 folded traces plus two later known records and one raw fragment. The inferred multiline marker reached ingest and every logical record matched the expected text.

Neither browser case reported JavaScript errors. `_parse_status:raw` retrieved each exception. The test server was stopped afterward. These checks exercise compatibility; they do not guarantee every user workflow or semantic parse is correct. In particular, discovery can still select an overly broad known pattern. A representative labeled corpus is required before claiming a parsing-accuracy percentage.

Run from `backend/`:

```sh
go test ./...
go test -race ./pkg/server/handlers ./pkg/server ./pkg/storage ./pkg/timeresolve -run 'Test(Mixed|AdaptiveDecoder|AutoTimestamp|AutomaticTimestampState|ResolveAutomatic|PostProcessPreservesRaw|TemplateCodecKeepsRaw|TemplateStorageMixed|DetectMultilineConfig|AutoDetectedHeader)' -count=1
go vet ./...
```

Run the frontend tests and production build as well. The storage backend remains opt-in; this change does not migrate existing data or remove the RAM/startup limits documented in [the storage guide](template-storage.md).
