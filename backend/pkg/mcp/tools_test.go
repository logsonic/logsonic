package mcp

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"
)

type recordedCall struct {
	method, path, query string
	body                map[string]any
}

// fakeLogSonic records every API call and answers with handler's result.
func fakeLogSonic(t *testing.T, handler func(r *http.Request, body map[string]any) (int, any)) (*httptest.Server, func() []recordedCall) {
	t.Helper()
	var mu sync.Mutex
	var calls []recordedCall
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if b, _ := io.ReadAll(r.Body); len(b) > 0 {
			_ = json.Unmarshal(b, &body)
		}
		mu.Lock()
		calls = append(calls, recordedCall{r.Method, strings.TrimPrefix(r.URL.Path, "/api/v1"), r.URL.RawQuery, body})
		mu.Unlock()
		code, resp := handler(r, body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)
	return srv, func() []recordedCall {
		mu.Lock()
		defer mu.Unlock()
		return append([]recordedCall(nil), calls...)
	}
}

func callTool(t *testing.T, baseURL, name string, args map[string]any) (*mcp.CallToolResult, string) {
	t.Helper()
	s := build(baseURL)
	tool := s.GetTool(name)
	if tool == nil {
		t.Fatalf("tool %s not registered", name)
	}
	var req mcp.CallToolRequest
	req.Params.Name = name
	req.Params.Arguments = args
	res, err := tool.Handler(context.Background(), req)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	text := ""
	if len(res.Content) > 0 {
		if tc, ok := res.Content[0].(mcp.TextContent); ok {
			text = tc.Text
		}
	}
	return res, text
}

func TestAllToolsRegistered(t *testing.T) {
	s := build("http://localhost:0")
	want := []string{
		"ping", "log_info", "query_logs", "log_distribution", "log_facets",
		"ingest_file", "ingest_status", "list_ingest_jobs", "cancel_ingest_job", "ingest_lines", "preview_file",
		"list_samples", "import_sample", "tail_file", "stop_tail",
		"list_sources", "get_source", "rename_source", "delete_source", "reimport_source", "rebuild_sources",
		"preview_timestamps", "delete_logs",
		"list_watches", "create_watch", "delete_watch", "pause_watch", "resume_watch",
		"list_grok_patterns", "test_grok_pattern", "save_grok_pattern", "delete_grok_pattern",
		"list_workspaces", "open_workspace", "create_workspace", "update_workspace", "delete_workspace", "duplicate_workspace", "workspace_url",
		"storage_info", "set_retention", "delete_storage_day", "clear_all_logs",
		"ui_focus", "ui_get_state", "ui_navigate", "ui_show_view", "ui_set_query", "ui_set_time", "ui_set_sources",
		"ui_set_columns", "ui_set_column_widths", "ui_add_filter", "ui_remove_filter", "ui_clear_filters",
		"ui_set_sort", "ui_set_page", "ui_fields_panel", "ui_sidebar", "ui_open_workspace", "ui_run_search",
	}
	for _, name := range want {
		if s.GetTool(name) == nil {
			t.Errorf("tool %s not registered", name)
		}
	}
	for _, name := range []string{"delete_source", "delete_logs", "clear_all_logs", "delete_storage_day"} {
		ann := s.GetTool(name).Tool.Annotations
		if ann.DestructiveHint == nil || !*ann.DestructiveHint {
			t.Errorf("%s should be marked destructive", name)
		}
	}
}

func TestUIToolsSendCommands(t *testing.T) {
	srv, calls := fakeLogSonic(t, func(_ *http.Request, _ map[string]any) (int, any) {
		return 200, map[string]any{"status": "applied", "state": map[string]any{"route": "/"}}
	})

	_, text := callTool(t, srv.URL, "ui_add_filter", map[string]any{"field": "level", "value": "error", "exclude": true})
	if !strings.Contains(text, `"applied"`) {
		t.Fatalf("unexpected result %s", text)
	}
	callTool(t, srv.URL, "ui_set_columns", map[string]any{"columns": []any{"level", "message"}, "mode": "hide"})
	callTool(t, srv.URL, "ui_set_sources", map[string]any{"sources": "nginx, api"})

	got := calls()
	if len(got) != 3 {
		t.Fatalf("want 3 calls, got %+v", got)
	}
	for _, c := range got {
		if c.method != "POST" || c.path != "/ui/command" {
			t.Fatalf("unexpected call %+v", c)
		}
	}
	if got[0].body["type"] != "add_filter" {
		t.Fatalf("add_filter type: %+v", got[0].body)
	}
	args := got[0].body["args"].(map[string]any)
	if args["field"] != "level" || args["value"] != "error" || args["exclude"] != true {
		t.Fatalf("add_filter args: %+v", args)
	}
	if got[1].body["type"] != "hide_columns" {
		t.Fatalf("hide mode should send hide_columns: %+v", got[1].body)
	}
	src := got[2].body["args"].(map[string]any)["sources"].([]any)
	if len(src) != 2 || src[0] != "nginx" || src[1] != "api" {
		t.Fatalf("sources not split: %+v", src)
	}
}

