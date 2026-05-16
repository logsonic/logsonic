import { FastMCP, UserError } from "fastmcp";
import { z } from "zod";
import fetch, { RequestInit, Response as FetchResponse } from "node-fetch";
import { LogResponse, SystemInfoResponse } from "../frontend/src/lib/api-types";

// Resolve the LogSonic base URL. LOGSONIC_URL wins (lets users point at HTTPS
// or a non-standard path); otherwise we compose from host + port.
const BASE_URL =
  process.env.LOGSONIC_URL?.replace(/\/+$/, "") ||
  `http://${process.env.LOGSONIC_HOST || "localhost"}:${process.env.LOGSONIC_PORT || 8080}`;
const API_BASE_URL = `${BASE_URL}/api/v1`;

const REQUEST_TIMEOUT_MS = Number(process.env.LOGSONIC_TIMEOUT_MS || 30_000);
const MAX_RETRIES = Number(process.env.LOGSONIC_MAX_RETRIES || 3);
const RETRY_BASE_MS = 250;

// MCP uses stdout for the JSON-RPC protocol. All diagnostics must go to stderr
// or they corrupt the wire format and the client disconnects silently.
const log = (...args: unknown[]) => console.error("[logsonic-mcp]", ...args);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ApiErrorBody { error?: string; status?: string; code?: string; details?: string; }

/**
 * fetchWithRetry — wraps node-fetch with:
 *   - per-attempt AbortController timeout
 *   - exponential backoff on network errors and 5xx
 *   - immediate fail on 4xx (caller bug; retrying won't help)
 * 4xx bodies are surfaced as UserError so they reach the model as readable
 * text. Network/5xx exhaustion becomes a structured JSON error envelope.
 */
async function fetchWithRetry(url: string, init: RequestInit = {}): Promise<FetchResponse> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      clearTimeout(timer);
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
        log(`5xx on ${url} (attempt ${attempt}/${MAX_RETRIES}); retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
        log(`network error on ${url} (attempt ${attempt}/${MAX_RETRIES}): ${(err as Error).message}; retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
    }
  }
  throw lastErr ?? new Error("request failed");
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${API_BASE_URL}${path}`;
  let res: FetchResponse;
  try {
    res = await fetchWithRetry(url, {
      ...init,
      headers: { Accept: "application/json", ...(init.headers || {}) },
    });
  } catch (err) {
    throw new UserError(
      `Could not reach LogSonic at ${BASE_URL}. Is the server running? (${(err as Error).message})`,
    );
  }

  if (!res.ok) {
    let body: ApiErrorBody = {};
    try { body = (await res.json()) as ApiErrorBody; } catch { /* non-JSON */ }
    const detail = body.details ? ` — ${body.details}` : "";
    throw new UserError(
      `LogSonic API ${res.status}: ${body.error || res.statusText}${detail}`,
    );
  }
  return (await res.json()) as T;
}

// Optional ISO-8601 / RFC3339 date guard — saves a round-trip when the model
// hands us a malformed date.
const rfc3339Date = (label: string) =>
  z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
    message: `${label} must be an RFC3339 timestamp (e.g. 2025-01-15T10:00:00Z)`,
  });

const server = new FastMCP({
  name: "Logsonic MCP",
  version: "1.1.0",
});

// ---------------------------------------------------------------------------
// ping — fast health check. Agents should call this once before any other
// tool, so failures are reported clearly instead of as opaque query errors.
// ---------------------------------------------------------------------------
server.addTool({
  name: "ping",
  description:
    "Check whether the LogSonic server is reachable. Returns server version info on success. " +
    "Always call this first in a fresh session before query_logs or log_info.",
  parameters: z.object({}),
  execute: async (): Promise<string> => {
    const data = await apiRequest<unknown>("/ping");
    return JSON.stringify({ status: "ok", base_url: BASE_URL, server: data });
  },
});

// ---------------------------------------------------------------------------
// query_logs — primary search tool.
// ---------------------------------------------------------------------------
server.addTool({
  name: "query_logs",
  description: `Query logs stored in LogSonic with full-text search, field filters, time range, sort, and pagination.

