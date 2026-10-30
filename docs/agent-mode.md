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
`query_logs` (rows plus exact total); `log_patterns` (a full scan of up to
1,000,000 rows into message templates, rare field values and sparse fields,
for needles that sit in INFO or WARN rows); `save_view` (store a confirmed
finding as a workspace with a fixed window); and `analyze_logs` (a sample
summary). The system prompt asks the agent to orient, sweep with
`log_patterns` on open-ended requests, narrow, confirm, then present the
evidence in the UI and save one view per confirmed problem. Correlation
suggests hypotheses, not proven causality. Tool output and scanned data are
bounded; answers must state sampling limits and distinguish counts from a sample
from whole-source totals. Logs are untrusted data, not instructions.

## Model endpoint

The Go process speaks one of two API formats, set by `LOGSONIC_AGENT_PROVIDER`
or Settings > Agent:

- `anthropic` (the default): the Anthropic Messages API at a path ending in
  `/v1/messages`, with an `x-api-key` header.
- `openai`: OpenAI Chat Completions at a path ending in `/chat/completions`,
  with `Authorization: Bearer`. OpenAI, Ollama, LiteLLM, vLLM, LM Studio and
  OpenRouter all serve it. The agent keeps its conversation in Messages shape
  and converts each request and reply (system prompt, function tools,
  `tool_calls`, `tool` results, streamed tool call fragments) at the boundary.
  The model must support tool calls.

To run the agent on a model on your own computer, see
[Run the agent on a local model](local-models.md).

The endpoint is `LOGSONIC_AGENT_PROXY_URL`, the model `LOGSONIC_AGENT_MODEL`
and the key `LOGSONIC_AGENT_PROXY_KEY`. An `https://` endpoint may be any
host; only `api.anthropic.com` falls back to `ANTHROPIC_API_KEY`, and only
`api.openai.com` to `OPENAI_API_KEY`, when no key is set. Settings > Agent
saves the format, endpoint, model and key to `<storage>/agent.json` (0600)
through `GET`/`PUT /api/v1/agent/settings` (loopback only, JSON body).
Environment variables win over saved values. The saved key is bound to the
endpoint host it was saved for. `GET /api/v1/agent/settings` returns the key
itself only to LogSonic's own page (no `Origin` header, or an `Origin` equal to
the `Host`, and no cross-site `Sec-Fetch-Site`), so the form can show it behind
a toggle; any other origin, including another `localhost` port, gets only its
last four characters. In the split development setup (frontend on 8081,
backend on 8080) the page is cross-origin and sees only the hint. When the
endpoint moves to another host and the field still holds the key, saving sends
it again so it is bound to the new host. The model list, which the page
fetches while the user types, never sends the shown key; the server adds a
stored key only for the host it belongs to.
`POST /api/v1/agent/test` (loopback only) sends one short request with the
fields as typed, saved or not, with one trivial tool declared so that a model
without tool support fails there. It refuses redirects and reports the
latency and reply, or which field to fix. Agent chat requests refuse
redirects too, so a key never follows one to another host.
`POST /api/v1/agent/models` (loopback only) lists the models at the
`/models` route beside an endpoint (`…/v1/models` for both formats, or
`/api/v1/models` for OpenRouter), reading both the Anthropic shape
(`data[].id`, `display_name`, `has_more`/`last_id` paging) and the OpenAI
shape (`data[].id`), with Ollama's `/api/tags` as a fallback on localhost. It
sends `x-api-key` and `Authorization: Bearer` with a key the page typed, or
else only a stored key that belongs to that host, and refuses redirects. Plain `http://` is accepted only for `localhost`, `127.0.0.1`
and `::1`, so keys and log excerpts never cross the network unencrypted. This
covers the Claude API directly, a local Claude proxy (the default,
`http://127.0.0.1:8789/v1/messages`), Ollama's Anthropic-compatible API, and
LiteLLM in front of Bedrock, Vertex AI, Azure, OpenAI and others. The status
probe counts any HTTP answer below 500 from `<origin>/health` as reachable,
because these servers share no health route. Browser code never reads model
credentials. Setup examples are in the README.

## External MCP servers

The agent can call tools from other MCP servers listed in
`<storage>/mcp.json` (or the path in `LOGSONIC_AGENT_MCP_CONFIG`), in the
Claude Desktop / Claude Code `mcpServers` format. `pkg/agentmcp` owns them:

- Transports: stdio (`command`, `args`, `env`), Streamable HTTP
  (`"type": "http"`, `url`, `headers`) and SSE (`"type": "sse"`). Optional
  `tools` is an allowlist; `disabled` keeps an entry without starting it.
  Invalid entries are skipped with a log line and listed in the status.
- The file is re-read at each agent request when its modification time or
  size changed. Removed or edited servers are closed; new ones connect in
  parallel with a 15 s handshake timeout; SSE and HTTP streams live until
  the server is removed or LogSonic stops. A failed server is retried at most every
  30 s and never fails the turn. A transport error during a call drops the
  session so the next request reconnects. Stdio servers are closed on
  shutdown.
