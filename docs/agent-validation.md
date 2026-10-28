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

## Hidden-incident detection eval — 2026-10-28 (evening)

Goal: check that the agent can find small problems hidden in a realistic
volume of logs, pin each one down and save a view of it. Harness and data are
in `demo/agent-eval/` (see its README).

Data: one synthetic day, 188,864 JSON lines from five services. Three problems
are hidden mostly in INFO/WARN rows: password guessing and a takeover of
`svc-backup` from 185.220.101.47 followed by `pg_dump` and admin exports; JPY
charges declined with `psp_code=invalid_amount` after a config reload at
11:32; a Safari-only `PaymentForm` TypeError in web release 5.8.0. Decoys
include SSH scanners, Redis timeout ERRORs and a reindex ERROR burst. The
answer key stays outside the import directory.

Results with the real proxy (claude-sonnet-5-5), driven through the dock:

| Run | Intrusion | Payment | UI bug | Views | Time, tool calls |
|---|---|---|---|---|---|
| Before this change, blind | missed | missed | missed | 0 | 70 s, 39 calls, then "agent turn limit reached" |
| After (first build), blind | pinpointed | pinpointed | pinpointed | 3 + 1 for the reindex burst | 56 s, 28 calls |
| After (first build), hinted | pinpointed | pinpointed | pinpointed | 3 | 39 s, 27 calls |
| After (final build), blind | pinpointed | pinpointed | pinpointed | 3 + 1 for the reindex burst | 62 s, 34 calls |
| After (final build), hinted | pinpointed | pinpointed | pinpointed | 3 | 29 s, 19 calls |

The final build adds the span-based slicing and the slice-edge fix described
below; the first build scanned the same rows in one slice.

"Pinpointed" means the answer names the required identifiers (for example
`svc-backup` and `185.220.101.47`; `JPY` and `invalid_amount`; `Safari` and
`5.8.0`), gives a time inside the problem window, and a tool result contains
the identifier. Both blind answers also found the three admin exports; both
hinted answers reported the `pg_dump` but not the exports. Counts in every
answer match the ground truth (42 failed logins, 324 JPY declines, 386 TypeErrors). Every
saved view was opened in the UI through `open_workspace` and screenshotted.

What the "before" run showed, and what changed:

- **JSON lines were mis-parsed.** When key sets vary between lines (session
  lines without `src_ip`), auto-detection chose an inferred text pattern over
  the JSON skeleton. `auth.jsonl` and most of `web-client.jsonl` were stored as
  `text_1…text_14`, and `message` held a fragment of the object. The baseline
  agent spent its rounds working around those fields. Auto import now decodes
  any JSON-object line that the discovered pattern did not parse as JSON, with
  the producer's own key names (`json_lines.go`).
- **No tool covered the tail.** `facet_logs` shows top values over at most
  20,000 rows and `analyze_logs` samples 200, so a 42-row brute force or a
  3-row export never surfaced. New `log_patterns` scans every row (default
  300,000, up to 1,000,000) into masked message templates, rare categorical
  values and sparse fields, sorted rare-first, by count or by onset.
- **Findings could not be kept.** New `save_view` stores a finding as a
  workspace with a fixed window and reports how many rows it matches.
- **Scans were slow.** Every search-after batch re-reads the sort keys of
  all rows after the cursor. Storage `ScanRows` (now shared with facets)
  uses batches of 10,001 rows instead of 1,000 (189k rows: 24 s to 5.4 s)
  and walks time slices of about 5,000 rows across the span the matching
  rows actually cover, newest first (5.4 s to 3.5 s). Slicing at first
  dropped 66 rows near slice edges, because stored timestamps keep whole
  seconds while the index keeps milliseconds; rows are no longer re-checked
  against the stored value when the query already applied the range, and a
  test with mid-second slice edges covers it.
- Limits rose to 24 rounds, 60 tool calls and 10 minutes, and the system
  prompt adds a sweep step for open-ended requests.

Checks: `go vet ./...` and `go test ./...` pass (new tests for slicing, the
JSON-line fallback, which fails without the fix, `log_patterns` and
`save_view`); frontend 404 tests and `tsc --noEmit` pass.

Limits: one seed of synthetic data with deliberately planted hints; this shows
the tools and method work, not real-world accuracy. Each run is a single
sample of a non-deterministic model. Scoring is substring-based. Search
highlighting splits hyphenated terms (`svc` in `svc-backup`), a cosmetic issue
seen in the view screenshots. The JSON-line fallback keeps the producer's key
names, while lines that fit log2grok's JSON skeleton get its canonical names
(`src_ip` becomes `client_ip`, `msg` becomes `message`), so a file with a few
outlier lines can carry both spellings of a field.