func TestUIToolSurfacesNoUI(t *testing.T) {
	srv, _ := fakeLogSonic(t, func(_ *http.Request, _ map[string]any) (int, any) {
		return 409, map[string]any{"status": "no_ui_connected", "error": "no LogSonic web UI is connected"}
	})
	res, text := callTool(t, srv.URL, "ui_get_state", nil)
	if !res.IsError || !strings.Contains(text, "no_ui_connected") {
		t.Fatalf("want error mentioning no_ui_connected, got %v %s", res.IsError, text)
	}
}

func TestShowViewBatchesThenRunsOnce(t *testing.T) {
	srv, calls := fakeLogSonic(t, func(_ *http.Request, body map[string]any) (int, any) {
		resp := map[string]any{"status": "applied", "type": body["type"]}
		if body["type"] == "set_columns" {
			resp["warnings"] = []string{"unknown columns: bogus"}
		}
		return 200, resp
	})
	_, text := callTool(t, srv.URL, "ui_show_view", map[string]any{
		"query":         "timeout",
		"relative_time": "last-7-days",
		"sources":       []any{"api"},
		"filters":       []any{map[string]any{"field": "level", "value": "error"}},
		"columns":       []any{"level", "bogus"},
		"sort_order":    "asc",
	})
	var types []string
	for _, c := range calls() {
		types = append(types, c.body["type"].(string))
		args, _ := c.body["args"].(map[string]any)
		switch c.body["type"] {
		case "set_query", "set_time", "set_sources", "add_filter":
			if args["run"] != false {
				t.Errorf("%s should not run a search: %+v", c.body["type"], args)
			}
		}
	}
	want := "set_query,set_time,set_sources,add_filter,set_sort,run_search,set_columns"
	if strings.Join(types, ",") != want {
		t.Fatalf("got %v, want %s", types, want)
	}
	if !strings.Contains(text, "unknown columns: bogus") || !strings.Contains(text, `"set_columns"`) {
		t.Fatalf("final state / warnings missing: %s", text)
	}
}

func TestIngestFileRunsSessionAndEndsIt(t *testing.T) {
	srv, calls := fakeLogSonic(t, func(r *http.Request, _ map[string]any) (int, any) {
		switch strings.TrimPrefix(r.URL.Path, "/api/v1") {
		case "/ingest/start":
			return 200, map[string]any{"status": "success", "session_id": "s1"}
		case "/ingest/file":
			return 202, map[string]any{"status": "accepted", "job_id": "j1"}
		case "/ingest/jobs":
			return 200, map[string]any{"jobs": []any{map[string]any{"job_id": "j1", "session_id": "s1", "state": "done", "rows_stored": 42}}}
		default:
			return 200, map[string]any{"status": "success"}
		}
	})
	res, text := callTool(t, srv.URL, "ingest_file", map[string]any{"path": "/var/log/app.log"})
	if res.IsError {
		t.Fatalf("ingest_file failed: %s", text)
	}
	if !strings.Contains(text, `"finished":true`) || !strings.Contains(text, `"rows_stored":42`) || !strings.Contains(text, `"source":"app.log"`) {
		t.Fatalf("unexpected result %s", text)
	}
	got := calls()
	var paths []string
	for _, c := range got {
		paths = append(paths, c.path)
	}
	if strings.Join(paths, ",") != "/ingest/start,/ingest/file,/ingest/jobs,/ingest/end" {
		t.Fatalf("unexpected call sequence %v", paths)
	}
	start := got[0].body
	if start["source"] != "app.log" || start["pattern"] != "auto" {
		t.Fatalf("session options: %+v", start)
	}
	if got[1].body["session_id"] != "s1" || got[3].body["session_id"] != "s1" {
		t.Fatalf("session id not threaded: %+v %+v", got[1].body, got[3].body)
	}
}

func TestDestructiveToolsNeedConfirm(t *testing.T) {
	srv, calls := fakeLogSonic(t, func(_ *http.Request, _ map[string]any) (int, any) {
		return 200, map[string]any{"status": "success"}
	})
	res, _ := callTool(t, srv.URL, "clear_all_logs", map[string]any{})
	if !res.IsError || len(calls()) != 0 {
		t.Fatalf("clear_all_logs without confirm must not call the API")
	}
	res, _ = callTool(t, srv.URL, "delete_logs", map[string]any{"ids": []any{"a"}})
	if !res.IsError || len(calls()) != 0 {
		t.Fatalf("delete_logs without confirm must not call the API")
	}
	res, _ = callTool(t, srv.URL, "delete_source", map[string]any{"name": "x", "confirm": true})
	if res.IsError || calls()[0].method != "DELETE" || calls()[0].path != "/sources/x" {
		t.Fatalf("delete_source with confirm: %+v", calls())
	}
}

func TestStringListShapes(t *testing.T) {
	for _, raw := range []any{[]any{"a", " b "}, "a,b", `["a","b"]`} {
		var req mcp.CallToolRequest
		req.Params.Arguments = map[string]any{"k": raw}
		got, err := stringList(req, "k")
		if err != nil || strings.Join(got, "|") != "a|b" {
			t.Errorf("%v: got %v %v", raw, got, err)
		}
	}
}