WORKFLOW: call ping → log_info → query_logs. log_info reveals available sources and the date range with data; querying outside that range returns nothing.

DATE PARAMETERS: start_date and end_date are RFC3339 (e.g. 2025-01-15T10:00:00Z). Omit both to scan everything LogSonic has.

PAGINATION: limit caps the page size (default 1000). offset skips rows. For large result sets, paginate by incrementing offset by limit until count < limit. The response includes total_count so you can decide whether to keep paging.

BLEVE QUERY SYNTAX (the 'query' parameter):
  1.  Bare term:                       error                  matches _raw field
  2.  Phrase:                          "connection timeout"   exact multi-word
  3.  Field scope:                     level:error            field-qualified
  4.  Required (AND):                  +level:error +service:api
  5.  Optional / OR:                   level:error|warning
  6.  Negation (NOT):                  -service:test
  7.  Grouping:                        +(level:error message:*timeout*) -service:test
  8.  Wildcards:                       host:web-*   user:?dmin
  9.  Regex:                           /timeout|deadline/
 10.  Numeric ranges:                  response_time:>500   status:>=400
 11.  Escape special chars with \\\\, treat URLs/IPs as phrases.

Default operator between bare terms is OR. Prefix with '+' to require, '-' to exclude.

SOURCE FILTER: the 'source' parameter is a comma-separated list of source names from log_info.source_names. Use this instead of stuffing _src into 'query' — it's faster and clearer.

EXAMPLES:
  • Recent errors:                     query="+level:error",  sort_order="desc"
  • API timeouts last hour:            query="+service:api +message:*timeout*"  start_date=…  end_date=…
  • All warnings except from test svc: query="+level:warning -service:test"
  • Slow responses:                    query="response_time:>1000"

