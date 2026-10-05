package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// simpleTool registers a tool whose handler is one REST call.
func simpleTool(s *server.MCPServer, tool mcp.Tool, call func(mcp.CallToolRequest) (json.RawMessage, error)) {
	s.AddTool(tool, func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		data, err := call(req)
		if err != nil {
			return resultErr(err), nil
		}
		return resultText(data), nil
	})
}

func registerManageTools(s *server.MCPServer, c *client) {
	// ================================================================ analysis

	simpleTool(s, mcp.NewTool("log_facets",
		mcp.WithDescription("Field/value breakdown of the logs matching a query: for each extracted field, the top values and their counts "+
			"(like Splunk's field sidebar). Use it to find which hosts/status codes/levels dominate an error spike before drilling in with query_logs. "+
			"Computed over a bounded sample of the newest matching rows; see facets.computed_over / sampled."),
		mcp.WithString("query", mcp.Description("Bleve query to scope the facets")),
		mcp.WithString("source", mcp.Description("Comma-separated source filter")),
		mcp.WithString("start_date", mcp.Description("Inclusive start, RFC3339")),
		mcp.WithString("end_date", mcp.Description("Inclusive end, RFC3339")),
		mcp.WithReadOnlyHintAnnotation(true),
	), func(req mcp.CallToolRequest) (json.RawMessage, error) {
		p := url.Values{}
		p.Set("limit", "1")
		p.Set("include_facets", "true")
		p.Set("include_distribution", "false")
		for arg, param := range map[string]string{"query": "query", "source": "_src", "start_date": "start_date", "end_date": "end_date"} {
			if v := strings.TrimSpace(req.GetString(arg, "")); v != "" {
				p.Set(param, v)
			}
		}
		data, err := c.get("/logs", p)
		if err != nil {
			return nil, err
		}
		var full map[string]json.RawMessage
		if json.Unmarshal(data, &full) != nil {
			return data, nil
		}
		return json.Marshal(map[string]json.RawMessage{
			"total_count":       full["total_count"],
			"available_columns": full["available_columns"],
			"facets":            full["facets"],
		})
	})

	// ================================================================= sources

	simpleTool(s, mcp.NewTool("list_sources",
		mcp.WithDescription("List ingested sources with row counts, time span, origin (file path / tail / stdin), pattern and import history."),
		mcp.WithReadOnlyHintAnnotation(true),
	), func(_ mcp.CallToolRequest) (json.RawMessage, error) {
		return c.get("/sources", nil)
	})

	simpleTool(s, mcp.NewTool("get_source",
		mcp.WithDescription("Get one source's catalog entry."),
		mcp.WithString("name", mcp.Required(), mcp.Description("Source name (stored _src)")),
		mcp.WithReadOnlyHintAnnotation(true),
	), func(req mcp.CallToolRequest) (json.RawMessage, error) {
		name, err := requiredString(req, "name")
		if err != nil {
			return nil, err
		}
		return c.get("/sources/"+url.PathEscape(name), nil)
	})

	simpleTool(s, mcp.NewTool("rename_source",
		mcp.WithDescription("Set a source's display name (the stored _src stays; queries by either name keep working). Empty display_name clears it."),
		mcp.WithString("name", mcp.Required(), mcp.Description("Source name (stored _src)")),
		mcp.WithString("display_name", mcp.Description("New display name")),
	), func(req mcp.CallToolRequest) (json.RawMessage, error) {
		name, err := requiredString(req, "name")
		if err != nil {
			return nil, err
		}
		return c.do("PATCH", "/sources/"+url.PathEscape(name), nil, map[string]string{
			"display_name": strings.TrimSpace(req.GetString("display_name", "")),
		})
	})

	simpleTool(s, mcp.NewTool("delete_source",
		mcp.WithDescription("Permanently delete every row of one source. Cannot be undone. Requires confirm=true."),
		mcp.WithString("name", mcp.Required(), mcp.Description("Source name (stored _src)")),
		mcp.WithBoolean("confirm", mcp.Required(), mcp.Description("Must be true")),
		mcp.WithDestructiveHintAnnotation(true),
	), func(req mcp.CallToolRequest) (json.RawMessage, error) {
		name, err := requiredString(req, "name")
		if err != nil {
			return nil, err
		}
		if !req.GetBool("confirm", false) {
			return nil, fmt.Errorf("delete_source removes all rows of %q permanently; call again with confirm=true if the user agreed", name)
		}
		return c.do("DELETE", "/sources/"+url.PathEscape(name), nil, nil)
	})

	simpleTool(s, mcp.NewTool("reimport_source",
		mcp.WithDescription("Delete a source's rows and import its origin file again with the recorded options (e.g. after fixing a pattern). Returns a job_id for ingest_status."),
		mcp.WithString("name", mcp.Required(), mcp.Description("Source name (stored _src)")),
		mcp.WithDestructiveHintAnnotation(true),
	), func(req mcp.CallToolRequest) (json.RawMessage, error) {
		name, err := requiredString(req, "name")
		if err != nil {
			return nil, err
		}
		return c.do("POST", "/sources/"+url.PathEscape(name)+"/reimport", nil, nil)
	})

	// ================================================================= watches

	simpleTool(s, mcp.NewTool("list_watches",
		mcp.WithDescription("List folder watches and the files each one tracks."),
		mcp.WithReadOnlyHintAnnotation(true),
	), func(_ mcp.CallToolRequest) (json.RawMessage, error) {
		return c.get("/watches", nil)
	})

	simpleTool(s, mcp.NewTool("create_watch",
		mcp.WithDescription("Watch a folder: every file matching glob is imported when it appears and followed as it grows (one source per file). Survives restarts."),
		mcp.WithString("dir", mcp.Required(), mcp.Description("Absolute folder path")),
		mcp.WithString("glob", mcp.Description("Base-name glob, e.g. *.log (default: every file)")),
		mcp.WithString("pattern", mcp.Description("Saved pattern name to parse with (default: auto-detect)")),
		mcp.WithBoolean("recursive", mcp.Description("Include subfolders")),
	), func(req mcp.CallToolRequest) (json.RawMessage, error) {
		dir, err := requiredString(req, "dir")
		if err != nil {
			return nil, err
		}
		return c.post("/watches", map[string]any{
			"dir":       dir,
			"glob":      strings.TrimSpace(req.GetString("glob", "")),
			"pattern":   strings.TrimSpace(req.GetString("pattern", "")),
			"recursive": req.GetBool("recursive", false),
		})
	})

	for _, action := range []struct{ name, verb, desc string }{
		{"delete_watch", "DELETE", "Stop and remove a folder watch. Imported rows stay."},
		{"pause_watch", "POST", "Pause a folder watch (stops following its files)."},
		{"resume_watch", "POST", "Resume a paused folder watch."},
	} {
		action := action
		simpleTool(s, mcp.NewTool(action.name,
			mcp.WithDescription(action.desc),
			mcp.WithString("id", mcp.Required(), mcp.Description("Watch id from list_watches")),
		), func(req mcp.CallToolRequest) (json.RawMessage, error) {
			id, err := requiredString(req, "id")
			if err != nil {
				return nil, err
			}
			path := "/watches/" + url.PathEscape(id)
			if action.verb == "POST" {
				path += "/" + strings.TrimSuffix(action.name, "_watch")
			}
			return c.do(action.verb, path, nil, nil)
		})
	}

	// ==================================================================== grok

	simpleTool(s, mcp.NewTool("save_grok_pattern",
		mcp.WithDescription("Save a Grok pattern to the library so imports can use it by name (pattern_name). Test it with test_grok_pattern first. update=true replaces an existing pattern of the same name."),
		mcp.WithString("name", mcp.Required(), mcp.Description("Pattern name")),
		mcp.WithString("pattern", mcp.Required(), mcp.Description("Grok pattern string")),
		mcp.WithString("description", mcp.Description("What logs it parses")),
		mcp.WithNumber("priority", mcp.Description("Higher is tried first during auto-detection")),
		mcp.WithObject("custom_patterns", mcp.Description("Named sub-patterns, e.g. {\"MYLEVEL\":\"(?:DEBUG|INFO)\"}")),
		mcp.WithBoolean("update", mcp.Description("Replace an existing pattern with this name")),
	), func(req mcp.CallToolRequest) (json.RawMessage, error) {
		name, err := requiredString(req, "name")
		if err != nil {
			return nil, err
		}
		pattern, err := requiredString(req, "pattern")
		if err != nil {
			return nil, err
		}
		custom, err := stringMap(req, "custom_patterns")
		if err != nil {
			return nil, err
		}
		body := map[string]any{
			"name":        name,
			"pattern":     pattern,
			"description": strings.TrimSpace(req.GetString("description", "")),
			"priority":    req.GetInt("priority", 0),
		}
		if len(custom) > 0 {
			body["custom_patterns"] = custom
		}
		method := "POST"
		if req.GetBool("update", false) {
			method = "PUT"
		}
		return c.do(method, "/grok", nil, body)
	})

	simpleTool(s, mcp.NewTool("delete_grok_pattern",
		mcp.WithDescription("Remove a saved Grok pattern from the library. Already-imported rows are unaffected."),
		mcp.WithString("name", mcp.Required(), mcp.Description("Pattern name")),
		mcp.WithDestructiveHintAnnotation(true),
	), func(req mcp.CallToolRequest) (json.RawMessage, error) {
		name, err := requiredString(req, "name")
		if err != nil {
			return nil, err
		}
		return c.do("DELETE", "/grok", url.Values{"name": {name}}, nil)
	})

	// ============================================================== workspaces

	simpleTool(s, mcp.NewTool("delete_workspace",
		mcp.WithDescription("Delete a saved workspace."),
		mcp.WithString("id", mcp.Required(), mcp.Description("Workspace id")),
		mcp.WithDestructiveHintAnnotation(true),
	), func(req mcp.CallToolRequest) (json.RawMessage, error) {
		id, err := requiredString(req, "id")
		if err != nil {
			return nil, err
		}
		return c.do("DELETE", "/workspaces/"+url.PathEscape(id), nil, nil)
	})

	simpleTool(s, mcp.NewTool("duplicate_workspace",
		mcp.WithDescription("Copy a saved workspace."),
		mcp.WithString("id", mcp.Required(), mcp.Description("Workspace id")),
	), func(req mcp.CallToolRequest) (json.RawMessage, error) {
		id, err := requiredString(req, "id")
		if err != nil {
			return nil, err
		}
		return c.do("POST", "/workspaces/"+url.PathEscape(id)+"/duplicate", nil, nil)
	})

	simpleTool(s, mcp.NewTool("update_workspace",
		mcp.WithDescription("Change fields of a saved workspace (name, description, query, sources, columns, time). Unset fields keep their value. "+
			"To save exactly what the UI shows, read ui_get_state and pass its query/sources/columns."),
		mcp.WithString("id", mcp.Required(), mcp.Description("Workspace id")),
		mcp.WithString("name", mcp.Description("New name")),
		mcp.WithString("description", mcp.Description("New description")),
		mcp.WithString("query", mcp.Description("New Bleve query")),
		mcp.WithString("source", mcp.Description("Comma-separated sources")),
		mcp.WithString("columns", mcp.Description("Comma-separated columns")),
		mcp.WithString("relative_time", mcp.Description("Relative range, e.g. last-7-days")),
		mcp.WithString("start_date", mcp.Description("Absolute start, RFC3339 (with end_date)")),
		mcp.WithString("end_date", mcp.Description("Absolute end, RFC3339 (with start_date)")),
	), func(req mcp.CallToolRequest) (json.RawMessage, error) {
		id, err := requiredString(req, "id")
		if err != nil {
			return nil, err
		}
		data, err := c.get("/workspaces/"+url.PathEscape(id), nil)
		if err != nil {
			return nil, err
		}
		ws, err := extractWorkspace(data)
		if err != nil {
			return nil, err
		}
		args := req.GetArguments()
		for _, key := range []string{"name", "description", "query"} {
			if _, ok := args[key]; ok {
				ws[key] = strings.TrimSpace(req.GetString(key, ""))
			}
		}
		if _, ok := args["source"]; ok {
			ws["sources"] = splitCSV(req.GetString("source", ""))
		}
		if _, ok := args["columns"]; ok {
			ws["columns"] = splitCSV(req.GetString("columns", ""))
		}
		start, end := strings.TrimSpace(req.GetString("start_date", "")), strings.TrimSpace(req.GetString("end_date", ""))
		switch {
		case start != "" || end != "":
			if start == "" || end == "" {
				return nil, fmt.Errorf("both start_date and end_date are required for an absolute range")
			}
			ws["time"] = map[string]any{"mode": "absolute", "start": start, "end": end}
		case strings.TrimSpace(req.GetString("relative_time", "")) != "":
			ws["time"] = map[string]any{"mode": "relative", "relative": strings.TrimSpace(req.GetString("relative_time", ""))}
		}
		out, err := c.do("PUT", "/workspaces/"+url.PathEscape(id), nil, ws)
		if err != nil {
			return nil, err
		}
		return json.RawMessage(withWorkspaceURL(out, c.serverBaseURL())), nil
	})

	// ================================================================= storage

	simpleTool(s, mcp.NewTool("storage_info",
		mcp.WithDescription("Storage overview: index size, rows and bytes per day, and the retention setting."),
		mcp.WithReadOnlyHintAnnotation(true),
	), func(_ mcp.CallToolRequest) (json.RawMessage, error) {
		return c.get("/storage", nil)
	})

	simpleTool(s, mcp.NewTool("set_retention",
		mcp.WithDescription("Set how many days of logs to keep (0-3650; older days are deleted by the retention sweep). clear=true restores the default."),
		mcp.WithNumber("retention_days", mcp.Description("Days to keep")),
		mcp.WithBoolean("clear", mcp.Description("Remove the override")),
		mcp.WithDestructiveHintAnnotation(true),
	), func(req mcp.CallToolRequest) (json.RawMessage, error) {
		if req.GetBool("clear", false) {
			return c.do("PUT", "/storage", nil, map[string]any{"retention_days": nil})
		}
		if _, ok := req.GetArguments()["retention_days"]; !ok {
			return nil, fmt.Errorf("pass retention_days or clear=true")
		}
		return c.do("PUT", "/storage", nil, map[string]any{"retention_days": req.GetInt("retention_days", 0)})
	})

	simpleTool(s, mcp.NewTool("delete_storage_day",
		mcp.WithDescription("Permanently delete every row stored for one day. Requires confirm=true."),
		mcp.WithString("date", mcp.Required(), mcp.Description("Day, YYYY-MM-DD (from storage_info)")),
		mcp.WithBoolean("confirm", mcp.Required(), mcp.Description("Must be true")),
		mcp.WithDestructiveHintAnnotation(true),
	), func(req mcp.CallToolRequest) (json.RawMessage, error) {
		date, err := requiredString(req, "date")
		if err != nil {
			return nil, err
		}
		if !req.GetBool("confirm", false) {
			return nil, fmt.Errorf("delete_storage_day removes all rows of %s permanently; call again with confirm=true if the user agreed", date)
		}
		return c.do("DELETE", "/storage/days/"+url.PathEscape(date), nil, nil)
	})

	simpleTool(s, mcp.NewTool("clear_all_logs",
		mcp.WithDescription("Permanently delete ALL stored logs from every source. Requires confirm=true. Only on an explicit user request."),
		mcp.WithBoolean("confirm", mcp.Required(), mcp.Description("Must be true")),
		mcp.WithDestructiveHintAnnotation(true),
	), func(req mcp.CallToolRequest) (json.RawMessage, error) {
		if !req.GetBool("confirm", false) {
			return nil, fmt.Errorf("clear_all_logs deletes every stored log; call again with confirm=true only if the user explicitly asked")
		}
		return c.do("DELETE", "/logs", nil, nil)
	})
}
