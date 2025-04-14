import { FastMCP } from "fastmcp";
import { z } from "zod";
import fetch from "node-fetch";
import { LogResponse, SystemInfoResponse } from "../frontend/src/lib/api-types";
const API_BASE_URL = `http://${process.env.LOGSONIC_HOST || "localhost"}:${process.env.LOGSONIC_PORT || 8080}/api/v1`;
import { UserError } from "fastmcp";

const server = new FastMCP({
  name: "Logsonic MCP",
  version: "1.0.0",
});

// Tool to query current logs with filtering and pagination
server.addTool({
  name: "query_logs",
  description: `Query existing logs available in logsonic with limit, offset, filtering, pagination, and time range support. 
  limit is the max number of logs to be returned and offset is the number of logs to skip from the beginning. Use these parameters to paginate through the logs.
  Before querying, always use get_system_info endpoint to check if the logsonic is running.
  Use get_system_info endpoint to get the list of available sources and date indexes. 
  start_date and end_date should always be in RFC3339 format. 
  For Querying, use the following Bleve Search Query Syntax:

1. Basic terms: 'error' matches the term 'error' anywhere in the default _raw field
2. Phrases: Use double quotes for exact multi-word matches e.g. "connection timeout"
3. Field scoping: level:error searches for 'error' specifically in the 'level' field
4. Boolean operators:
   - Default behavior is OR: error warning returns logs containing 'error' OR 'warning'
   - + for required terms (AND): +level:error +service:api requires both conditions
   - | for optional terms (OR): +level:error|api requires level to match 'error' or 'api'
   - - for negation (NOT): +level:error -service:db requires 'error' level but excludes 'db' service
   - Parentheses for grouping: +(level:error message:*timeout*) -service:test
5. Wildcards: Use * for multi-character and ? for single-character wildcards
6. Regular Expressions: Use /regex/ for complex patterns
7. Numeric Ranges: Use >, >=, <, <= for numeric comparisons
8. Escaping: Escape special characters with backslash \\
9. IP addresses and URLs should be treated as phrases or escaped
10. Optimize queries for brevity when possible

Example bleve search queries:
- Find errors or warnings but not from test service: +(level:error|warning) -service:test
- Find timeout errors in API service: +level:error +service:api +message:*timeout*
- Find logs with response time > 500ms: response_time:>500

The response will be a JSON object with the following fields:
{
  available_columns?: string[];
  count?: number;
  end_date?: string;
  limit?: number;
  log_distribution?: LogDistributionEntry[];
  logs?: Record<string, any>[];
  offset?: number;
  query?: string;
  sort_by?: string;
  sort_order?: string;
  start_date?: string;
  status?: string;
  time_taken?: number;
  index_query_time?: number;
  total_count?: number;
}
`,
  parameters: z.object({
    limit: z.number().optional().describe("Maximum number of logs to return (default: 1000)"),
    offset: z.number().optional().describe("Number of logs to skip (default: 0)"),
    sort_by: z.string().optional().describe("Field to sort by (default: timestamp)"),
    sort_order: z.enum(["asc", "desc"]).optional().describe("Sort order (asc or desc, default: desc)"),
    start_date: z.string().optional().describe("Start date for log retrieval (RFC3339 format)"),
    end_date: z.string().optional().describe("End date for log retrieval (RFC3339 format)"),
    query: z.string().optional().describe("Optional search query to filter logs. Logsonic supports bleve search query syntax."),
    source: z.string().optional().describe("Optional comma-separated source filter"),
  }),
  execute: async (args): Promise<string> => {
    try {
      // Build query parameters
      const queryParams = new URLSearchParams();
      
      if (args.limit) queryParams.append("limit", args.limit.toString());
      if (args.offset) queryParams.append("offset", args.offset.toString());
      if (args.sort_by) queryParams.append("sort_by", args.sort_by);
      if (args.sort_order) queryParams.append("sort_order", args.sort_order);
      if (args.start_date) queryParams.append("start_date", args.start_date);
      if (args.end_date) queryParams.append("end_date", args.end_date);
      if (args.query) queryParams.append("query", args.query);
      if (args.source) queryParams.append("_src", args.source);

      // Make HTTP request to the logs endpoint
      const response = await fetch(`${API_BASE_URL}/logs?${queryParams.toString()}`, {
        method: "GET",
        headers: {
          "Accept": "application/json",
        },
      });

      if (!response.ok) {
        const errorData = await response.json() as { error?: string };
        throw new UserError(`API request failed: ${errorData.error || response.statusText}`);
      }

      const data = await response.json() as LogResponse;
      return JSON.stringify(data);
    } catch (error) {
      return JSON.stringify({
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
        logs: [],
        count: 0,
        total_count: 0,
        time_taken: 0
      } as LogResponse);
    }
  },
});

// Tool to get system and storage information
server.addTool({
  name: "log_info",
  description: "Get information about the current logs available in logsonic database. Use this tool to get the list of available sources and date indexes.",
  parameters: z.object({}),
  execute: async (args): Promise<string> => {
    try {
      // Build query parameters
      const queryParams = new URLSearchParams();
      queryParams.append("refresh", "true");

      // Make HTTP request to the info endpoint
      const response = await fetch(`${API_BASE_URL}/info?${queryParams.toString()}`, {
        method: "GET",
        headers: {
          "Accept": "application/json",
        },
      });

      if (!response.ok) {
        const errorData = await response.json() as { error?: string };
        throw new UserError(`API request failed: ${errorData.error || response.statusText}`);
      } 

      const data = await response.json() as SystemInfoResponse;
      // remove system_info from the response and return the rest
      const { system_info, ...rest } = data;
      return JSON.stringify(rest);
    } catch (error) {
      return JSON.stringify({
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
        storage_info: {
          available_dates: [],
          source_names: [],
          storage_directory: "",
          storage_size_bytes: 0,
          total_indices: 0,
          total_log_entries: 0
        }
      } as SystemInfoResponse);
    }
  },
});

server.addTool({
  name: "logsonic_url",
  description: "Get a URL to open Logsonic web interface with timestamp and log filters",
  parameters: z.object({
    query: z.string().optional().describe("Optional search query to filter logs. Logsonic supports bleve search query syntax."),
    start_date: z.string().optional().describe("Start date for log retrieval (Unix milliseconds)"),
    end_date: z.string().optional().describe("End date for log retrieval (Unix milliseconds)"),
  }),
  execute: async (args): Promise<string> => {
    const queryParams = new URLSearchParams();
    if (args.query) queryParams.append("q", args.query);
    if (args.start_date) queryParams.append("since", args.start_date);
    if (args.end_date) queryParams.append("to", args.end_date);
    return `http://${process.env.LOGSONIC_HOST || "localhost"}:${process.env.LOGSONIC_PORT || 8080}/?#${queryParams.toString()}`;
  },
});

server.start({
  transportType: "stdio",
});