RESPONSE: JSON with logs[], count, total_count, available_columns (field names you can use in 'query'), log_distribution (time-bucketed counts), time_taken (ms).`,
  parameters: z.object({
    limit: z.number().int().positive().max(10_000).optional().describe("Max logs returned (default 1000, max 10000)"),
    offset: z.number().int().nonnegative().optional().describe("Rows to skip (for pagination)"),
    sort_by: z.string().optional().describe("Field to sort by (default: _timestamp)"),
    sort_order: z.enum(["asc", "desc"]).optional().describe("Sort direction (default: desc — newest first)"),
    start_date: rfc3339Date("start_date").optional().describe("Inclusive start of time window, RFC3339"),
    end_date: rfc3339Date("end_date").optional().describe("Inclusive end of time window, RFC3339"),
    query: z.string().optional().describe("Bleve query string (see description for syntax)"),
    source: z.string().optional().describe("Comma-separated source filter, e.g. 'nginx,api-server'"),
  }),
  execute: async (args): Promise<string> => {
    const qp = new URLSearchParams();
    if (args.limit !== undefined) qp.append("limit", String(args.limit));
    if (args.offset !== undefined) qp.append("offset", String(args.offset));
    if (args.sort_by) qp.append("sort_by", args.sort_by);
    if (args.sort_order) qp.append("sort_order", args.sort_order);
    if (args.start_date) qp.append("start_date", args.start_date);
    if (args.end_date) qp.append("end_date", args.end_date);
    if (args.query) qp.append("query", args.query);
    if (args.source) qp.append("_src", args.source);

    const data = await apiRequest<LogResponse>(`/logs?${qp.toString()}`);
    return JSON.stringify(data);
  },
});

// ---------------------------------------------------------------------------
// log_info — system + storage introspection.
// ---------------------------------------------------------------------------
server.addTool({
  name: "log_info",
  description:
    "Get the list of available sources, dates with data, total entries, and storage size. " +
    "Always call this before query_logs to discover which sources exist and which time range has data. " +
    "Returns: storage_info { source_names[], available_dates[], total_log_entries, storage_size_bytes, total_indices, storage_directory }.",
  parameters: z.object({
    refresh: z.boolean().optional().describe("Force recompute (default true). Set false to use the server's cached snapshot."),
  }),
  execute: async (args): Promise<string> => {
    const qp = new URLSearchParams();
    qp.append("refresh", args.refresh === false ? "false" : "true");
    const data = await apiRequest<SystemInfoResponse>(`/info?${qp.toString()}`);
    // Strip system_info (host/OS/Go runtime details) — not useful to agents and noisy.
    const { system_info: _unused, ...rest } = data as SystemInfoResponse;
    return JSON.stringify(rest);
  },
});

// ---------------------------------------------------------------------------
// list_grok_patterns — show the parser library so the agent can describe how
// a given source is structured (field names, sample regex).
// ---------------------------------------------------------------------------
server.addTool({
  name: "list_grok_patterns",
  description:
    "List the Grok patterns LogSonic uses to parse incoming logs. Useful when the user asks 'what fields can I search on for source X' or 'what does LogSonic know how to parse'. " +
    "Returns: patterns[] with name, pattern (regex-like grok expression), description, priority, custom_patterns.",
  parameters: z.object({}),
  execute: async (): Promise<string> => {
    const data = await apiRequest<unknown>("/grok");
    return JSON.stringify(data);
  },
});

// ---------------------------------------------------------------------------
// test_grok_pattern — dry-run a pattern against sample log lines. Lets the
// agent validate a custom pattern before suggesting the user save it.
// ---------------------------------------------------------------------------
server.addTool({
  name: "test_grok_pattern",
  description:
    "Parse sample log lines with a Grok pattern WITHOUT ingesting them. " +
    "Use this to sanity-check a pattern, to show the user how their lines would be parsed, or to auto-suggest a pattern when none is provided. " +
    "If grok_pattern is omitted, LogSonic runs autosuggest and returns the best-matching known patterns with confidence scores.",
  parameters: z.object({
    logs: z.array(z.string()).min(1).max(50).describe("Sample log lines to parse (1-50)"),
    grok_pattern: z.string().optional().describe("Grok pattern string. Omit to trigger autosuggest."),
    custom_patterns: z.record(z.string(), z.string()).optional().describe("Named sub-patterns referenced by grok_pattern (e.g. { MYAPP_LEVEL: '(?:DEBUG|INFO|WARN|ERROR)' })"),
  }),
  execute: async (args): Promise<string> => {
    const body = JSON.stringify({
      logs: args.logs,
      grok_pattern: args.grok_pattern,
      custom_patterns: args.custom_patterns,
    });
    const data = await apiRequest<unknown>("/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return JSON.stringify(data);
  },
});

// ---------------------------------------------------------------------------
// logsonic_url — produce a deep-link the user can open in their browser.
// ---------------------------------------------------------------------------
server.addTool({
  name: "logsonic_url",
  description:
    "Build a deep-link URL into the LogSonic web UI with a pre-filled query and time range. " +
    "Use this when the user wants to 'open this in the UI' or to share a search. " +
    "Dates here are Unix milliseconds (NOT RFC3339) because that's what the UI's URL hash expects.",
  parameters: z.object({
    query: z.string().optional().describe("Bleve query to pre-fill"),
    start_date: z.string().optional().describe("Start time as Unix milliseconds"),
    end_date: z.string().optional().describe("End time as Unix milliseconds"),
  }),
  execute: async (args): Promise<string> => {
    const qp = new URLSearchParams();
    if (args.query) qp.append("q", args.query);
    if (args.start_date) qp.append("since", args.start_date);
    if (args.end_date) qp.append("to", args.end_date);
    return `${BASE_URL}/?#${qp.toString()}`;
  },
});

