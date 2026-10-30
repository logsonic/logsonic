# Agent mode prototype demo

Selected log evidence is sent through the local proxy to Claude. Ordinary Search
stays local. Design and data boundaries: [agent-mode.md](../docs/agent-mode.md).

If `curl http://127.0.0.1:8789/health` fails, start the existing proxy:

```sh
cd /Users/akashgoswami/src/claude-code-api
npm run proxy
```

From the LogSonic repository, start the backend with an isolated index:

```sh
cd backend
go build -o /tmp/logsonic-agent-prototype .
/tmp/logsonic-agent-prototype -host 127.0.0.1 -port 8097 -auto-port=false -storage /tmp/logsonic-agent-demo-20261028
```

In another terminal:

```sh
cd frontend
PORT=5173 VITE_API_BASE_URL=http://127.0.0.1:8097 npm run dev -- --host 127.0.0.1
```

Open http://127.0.0.1:5173/#/agent (or press Cmd/Ctrl+J on the log view). The
agent dock opens on the right; search, chart and table stay on the left. Ask:

> Import all logs from /Users/akashgoswami/src/logsonic/demo/agent-logs.
> Find anomalies and correlate the incident across services using trace IDs
> and timestamps. Identify the likely cause with specific evidence.

Then ask:

> Show the exact evidence for trace order-018 across all three services.
> Query the imported logs; do not reimport.

The 72 synthetic events include a warning at 10:17 UTC and 18 failures from
10:18–10:23 UTC. Payments reports database pool exhaustion at 50 connections;
checkout and gateway report downstream failures with shared order trace IDs.
These fixtures verify prototype behavior, not real-world diagnostic accuracy.

Run the real-browser demo from the repository root:

```sh
node demo/agent-demo.mjs
```

It verifies ingestion, a queried follow-up and that the investigation survives
closing and reopening the dock; turn data (from the dock's saved state),
screenshots and video go under `/tmp/logsonic-agent-demo-artifacts`.
Set `HEADLESS=0` for a visible browser. Reimport can append duplicates; use a fresh
storage path for independent runs. Do not delete a running server's index.

## Other sources and limits

- HTTPS: a public direct log URL, up to 16 MiB. Private/special network addresses
  are refused. Tool results show the remote source name. No SSH collection.
- AWS: requires installed AWS CLI and configured read-only named profile. Specify
  CloudWatch log group, profile, region and time interval in chat. One page of at
  most 1,000 events; truncation is reported. CLI fixture tests do not prove live
  AWS access. Credentials stay in the CLI environment.
- Local: absolute regular file or non-recursive directory; up to 16 files and
  64 MiB per file. Hidden files in a directory are skipped; entries that are
  refused or not regular files are skipped and listed in the result.
  Credential locations (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `.env`
  files and similar) are refused. Set `LOGSONIC_AGENT_INGEST_ROOT` to limit
  imports to one folder.

Settings > Agent saves the API format (Anthropic or OpenAI compatible),
endpoint, model and API key to `<storage>/agent.json` (0600), and its Test
button checks them before you save; the variables below win over it.
`LOGSONIC_AGENT_PROVIDER` is `anthropic` (default) or `openai`.
`LOGSONIC_AGENT_PROXY_URL` is the full endpoint, ending in `/v1/messages` or
`/chat/completions`, default `http://127.0.0.1:8789/v1/messages`. Plain HTTP is accepted only for
localhost; use HTTPS for the Claude API or a remote gateway. The README's
"Connect a model" section has Claude API, Ollama and LiteLLM setups.
`LOGSONIC_AGENT_MODEL` defaults to `claude-sonnet-5-5`.
`LOGSONIC_AGENT_PROXY_KEY` defaults to `local-proxy` (for
`https://api.anthropic.com`, `ANTHROPIC_API_KEY` when set, and for
`https://api.openai.com`, `OPENAI_API_KEY`); override for a
keyed proxy.
External MCP servers for the agent go in `<storage>/mcp.json`
(`LOGSONIC_AGENT_MCP_CONFIG` overrides the path); check them with
`curl http://127.0.0.1:8097/api/v1/agent/mcp`.

Agent endpoints accept loopback clients only. Requests are bounded to ten
minutes, 24 model rounds and 60 tool calls. With `"stream": true` the chat
endpoint answers with server-sent events (`text`, `step_start`, `step`, `done`,
`error`); without it, one JSON reply arrives at turn end. Investigations are
saved in the browser's localStorage.
LogSonic adds no general shell tool, redaction pipeline or continuous AWS
subscription; external MCP servers add only the tools you configure.

Stop the demo terminals with Ctrl+C. The existing proxy is separately managed;
only stop it if started for this demo (`npm run stop` in its repository). Binary,
isolated demo storage and browser artifacts are under `/tmp`.

To drive the UI from chat, try: “Show only ERROR logs from payments.jsonl for
2026-10-28 10:00–11:00 UTC, with timestamp, message, level, service and trace_id
columns.” The agent uses the existing MCP UI methods and reports acknowledged
state in its action evidence.

After the incident demo has populated a fresh index, run
`node demo/agent-ui-demo.mjs` to verify real MCP-driven UI changes and Search /
Agent mode retention. It expects the six synthetic payments failures.