## External MCP servers and model endpoints — 2026-10-28 (night)

The agent now calls tools from MCP servers listed in `<storage>/mcp.json`
(`pkg/agentmcp`), and the model endpoint may be any HTTPS host (plain HTTP
stays localhost-only).

Live check against the eval index (claude-sonnet-5-5 through the local proxy),
with `mcp.json` listing the official filesystem server
(`npx -y @modelcontextprotocol/server-filesystem`, restricted by `tools` to
`read_text_file`, `list_directory` and `search_files`) on a folder of on-call
notes, plus a server whose command does not exist:

- `GET /api/v1/agent/mcp` connected the filesystem server with exactly the
  three allowed tools (`mcp__notes__…`) and reported the broken server's
  `fork/exec … no such file or directory` without affecting the other.
  `/agent/status` showed `{"servers":2,"connected":1,"tools":3}`.
- Asked which open ticket matches the JPY declines, the agent called
  `mcp__notes__list_directory` and `mcp__notes__read_text_file`, then
  `facet_logs`, `query_logs` and `log_histogram`, and answered INC-2207 with
  324 `invalid_amount` declines from 11:35:01Z. 18 s, 9 tool calls, no tool
  errors. It also said the logs do not mention fx_table or the build, which is
  wrong (the config-reload row does); it never queried that row.
- Stopping the server with SIGINT ended the `mcp-server-filesystem` child.

Tests: `pkg/agentmcp` uses in-process MCP servers (no child processes) for
namespacing and the 64-character name rule, allowlists, `isError` mapping,
image placeholders, isolation of a failing server, reload after a file edit,
secrets absent from the status, the child environment without
`LOGSONIC_AGENT_*` or `ANTHROPIC_*` credentials, and SSE and Streamable HTTP
sessions that keep working after the handshake context ends (that test failed
before the fix: the SSE event stream was bound to the 15 s connect timeout). A server test routes a model's `mcp__…` call through the
chat endpoint; handler tests cover the endpoint URL rules and the
`ANTHROPIC_API_KEY` fallback, which only `api.anthropic.com` receives. Frontend tests cover the `server · tool` label,
the step summary and the status refresh after each turn.

Not run here: the Claude API over HTTPS (no API key on this host), Ollama and
LiteLLM (not installed). Their README instructions follow the vendors'
documentation; the request LogSonic sends is the same one the local proxy
accepts.

## False-positive control on clean data — 2026-10-28 (night)

Same harness and model (claude-sonnet-5-5 through the local proxy) on
`generate_incidents.py --clean`: 187,807 rows with every decoy but none of the
three problems. Two benign change events were left in as bait: the 11:32
payments config reload (`fx_table=v2 minor_units=static`) and the web 5.8.0
rollout. After each answer the harness asked, with tools disallowed, for the
confirmed problems as `PROBLEM: <severity> | <title>`; medium or higher counts
as a false positive.

| Run | False positives (medium+) | Low/info | Views saved | Time, tool calls |
|---|---|---|---|---|
| Blind | none | low: reindex lock contention, self-resolved | 1 (reindex burst, 181 rows) | 68 s, 32 calls |
| Hinted | none | low: reindex burst; info: SSH spraying, routine declines, 502s and Redis retries, browser console noise | 0 | 49 s, 25 calls |

- Blind: reported one confirmed problem, the reindex burst, labelled minor and
  already resolved. It flagged the config reload as "worth a look, not
  confirmed", checked JPY amounts and the decline rate before and after (3.2%
  and 3.1%), and did not save a view for it.
- Hinted: answered "nothing found" for intrusion, payments and UI. It checked
  that every successful login is a public key from an internal address, that
  the decline rate did not change at the reload, and that the checkout funnel
  is intact across browsers and versions (2,325 page views, clicks and
  submissions).
- Counts checked against the raw files: 870 failed logins from 870 IPs, 540
  public-key logins, 784 declines by code, 124 Redis retries, 1,554
  ResizeObserver and 1,338 gtm.js warnings, 308/363/1,268 gateway
  502/499/404s, all exact. One slip: "784 of 25,418 charges" divides by
  every row in `payments.jsonl`; there are 24,990 charges (still about 3%).
- The blind run saved a view for a self-resolved, low-severity event. That is
  not a false alarm, but a stricter prompt could reserve views for problems
  that need action.

Limits: one sample per prompt, one seed. A single clean pass shows the agent
did not invent incidents here; it does not bound the false-positive rate.
