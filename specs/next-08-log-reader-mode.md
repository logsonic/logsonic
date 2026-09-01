# next-08 — Log reader mode (keyboard navigation, context view, copy/export, session restore)

**Horizon:** Next · **Size:** M · **Priority:** P0 (UI). Medium-depth spec.
**TBD.md ref:** §3 principles D4/D6, §7 Structure + Keyboard model.
**Depends on:** `now-06` (action registry — the keyboard map dispatches into it); `now-10` (sources catalog, for context view's per-source ordering is index-level, catalog optional).
**Read `specs/README.md` first.**

## Goal

The table is a search-results grid; a log tool also needs the `less`/lnav half: move through rows with the keyboard, see what happened *around* a row regardless of the current filter, wrap long lines, copy a row in the shape a ticket wants, export in more than JSONL, and come back tomorrow to the same view.

## Design decisions (made)

- **Row focus model.** One focused row (roving `tabindex`, ARIA grid). Keys: `↑/↓` or `j/k` move; `PgUp/PgDn`; `⌘↑/⌘↓` (`Ctrl` on Win/Linux) first/last; `Enter`/`Space` opens the inspector; `Esc` closes inspector then blurs; `n/N` next/previous row whose message contains a highlighted match; `c` context view. Focus survives re-render and virtualization (store `focusedRowId` in `useLogResultStore`, restore by id after a page changes). No key is active while an input has focus.
- **Inspector panel** replaces `ExpandedRow.tsx`: right-hand panel (resizable, persisted), sections: parsed fields (mono, per-field copy / filter / exclude via the `now-02` query helper), raw line (wrap toggle), JSON. Table scroll position never moves when the inspector opens. `⌘-click` a row = open in split (inspector pinned).
- **Context view** — the core feature. `GET /api/v1/logs/context?id=<docID>&before=50&after=50` returns rows of the same `_src` ordered by `(timestamp, _seq)` around the anchor, **ignoring the query and time-range filters** (but honoring the source). Implementation: two bounded `SearchPage`-style queries on the anchor's day-index (and neighbors when the window crosses midnight): `timestamp <= anchor` descending `before+1`, `timestamp >= anchor` ascending `after`, with `_seq` tie-breaks — reuses `timestampSort`. Response `{anchor_id, rows[], truncated_before, truncated_after}`. UI: a modal-free overlay that replaces the table area, anchor row pinned/highlighted, "load 50 more" at both ends, `Esc` returns to the filtered view at the same scroll offset and focused row.
- **Wrap toggle** in the viewer header; persisted per workspace (`Workspace.Visualization` gains `wrap: bool`); virtualizer switches to measured row heights when on.
- **Copy actions**: `⌘C` copies the focused row as `timestamp level message` text (visible columns, tab-separated); `⌘⇧C` as pretty JSON; with a multi-row selection, as a **Markdown table** of the visible columns (this is what gets pasted into tickets). Copy uses the Clipboard API; in the native shell it just works (same-origin, user gesture).
- **Export formats** (`LogExportButton.tsx` menu): JSONL (existing), **CSV** (RFC 4180, visible columns, UTF-8 BOM optional toggle for Excel), **Markdown table** (visible columns, capped 1,000 rows with a warning), **raw lines** (`_raw` only — the format `grep` wants). Server-side streaming for JSONL/CSV/raw over the full result window via `GET /api/v1/logs/export?format=…` (chunked, cancellable, same bounds as today's export), so exports of 1M rows do not build the string in the browser.
- **Session restore**: `useSessionStore` (persist): last route, workspace id, query, time range mode, sources, sidebar width, inspector width, density, wrap. On app load with no URL hash, restore; with a hash, the hash wins (deep links stay authoritative). Native shell already restores the window frame (`macos-b1` item 4).

## Anchors

`LogViewer/LogViewerTable.tsx` (virtualizer, row rendering, selection state, `getLogRowId`), `Home/ExpandedRow.tsx` (replace), `Home/LogExportButton.tsx`, `storage/search_page.go` (`timestampSort`, search-after — the context query is a sibling function), `handlers/logs.go` (param style), `stores/useLogResultStore.ts`, `stores/useWorkspaceStore.ts` (`Visualization`), `lib/actions.ts` (registry from `now-06`), `useSearchParser.tsx` (`createHighlighter` — reuse to compute "rows with matches" for `n/N`).

## Test cases

Unit: key map → actions (each key dispatches the right registry id; none fire inside inputs); copy formatters (text/JSON/Markdown with pipes and newlines escaped); CSV escaping (quotes, commas, newlines, BOM toggle). Backend: context endpoint — C1 anchor mid-day → 50/50 rows in `_seq` order; C2 anchor at 00:00:30 with `before=100` → crosses into previous day-index, `truncated_before=false`; C3 anchor is first row of the source → `truncated_before=true`, zero before-rows; C4 filter/query in the current UI does not affect context (endpoint takes no query); C5 export CSV of 100k rows streams (first bytes < 200 ms, memory bounded). E2E: import syslog sample → search `error` → focus row 3 with `j` → `c` → context shows non-error neighbors → `Esc` → same row focused → `⌘⇧C` → clipboard JSON has the row's fields → export CSV downloads with the visible columns.

## Acceptance criteria

- [ ] Whole investigation keyboard-only (import → search → navigate → inspect → context → copy → export) verified in E2E.
- [ ] Context view correct across day boundaries; performance < 200 ms on 10M rows.
- [ ] Exports stream server-side; Markdown/CSV/raw added; JSONL unchanged.
- [ ] Session restore survives relaunch of the native app and a browser reload.

## Out of scope

Bookmarks/annotations on rows (needs a data model — with case files), split-pane two-source view, follow-mode auto-scroll changes (live tail already handles it).
