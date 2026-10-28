# Agent prototype validation — 2026-10-28

Implemented chat Agent mode with existing Search preserved, using the existing
Claude Code proxy at 127.0.0.1:8789 and claude-sonnet-5-5.

## Observed runtime

- Real browser demo: imported 72 synthetic rows from three local JSONL files,
  found 18 errors, correlated payments pool exhaustion with checkout and gateway
  failures, then queried trace order-018 without reimporting.
- The trace evidence includes all three sources at 2026-10-28T10:18:00Z.
- Exact phrase query `trace_id:"order-018"` returns three rows. Unquoted
  hyphenated identifiers may match broadly; the agent tool description and
  instructions now explain quoting and checking returned versus total counts.
- Real HTTPS import from the project's public app-json.log sample: 99,822 bytes,
  500 rows stored, zero failures.
- Returned to the existing Logs page without browser exceptions. Agent route
  at 390px viewport has no horizontal overflow.
- CloudWatch CLI fixture checks explicit profile/region, single-page collection,
  preserved AWS event timestamps and truncation. Live AWS was not exercised:
  the host has no AWS CLI.

## Checks

- Frontend: 34 test files, 385 tests pass; production Vite build passes.
- Backend: `go test ./...` passes. One repeated run hit the existing live-tail
  timing failure in TestDeleteStorageDay (tail row not catalogued within 5s).
  Uncached focused rerun including that test, all Agent HTTP tests and MCP route
  coverage passes. No live-tail implementation was changed.
- Regression tests cover empty Anthropic tool inputs, actual tool-driven import
  and query, JSON timestamp normalization, token-limit reporting, non-public
  download addresses, CloudWatch and loopback route restrictions.
- `git diff --check` passes. Build has existing chunk-size/import warnings;
  repo-wide TypeScript diagnostics outside this feature remain.

## Artifacts and reproduction

Run `node demo/agent-demo.mjs` with the servers described in
[the demo instructions](../demo/agent-README.md). Captured JSON responses,
screenshots and browser recording are at `/tmp/logsonic-agent-demo-artifacts`.
The running demo uses a separate `/tmp/logsonic-agent-demo-final` index.

This is a finite investigation prototype. Analysis samples at most 200 matching
rows and reports this limit; it does not establish exhaustive anomaly detection
or real-world causal accuracy. Claude receives selected log evidence. There is
no redaction pipeline or durable chat history. No commit or deployment was made.

## Inline chat and MCP UI control update

Agent chat now replaces the main view's top search controls in a 320px bounded
panel; the chart and log table stay below. Real-browser checks verified retained
search draft and conversation across Search / Agent switches, disabled hidden
search shortcuts and the mobile layout. Successful agent replies refresh the
visible results without resetting the current filters.

A live Claude request invoked the actual registered MCP `ui_show_view` handler,
which drove the real browser through `/ui/command` and received its acknowledgement.
The view changed to six ERROR rows from payments.jsonl, 10:00–11:00 UTC, with
columns timestamp/message/level/service/trace_id. The URL and UI stayed at
`#/agent`, including after switching modes. This caught and fixed a store URL
writer that had previously overwritten the Agent route during search updates.

Latest frontend checks: 35 test files, 388 tests pass; production build passes.
Backend full suite and focused shared MCP schema/adapter/acknowledgement tests
pass. The adapter forwards request cancellation and excludes non-UI tools.
Reproduce with `node demo/agent-ui-demo.mjs` after populating the demo index.
Evidence: `/tmp/logsonic-agent-demo-artifacts/ui-control.json` and
`agent-ui-controlled.png`. No commit was made.

## Agent dock, streaming and investigation tools — 2026-10-28 (later)

The stacked chat-above-logs layout was replaced by a right-hand dock (Cmd/Ctrl+J,
header button, rail; `#/agent` opens it). Replies stream over SSE; steps show a
live spinner and a "Show in table" action. Investigations persist in
localStorage with a history list. New tools: `log_histogram`, `facet_logs`,
`log_context`, `compare_windows`. Limits raised to 16 rounds, 40 tool calls,
5 minutes.

Observed with the real proxy (claude-sonnet-5-5):

- `node demo/agent-demo.mjs` against a fresh index: imported the three demo
  files, then used list_sources, log_histogram, facet_logs, query_logs and
  compare_windows, and identified payments pool exhaustion. The follow-up used
  only query_logs (no reimport). After the import the table showed all 72 rows
  and three sources. The conversation survived closing and reopening the dock.
- `node demo/agent-ui-demo.mjs`: the agent called ui_get_state and
  ui_show_view; the table showed the six payments failures beside the dock, and
  the driving step was marked "In table".
- "Show in table" on a log_context step showed the 12 events around 10:17.

Bugs found and fixed while checking:

- `ui_set_sources` with an empty list (documented as "all sources") selected no
  source, so the table showed nothing. It now selects every known source.
- After an agent import the source catalog was not refreshed, so the table
  stayed on "No logs yet". The dock now refreshes it before searching.
- compare_windows counted events on a shared boundary in both windows. Windows
  are now half-open; a regression test fails without the fix.
- The `OR`/`AND`/`NOT` operators were highlighted inside words ("order").

Checks: frontend 36 files / 402 tests, TypeScript and production build pass;
`go vet` and `go test ./pkg/server/... ./pkg/mcp/...` pass. Light, dark and
390px layouts reviewed (no horizontal overflow at 390px).
