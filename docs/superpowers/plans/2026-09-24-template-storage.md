# Template Storage Implementation Plan

> For agentic workers: execute scoped tasks with test-driven-development, then one independent branch review.

**Goal:** Implement experiment 2 on `codex/template-compressed-storage`, preserving existing user behavior through the established query evaluator.
**Architecture:** Lossless template/Zstandard segments are authoritative on disk. Memory-only Bleve indexes preserve query semantics and are rebuilt on open. Existing storage remains default and readable.
**Tech Stack:** Go, existing Bleve and klauspost/compress dependencies, filesystem atomic rename and sync, portable existing bbolt lock support if appropriate.
**Spec:** `docs/superpowers/specs/2026-09-24-template-storage.md`

**Implementation shape:** `TemplateStorage` wraps the existing `*Storage` configured with memory-only Scorch indexes. Durable records live in immutable segments under `<storage>/template-v1`; they are replayed to rebuild the disposable query indexes. This does not add a `templates` field to `Storage` or replace the Bleve query evaluator. Checklist items below remain open until their stated checks have been run and reviewed.

## Global constraints

- No live-data migration, push, merge, or release.
- Preserve StorageInterface and search/ingestion API semantics.
- New engine opt-in; auto-detect its own existing directory.
- Compression must not alter parsed field values or `_raw` bytes.

## Review focus

- Duplicate IDs across batches must upsert and remain so after reopen.
- Deleted rows must stay deleted after recovery, including when later upserted.
- Truncated committed segments fail clearly; temporary files never become visible.
- Clear, retention, and source delete must preserve unrelated state and active operation safety.
- Concurrent process opens and failed durable writes must not corrupt or silently diverge.

## Tasks

- [x] **Codec:** Add `template_codec.go` / `_test.go` in storage. Interface `templateRecord{ID string; Fields map[string]interface{}}`, `templateSegment{Records []templateRecord; Deleted []string}`, `encodeTemplateSegment(templateSegment) ([]byte,error)`, `decodeTemplateSegment([]byte) (templateSegment,error)`. First assert raw and typed round trips plus corruption rejection; demonstrate red, then implement bounded reversible string templating and Zstandard envelope. Test all review inputs affecting codec.
- [x] **Persistence:** Add `template_store.go` and persistence tests. Use a `TemplateStorage` wrapper with operation leases around a memory-only `Storage`; add `NewTemplateStorage` and `NewStorageWithEngine`. First test write/reopen/delete/upsert and ownership conflicts, then implement immutable day segments, lock, replay, sync and fail-closed behavior. Serialize mutations and provide query operation leases without recursive locking.
- [x] **Integration:** Dispatch existing Store/Delete/Clear/RemoveDay/List/Close/retention/size methods through template mode. Preserve Bleve behavior exactly in default mode. Add engine option to config/server/CLI with validation and environment override tests.
- [x] **Compatibility:** Differential tests against legacy backend including all query classes, sorting/projection/metadata, source deletion/retention and nested values. Run selected existing HTTP integration tests with template mode as well.
- [x] **Validation:** Backend tests/race/vet; frontend tests/build; isolated API smoke; size benchmarks including reopen/query time. Document actual results and memory/startup limitations, review branch, fix substantive findings and commit.

## Execution decisions

The user's instruction to work on the selected approach authorizes implementation. Reuse the already reviewed experiment memo; proceed with the scoped design without repeating approval requests. Delegate the independent codec, keep persistence/integration local, and use separate compatibility tests and final review.

The persistent-template experiment deliberately reuses in-memory Bleve query evaluation. A native compressed-domain query engine is deferred until differential semantics and storage gains are established; dropping existing query operators would violate the request.

## Validation outcome

See `docs/template-storage-validation.md` for completed checks, benchmark values and limits. Review findings for mixed-engine ownership and interrupted day deletion were fixed with red/green regressions. Race testing additionally exposed and fixed shared query mutation across shards. The engine remains opt-in because replay and resident index memory are material costs.
