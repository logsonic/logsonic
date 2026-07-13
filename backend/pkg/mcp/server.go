// Package mcp implements the LogSonic MCP server as a Go binary subcommand.
// Run it with: logsonic mcp [--url http://localhost:8080]
// It speaks the MCP stdio transport — pipe it into Claude Desktop, Cursor, etc.
package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// All diagnostic output goes to stderr — stdout is the MCP JSON-RPC wire.
var logger = log.New(os.Stderr, "[logsonic-mcp] ", 0)

type baseURLProvider func() string

// client holds the resolved base URL and a shared HTTP client.
type client struct {
	baseURL baseURLProvider
	http    *http.Client
}

func newClient(baseURL string) *client {
	return newClientWithBaseURLProvider(staticBaseURL(baseURL))
}

func newClientWithBaseURLProvider(provider baseURLProvider) *client {
	return &client{
		baseURL: provider,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

func staticBaseURL(baseURL string) baseURLProvider {
	trimmed := strings.TrimRight(baseURL, "/")
	return func() string {
		return trimmed
	}
}

func (c *client) serverBaseURL() string {
	return strings.TrimRight(c.baseURL(), "/")
}

func (c *client) get(path string, params url.Values) (json.RawMessage, error) {
	baseURL := c.serverBaseURL()
	u := baseURL + "/api/v1" + path
	if len(params) > 0 {
		u += "?" + params.Encode()
	}
	resp, err := c.http.Get(u)
	if err != nil {
		return nil, fmt.Errorf("cannot reach LogSonic at %s: %w", baseURL, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("LogSonic API %d: %s", resp.StatusCode, string(body))
	}
	return json.RawMessage(body), nil
}

func (c *client) post(path string, payload any) (json.RawMessage, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	baseURL := c.serverBaseURL()
	resp, err := c.http.Post(baseURL+"/api/v1"+path, "application/json", bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("cannot reach LogSonic at %s: %w", baseURL, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("LogSonic API %d: %s", resp.StatusCode, string(body))
	}
	return json.RawMessage(body), nil
}

func resultText(v json.RawMessage) *mcp.CallToolResult {
	return mcp.NewToolResultText(string(v))
}

func resultErr(err error) *mcp.CallToolResult {
	return mcp.NewToolResultError(err.Error())
}

// build constructs and returns a configured MCPServer with all tools registered.
// baseURL is the LogSonic server root (e.g. "http://localhost:8080").
func build(baseURL string) *server.MCPServer {
	return buildWithBaseURLProvider(staticBaseURL(baseURL))
}

func buildWithBaseURLProvider(provider baseURLProvider) *server.MCPServer {
	c := newClientWithBaseURLProvider(provider)
	s := server.NewMCPServer("Logsonic MCP", "1.2.0")

	// ------------------------------------------------------------------ ping
	s.AddTool(mcp.NewTool("ping",
		mcp.WithDescription("Check whether the LogSonic server is reachable. "+
			"Returns server version info on success. Always call this first in a fresh session."),
	), func(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		data, err := c.get("/ping", nil)
		if err != nil {
			return resultErr(err), nil
		}
		out, _ := json.Marshal(map[string]any{"status": "ok", "base_url": c.serverBaseURL(), "server": json.RawMessage(data)})
		return mcp.NewToolResultText(string(out)), nil
	})

	// --------------------------------------------------------------- log_info
	s.AddTool(mcp.NewTool("log_info",
		mcp.WithDescription("Get the list of available sources, dates with data, total entries, and storage size. "+
			"Always call this before query_logs to discover which sources exist and which time range has data."),
		mcp.WithBoolean("refresh",
			mcp.Description("Force recompute (default true). Set false to use the server's cached snapshot."),
		),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		refresh := req.GetBool("refresh", true)
		p := url.Values{}
		if refresh {
			p.Set("refresh", "true")
		} else {
			p.Set("refresh", "false")
		}
		data, err := c.get("/info", p)
		if err != nil {
			return resultErr(err), nil
		}
		// Strip system_info — noisy and not useful to agents.
		var full map[string]json.RawMessage
		if json.Unmarshal(data, &full) == nil {
			delete(full, "system_info")
			if stripped, e := json.Marshal(full); e == nil {
				return mcp.NewToolResultText(string(stripped)), nil
			}
		}
		return resultText(data), nil
	})

	// ------------------------------------------------------------- query_logs
	s.AddTool(mcp.NewTool("query_logs",
		mcp.WithDescription(`Query logs stored in LogSonic with full-text search, field filters, time range, sort, and pagination.

WORKFLOW: call ping → log_info → query_logs. log_info reveals available sources and the date range with data.

DATE PARAMETERS: start_date and end_date are RFC3339 (e.g. 2025-01-15T10:00:00Z). Omit both to scan everything.

BLEVE QUERY SYNTAX: bare term matches _raw; field:value for field scope; +required -excluded; | for OR; * wildcard; /regex/.

SOURCE FILTER: comma-separated source names from log_info.source_names — faster than _src: in query.

RESPONSE: JSON with logs[], count, total_count, available_columns, log_distribution, time_taken.`),
		mcp.WithNumber("limit", mcp.Description("Max logs returned (default 1000, max 10000)")),
		mcp.WithNumber("offset", mcp.Description("Rows to skip for pagination")),
		mcp.WithString("sort_by", mcp.Description("Field to sort by (default: _timestamp)")),
		mcp.WithString("sort_order", mcp.Description("asc or desc (default: desc — newest first)")),
		mcp.WithString("start_date", mcp.Description("Inclusive start of time window, RFC3339")),
		mcp.WithString("end_date", mcp.Description("Inclusive end of time window, RFC3339")),
		mcp.WithString("query", mcp.Description("Bleve query string")),
		mcp.WithString("source", mcp.Description("Comma-separated source filter, e.g. 'nginx,api-server'")),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		p := url.Values{}
		if v := req.GetInt("limit", 0); v > 0 {
			p.Set("limit", fmt.Sprint(v))
		}
		if v := req.GetInt("offset", -1); v >= 0 {
			p.Set("offset", fmt.Sprint(v))
		}
		if v := req.GetString("sort_by", ""); v != "" {
			p.Set("sort_by", v)
		}
		if v := req.GetString("sort_order", ""); v != "" {
			p.Set("sort_order", v)
		}
		if v := req.GetString("start_date", ""); v != "" {
			p.Set("start_date", v)
		}
		if v := req.GetString("end_date", ""); v != "" {
			p.Set("end_date", v)
		}
		if v := req.GetString("query", ""); v != "" {
			p.Set("query", v)
		}
		if v := req.GetString("source", ""); v != "" {
			p.Set("_src", v)
		}
		data, err := c.get("/logs", p)
		if err != nil {
			return resultErr(err), nil
		}
		return resultText(data), nil
	})

	// ------------------------------------------------------- list_grok_patterns
	s.AddTool(mcp.NewTool("list_grok_patterns",
		mcp.WithDescription("List the Grok patterns LogSonic uses to parse incoming logs. "+
			"Returns patterns[] with name, pattern, description, priority, custom_patterns."),
	), func(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		data, err := c.get("/grok", nil)
		if err != nil {
			return resultErr(err), nil
		}
		return resultText(data), nil
	})

	// ------------------------------------------------------- test_grok_pattern
	s.AddTool(mcp.NewTool("test_grok_pattern",
		mcp.WithDescription("Parse sample log lines with a Grok pattern WITHOUT ingesting them. "+
			"Omit grok_pattern to trigger autosuggest — returns best-matching patterns with confidence scores."),
		mcp.WithString("logs",
			mcp.Description("JSON array of sample log lines to parse (1–50), e.g. [\"line1\",\"line2\"]"),
			mcp.Required(),
		),
		mcp.WithString("grok_pattern", mcp.Description("Grok pattern string. Omit to trigger autosuggest.")),
		mcp.WithString("custom_patterns",
			mcp.Description("JSON object of named sub-patterns, e.g. {\"MYAPP_LEVEL\":\"(?:DEBUG|INFO|WARN|ERROR)\"}"),
		),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		logsRaw := req.GetString("logs", "[]")
		var logs []string
		if err := json.Unmarshal([]byte(logsRaw), &logs); err != nil {
			return resultErr(fmt.Errorf("'logs' must be a JSON array of strings: %w", err)), nil
		}
		payload := map[string]any{"logs": logs}
		if v := req.GetString("grok_pattern", ""); v != "" {
			payload["grok_pattern"] = v
		}
		if v := req.GetString("custom_patterns", ""); v != "" {
			var cp map[string]string
			if err := json.Unmarshal([]byte(v), &cp); err == nil {
				payload["custom_patterns"] = cp
			}
		}
		data, err := c.post("/parse", payload)
		if err != nil {
			return resultErr(err), nil
		}
		return resultText(data), nil
	})

	// ----------------------------------------------------------- logsonic_url
	s.AddTool(mcp.NewTool("logsonic_url",
		mcp.WithDescription("Build a deep-link URL into the LogSonic web UI with a pre-filled query and time range. "+
			"Dates here are Unix milliseconds (NOT RFC3339) because that's what the UI's URL hash expects."),
		mcp.WithString("query", mcp.Description("Bleve query to pre-fill")),
		mcp.WithString("start_date", mcp.Description("Start time as Unix milliseconds")),
		mcp.WithString("end_date", mcp.Description("End time as Unix milliseconds")),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		p := url.Values{}
		if v := req.GetString("query", ""); v != "" {
			p.Set("q", v)
		}
		if v := req.GetString("start_date", ""); v != "" {
			p.Set("since", v)
		}
		if v := req.GetString("end_date", ""); v != "" {
			p.Set("to", v)
		}
		result := c.serverBaseURL() + "/?#" + p.Encode()
		return mcp.NewToolResultText(result), nil
	})

	// -------------------------------------------------------- log_distribution
	s.AddTool(mcp.NewTool("log_distribution",
		mcp.WithDescription("Return only the time-bucketed log distribution for a query (counts per time bucket, per source). "+
			"Cheaper than query_logs when you just want to see 'when did errors spike' without inspecting individual rows."),
		mcp.WithString("query", mcp.Description("Bleve query to scope the distribution")),
		mcp.WithString("source", mcp.Description("Comma-separated source filter")),
		mcp.WithString("start_date", mcp.Description("Inclusive start of time window, RFC3339")),
		mcp.WithString("end_date", mcp.Description("Inclusive end of time window, RFC3339")),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		p := url.Values{}
		p.Set("limit", "1") // suppress row payload; distribution is computed independently
		if v := req.GetString("query", ""); v != "" {
			p.Set("query", v)
		}
		if v := req.GetString("source", ""); v != "" {
			p.Set("_src", v)
		}
		if v := req.GetString("start_date", ""); v != "" {
			p.Set("start_date", v)
		}
		if v := req.GetString("end_date", ""); v != "" {
			p.Set("end_date", v)
		}
		data, err := c.get("/logs", p)
		if err != nil {
			return resultErr(err), nil
		}
		// Extract just the distribution fields to keep the response small.
		var full map[string]json.RawMessage
		if json.Unmarshal(data, &full) == nil {
			out := map[string]json.RawMessage{
				"status":           json.RawMessage(`"success"`),
				"total_count":      full["total_count"],
				"log_distribution": full["log_distribution"],
			}
			if b, e := json.Marshal(out); e == nil {
				return mcp.NewToolResultText(string(b)), nil
			}
		}
		return resultText(data), nil
	})

	// -------------------------------------------------------- list_workspaces
	s.AddTool(mcp.NewTool("list_workspaces",
		mcp.WithDescription("List saved LogSonic investigation workspaces. "+
			"Use this when the user wants to reopen or reuse a named troubleshooting view."),
	), func(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		data, err := c.get("/workspaces", nil)
		if err != nil {
			return resultErr(err), nil
		}
		return mcp.NewToolResultText(compactWorkspaces(data)), nil
	})

	// -------------------------------------------------------- open_workspace
	s.AddTool(mcp.NewTool("open_workspace",
		mcp.WithDescription("Return one saved investigation workspace by id, including the UI URL that opens its query/time range."),
		mcp.WithString("id", mcp.Description("Workspace id from list_workspaces"), mcp.Required()),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id := strings.TrimSpace(req.GetString("id", ""))
		if id == "" {
			return resultErr(fmt.Errorf("id is required")), nil
		}
		data, err := c.get("/workspaces/"+url.PathEscape(id), nil)
		if err != nil {
			return resultErr(err), nil
		}
		return mcp.NewToolResultText(withWorkspaceURL(data, c.serverBaseURL())), nil
	})

	// ------------------------------------------------------- create_workspace
	s.AddTool(mcp.NewTool("create_workspace",
		mcp.WithDescription("Create a saved investigation workspace from query/time/source state. "+
			"Prefer relative_time for reusable views; use start_date/end_date only when the window must stay fixed."),
		mcp.WithString("name", mcp.Description("Workspace name"), mcp.Required()),
		mcp.WithString("description", mcp.Description("Optional description")),
		mcp.WithString("query", mcp.Description("Bleve query string to save")),
		mcp.WithString("source", mcp.Description("Comma-separated source names")),
		mcp.WithString("relative_time", mcp.Description("Relative range such as last-24-hours or last-7-days")),
		mcp.WithString("start_date", mcp.Description("Absolute start time, RFC3339")),
		mcp.WithString("end_date", mcp.Description("Absolute end time, RFC3339")),
		mcp.WithString("columns", mcp.Description("Comma-separated columns to restore")),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		name := strings.TrimSpace(req.GetString("name", ""))
		if name == "" {
			return resultErr(fmt.Errorf("name is required")), nil
		}

		startDate := strings.TrimSpace(req.GetString("start_date", ""))
		endDate := strings.TrimSpace(req.GetString("end_date", ""))
		relativeTime := strings.TrimSpace(req.GetString("relative_time", ""))
		if relativeTime == "" {
			relativeTime = "last-24-hours"
		}

		timeSpec := map[string]any{"mode": "relative", "relative": relativeTime}
		if startDate != "" || endDate != "" {
			if startDate == "" || endDate == "" {
				return resultErr(fmt.Errorf("both start_date and end_date are required for an absolute workspace")), nil
			}
			timeSpec = map[string]any{"mode": "absolute", "start": startDate, "end": endDate}
		}

		payload := map[string]any{
			"name":          name,
			"description":   strings.TrimSpace(req.GetString("description", "")),
			"query":         strings.TrimSpace(req.GetString("query", "")),
			"sources":       splitCSV(req.GetString("source", "")),
			"time":          timeSpec,
			"sort_by":       "timestamp",
			"sort_order":    "desc",
			"columns":       splitCSV(req.GetString("columns", "")),
			"visualization": map[string]any{"type": "logs", "bucket": "auto"},
		}
		data, err := c.post("/workspaces", payload)
		if err != nil {
			return resultErr(err), nil
		}
		return mcp.NewToolResultText(withWorkspaceURL(data, c.serverBaseURL())), nil
	})

	// ---------------------------------------------------------- workspace_url
	s.AddTool(mcp.NewTool("workspace_url",
		mcp.WithDescription("Build a UI URL for a saved workspace id. The URL restores query and time range."),
		mcp.WithString("id", mcp.Description("Workspace id from list_workspaces"), mcp.Required()),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id := strings.TrimSpace(req.GetString("id", ""))
		if id == "" {
			return resultErr(fmt.Errorf("id is required")), nil
		}
		data, err := c.get("/workspaces/"+url.PathEscape(id), nil)
		if err != nil {
			return resultErr(err), nil
		}
		workspace, err := extractWorkspace(data)
		if err != nil {
			return resultErr(err), nil
		}
		return mcp.NewToolResultText(buildWorkspaceURL(c.serverBaseURL(), workspace)), nil
	})

	return s
}

func compactWorkspaces(data json.RawMessage) string {
	var response struct {
		Status     string `json:"status"`
		Workspaces []struct {
			ID          string          `json:"id"`
			Name        string          `json:"name"`
			Description string          `json:"description,omitempty"`
			Query       string          `json:"query,omitempty"`
			Sources     []string        `json:"sources,omitempty"`
			Time        json.RawMessage `json:"time"`
			Favorite    bool            `json:"favorite"`
			UpdatedAt   string          `json:"updated_at,omitempty"`
		} `json:"workspaces"`
	}
	if json.Unmarshal(data, &response) != nil {
		return string(data)
	}
	out, err := json.Marshal(response)
	if err != nil {
		return string(data)
	}
	return string(out)
}

func withWorkspaceURL(data json.RawMessage, baseURL string) string {
	workspace, err := extractWorkspace(data)
	if err != nil {
		return string(data)
	}
	var response map[string]any
	if json.Unmarshal(data, &response) != nil {
		return string(data)
	}
	response["url"] = buildWorkspaceURL(baseURL, workspace)
	out, err := json.Marshal(response)
	if err != nil {
		return string(data)
	}
	return string(out)
}

func extractWorkspace(data json.RawMessage) (map[string]any, error) {
	var response struct {
		Workspace map[string]any `json:"workspace"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, err
	}
	if len(response.Workspace) == 0 {
		return nil, fmt.Errorf("workspace not found in response")
	}
	return response.Workspace, nil
}

func buildWorkspaceURL(baseURL string, workspace map[string]any) string {
	p := url.Values{}
	if query, ok := workspace["query"].(string); ok && query != "" {
		p.Set("q", query)
	}

	if timeSpec, ok := workspace["time"].(map[string]any); ok {
		mode, _ := timeSpec["mode"].(string)
		if mode == "absolute" {
			if start, ok := timeSpec["start"].(string); ok && start != "" {
				if parsed, err := time.Parse(time.RFC3339Nano, start); err == nil {
					p.Set("since", fmt.Sprint(parsed.UnixMilli()))
				}
			}
			if end, ok := timeSpec["end"].(string); ok && end != "" {
				if parsed, err := time.Parse(time.RFC3339Nano, end); err == nil {
					p.Set("to", fmt.Sprint(parsed.UnixMilli()))
				}
			}
		} else {
			relative, _ := timeSpec["relative"].(string)
			if relative == "" {
				relative = "last-24-hours"
			}
			p.Set("isRelative", "true")
			p.Set("relativeValue", relative)
			p.Set("relative", relative)
		}
	}

	return baseURL + "/?#" + p.Encode()
}

func splitCSV(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// resolveURL returns the LogSonic base URL from the explicit flag value, then
// LOGSONIC_URL, then LOGSONIC_HOST+LOGSONIC_PORT, then the default localhost:8080.
func resolveURL(flagURL string) string {
	if flagURL != "" {
		return strings.TrimRight(flagURL, "/")
	}
	if u := os.Getenv("LOGSONIC_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	host := os.Getenv("LOGSONIC_HOST")
	if host == "" {
		host = "localhost"
	}
	port := os.Getenv("LOGSONIC_PORT")
	if port == "" {
		port = "8080"
	}
	return fmt.Sprintf("http://%s:%s", host, port)
}

// Serve resolves the LogSonic URL, probes it, then blocks serving the MCP
// stdio transport. Used by the `logsonic mcp` subcommand.
func Serve(flagURL string) error {
	baseURL := resolveURL(flagURL)
	c := newClient(baseURL)
	if _, err := c.get("/ping", nil); err != nil {
		logger.Printf("WARNING: LogSonic at %s is not reachable (%v). Will still start; tools will error until it is up.", baseURL, err)
	} else {
		logger.Printf("connected to LogSonic at %s", baseURL)
	}
	return server.ServeStdio(build(baseURL))
}

// Handler returns an http.Handler that serves the MCP Streamable HTTP
// transport (MCP spec 2025-03-26) on any path it is mounted at.
// baseURL is the LogSonic server root the tools will call — typically the
// same origin the handler is mounted on (e.g. "http://localhost:8080").
func Handler(baseURL string) http.Handler {
	return HandlerWithBaseURLProvider(staticBaseURL(baseURL))
}

func HandlerWithBaseURLProvider(provider func() string) http.Handler {
	return server.NewStreamableHTTPServer(buildWithBaseURLProvider(provider),
		server.WithStateLess(true), // no session state needed for read-only tools
	)
}
