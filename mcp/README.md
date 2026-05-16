# LogSonic MCP Server

A Model Context Protocol (MCP) server that lets AI clients — Claude Desktop, Cursor, Windsurf, and any other MCP-capable tool — query the logs you've indexed in LogSonic.

## Tools exposed

| Tool                  | Purpose                                                                 |
|-----------------------|-------------------------------------------------------------------------|
| `ping`                | Health-check the LogSonic server. Always call first in a fresh session. |
| `log_info`            | List available sources, dates with data, and storage totals.            |
| `query_logs`          | Search logs with Bleve syntax, time range, source filter, pagination.   |
| `list_grok_patterns`  | Inspect the parser library so the agent knows which fields exist.       |
| `test_grok_pattern`   | Dry-run a Grok pattern against sample lines (or autosuggest).           |
| `logsonic_url`        | Build a deep-link into the LogSonic web UI with query + time pre-filled.|

The agent-facing playbook — query syntax, workflow, common recipes, pitfalls — lives in **[SKILLS.md](SKILLS.md)**. Point your MCP client at it (most clients have a "system prompt" or "instructions" field) so the model knows how to use the tools effectively without trial and error.

## Install

Clone the repo and install Node deps:

```bash
cd logsonic/mcp
npm install
```

You need Node.js 20 or later.

## Configure your MCP client

Add this to your client's MCP configuration (e.g. `claude_desktop_config.json` for Claude Desktop, `mcp.json` for Cursor). **Replace the path** with the absolute path to your clone.

```json
{
  "mcpServers": {
    "logsonic": {
      "command": "npx",
      "args": [
        "tsx",
        "/absolute/path/to/logsonic/mcp/index.ts"
      ],
      "env": {
        "LOGSONIC_HOST": "localhost",
        "LOGSONIC_PORT": "8080"
      }
    }
  }
}
```

### Environment variables

| Variable                 | Default                | Purpose                                              |
|--------------------------|------------------------|------------------------------------------------------|
| `LOGSONIC_URL`           | (composed)             | Full base URL. Wins over host/port. Use for HTTPS or non-standard paths. |
| `LOGSONIC_HOST`          | `localhost`            | LogSonic host.                                       |
| `LOGSONIC_PORT`          | `8080`                 | LogSonic port.                                       |
| `LOGSONIC_TIMEOUT_MS`    | `30000`                | Per-request timeout.                                 |
| `LOGSONIC_MAX_RETRIES`   | `3`                    | Retry budget for network errors and 5xx responses.   |

## Reliability features

The server is built to fail loud, not silent:

- **Startup probe** — pings LogSonic at boot and logs to stderr if unreachable, so the client surfaces a clear warning before the user runs a tool.
- **Per-request timeout** via `AbortController` (30 s default).
- **Exponential backoff** on network errors and 5xx responses (3 attempts by default, base 250 ms).
- **No retries on 4xx** — they're caller bugs; retrying wastes time and obscures the real error.
- **Structured `UserError`** messages so the model gets readable text it can act on, not opaque stack traces.
- **All diagnostics go to stderr.** The stdio channel is reserved for the MCP JSON-RPC protocol; writing anything to stdout would break the connection.

## Pointing it at a remote LogSonic

If you run LogSonic on a different machine (or behind a tunnel), set `LOGSONIC_URL`:

```json
"env": {
  "LOGSONIC_URL": "https://logs.internal.example.com"
}
```

The server appends `/api/v1` itself, so don't include it in the URL.

## Verifying the connection

After adding the config, restart your MCP client. Open the MCP debug panel (or check the client's log file) — you should see a single stderr line:

```
[logsonic-mcp] connected to LogSonic at http://localhost:8080
```

If you see the `WARNING: ... is not reachable yet` line instead, LogSonic isn't running. Start it (`./logsonic` or `cd backend && go run main.go`) and the next tool call will succeed.