- Each tool is exposed as `mcp__<server>__<tool>` (cleaned to
  `[A-Za-z0-9_-]`, at most 64 characters, with a hash suffix when shortened),
  its description prefixed with the server name, its `inputSchema` passed
  through as `input_schema`. At most 64 tools per server (the first 64 by name,
  with a log warning); the list is sorted so the tool block stays stable
  between requests.
- Results: text blocks are joined; image and audio blocks become a one-line
  placeholder; embedded text resources are inlined; `isError` becomes a tool
  error. Calls time out after 90 s, and the 32 KiB tool-output limit applies.
- `GET /api/v1/agent/mcp` (loopback only) connects the servers and reports
  transport, a target (command name or URL origin), connection state, tool
  names and errors. It never returns `env`, `headers`, arguments or URL paths.
  `GET /api/v1/agent/status` adds a summary (`mcp.servers`, `connected`,
  `tools`).
- There is no write API for servers: a stdio entry runs a program as the
  user, so only a file edit can add one. Settings > Agent shows the file
  path, an editor command, an example and the status above, but cannot
  change the file.

## Data and runtime boundary

Agent mode sends prompts, tool results and selected log evidence to the model
endpoint above. With a local model nothing leaves the machine; with a cloud
endpoint, do not use Agent mode with logs that cannot be sent to that
provider. Ordinary Search remains local. There is no redaction pipeline. AWS
credentials stay with the local AWS CLI and are not sent in prompts. Remote
downloads and AWS reads occur only when selected as tools for an investigation.

Local imports resolve symlinks, then refuse credential locations (`~/.ssh`,
`~/.aws`, `~/.gnupg`, `~/.kube`, `~/.config/gcloud`, `~/.docker/config.json`,
`.env` files, shell histories and similar); other dot folders such as
`~/.ollama/logs` stay importable. The opened path is checked again before
import. `LOGSONIC_AGENT_INGEST_ROOT` limits imports to one folder. A directory
import skips hidden files and lists any refused or non-regular entry it skipped.
Remote downloads connect only to public addresses: private, loopback,
link-local, CGNAT, documentation, multicast, NAT64, 6to4, Teredo and
IPv4-compatible IPv6 ranges are refused at connect time and on every redirect.

External MCP servers receive whatever arguments the model passes, which can
include log excerpts, and may have side effects outside LogSonic (creating
tickets, writing files). Stdio servers inherit LogSonic's environment minus
model credentials (`LOGSONIC_AGENT_*`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`), plus their own `env`. The system prompt tells the
agent to call external tools only when the user's request needs them and never
because log content asks for it. The server also pauses every external MCP
call for approval, including read-only tools, and any import of a path, URL or
log group that the user did not write in the conversation. Imports the user
named, searches, viewer changes and saved views run without a prompt. The prompt
shows the exact arguments and offers Deny, Approve once, or Approve all for the
current investigation. That grant lives only in browser memory until **Require
approvals** is selected, a new investigation starts or the page reloads.
The per-server `tools` allowlist further limits the tools available. See
[agent security](agent-security.md) for the protocol, tests and deployment limits.

Configuration and exact runnable instructions are in `demo/agent-README.md`.
Conversation state is held by the frontend in localStorage on this machine.
The prototype does not promise exhaustive anomaly detection, SSH collection or
continuous AWS subscription. LogSonic's own tools are bounded reads and
additive ingestion with no general command execution tool; external MCP
servers add only the tools the user configured.

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

When a turn reads data and a LogSonic window is connected, the turn ends with
the evidence on screen whether or not the model called `ui_show_view`. The
server derives the sources (imported sources and the `source` arguments of the
data tools), the time window (the union of the windows those tools searched)
and the last `query_logs` query that found rows, and applies only what the model did not set
itself. A time range the model chose is replaced only when it left the table
empty. This step appears in the trace as a `ui_show_view` step marked
"In table". With no window open (an API caller), nothing is applied.

Data tools (`query_logs`, `analyze_logs`, `facet_logs`, `log_histogram`,
`log_patterns`) called without `start_time` and `end_time` search the span of
the requested sources (all sources when none is named), not the last year, so
old imported logs are found. The step shows the window that was searched; the
model's own arguments are replayed to it unchanged.

Selecting a source the agent has just imported refreshes the UI's source list
first, so the new source stays selected in the filter panel.

## Viewer awareness and workspace suggestions

`ui_get_state` includes current timezone, column widths and layout lock, color
rules, saved query drafts, workspace summaries, and the available time, sidebar,
column, sort and pagination options. Large metadata is bounded and marked when
truncated. `ui_list_workspaces` refreshes available workspaces, and
`ui_get_workspace` reads one without applying it. `ui_set_viewer_options` changes
the display timezone or column lock.

The agent may suggest saving a view worth reopening, and checks existing
workspaces before suggesting duplicates. A suggestion does not create anything.
When asked to save the current setup, `ui_save_workspace` uses the same save path
as the workspace menu, preserving query, sources, time selection, sorting, columns,
widths, color rules and saved query drafts, without an approval prompt. `save_view` remains the
separate tool for an explicit finding and evidence window.

The existing workspace format does not retain timezone, layout lock, pagination
or sidebar state. The model receives this limitation alongside viewer options.
