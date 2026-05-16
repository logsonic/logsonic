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
    custom_patterns: z.record(z.string()).optional().describe("Named sub-patterns referenced by grok_pattern (e.g. { MYAPP_LEVEL: '(?:DEBUG|INFO|WARN|ERROR)' })"),
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
