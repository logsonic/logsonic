# Working with LogSonic via MCP

This is the agent-facing playbook for the LogSonic MCP server. If you (the agent) have access to the `ping`, `query_logs`, `ingest_file`, `ui_show_view` and related tools, read this first — it will save the user a lot of back-and-forth.

LogSonic is agent-first: every operation the UI offers is also a tool. You can ingest logs, analyze them, and drive the web UI the user is looking at (query, filters, columns, time range, sort, page) without the user clicking anything.

## What LogSonic is

LogSonic is a local log analytics engine. The user has ingested some log files (one or more "sources") and indexed them in time-sharded Bleve indices. You query those indices over HTTP — you do **not** see raw files. Every log line has a `_timestamp` field (RFC3339), a `_src` field (the source name), a `_raw` field (the original line), and any fields the Grok parser extracted (e.g. `level`, `service`, `response_time`, `status`, `host`).

You can:
- Ingest: `ingest_file` (a path on the machine running LogSonic), `ingest_lines` (lines you already hold), `import_sample`, `tail_file` (follow a growing file), `create_watch` (follow a whole folder).
- Analyze: `log_distribution`, `log_facets`, `query_logs`.
- Display: the `ui_*` tools change what the user sees in the LogSonic web UI and return the UI state afterwards.
- Manage: sources (`list_sources`, `rename_source`, `reimport_source`, `delete_source`), Grok patterns, workspaces, storage and retention.

You cannot:
- Read files the LogSonic server can't read — paths are on the server's machine, not yours.
- Drive the UI when no UI is open: `ui_*` tools then fail with `no_ui_connected`.
- Query data outside the range LogSonic has indexed.

You can create and reopen saved investigation workspaces. Workspaces store local query state, time range, sources, columns, coloring, visualization mode, and any saved queries under the user's LogSonic storage directory.

## The standard workflow

For any new question, follow this sequence:

1. **`ping`** — confirm the server is up. If this fails, stop and tell the user the LogSonic server isn't running (default `http://localhost:8080`).
2. **`log_info`** — read `source_names` and `available_dates`. Without this, you don't know what sources exist or what time range has data. Skipping this is the most common mistake.
3. **`query_logs`** — run the actual search. Constrain by `source` and time range when you can; it makes queries faster and answers more accurate.
4. **`ui_show_view`** — when the user should *see* the result, put it on screen: query, time range, sources, filters, columns and sort in one call.

If the data isn't in LogSonic yet, ingest it first (see "Ingest" below), then continue at step 3.

For recurring investigations, call `list_workspaces` after `log_info`. If an existing workspace matches the user's intent, use `open_workspace` or `workspace_url` instead of rebuilding the query from scratch.

If a query returns zero results, **do not** immediately assume "no errors exist." Check whether your time window overlaps `available_dates`, whether the field name you used is in `available_columns` from a prior query, and whether the source filter is spelled correctly.

## Bleve query syntax — the parts you'll actually use

The `query` parameter to `query_logs` is a Bleve query string. The rules:

| Want                                | Write                                         |
|-------------------------------------|-----------------------------------------------|
| Plain word, any field               | `timeout`                                     |
| Exact phrase                        | `"connection timeout"`                        |
| Specific field equals               | `level:error`                                 |
| AND                                 | `+level:error +service:api`                   |
| OR (between two field values)       | `level:error\|warning`                        |
| NOT                                 | `-service:test`                               |
| Group                               | `+(level:error message:*timeout*) -env:dev`   |
| Wildcard                            | `host:web-*`                                  |
| Regex                               | `/timeout\|deadline/`                         |
| Numeric range                       | `response_time:>500`, `status:>=400`          |

Key gotchas:

- **The default operator between bare terms is OR, not AND.** `error api` returns rows containing *either* word. To require both, prefix each with `+`: `+error +api`.
- **`-` only works inside a query that already has a `+` term.** `-foo` on its own is a no-op. Combine: `+level:error -service:test`.
- **Field names are case-sensitive and depend on the Grok pattern**. Run a small `query_logs` with `limit=1` first and inspect `available_columns` to see exactly which fields exist for your source.
- **Treat URLs, IPs, file paths as phrases**: wrap them in quotes (`"192.168.1.1"`, `"/api/v1/foo"`). Otherwise the `:` or `/` confuses the parser.

