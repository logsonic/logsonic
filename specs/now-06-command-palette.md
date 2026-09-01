# now-06 — ⌘K command palette

**Horizon:** Now (v1.8) · **Size:** M · **Priority:** P2 (high UX leverage)
**TBD.md ref:** §5 v1.8, §7 Structure + Keyboard model ("the app's spine").
**Depends on:** now-03 (saved queries/history stores; can be built in parallel if store APIs are agreed).
**Read `specs/README.md` first.**

## Goal

One keyboard surface for everything: ⌘K (Ctrl+K on Win/Linux) opens a palette with fuzzy search over **actions**, **sources**, **saved queries**, and **query history**. The search bar already advertises ⌘K in its placeholder — currently it only focuses search. Make the promise true.

## Design decisions (made)

- Library: **`cmdk`** (the pacocoursey command palette) — battle-tested, composable with the existing Radix stack, ~5 kB. Do not hand-roll list navigation.
- ⌘K opens the palette. Plain `/` keeps its existing behavior (focus the search input) — do not break muscle memory.
- Groups, in order: **Actions**, **Saved queries** (active workspace), **Recent searches** (history store), **Sources** (toggle source filter), **Workspaces** (switch). Empty groups hidden.
- v1 action list (each dispatches through existing stores/handlers — no new business logic in the palette):
  - Import logs… (navigate to `/import`)
  - Export results (trigger `LogExportButton` logic)
  - Toggle theme (useThemeStore)
  - Clear all logs… (opens the existing confirm dialog — never destructive without the dialog)
  - Toggle histogram panel
  - Open MCP setup / docs links (existing Header actions)
  - Copy current query as URL
- The palette is a **dispatcher**: an `actions registry` module exports `{id, title, keywords, group, perform()}`. Future specs (macos-b2 menus) reuse this registry so native menus and palette stay in sync — this is the reason the registry must NOT live inside the React component.

## Current-state anchors

- Global shortcut today: find the existing `/` and `⌘K` key handling (grep `metaKey` / `ctrlKey` / `keydown` in `frontend/src/components/Home/LogSearch.tsx` and `pages/Home.tsx`) and unify into one listener.
- Stores to dispatch into: `useThemeStore`, `useSearchQueryParamsStore` (source toggling, query set), `useWorkspaceStore`, `useQueryHistoryStore` (from now-03), clear-logs flow in `components/Home/Header.tsx` (AlertDialog).
- Radix Dialog styling patterns: `frontend/src/components/ui/` (use the existing dialog primitives so theming tokens apply).

## Step-by-step

1. `npm i cmdk` (frontend).
2. New module `frontend/src/lib/actions.ts` — the registry described above, unit-testable (each action's `perform` calls store methods; inject stores via getters for testability).
3. New component `frontend/src/components/common/CommandPalette.tsx` — cmdk inside a Radix Dialog; groups per above; fuzzy provided by cmdk; footer hint row (↑↓ navigate · ↵ run · esc close). Styles via `--ls-*` tokens; mono for query/source items, sans for actions.
4. Mount once in `pages/Home.tsx` (or the shell root); single global keydown listener (⌘K/Ctrl+K toggles; ignores events when focus is in an input EXCEPT the dedicated ⌘K).
5. Wire "Recent searches" + "Saved queries" items: selecting sets query/time/sources through the same restore path now-03 built, then runs the search.
6. Destructive action ("Clear all logs…") must open the existing AlertDialog, not clear directly — refactor the dialog out of `Header.tsx` into a shared component if needed.
7. Respect `prefers-reduced-motion` (no scale-in animation when set).

## Test cases

**Unit (vitest):** registry — every action has unique id, non-empty title, callable perform; theme toggle action flips `useThemeStore`; source action toggles the source in `useSearchQueryParamsStore`; palette filter matches on `keywords` (e.g. "dark" finds Toggle theme).

**E2E (extend `e2e-comprehensive.mjs`):**

| # | Flow | Pass criterion |
|---|------|----------------|
| P1 | press ⌘K | palette visible, input focused |
| P2 | type "theme" ↵ | theme class flips on `<html>`, palette closes |
| P3 | type "clear" ↵ | AlertDialog appears (and Cancel works; logs NOT cleared) |
| P4 | with 2 sources imported, ⌘K → type source name ↵ | source filter toggles, search reruns |
| P5 | esc | closes; focus returns to previously focused element |
| P6 | `/` key | still focuses the search input, palette does NOT open |

## Manual validation

Keyboard-only session: import → search → filter source → toggle theme → export, never touching the mouse. Screen-reader smoke check (VoiceOver): palette announces as dialog, items readable.

## Acceptance criteria

- [ ] ⌘K/Ctrl+K opens; all five groups populate from live state; `/` unchanged.
- [ ] Registry module is UI-independent (imported by the palette, importable by future native-menu bridge).
- [ ] Destructive actions always route through existing confirm dialogs.
- [ ] Tests green; visible focus states; reduced-motion respected.

## Out of scope

- Palette-driven log-row actions (copy row, filter-by-value — belongs to the row inspector work, TBD §7 and spec next-08).
- Fuzzy search over log *content* (that's the search bar's job).
