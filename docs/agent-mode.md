# Agent mode prototype

The agent is a resizable dock on the right of the log view. The header Agent
button, the icon rail and Cmd/Ctrl+J toggle it; `#/agent` still works as a link
that opens the dock. Search, chart, table, sidebar and status bar stay visible
on the left, so the agent can drive the table while the operator watches it.
Below 820px the dock covers the workspace instead of squeezing the table.

Replies stream. Each tool call appears in the action trail as soon as it
starts, with a spinner until its result arrives, and answer text appears token
by token. Stop (or Esc in the composer) cancels the request, including the
model call and any running tool. Every search-like step has a "Show in table"
action that applies its query, sources and time range to the log table; the
step currently driving the table, whether applied by the operator or by a
`ui_*` tool, is marked "In table".

Investigations persist in the browser (localStorage, newest 30). The history
button lists them; New starts a fresh one. A follow-up sends earlier answers
plus a short digest of the tools each turn used, so the agent knows what is
already imported or found.

## Design

The operator describes an incident and identifies its sources. Claude selects
bounded tools, LogSonic executes them, and results return to Claude until it can
answer. Follow-up questions reuse the conversation. The Go process owns the tool
runtime and calls the existing Anthropic-compatible Claude Code proxy; browser
code never reads Claude credentials.

Sources include server-local paths/directories, HTTPS log downloads and AWS
CloudWatch log groups. CloudWatch uses the installed AWS CLI with an explicit
profile and region. Agent mode is an interactive, finite investigation, not a
continuous ingestion scheduler. Existing watched folders handle ongoing files.

Ingestion uses the existing parser/index. The investigation tools are:
`list_sources`; `log_histogram` (exact counts per time bucket and source);
`facet_logs` (top values per field); `compare_windows` (exact totals and rates
for a baseline and an incident window, each including its start and excluding
its end); `log_context` (events around a timestamp, oldest first);
`query_logs` (rows plus exact total); and `analyze_logs` (a sample summary).
The system prompt asks the agent to orient, narrow, confirm, then present the
evidence in the UI. Correlation
suggests hypotheses, not proven causality. Tool output and scanned data are
bounded; answers must state sampling limits and distinguish counts from a sample
from whole-source totals. Logs are untrusted data, not instructions.

## Data and runtime boundary

Agent mode sends prompts, tool results and selected log evidence through the
local proxy to Claude. It requires network access and the proxy account; ordinary
Search remains local. Do not use Agent mode with logs that cannot be sent to that
provider. The prototype has no redaction pipeline. AWS credentials stay with the
local AWS CLI and are not sent in prompts. Remote downloads and AWS reads occur
only when selected as tools for an investigation.

Configuration and exact runnable instructions are in `demo/agent-README.md`.
Conversation state is held by the frontend in localStorage on this machine.
The prototype does not promise exhaustive anomaly detection, SSH collection or continuous
AWS subscription. Tool actions are bounded reads and additive ingestion; there
is no general command execution tool.

## Acceptance

- Search and Agent routes render and remain reachable through the same rail.
- A real proxy tool loop imports the three local demo sources into a fresh index.
- An answer identifies the error cluster and cross-service trace evidence.
- A follow-up can query already imported logs.
- Mock-proxy tests exercise tool execution and failure paths.
- Production frontend build and relevant Go/frontend regression checks pass.
- HTTPS and CloudWatch connectors have explicit limits and errors; a live AWS
  account is not required to run the local incident demo.

## UI control from chat

The embedded agent also uses the existing MCP `ui_*` tool registry. Schemas and
handlers are shared with external MCP clients, so chat can inspect UI state,
show a result view, apply queries/filters/time/source selections, adjust columns,
sort/page results, open sidebars and navigate. Tool evidence includes the UI's
acknowledged state; no connected UI or a rejected command is reported as an error.
The dock stays open while log-view commands update the table beside it.
