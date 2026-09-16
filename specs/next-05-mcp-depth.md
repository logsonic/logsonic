# next-05 — MCP depth (aggregations, patterns, resources)

**Horizon:** Next · **Size:** M · **Priority:** P1. Medium-depth spec.
**Depends on:** now-02 (facets), next-03 (patterns endpoint).
**Read `specs/README.md` first.**

## Goal

Make LogSonic the best log backend an agent has ever had. Agents can't page through 3M rows — give them aggregation, facet, and pattern tools plus saved queries as resources, so a Claude/Cursor session can answer "what's wrong?" in three tool calls.

## Current MCP surface (anchor)

`backend/pkg/mcp/server.go` — tools today: `ping`, `log_info`, `query_logs`, `list_grok_patterns`, `test_grok_pattern`, `logsonic_url`, `log_distribution`, `list_workspaces`, `open_workspace`, `create_workspace`, `workspace_url`. Streamable-HTTP at `/mcp` (`server.go:223`); tool handlers call the local REST API via the base-URL provider. Agent guidance lives in `mcp/SKILLS.md`.

## Design decisions (made)

- **Keep the pattern: MCP tools are thin proxies over REST endpoints.** New capability = REST first (or reuse now-02/next-03 endpoints), then a tool that formats it for token efficiency. No business logic in the MCP layer.
- New tools:
  1. `get_field_facets(query?, start?, end?, sources?)` → now-02's facets (`include_facets=true`, drop the rows: call with `limit=0`-style minimal fetch — if the REST path requires rows, add a `facets_only=true` param to `HandleReadAll` as part of this task). Output: compact table-like text, not raw JSON, to save agent tokens.
  2. `get_log_patterns(query?, start?, end?, sources?, sort=count|novelty, limit=20)` → next-03's endpoint; template + count + % + first/last seen.
  3. `count_by(field, query?, start?, end?, sources?)` → single-field facet with full value list (cap 50) — the "GROUP BY" agents keep wanting.
  4. `get_error_summary(start?, end?, sources?)` → composite convenience: level facet + top-10 error patterns + error histogram in one call (agents burn fewer round-trips; implement by calling the three underlying REST endpoints server-side).
- **Resources:** expose saved queries (now-03) as MCP resources (`logsonic://saved-query/<workspace>/<id>` — readable, returns the query + context) and `logsonic://skills` serving `mcp/SKILLS.md` content so agents can self-brief.
- **Prompt:** one MCP prompt `investigate` (args: `symptom`, optional `timeframe`) that expands to a structured investigation playbook referencing the tools (mirrors SKILLS.md content).
- `query_logs` gains an optional `default_operator: "and"|"or"` argument (default `or`, unchanged) mirroring next-09's REST parameter; `SKILLS.md` explains it but keeps recommending explicit `+` terms. The `facets_only=true` parameter on `/api/v1/logs` is shared with next-09 autocomplete — whichever lands first adds it with the same contract.
- Token discipline rule for ALL tool outputs: default compact text rendering, `format:"json"` arg for raw. Cap any list at explicit limits with a "truncated, refine your query" note — an agent must never receive an unbounded dump.

## Step-by-step (condensed)

1. REST gap-fill: `facets_only` param on `/api/v1/logs` (if needed per decision 1). 2. Four tools in `mcp/server.go` following the existing `AddTool` style. 3. Resources + prompt registration (check the mcp-go library version in `go.mod` supports resources/prompts; upgrade if needed — note breaking-change risk in PR). 4. Update `mcp/README.md` + `mcp/SKILLS.md` with the new tools and revised playbooks.

## Test cases

Unit: each tool with a stubbed REST base URL (httptest server serving fixtures) → output snapshot tests (golden files) for the compact text formats; limit/truncation behavior; error passthrough (REST 500 → tool error result not panic). Integration (script or manual): real server + `npx @modelcontextprotocol/inspector` — call every tool against imported `sample-logs/linux-syslog.log`; verify resource listing shows saved queries after creating one. Agent-level smoke (manual): Claude Code session with the MCP configured — "what errors are in my logs?" resolves using `get_error_summary` without paging raw rows (observe tool-call transcript).

## Acceptance criteria

- [ ] All four tools + resources + prompt visible and functional in MCP inspector.
- [ ] Golden-file output tests green; every output bounded.
- [ ] SKILLS.md updated — the playbooks reference the new tools as the primary path, raw `query_logs` as fallback.

## Out of scope

Write-path tools (agents don't ingest), multi-instance discovery, auth (loopback stance).
