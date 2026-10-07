# LogSonic MCP Server

A Model Context Protocol (MCP) server that lets AI clients — Claude Desktop, Cursor, Windsurf, and any other MCP-capable tool — query the logs you've indexed in LogSonic.

## Tools exposed

LogSonic is agent-first: everything the UI does is a tool (a backend test fails when a REST route has no matching tool), so an agent can ingest, analyze and display logs end to end. The server also sends a short playbook in its MCP `instructions`.

**Ingest**

| Tool | Purpose |
|---|---|
| `ingest_file` | Import a file from the server's disk (auto-detected format, rotated siblings, .gz/.zst/.bz2); waits for the job. |
| `ingest_status` | Wait for / read one import job. |
| `list_ingest_jobs` / `cancel_ingest_job` | Running and recent import jobs. |
| `ingest_lines` | Ingest log lines the agent already has. |
| `preview_file` | First lines of a file, to check the format before importing. |
| `list_samples` / `import_sample` | Bundled sample logs. |
| `tail_file` / `stop_tail` | Follow a growing file live. |
| `create_watch` / `list_watches` / `pause_watch` / `resume_watch` / `delete_watch` | Follow every matching file in a folder. |

**Analyze**

| Tool | Purpose |
|---|---|
| `ping` | Health-check the server. Call first. |
| `log_info` | Sources, dates with data, storage totals. |
| `query_logs` | Search with Bleve syntax, time range, source filter, sort, pagination. |
| `log_distribution` | Time-bucketed counts, no rows. |
| `log_facets` | Top values per field for a query (what dominates a spike). |
| `list_grok_patterns` / `test_grok_pattern` | Parser library; dry-run or autosuggest a pattern. |
| `preview_timestamps` | How timestamps of sample lines resolve (timezone, year-less dates) before import. |
| `save_grok_pattern` / `delete_grok_pattern` | Manage the parser library. |

**Display — drive the web UI** (each returns the UI state after the change)

| Tool | Purpose |
|---|---|
| `ui_get_state` | What the user sees: query, filters, sources, time, columns, sort, page, result count, first rows. |
| `ui_show_view` | Set query, time, sources, filters, columns and sort in one call, run one search. |
| `ui_add_filter` / `ui_remove_filter` / `ui_clear_filters` | Field filters, as in the Fields panel. |
| `ui_set_columns` | Set, show or hide table columns. |
| `ui_set_column_widths` | Column widths in pixels. |
| `ui_set_query` / `ui_set_time` / `ui_set_sources` | Search bar, time range, source selection. |
| `ui_set_sort` / `ui_set_page` | Table order, page and page size. |
| `ui_fields_panel` / `ui_sidebar` | Open or close the Fields panel, or any sidebar panel (filter, fields, sources, styling). |
| `ui_navigate` | Switch page (logs, import, settings). |
| `ui_open_workspace` | Load a saved workspace into the UI. |
| `ui_run_search` | Run the current search (after `run=false` changes). |
| `ui_focus` | Raise the macOS app window. |
| `logsonic_url` / `workspace_url` | Deep links for when no UI is open. |

The `ui_*` tools need an open LogSonic UI (the macOS app or a browser tab). With none open they return `no_ui_connected` right away.

**Manage**

| Tool | Purpose |
|---|---|
| `list_sources` / `get_source` / `rename_source` | Ingested sources and their origin. |
| `reimport_source` | Re-read a source's origin file (e.g. after fixing its pattern). |
| `rebuild_sources` | Recompute source counts and time bounds from the indices. |
| `delete_source` | Delete one source's rows (`confirm=true`). |
| `list_workspaces` / `open_workspace` / `create_workspace` / `update_workspace` / `duplicate_workspace` / `delete_workspace` | Saved investigations. |
| `storage_info` / `set_retention` / `delete_storage_day` | Storage and retention. |
| `delete_logs` | Delete specific rows by `_id` (`confirm=true`). |
| `clear_all_logs` | Delete everything (`confirm=true`). |

Destructive tools carry the MCP `destructiveHint` annotation; read-only ones carry `readOnlyHint`.

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