// ---------------------------------------------------------------------------
// Shared helper for tools that page through /logs. Caps total rows scanned to
// keep facet/context scans bounded — agents that need more should narrow the
// query or time window rather than blast the index.
// ---------------------------------------------------------------------------
async function fetchLogs(params: Record<string, string | number | undefined>): Promise<LogResponse> {
  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qp.append(k, String(v));
  }
  return apiRequest<LogResponse>(`/logs?${qp.toString()}`);
}

// ---------------------------------------------------------------------------
// log_field_facets — top-N values for one or more fields, optionally scoped by
// query/time. Replaces the manual "paginate query_logs then count" loop the
// agent would otherwise do, and returns just the counts (not raw rows), which
// is much cheaper on tokens.
// ---------------------------------------------------------------------------
server.addTool({
  name: "log_field_facets",
  description:
    "Aggregate top-N values of one or more fields over matching logs. Use this BEFORE building a detailed query — it answers 'what severities exist?', 'which sources are active?', 'which users hit the API?' without dumping raw rows. " +
    "Synthesized client-side by paginating /logs; the total rows scanned is capped (default 5000) to keep latency bounded. If the scan exceeds the cap, the response sets truncated=true and you should narrow the query or time window before trusting the counts.",
  parameters: z.object({
    fields: z.array(z.string()).min(1).max(10).describe("Field names to facet on, e.g. ['severity','user','database']"),
    query: z.string().optional().describe("Bleve query to scope the scan (same syntax as query_logs)"),
    source: z.string().optional().describe("Comma-separated source filter"),
    start_date: rfc3339Date("start_date").optional().describe("Inclusive start of time window, RFC3339"),
    end_date: rfc3339Date("end_date").optional().describe("Inclusive end of time window, RFC3339"),
    top_n: z.number().int().positive().max(100).optional().describe("Max values per field returned (default 20)"),
    max_scan: z.number().int().positive().max(50_000).optional().describe("Cap on rows paginated through (default 5000)"),
  }),
  execute: async (args): Promise<string> => {
    const topN = args.top_n ?? 20;
    const maxScan = args.max_scan ?? 5000;
    const pageSize = 1000;

    const counts: Record<string, Map<string, number>> = {};
    for (const f of args.fields) counts[f] = new Map();

    let offset = 0;
    let scanned = 0;
    let total = 0;
    let truncated = false;
    while (scanned < maxScan) {
      const data = await fetchLogs({
        limit: Math.min(pageSize, maxScan - scanned),
        offset,
        query: args.query,
        _src: args.source,
        start_date: args.start_date,
        end_date: args.end_date,
        sort_by: "timestamp",
        sort_order: "desc",
      });
      total = data.total_count ?? 0;
      const rows = data.logs ?? [];
      for (const row of rows) {
        for (const f of args.fields) {
          const v = (row as Record<string, unknown>)[f];
          if (v === undefined || v === null || v === "") continue;
          const key = String(v);
          counts[f].set(key, (counts[f].get(key) ?? 0) + 1);
        }
      }
      scanned += rows.length;
      offset += rows.length;
      if (rows.length === 0 || rows.length < pageSize) break;
    }
    if (total > scanned) truncated = true;

    const facets: Record<string, Array<{ value: string; count: number }>> = {};
    for (const f of args.fields) {
      facets[f] = Array.from(counts[f].entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([value, count]) => ({ value, count }));
    }
    return JSON.stringify({
      status: "success",
      scanned,
      total_matching: total,
      truncated,
      facets,
    });
  },
});

