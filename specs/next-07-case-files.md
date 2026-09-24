# next-07 — Case files (investigation export/import)

**Horizon:** Next · **Size:** M · **Priority:** P2. Medium-depth spec.
**Depends on:** now-03 (saved queries are part of the bundle).
**Read `specs/README.md` first.**

## Goal

Export an investigation as one file a colleague can open in their own LogSonic: the filtered logs, the workspace (queries, color rules, time range), and provenance. Collaboration without a server — aligned with local-first.

## Design decisions (made)

- **Format: a single `.logsonic-case` file = zip** containing `manifest.json` (format_version, created_at, app_version, row_count, sha256 of members), `workspace.json` (the full Workspace incl. saved queries), and `logs.ndjson.gz` (the exported rows: parsed documents as NDJSON, gzipped inside the zip — double compression is fine, NDJSON.gz keeps the member streamable).
- **Scope of rows: the current query window** (same bounds as export today), NOT the whole corpus. Cap 1M rows / 512 MB uncompressed with a clear pre-export size estimate dialog.
- Import creates a **new dedicated source** `case.<original-name>` (rows re-indexed via the normal `StoreWithIDs` path preserving original timestamps — they land in their historical day-indices) and installs the workspace as a new workspace named after the case. Doc-ID collision with an already-imported identical case: `BuildDocID` (`storage/storage.go:197`) dedupes naturally — verify and test rather than assume.
- Endpoints: `POST /api/v1/case/export` (body: current search context; streams the zip) and `POST /api/v1/case/import` (multipart upload; returns workspace id + source name + row count). Format version checked on import; future-version files rejected with a clear message.
- UI: "Export case…" in the export button's menu (`LogExportButton.tsx`) with the size-estimate confirm; import via the Import page (new "Case file" card) and macOS file association (`.logsonic-case` UTI added in macos-b2's plist when both have landed).

## Anchors

`components/Home/LogExportButton.tsx` (existing export flow + how it fetches full result sets), workspace round-trip (`useWorkspaceStore`, `pkg/workspaces/store.go`), `StoreWithIDs`/`BuildDocID` (`storage/storage.go:197-218`), Import page structure (`pages/Import.tsx`).

## Test cases

Backend: C1 export→import round-trip on a second storage dir (`t.TempDir()`) → row count, field values, timestamps identical; workspace appears with saved queries; C2 import same case twice → no duplicate docs (BuildDocID dedupe verified); C3 tampered zip (bad sha256) → rejected; C4 future format_version → clear error; C5 1M-row cap enforced; C6 zip-slip path traversal attempt in member names → rejected (security test — use archive entry names like `../../evil`). Frontend: size-estimate math; E2E: export case from a filtered apache.log view → clear all logs → import the case → search reproduces the filtered view via the installed workspace.

## Acceptance criteria

- [ ] Round-trip fidelity (C1) proven by test; re-import idempotent.
- [ ] Zip-slip and integrity checks in place.
- [ ] Case files documented in `docs/` (format spec included — it's a public interchange format now).

## Out of scope

Annotations/comments on rows (needs its own data model first), encryption/passwords on case files, partial-corpus diff-aware sync.
