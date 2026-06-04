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
| `log_distribution`    | Time-bucketed log counts without the row payload — fast trend overview. |

The agent-facing playbook — query syntax, workflow, common recipes, pitfalls — lives in **[SKILLS.md](SKILLS.md)**. Point your MCP client at it so the model knows how to use the tools effectively.

## Connect your MCP client

### Option A — HTTP transport (recommended)

LogSonic exposes the MCP server directly on its HTTP port at `/mcp`. No binary path, no extra install — just a URL. Works with Claude Desktop, Cursor, Windsurf, and any MCP client that supports the Streamable HTTP transport (updated after March 2025).

```json
{
  "mcpServers": {
    "logsonic": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

If LogSonic is running on a different port, replace `8080` accordingly.

**Config file locations:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Cursor: `mcp.json` in your project or global Cursor settings

**Verify:** after restarting your client, run:
```bash
curl http://localhost:8080/mcp
```
You should get a JSON-RPC response. If not, make sure LogSonic is running first.

---

### Option B — binary stdio (fallback)

Use this if your client doesn't support HTTP transport yet. The MCP server is built into the `logsonic` binary — a downloaded binary or Homebrew install already includes it.

```json
{
  "mcpServers": {
    "logsonic": {
      "command": "/path/to/logsonic",
      "args": ["mcp"],
      "env": {
        "LOGSONIC_URL": "http://localhost:8080"
      }
    }
  }
}
```

Run `which logsonic` to find the binary path. When the client starts, check its MCP log for:
```
[logsonic-mcp] connected to LogSonic at http://localhost:8080
```
If you see the `WARNING: ... is not reachable` line instead, start LogSonic first.

### Environment variables (Option B / HTTP transport with non-default address)

| Variable              | Default                | Purpose                                              |
|-----------------------|------------------------|------------------------------------------------------|
| `LOGSONIC_URL`        | (composed)             | Full base URL. Wins over host/port. Use for HTTPS or non-standard paths. |
| `LOGSONIC_HOST`       | `localhost`            | LogSonic host.                                       |
| `LOGSONIC_PORT`       | `8080`                 | LogSonic port.                                       |
| `LOGSONIC_TIMEOUT_MS` | `30000`                | Per-request timeout (Option B only).                 |

## Pointing at a remote LogSonic

Option A: just change the URL in the config:
```json
{ "mcpServers": { "logsonic": { "url": "https://logs.internal.example.com/mcp" } } }
```

Option B: set `LOGSONIC_URL` in the `env` block:
```json
"env": { "LOGSONIC_URL": "https://logs.internal.example.com" }
```

## Reliability

- **Startup probe** — on stdio start, pings LogSonic and logs a warning to stderr if unreachable.
- **Per-request timeout** — 30 s default (configurable via `LOGSONIC_TIMEOUT_MS`).
- **Structured errors** — `UserError` messages reach the model as readable text, not opaque stack traces.
- **Stateless HTTP** — the HTTP transport uses no session state; every request is independent.