// ---------------------------------------------------------------------------
// log_distribution — time-bucketed counts only, without the row payload. Same
// signal /logs already produces in its response, but stripped so the agent
// pays for one small response instead of carrying full log rows it doesn't need.
// ---------------------------------------------------------------------------
server.addTool({
  name: "log_distribution",
  description:
    "Return only the time-bucketed log distribution for a query (counts per time bucket, per source). Cheaper than query_logs when you just want to see 'when did errors spike' without inspecting individual rows.",
  parameters: z.object({
    query: z.string().optional().describe("Bleve query to scope the distribution"),
    source: z.string().optional().describe("Comma-separated source filter"),
    start_date: rfc3339Date("start_date").optional().describe("Inclusive start of time window, RFC3339"),
    end_date: rfc3339Date("end_date").optional().describe("Inclusive end of time window, RFC3339"),
  }),
  execute: async (args): Promise<string> => {
    // limit=1 to suppress the row payload; log_distribution is computed
    // independently of pagination on the backend.
    const data = await fetchLogs({
      limit: 1,
      query: args.query,
      _src: args.source,
      start_date: args.start_date,
      end_date: args.end_date,
    });
    return JSON.stringify({
      status: "success",
      total_count: data.total_count ?? 0,
      log_distribution: data.log_distribution ?? [],
    });
  },
});