## Time ranges

`query_logs` accepts `start_date` and `end_date` in **RFC3339** (`2025-01-15T10:00:00Z`). The `logsonic_url` tool is the exception — its `start_date`/`end_date` are **Unix milliseconds** because that's what the UI's URL hash expects. Don't mix them up.

If the user says "last hour" / "yesterday" / "last 7 days", compute the absolute window yourself from the current time and pass RFC3339. Don't pass through fuzzy strings — LogSonic won't parse them.

## Facets (field summary of a window)

`log_facets` (the same data as `GET /api/v1/logs?include_facets=true`) returns a `facets` object: for every parsed field, the distinct-value count and up to 8 top values with counts, computed over the newest rows of the current window (`computed_over`; `sampled: true` when the window exceeded the 20,000-row scan cap). High-cardinality fields (IDs) report only their distinct count. The one exception is `_src`: its values come from the sources catalog and list every source with its total row count, regardless of the window or query. Use it to learn which fields and values exist before writing a `field:value` query instead of paging raw rows.

## Pagination

Every response includes `count` (rows in this page), `total_count` (rows matching the query overall), and `limit`/`offset` (what you asked for). To page:

```
offset = 0
loop:
  result = query_logs(query=..., limit=1000, offset=offset)
  process(result.logs)
  if result.count < result.limit: stop
  offset += result.limit
```

The default limit is 1000 and the max is 10000. For exploratory questions, ask for `limit=50` first to keep the response small — you don't need every match to answer "are there any errors from service X."

## Sources

Use the `source` parameter (comma-separated names from `log_info.source_names`) rather than putting `_src:foo` in the query. It's faster and clearer.

## Field discovery

When you don't know what fields a source has:

1. `query_logs` with `source="<the source>"`, `limit=1`.
2. Read `available_columns` from the response.
3. Or call `list_grok_patterns` to see the parser definition — fields named in the pattern (e.g. `%{WORD:level}`) become column names.

If the user asks "what can I search on for source X," prefer `list_grok_patterns` — it returns the field schema without burning a query.

## Common task recipes

### "Show me the most recent errors"

```
ping
log_info                            # confirm sources + date range
query_logs(
  query="+level:error",
  sort_order="desc",
  limit=50,
)
```

### "Find timeouts in the API service in the last 24 hours"

```
ping
log_info
query_logs(
  query="+service:api +(message:*timeout* /timeout|deadline/)",
  start_date=<now - 24h, RFC3339>,
  end_date=<now, RFC3339>,
  limit=100,
)
```

### "How many 5xx responses did nginx return today?"

```
log_info                            # confirm 'nginx' is in source_names
query_logs(
  source="nginx",
  query="+status:>=500",
  start_date=<today 00:00 UTC>,
  limit=1,                          # we only need total_count
)
# Read total_count from the response.
```

### "Give me a link the user can open to see these in the UI"

If the UI is already open, `ui_show_view` puts the result on screen directly. Otherwise build a link:

```
logsonic_url(
  query="+level:error +service:api",
  start_date=<unix-ms>,
  end_date=<unix-ms>,
)
```

### "Why isn't my pattern matching?"

```
test_grok_pattern(
  logs=[<a few sample lines>],
  grok_pattern="<the candidate pattern>",
)
# Inspect the response: 'processed' vs 'failed' tells you the hit rate;
# 'logs[*]' shows the extracted fields per input line.
```

### "What patterns does LogSonic know how to parse?"

```
list_grok_patterns
```

Returns the full library — name, regex-like grok expression, description, priority. Useful to set expectations before suggesting a custom pattern.

## Ingest

```
preview_file(path="/var/log/app.log")              # look at the format first
test_grok_pattern(logs=[...first lines...])        # omit grok_pattern to autosuggest
ingest_file(path="/var/log/app.log", source="app") # format auto-detected unless pattern/pattern_name given
# -> {"finished": true, "job": {"state": "done", "rows_stored": 12034, ...}}
# finished=false: call ingest_status(job_id=...) until it is.
```

