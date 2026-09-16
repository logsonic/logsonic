# next-09 — Query-bar UX (default_operator, inline parse errors, autocomplete)

**Horizon:** Next · **Size:** S–M · **Priority:** P1. Medium-depth spec.
**TBD.md ref:** §2 P1 (`%` mangling — the *fix* lands in `now-07`; this spec surfaces parse errors), §7 Query bar, §12 non-goal "no new DSL".
**Depends on:** `now-02` (facets endpoint feeds value autocomplete).
**Read `specs/README.md` first.**

## Goal

`mcp/SKILLS.md` documents two footguns of the current query syntax: bare terms are OR-ed (`error api` matches either) and `-foo` alone is a no-op. Humans hit both constantly and get no feedback when a query fails to parse (the UI shows an empty result). Fix the ergonomics **without** a new language: an explicit operator setting, visible parse errors, and completion for field names/values.

## Design decisions (made)

- **`default_operator` is a request parameter, never a silent rewrite.** `GET /api/v1/logs` (and `/logs/context`, `/patterns` later) accept `default_operator=and|or` (default `or` — unchanged for every existing caller including MCP). Implementation: Bleve's `QueryStringQuery` has no such switch, so build the query via the parser then post-process the top-level `BooleanQuery`: when `and`, move `Should` clauses of bare terms into `Must` (nested groups untouched). Unit-test the rewrite on the parsed tree, not on strings. The UI sends `and` by default with an `AND|OR` toggle at the bar's right edge (persisted per workspace as `Workspace.QueryOperator`). MCP `query_logs` gains an optional `default_operator` argument; `SKILLS.md` documents it and keeps recommending explicit `+` for agents.
- **Inline parse errors.** The handler already returns 400 `invalid query: …` from Bleve; the frontend currently swallows it into a generic error. Render it under the bar (not a toast), with the offending span highlighted when Bleve's message contains a position (it often does: `parse error at line 1 col N`), plus a one-line hint table for the common cases (unbalanced quote, `:` in value → quote it, leading `-` with nothing required → add a `+` term or switch to AND). After `now-07` deletes the `PathUnescape` double-decode, `%` never reaches this path as an error.
- **Autocomplete** (cmdk-style popover anchored to the caret, not a dropdown that steals Enter): after typing ≥ 1 letter with no `:` in the current token → field names from `available_columns` (already in `useSearchQueryParamsStore`); after `field:` → top values from `GET /logs?include_facets=true&facets_only=true&limit=0` for that field (the `facets_only` param is specified in `next-05`; add it here if `next-05` has not landed — same contract); after a space → operator hints (`+`, `-`, `"`). `Tab`/`→` accepts, `Esc` dismisses, `Enter` always submits the search (never accepts a suggestion). Values are escaped with the shared helper from `now-02` (`lib/utils.ts`). Debounce 120 ms; abort in-flight facet requests on keystroke.
- **Query chips (read-only).** Below the bar, render the parsed query as chips (`level:error`, `-service:test`, `"connection timeout"`) using the existing `useSearchParser` tokens, each with an ✕ that removes the clause. This is display + removal only; editing happens in the text field.

## Anchors

`components/Home/LogSearch.tsx` (bar, hints, key handling), `hooks/useSearchParser.tsx` (tokenizer for chips), `hooks/useSearchLogs.ts` (param assembly), `handlers/logs.go` (param parsing, error shapes), `storage/search_page.go` `buildPageQuery` (parse site — post-process here), `pkg/mcp/server.go` `query_logs`, `mcp/SKILLS.md`, `types.Workspace`.

## Test cases

Backend: A1 `error api` with `and` → both required; A2 `+(a b) c` with `and` → group untouched, `c` required; A3 `-foo` alone with `and` → 400 with a helpful message ("nothing to match against; add a term or use `+`") — decide + document; A4 `or` path byte-identical to today (regression on a fixture of 20 queries). Frontend: parse error rendering with position highlight; autocomplete accept/dismiss/Enter semantics; chip removal updates the query and re-runs; toggle persisted in workspace. E2E: type `level:` → values appear from facets → accept → run → chips show → remove chip → results update.

## Acceptance criteria

- [ ] `default_operator` implemented on the parsed tree, default unchanged, MCP documented.
- [ ] Parse errors visible inline with actionable hints; never a silent empty result.
- [ ] Autocomplete never intercepts Enter; escaping shared with facets.
- [ ] `SKILLS.md` updated; Swagger regenerated.

## Out of scope

A new query language, saved-query templating, natural-language-to-query (non-goal: agents do that).
