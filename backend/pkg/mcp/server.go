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

// client holds the resolved base URL and a shared HTTP client.
type client struct {
	baseURL    string
	apiBaseURL string
	http       *http.Client
}

func newClient(baseURL string) *client {
	return &client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		apiBaseURL: strings.TrimRight(baseURL, "/") + "/api/v1",
		http:       &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *client) get(path string, params url.Values) (json.RawMessage, error) {
	u := c.apiBaseURL + path
	if len(params) > 0 {
		u += "?" + params.Encode()
	}
	resp, err := c.http.Get(u)
	if err != nil {
		return nil, fmt.Errorf("cannot reach LogSonic at %s: %w", c.baseURL, err)
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
	resp, err := c.http.Post(c.apiBaseURL+path, "application/json", bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("cannot reach LogSonic at %s: %w", c.baseURL, err)
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
	c := newClient(baseURL)
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
		out, _ := json.Marshal(map[string]any{"status": "ok", "base_url": baseURL, "server": json.RawMessage(data)})
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
		result := baseURL + "/?#" + p.Encode()
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

	return s
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
	baseURL = strings.TrimRight(baseURL, "/")
	return server.NewStreamableHTTPServer(build(baseURL),
		server.WithStateLess(true), // no session state needed for read-only tools
	)
}