- `include_rotated=true` also imports `app.log.1`, `app-2025-01-01.log`, ... oldest first.
- `.gz`, `.zst` and `.bz2` files are read directly.
- Lines you already have (from `kubectl logs`, an API, a paste): `ingest_lines(source="pod-x", lines=[...])`.
- A parse that needs a custom pattern: test it with `test_grok_pattern`, keep it with `save_grok_pattern`, then import with `pattern_name=`.
- Wrong pattern after the fact: fix it, then `reimport_source(name=...)` re-reads the origin file.
- Live files: `tail_file` (one file, stop with `stop_tail`) or `create_watch(dir=..., glob="*.log")`.

## Driving the UI

Every `ui_*` tool waits for the UI to apply the change and returns `{"status":"applied","warnings":[...],"state":{...}}`. `state` is what the user now sees:

| field | meaning |
|---|---|
| `route` | page (`/` is the log viewer) |
| `query`, `filters`, `free_text` | the search bar, split into field filters and the rest |
| `sources`, `time` | source selection and time range |
| `columns.selected` / `columns.available` | visible columns, and every column in the results |
| `sort`, `page`, `page_size` | table order and paging |
| `result_count`, `preview_rows` | matching rows, and the first 5 as displayed |
| `fields_panel_open`, `active_workspace_id` | sidebar and workspace |

Tools:

- `ui_show_view` — set several things at once and run one search. Use this for "show me X".
- `ui_add_filter(field, value, exclude?)` / `ui_remove_filter(field, value?)` / `ui_clear_filters(keep_text?)` — same as clicking values in the Fields panel. Numeric values (`status=404`) are written unquoted so numeric fields match.
- `ui_set_columns(columns, mode=set|show|hide)` — `timestamp` always stays first. Unknown names come back in `warnings`.
- `ui_set_query`, `ui_set_time`, `ui_set_sources`, `ui_set_sort`, `ui_set_page`, `ui_set_column_widths`, `ui_fields_panel`, `ui_navigate`, `ui_open_workspace`, `ui_run_search`, `ui_get_state`.
- Search-changing tools take `run=false` to batch changes; finish with `ui_run_search`.

If a `ui_*` tool returns `no_ui_connected`, call `ui_focus` (raises the macOS app) or ask the user to open the `ui_url` it returns, then retry. A `timeout` means the UI was open but did not answer in 10s — retry once.

### "Show me the 404s from nginx with the request path"

```
ui_show_view(
  sources=["nginx"],
  relative_time="last-24-hours",
  filters=[{"field": "status", "value": "404"}],
  columns=["status", "method", "path", "client_ip"],
)
# Check state.result_count and state.preview_rows, then tell the user what they're looking at.
```

### "Import this file and show me the errors"

```
ingest_file(path="/var/log/app.log", source="app")
log_facets(source="app")                       # which level values exist?
ui_show_view(sources=["app"], relative_time="all-time",
             filters=[{"field": "level", "value": "ERROR"}],
             columns=["level", "message"])
create_workspace(name="app errors", query="+level:\"ERROR\"", source="app", relative_time="all-time")
```

## Destructive tools

`delete_source`, `delete_storage_day` and `clear_all_logs` need `confirm=true` and cannot be undone. Use them only when the user asked for that deletion. `reimport_source` and `set_retention` also remove rows; say so before calling them.

## Error handling

Tools raise `UserError` for things you can correct (bad date, unreachable server, 4xx). If you see one, read the message and either fix the arguments or report it back to the user — don't blindly retry. Network/5xx errors are retried automatically (3 attempts with backoff) before they surface to you.

## Performance hints

- **Time-bound everything you can.** Indices are time-sharded; narrower windows skip whole shards.
- **Prefer `source=`** over `+_src:foo` in the query string — the server handles it via a faster path.
- **Start with `limit=50`** for exploration. Bump to 1000+ only when you actually need to enumerate.
- **`total_count` answers "how many"** without retrieving the rows. Don't paginate just to count.
- **`log_distribution` in the response is a free histogram** — use it to summarize trends ("most errors between 02:00 and 03:00") without extra queries.

## What not to do

- Don't invent field names. Verify with `available_columns` or `list_grok_patterns`.
- Don't pass relative dates (`-1h`, `yesterday`) — convert to RFC3339 first.
- Don't query without time bounds for "what's happening" questions — you'll scan everything and the answer is rarely useful.
- Don't surface raw `time_taken` / `index_query_time` to the user unless they asked about performance.
- Don't paginate to fetch a count — use `total_count` from a `limit=1` call.