// Doc IDs are emitted by the backend as `<unixNano>-<source>-<seq>`. The
// unixNano prefix lets us narrow a lookup to the exact second the row was
// written without scanning the whole index. Source names can contain hyphens
// so we only split on the FIRST hyphen.
const parseIdTimestamp = (id: string): Date | null => {
  const m = /^(\d+)-/.exec(id);
  if (!m) return null;
  const ns = BigInt(m[1]);
  const ms = Number(ns / 1_000_000n);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Locate a row by exact _id match within a narrow time window derived from
// the doc-id's unixNano prefix. Returns the matching row or null.
async function lookupById(id: string): Promise<Record<string, unknown> | null> {
  const ts = parseIdTimestamp(id);
  if (!ts) return null;
  // Doc IDs are written with nanosecond precision; the API only takes
  // RFC3339 seconds, so widen by ±1 s to be safe across rounding.
  const start = new Date(ts.getTime() - 1000).toISOString();
  const end = new Date(ts.getTime() + 1000).toISOString();
  // Page until we either find a match or exhaust the slice for this second.
  const pageSize = 1000;
  let offset = 0;
  for (let i = 0; i < 5; i++) {
    const data = await fetchLogs({
      limit: pageSize,
      offset,
      start_date: start,
      end_date: end,
      sort_by: "timestamp",
      sort_order: "asc",
    });
    const rows = data.logs ?? [];
    const hit = rows.find((r) => (r as Record<string, unknown>)._id === id);
    if (hit) return hit as Record<string, unknown>;
    if (rows.length < pageSize) return null;
    offset += rows.length;
  }
  return null;
}

// ---------------------------------------------------------------------------
// get_log_by_id — fetch a single log row by its _id. Always returns the full
// parsed row including _raw. Backend doesn't expose a doc-id lookup endpoint;
// we derive the timestamp from the id's unixNano prefix and scan a 2-second
// window for the matching _id.
// ---------------------------------------------------------------------------
server.addTool({
  name: "get_log_by_id",
  description:
    "Fetch one log entry by its _id (the unique identifier returned in query_logs results). Returns the full parsed row including _raw. Returns status='not_found' when no row matches.",
  parameters: z.object({
    id: z.string().min(1).describe("The _id of the log row to retrieve"),
  }),
  execute: async (args): Promise<string> => {
    const row = await lookupById(args.id);
    if (!row) return JSON.stringify({ status: "not_found", id: args.id });
    return JSON.stringify({ status: "success", log: row });
  },
});

// ---------------------------------------------------------------------------
// log_context — fetch N rows before and after a reference point (either a log
// _id or an RFC3339 timestamp). Standard "show me surrounding lines" move when
// debugging an incident.
// ---------------------------------------------------------------------------
server.addTool({
  name: "log_context",
  description:
    "Return the N log entries immediately before and after a reference point. Provide either id (an _id from a prior query) or timestamp (RFC3339). Useful for incident debugging — 'what happened around the FATAL at T?'. " +
    "Optional source/query parameters narrow the scan to one stream (e.g. limit to a specific service). Returns { before:[…], pivot:{…}|null, after:[…] } sorted oldest→newest.",
  parameters: z.object({
    id: z.string().optional().describe("_id of the pivot log row (preferred — looks up its timestamp)"),
    timestamp: rfc3339Date("timestamp").optional().describe("RFC3339 pivot timestamp (use when no _id available)"),
    before: z.number().int().nonnegative().max(500).optional().describe("Rows before the pivot (default 5)"),
    after: z.number().int().nonnegative().max(500).optional().describe("Rows after the pivot (default 5)"),
    window_seconds: z.number().int().positive().max(86_400).optional().describe("Seconds on each side of the pivot to scan (default 300 = 5 min)"),
    source: z.string().optional().describe("Comma-separated source filter"),
    query: z.string().optional().describe("Optional Bleve query to further scope context (e.g. same service)"),
  }),
  execute: async (args): Promise<string> => {
    if (!args.id && !args.timestamp) {
      throw new UserError("log_context: provide either id or timestamp");
    }
    const before = args.before ?? 5;
    const after = args.after ?? 5;
    const windowSec = args.window_seconds ?? 300;

    let pivot: Record<string, unknown> | null = null;
    let pivotTs: string | undefined = args.timestamp;
    if (args.id) {
      pivot = await lookupById(args.id);
      if (!pivot) {
        return JSON.stringify({ status: "not_found", id: args.id });
      }
      // Backend stores parsed timestamp under `_timestamp`; fall back to
      // `timestamp` for sources that don't carry one separately.
      pivotTs = (pivot._timestamp as string | undefined) ?? (pivot.timestamp as string | undefined);
    }
    if (!pivotTs) {
      throw new UserError("log_context: could not determine pivot timestamp");
    }

    const pivotDate = new Date(pivotTs);
    if (Number.isNaN(pivotDate.getTime())) {
      throw new UserError(`log_context: invalid pivot timestamp '${pivotTs}'`);
    }
    const startDate = new Date(pivotDate.getTime() - windowSec * 1000).toISOString();
    const endDate = new Date(pivotDate.getTime() + windowSec * 1000).toISOString();

    // Fetch before/after independently so we can sort each appropriately and
    // bound the row count explicitly. Each call scopes to its half-window.
    const [beforeResp, afterResp] = await Promise.all([
      before > 0
        ? fetchLogs({
            limit: before,
            query: args.query,
            _src: args.source,
            start_date: startDate,
            end_date: pivotDate.toISOString(),
            sort_by: "timestamp",
            sort_order: "desc",
          })
        : Promise.resolve({ logs: [] } as LogResponse),
      after > 0
        ? fetchLogs({
            limit: after,
            query: args.query,
            _src: args.source,
            start_date: pivotDate.toISOString(),
            end_date: endDate,
            sort_by: "timestamp",
            sort_order: "asc",
          })
        : Promise.resolve({ logs: [] } as LogResponse),
    ]);

    const filterPivot = (rows: Record<string, unknown>[] | undefined): Record<string, unknown>[] => {
      if (!rows) return [];
      if (!args.id) return rows;
      return rows.filter((r) => r._id !== args.id);
    };
    // before came back desc (closest to pivot first); flip to oldest→newest.
    const beforeRows = filterPivot(beforeResp.logs).slice(0, before).reverse();
    const afterRows = filterPivot(afterResp.logs).slice(0, after);

    return JSON.stringify({
      status: "success",
      pivot,
      pivot_timestamp: pivotTs,
      window_seconds: windowSec,
      before: beforeRows,
      after: afterRows,
    });
  },
});

// ---------------------------------------------------------------------------
// Startup. Probe the server once so an unreachable LogSonic surfaces as a
// log line on stderr instead of as silent tool failures later.
// ---------------------------------------------------------------------------
(async () => {
  try {
    await fetchWithRetry(`${API_BASE_URL}/ping`, { method: "GET" });
    log(`connected to LogSonic at ${BASE_URL}`);
  } catch (err) {
    log(`WARNING: LogSonic at ${BASE_URL} is not reachable yet (${(err as Error).message}). The MCP server will still start; tools will error until the server is up.`);
  }
  server.start({ transportType: "stdio" });
})();
