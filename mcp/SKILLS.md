# Working with LogSonic via MCP

This is the agent-facing playbook for the LogSonic MCP server. If you (the agent) have access to the `ping`, `query_logs`, `log_info`, `list_grok_patterns`, `test_grok_pattern`, and `logsonic_url` tools, read this first — it will save the user a lot of back-and-forth.

## What LogSonic is

LogSonic is a local log analytics engine. The user has ingested some log files (one or more "sources") and indexed them in time-sharded Bleve indices. You query those indices over HTTP — you do **not** see raw files. Every log line has a `_timestamp` field (RFC3339), a `_src` field (the source name), a `_raw` field (the original line), and any fields the Grok parser extracted (e.g. `level`, `service`, `response_time`, `status`, `host`).

You cannot:
- Modify, delete, or ingest logs (read-only tools by design).
- Tail logs in real time — every query is a snapshot.
- Query data outside the range LogSonic has indexed.

## The standard workflow

For any new question, follow this sequence:

1. **`ping`** — confirm the server is up. If this fails, stop and tell the user the LogSonic server isn't running (default `http://localhost:8080`).
2. **`log_info`** — read `source_names` and `available_dates`. Without this, you don't know what sources exist or what time range has data. Skipping this is the most common mistake.
3. **`query_logs`** — run the actual search. Constrain by `source` and time range when you can; it makes queries faster and answers more accurate.

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
