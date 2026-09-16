# now-03 — Saved queries + query history

**Horizon:** Now (v1.7) · **Size:** S (days) · **Priority:** P1
**TBD.md ref:** §5 v1.7, §6 backlog.
**Read `specs/README.md` first** for dev setup and codebase map.

## Goal

Two related conveniences in the search bar: (1) **history** — ↑/↓ recalls previous queries of this browser profile, newest first; (2) **saved queries** — star a query to name and keep it; saved queries persist in the **workspace** so they travel with investigations.

## Design decisions (made)

- **History is local-only** (browser `localStorage` via Zustand `persist` middleware), capped at 50 entries, deduplicated (re-running a query moves it to the front). It is NOT part of the workspace — history is personal scratch, workspaces are curated state.
- **Saved queries live in the workspace** (`types.Workspace`, `backend/pkg/types/types.go:303`) as a new optional array; workspaces already round-trip through `POST/PUT /api/v1/workspaces` and the frontend `useWorkspaceStore`. No new endpoint needed.
- A query record saves the **full search context**: query string + relative-or-absolute time range + source filter. Recalling restores all three (this matches what `buildWorkspaceFromState` already captures — reuse its shapes).
- Keyboard model: with the search input focused and the input EMPTY or unchanged from a recalled entry, ↑/↓ walks history (like a shell). Once the user edits, ↑/↓ returns to normal cursor movement. Esc restores what they were typing.

## Current-state anchors

- Search bar: `frontend/src/components/Home/LogSearch.tsx`.
- Query state: `frontend/src/stores/useSearchQueryParams.ts` (interface line 8; the search-trigger action lives here — find where the search is actually dispatched and hook history-push there, so history records *executed* queries only, not keystrokes).
- Workspace round-trip: `frontend/src/stores/useWorkspaceStore.ts` — `buildWorkspaceFromState` (line 38), `applyWorkspaceToCurrentState` (line 79), `isWorkspaceDirty` (line 106). All three must learn the new field.
- Workspace DTO: `backend/pkg/types/types.go:303` (`Workspace`, with `WorkspaceTime` line 276 as the time-range shape to reuse).
- Workspace persistence: `backend/pkg/workspaces/store.go` (JSON file-backed; verify it marshals unknown-to-it fields transparently — it should, since it stores the whole struct).
- Frontend API types: `frontend/src/lib/api-types.ts`.

## API contract

Extend `Workspace` (backend + `api-types.ts`), no endpoint changes:

```go
type SavedQuery struct {
    ID        string         `json:"id"`                  // uuid
    Name      string         `json:"name"`                // user-provided, 1..60 chars
    Query     string         `json:"query"`               // may be ""
    Time      *WorkspaceTime `json:"time,omitempty"`      // reuse existing shape
    Sources   []string       `json:"sources,omitempty"`
    CreatedAt time.Time      `json:"created_at"`
}
// on Workspace:
SavedQueries []SavedQuery `json:"saved_queries,omitempty"`
```

Backward compatibility: old workspace files lack the field → must load fine (omitempty both ways). Add a Go test that unmarshals a pre-change workspace JSON fixture.

## Step-by-step

1. **Backend:** add `SavedQuery` type + field; regenerate Swagger (workspace schemas appear in it); add the backward-compat unmarshal test in `pkg/workspaces`.
2. **Frontend types:** mirror in `api-types.ts`.
3. **New store** `stores/useQueryHistoryStore.ts` (Zustand + `persist`, key `logsonic-query-history`): `entries: {query, timeISO?, sources?, at}[]`, `push(entry)`, `clear()`; cap 50; dedupe by `query+sources` moving hit to front.
4. **Hook history push** into the search-execution action in `useSearchQueryParams.ts` (executed searches only; skip empty-query default loads).
5. **LogSearch.tsx:**
   - ↑/↓ handler per the keyboard model above; recalled entry fills query + restores time/sources.
   - Star button (lucide `Star`) inside the input's right edge: opens a small Radix popover — name field (default: the query string truncated to 40 chars) + Save. Saving appends to `useWorkspaceStore`'s current draft state and marks workspace dirty.
   - A `Bookmark`/`History` dropdown (Radix `DropdownMenu`) next to the star listing: saved queries of the active workspace (click = apply; hover reveals delete ✕), divider, last 10 history entries, "Clear history".
6. **Workspace store:** extend `buildWorkspaceFromState`, `applyWorkspaceToCurrentState` (applying a workspace does NOT auto-run any saved query — it only loads them into the dropdown), and `isWorkspaceDirty` (saved-query changes count as dirty).
7. If no workspace is active when the user saves: keep the saved query in an in-memory "unsaved workspace draft" and surface the existing "save workspace" affordance (`WorkspaceMenu.tsx`) — do not invent a new flow; a saved query simply makes the workspace dirty/creatable.

## Test cases

**Backend:** pre-change workspace JSON loads (compat); workspace with 3 saved queries round-trips through create→get→update→get unchanged.

**Frontend unit (vitest):**

| # | Case | Pass criterion |
|---|------|----------------|
| F1 | push 60 entries | store holds 50, newest first |
| F2 | push duplicate | moved to front, no duplicate |
| F3 | ↑ on empty focused input | fills most recent query |
| F4 | ↑↑↓ | walks back two, forward one |
| F5 | edit after recall, then ↑ | cursor moves, history not triggered |
| F6 | Esc during recall | original typed text restored |
| F7 | `buildWorkspaceFromState`/`applyWorkspaceToCurrentState` | saved queries round-trip; apply does not trigger a search |
| F8 | `isWorkspaceDirty` | true after adding a saved query |

**E2E (extend `e2e-comprehensive.mjs` or new `e2e-saved-queries.mjs`):** import sample log → run `level:error` → run `level:info` → press ↑ twice in empty search box (asserts `level:error` restored) → star it, name "errors", save workspace → reload page → open workspace → dropdown shows "errors" → click applies query + reruns.

## Manual validation

1. Save a query with a relative time range ("last 15 min") — recall next day should re-resolve relative ranges, not pin stale absolutes (follow whatever `WorkspaceTime` already does for workspaces; be consistent with it).
2. History survives page reload; "Clear history" empties it; saved queries are untouched by clearing history.
3. Two browser profiles do not share history (localStorage isolation — expected).

## Acceptance criteria

- [ ] ↑/↓ shell-style recall works per the keyboard model, including Esc restore.
- [ ] Saved queries persist in workspaces, survive backend restart, and old workspace files still load.
- [ ] History capped/deduped, local-only, clearable.
- [ ] All listed tests green; Swagger regenerated.

## Out of scope

- ⌘K palette listing of saved queries (`now-06` consumes this store — keep the store API clean).
- Sharing/export of saved queries (`next-07-case-files.md`).
