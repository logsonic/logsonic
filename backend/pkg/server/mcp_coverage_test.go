package server

import (
	"net/http"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	lsmcp "logsonic/pkg/mcp"
)

// restRouteTools maps every /api/v1 route to the MCP tool that exposes it,
// so an agent can do everything the UI does. A route that only makes sense
// for the browser UI or a CLI stream is listed in restRouteExempt instead.
// Adding a route without updating one of the two fails
// TestEveryRESTRouteHasAnMCPTool.
var restRouteTools = map[string]string{
	"GET /api/v1/ping":                       "ping",
	"GET /api/v1/info":                       "log_info",
	"GET /api/v1/logs/":                      "query_logs",
	"DELETE /api/v1/logs/":                   "clear_all_logs",
	"DELETE /api/v1/logs/ids":                "delete_logs",
	"POST /api/v1/ingest/start":              "ingest_lines",
	"POST /api/v1/ingest/logs":               "ingest_lines",
	"POST /api/v1/ingest/end":                "ingest_lines",
	"POST /api/v1/ingest/file":               "ingest_file",
	"GET /api/v1/ingest/jobs":                "list_ingest_jobs",
	"DELETE /api/v1/ingest/jobs/{id}":        "cancel_ingest_job",
	"POST /api/v1/parse":                     "test_grok_pattern",
	"POST /api/v1/parse/preview-file":        "preview_file",
	"POST /api/v1/timestamp/preview":         "preview_timestamps",
	"GET /api/v1/grok/":                      "list_grok_patterns",
	"POST /api/v1/grok/":                     "save_grok_pattern",
	"PUT /api/v1/grok/":                      "save_grok_pattern",
	"DELETE /api/v1/grok/":                   "delete_grok_pattern",
	"GET /api/v1/workspaces/":                "list_workspaces",
	"POST /api/v1/workspaces/":               "create_workspace",
	"GET /api/v1/workspaces/{id}":            "open_workspace",
	"PUT /api/v1/workspaces/{id}":            "update_workspace",
	"DELETE /api/v1/workspaces/{id}":         "delete_workspace",
	"POST /api/v1/workspaces/{id}/duplicate": "duplicate_workspace",
	"GET /api/v1/sources/":                   "list_sources",
	"POST /api/v1/sources/rebuild":           "rebuild_sources",
	"GET /api/v1/sources/{name}":             "get_source",
	"PATCH /api/v1/sources/{name}":           "rename_source",
	"DELETE /api/v1/sources/{name}":          "delete_source",
	"POST /api/v1/sources/{name}/reimport":   "reimport_source",
	"GET /api/v1/storage/":                   "storage_info",
	"PUT /api/v1/storage/":                   "set_retention",
	"DELETE /api/v1/storage/days/{date}":     "delete_storage_day",
	"GET /api/v1/samples":                    "list_samples",
	"POST /api/v1/samples/{name}/import":     "import_sample",
	"GET /api/v1/watches/":                   "list_watches",
	"POST /api/v1/watches/":                  "create_watch",
	"DELETE /api/v1/watches/{id}":            "delete_watch",
	"POST /api/v1/watches/{id}/pause":        "pause_watch",
	"POST /api/v1/watches/{id}/resume":       "resume_watch",
	"POST /api/v1/live/files":                "tail_file",
	"DELETE /api/v1/live/sources/{sourceID}": "stop_tail",
	"POST /api/v1/ui/focus":                  "ui_focus",
	"POST /api/v1/ui/command":                "ui_get_state",
}

var restRouteExempt = map[string]string{
	"GET /api/v1/swagger/*":                               "API docs for humans",
	"GET /api/v1/live/events":                             "SSE stream the browser UI subscribes to; agents read state via ui_get_state",
	"POST /api/v1/live/stdin":                             "streaming request body for `cmd | logsonic tail`; agents send lines with ingest_lines",
	"POST /api/v1/ui/ack":                                 "the browser UI's reply to /ui/command, never called by an agent",
	"POST /api/v1/live/subscribers/{subscriberID}/pause":  "pauses one browser's SSE row feed",
	"POST /api/v1/live/subscribers/{subscriberID}/resume": "resumes one browser's SSE row feed",
}

// uiCommandTools are the tools that drive the UI through POST /ui/command;
// every one must exist alongside the route's representative ui_get_state.
var uiCommandTools = []string{
	"ui_get_state", "ui_navigate", "ui_show_view", "ui_set_query", "ui_set_time", "ui_set_sources",
	"ui_set_columns", "ui_set_column_widths", "ui_add_filter", "ui_remove_filter", "ui_clear_filters",
	"ui_set_sort", "ui_set_page", "ui_fields_panel", "ui_sidebar", "ui_open_workspace", "ui_run_search",
}

func TestEveryRESTRouteHasAnMCPTool(t *testing.T) {
	srv, err := NewServer(Config{Host: "localhost", Port: ":0", StoragePath: t.TempDir(), Timeout: time.Second})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	t.Cleanup(func() { _ = srv.services.CloseStorage() })

	tools := lsmcp.ToolNames()
	hasTool := func(name string) bool { return slices.Contains(tools, name) }

	seen := map[string]bool{}
	err = chi.Walk(srv.router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if !strings.HasPrefix(route, "/api/v1/") {
			return nil
		}
		key := method + " " + route
		seen[key] = true
		if _, ok := restRouteExempt[key]; ok {
			return nil
		}
		tool, ok := restRouteTools[key]
		if !ok {
			t.Errorf("REST route %s has no MCP tool: add one in pkg/mcp and map it in restRouteTools, or list it in restRouteExempt with a reason", key)
			return nil
		}
		if !hasTool(tool) {
			t.Errorf("REST route %s maps to MCP tool %q, which is not registered", key, tool)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}

	// Stale entries: a mapped route that no longer exists.
	var stale []string
	for key := range restRouteTools {
		if !seen[key] {
			stale = append(stale, key)
		}
	}
	for key := range restRouteExempt {
		if !seen[key] {
			stale = append(stale, key)
		}
	}
	sort.Strings(stale)
	for _, key := range stale {
		t.Errorf("mapped route %s is not registered on the router; remove or fix the entry", key)
	}

	for _, name := range uiCommandTools {
		if !hasTool(name) {
			t.Errorf("UI tool %s is not registered", name)
		}
	}
}
