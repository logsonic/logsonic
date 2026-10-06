package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// uiCommandTimeoutMS is how long the server waits for the UI's ack. A
// command that runs a search acks after the search finishes (up to ~4.5s),
// so leave room for that and stay under the 30s HTTP client timeout.
const uiCommandTimeoutMS = 10000

// uiCommand sends one command to the connected web UI via POST /ui/command
// and returns the UI's response (status, warnings, state after the command).
func (c *client) uiCommand(cmdType string, args map[string]any) (json.RawMessage, error) {
	if args == nil {
		args = map[string]any{}
	}
	return c.post("/ui/command", map[string]any{
		"type":       cmdType,
		"args":       args,
		"timeout_ms": uiCommandTimeoutMS,
	})
}

// uiTool registers a tool that sends one UI command; shape builds the
// command's args from the call (nil sends none).
func uiTool(s *server.MCPServer, c *client, tool mcp.Tool, cmdType string, shape func(mcp.CallToolRequest) (map[string]any, error)) {
	s.AddTool(tool, func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args := map[string]any{}
		if shape != nil {
			var err error
			if args, err = shape(req); err != nil {
				return resultErr(err), nil
			}
		}
		data, err := c.uiCommand(cmdType, args)
		if err != nil {
			return resultErr(err), nil
		}
		return resultText(data), nil
	})
}

var runArg = mcp.WithBoolean("run", mcp.Description("Run the search after the change (default true). Pass false to batch several changes, then call ui_run_search."))

func registerUITools(s *server.MCPServer, c *client) {
	// --------------------------------------------------------------- ui_focus
	s.AddTool(mcp.NewTool("ui_focus",
		mcp.WithDescription("Bring the LogSonic app window to the front (macOS app), optionally at a route. "+
			"In browser mode nothing raises a window: give the user ui_url instead so they can open it."),
		mcp.WithString("route", mcp.Description("Optional route: / (logs), /import, /settings/patterns, /settings/storage, /settings/watches")),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		route := strings.TrimSpace(req.GetString("route", ""))
		body := map[string]string{}
		if route != "" {
			if !strings.HasPrefix(route, "#") {
				route = "#" + route
			}
			body["route"] = route
		}
		if _, err := c.post("/ui/focus", body); err != nil {
			return resultErr(err), nil
		}
		return jsonResult(map[string]string{"status": "ok", "ui_url": c.serverBaseURL() + "/"}), nil
	})

	// ----------------------------------------------------------- ui_get_state
	uiTool(s, c, mcp.NewTool("ui_get_state",
		mcp.WithDescription("Read what the user currently sees in the LogSonic web UI: route, query, active filters, free text, sources, time range, "+
			"selected/available columns, sort, page, result_count, the first rows as displayed, and Fields panel state. "+
			"Every ui_* tool returns this same state after its change. Fails with no_ui_connected when no UI is open "+
			"(then use ui_focus, or ask the user to open the server URL)."),
		mcp.WithReadOnlyHintAnnotation(true),
	), "get_state", nil)

	// ----------------------------------------------------------- ui_navigate
	uiTool(s, c, mcp.NewTool("ui_navigate",
		mcp.WithDescription("Switch the UI to a page."),
		mcp.WithString("route", mcp.Required(), mcp.Enum("/", "/import", "/settings/patterns", "/settings/storage", "/settings/watches", "/settings/mcp", "/settings/about"),
			mcp.Description("/ is the log viewer")),
	), "navigate", func(req mcp.CallToolRequest) (map[string]any, error) {
		route, err := requiredString(req, "route")
		return map[string]any{"route": route}, err
	})

	// ----------------------------------------------------------- ui_show_view
	s.AddTool(mcp.NewTool("ui_show_view",
		mcp.WithDescription("Set up the whole log view in one call and run one search: query, time range, sources, filters, columns, sort. "+
			"Only the fields you pass change. The usual way to show the user an analysis result."),
		mcp.WithString("query", mcp.Description("Bleve query (replaces the current one; filters below are added on top)")),
		mcp.WithString("relative_time", mcp.Description("Relative range: last-5-minutes, last-15-minutes, last-30-minutes, last-60-minutes, last-24-hours, last-7-days, last-30-days, last-quarter, year-to-date, last-1-year, last-10-years, all-time")),
		mcp.WithString("start_date", mcp.Description("Absolute start, RFC3339 or Unix ms (with end_date)")),
		mcp.WithString("end_date", mcp.Description("Absolute end, RFC3339 or Unix ms (with start_date)")),
		mcp.WithArray("sources", mcp.WithStringItems(), mcp.Description("Sources to show (empty array = all)")),
		mcp.WithArray("filters", mcp.Description("Field filters: [{\"field\":\"level\",\"value\":\"error\"},{\"field\":\"host\",\"value\":\"db1\",\"exclude\":true}]"),
			mcp.Items(map[string]any{"type": "object", "properties": map[string]any{
				"field": map[string]any{"type": "string"}, "value": map[string]any{"type": "string"}, "exclude": map[string]any{"type": "boolean"},
			}, "required": []string{"field", "value"}})),
		mcp.WithArray("columns", mcp.WithStringItems(), mcp.Description("Columns to show, in order (timestamp is always first)")),
		mcp.WithString("sort_by", mcp.Description("Sort field")),
		mcp.WithString("sort_order", mcp.Enum("asc", "desc"), mcp.Description("Sort order")),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		steps, err := showViewSteps(req)
		if err != nil {
			return resultErr(err), nil
		}
		var last json.RawMessage
		var warnings []string
		for _, step := range steps {
			data, err := c.uiCommand(step.cmd, step.args)
			if err != nil {
				return resultErr(fmt.Errorf("%s: %w", step.cmd, err)), nil
			}
			var resp struct {
				Warnings []string `json:"warnings"`
			}
			if json.Unmarshal(data, &resp) == nil {
				warnings = append(warnings, resp.Warnings...)
			}
			last = data
		}
		var out map[string]any
		if json.Unmarshal(last, &out) != nil {
			return resultText(last), nil
		}
		if len(warnings) > 0 {
			out["warnings"] = warnings
		}
		return jsonResult(out), nil
	})

	// ------------------------------------------------------------ ui_set_query
	uiTool(s, c, mcp.NewTool("ui_set_query",
		mcp.WithDescription("Replace the search bar query (Bleve syntax, same as query_logs) and run it. Empty string clears it."),
		mcp.WithString("query", mcp.Required(), mcp.Description("Bleve query")),
		runArg,
	), "set_query", func(req mcp.CallToolRequest) (map[string]any, error) {
		return argsWithout(req), nil
	})

	// ------------------------------------------------------------- ui_set_time
	uiTool(s, c, mcp.NewTool("ui_set_time",
		mcp.WithDescription("Set the UI time range: a relative preset, or an absolute start/end."),
		mcp.WithString("relative", mcp.Description("last-5-minutes, last-15-minutes, last-30-minutes, last-60-minutes, last-24-hours, last-7-days, last-30-days, last-quarter, year-to-date, last-1-year, last-10-years, all-time")),
		mcp.WithString("start", mcp.Description("Absolute start, RFC3339 or Unix ms")),
		mcp.WithString("end", mcp.Description("Absolute end, RFC3339 or Unix ms")),
		runArg,
	), "set_time", func(req mcp.CallToolRequest) (map[string]any, error) {
		return argsWithout(req), nil
	})

	// ---------------------------------------------------------- ui_set_sources
	uiTool(s, c, mcp.NewTool("ui_set_sources",
		mcp.WithDescription("Choose which sources the UI shows. Empty list shows all."),
		mcp.WithArray("sources", mcp.WithStringItems(), mcp.Description("Source names (list_sources)")),
		runArg,
	), "set_sources", func(req mcp.CallToolRequest) (map[string]any, error) {
		sources, err := stringList(req, "sources")
		if sources == nil {
			sources = []string{}
		}
		args := argsWithout(req)
		args["sources"] = sources
		return args, err
	})

	// ---------------------------------------------------------- ui_set_columns
	s.AddTool(mcp.NewTool("ui_set_columns",
		mcp.WithDescription("Choose the log table's columns. mode=set replaces the visible columns (in this order), "+
			"mode=show adds columns, mode=hide removes them. timestamp is mandatory and always shown first. "+
			"Unknown names come back as warnings; state.columns.available lists the valid ones."),
		mcp.WithArray("columns", mcp.Required(), mcp.WithStringItems(), mcp.Description("Column names")),
		mcp.WithString("mode", mcp.Enum("set", "show", "hide"), mcp.Description("Default set")),
	), func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		columns, err := stringList(req, "columns")
		if err != nil {
			return resultErr(err), nil
		}
		cmd := map[string]string{"set": "set_columns", "show": "show_columns", "hide": "hide_columns"}[req.GetString("mode", "set")]
		if cmd == "" {
			return resultErr(fmt.Errorf("mode must be set, show or hide")), nil
		}
		data, err := c.uiCommand(cmd, map[string]any{"columns": columns})
		if err != nil {
			return resultErr(err), nil
		}
		return resultText(data), nil
	})

	// ------------------------------------------------------ ui_set_column_widths
	uiTool(s, c, mcp.NewTool("ui_set_column_widths",
		mcp.WithDescription("Set column widths in pixels, e.g. {\"message\": 600}."),
		mcp.WithObject("widths", mcp.Required(), mcp.Description("Column -> width in px")),
	), "set_column_widths", func(req mcp.CallToolRequest) (map[string]any, error) {
		return argsWithout(req), nil
	})

	// ----------------------------------------------------------- ui_add_filter
	uiTool(s, c, mcp.NewTool("ui_add_filter",
		mcp.WithDescription("Add a field filter to the UI search, like clicking a value in the Fields panel: adds +field:\"value\" "+
			"(or -field:\"value\" with exclude=true) to the query and runs it. Adding the same filter twice is a no-op; "+
			"adding the opposite polarity flips it."),
		mcp.WithString("field", mcp.Required(), mcp.Description("Field name (letters, digits, _ and .)")),
		mcp.WithString("value", mcp.Required(), mcp.Description("Exact value")),
		mcp.WithBoolean("exclude", mcp.Description("Exclude matching rows instead of requiring them")),
		runArg,
	), "add_filter", func(req mcp.CallToolRequest) (map[string]any, error) {
		return argsWithout(req), nil
	})

	// -------------------------------------------------------- ui_remove_filter
	uiTool(s, c, mcp.NewTool("ui_remove_filter",
		mcp.WithDescription("Remove a field filter from the UI search. With value, removes that field/value (either polarity); without, every filter on the field."),
		mcp.WithString("field", mcp.Required(), mcp.Description("Field name")),
		mcp.WithString("value", mcp.Description("Value to remove (omit for all values of the field)")),
		runArg,
	), "remove_filter", func(req mcp.CallToolRequest) (map[string]any, error) {
		return argsWithout(req), nil
	})

	// -------------------------------------------------------- ui_clear_filters
	uiTool(s, c, mcp.NewTool("ui_clear_filters",
		mcp.WithDescription("Clear the UI search. keep_text=true drops only field filters and keeps the free-text part."),
		mcp.WithBoolean("keep_text", mcp.Description("Keep free text, drop only field filters")),
		runArg,
	), "clear_filters", func(req mcp.CallToolRequest) (map[string]any, error) {
		return argsWithout(req), nil
	})

	// ------------------------------------------------------------- ui_set_sort
	uiTool(s, c, mcp.NewTool("ui_set_sort",
		mcp.WithDescription("Sort the log table by a field."),
		mcp.WithString("field", mcp.Description("Field (default: current)")),
		mcp.WithString("order", mcp.Enum("asc", "desc"), mcp.Description("Order (default: current)")),
	), "set_sort", func(req mcp.CallToolRequest) (map[string]any, error) {
		return argsWithout(req), nil
	})

	// ------------------------------------------------------------- ui_set_page
	uiTool(s, c, mcp.NewTool("ui_set_page",
		mcp.WithDescription("Go to a result page and/or change the page size."),
		mcp.WithNumber("page", mcp.Description("1-based page")),
		mcp.WithNumber("page_size", mcp.Description("Rows per page, 1-10000")),
	), "set_page", func(req mcp.CallToolRequest) (map[string]any, error) {
		return argsWithout(req), nil
	})

	// -------------------------------------------------------- ui_fields_panel
	uiTool(s, c, mcp.NewTool("ui_fields_panel",
		mcp.WithDescription("Open or close the Fields panel (top values per field for the current search)."),
		mcp.WithBoolean("open", mcp.Required(), mcp.Description("true to open")),
	), "set_fields_panel", func(req mcp.CallToolRequest) (map[string]any, error) {
		return map[string]any{"open": req.GetBool("open", true)}, nil
	})

	// ------------------------------------------------------------- ui_sidebar
	uiTool(s, c, mcp.NewTool("ui_sidebar",
		mcp.WithDescription("Open or close a log-view sidebar panel: filter (source checkboxes), fields (top values per field), "+
			"sources (source list and import history), styling (color rules). Opening one replaces the open one. "+
			"state.sidebar reports what is shown."),
		mcp.WithString("panel", mcp.Required(), mcp.Enum("filter", "fields", "sources", "styling"), mcp.Description("Panel")),
		mcp.WithBoolean("open", mcp.Required(), mcp.Description("true to open, false to close")),
	), "set_sidebar", func(req mcp.CallToolRequest) (map[string]any, error) {
		panel, err := requiredString(req, "panel")
		return map[string]any{"panel": panel, "open": req.GetBool("open", true)}, err
	})

	// -------------------------------------------------------- ui_open_workspace
	uiTool(s, c, mcp.NewTool("ui_open_workspace",
		mcp.WithDescription("Load a saved workspace into the UI (query, time, sources, columns, color rules) and run it."),
		mcp.WithString("id", mcp.Required(), mcp.Description("Workspace id (list_workspaces)")),
	), "open_workspace", func(req mcp.CallToolRequest) (map[string]any, error) {
		id, err := requiredString(req, "id")
		return map[string]any{"id": id}, err
	})

	// ----------------------------------------------------------- ui_run_search
	uiTool(s, c, mcp.NewTool("ui_run_search",
		mcp.WithDescription("Run the UI's current search (after changes made with run=false)."),
	), "run_search", nil)
}

type uiStep struct {
	cmd  string
	args map[string]any
}

// showViewSteps turns ui_show_view's arguments into UI commands that each
// skip the search (run:false), then one run_search, then the columns.
func showViewSteps(req mcp.CallToolRequest) ([]uiStep, error) {
	args := req.GetArguments()
	noRun := func(m map[string]any) map[string]any {
		m["run"] = false
		return m
	}
	var steps []uiStep
	if q, ok := args["query"]; ok {
		steps = append(steps, uiStep{"set_query", noRun(map[string]any{"query": fmt.Sprint(q)})})
	}
	rel := strings.TrimSpace(req.GetString("relative_time", ""))
	start, end := strings.TrimSpace(req.GetString("start_date", "")), strings.TrimSpace(req.GetString("end_date", ""))
	switch {
	case start != "" || end != "":
		if start == "" || end == "" {
			return nil, fmt.Errorf("pass both start_date and end_date")
		}
		steps = append(steps, uiStep{"set_time", noRun(map[string]any{"start": start, "end": end})})
	case rel != "":
		steps = append(steps, uiStep{"set_time", noRun(map[string]any{"relative": rel})})
	}
	if _, ok := args["sources"]; ok {
		sources, err := stringList(req, "sources")
		if err != nil {
			return nil, err
		}
		if sources == nil {
			sources = []string{}
		}
		steps = append(steps, uiStep{"set_sources", noRun(map[string]any{"sources": sources})})
	}
	if raw, ok := args["filters"]; ok {
		filters, err := parseFilters(raw)
		if err != nil {
			return nil, err
		}
		for _, f := range filters {
			f["run"] = false
			steps = append(steps, uiStep{"add_filter", f})
		}
	}
	if by, order := strings.TrimSpace(req.GetString("sort_by", "")), strings.TrimSpace(req.GetString("sort_order", "")); by != "" || order != "" {
		sort := map[string]any{}
		if by != "" {
			sort["field"] = by
		}
		if order != "" {
			sort["order"] = order
		}
		steps = append(steps, uiStep{"set_sort", sort})
	}
	steps = append(steps, uiStep{"run_search", map[string]any{}})
	// Columns last: once the search has run, the UI knows which columns
	// exist and warns about unknown names.
	if _, ok := args["columns"]; ok {
		columns, err := stringList(req, "columns")
		if err != nil {
			return nil, err
		}
		steps = append(steps, uiStep{"set_columns", map[string]any{"columns": columns}})
	}
	return steps, nil
}

func parseFilters(raw any) ([]map[string]any, error) {
	if s, ok := raw.(string); ok {
		if strings.TrimSpace(s) == "" {
			return nil, nil
		}
		var v []any
		if err := json.Unmarshal([]byte(s), &v); err != nil {
			return nil, fmt.Errorf("filters: invalid JSON array: %w", err)
		}
		raw = v
	}
	list, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("filters must be an array of {field, value, exclude?}")
	}
	out := make([]map[string]any, 0, len(list))
	for i, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("filters[%d] must be an object", i)
		}
		field, _ := m["field"].(string)
		if strings.TrimSpace(field) == "" || m["value"] == nil {
			return nil, fmt.Errorf("filters[%d] needs field and value", i)
		}
		f := map[string]any{"field": field, "value": fmt.Sprint(m["value"])}
		if ex, ok := m["exclude"].(bool); ok {
			f["exclude"] = ex
		}
		out = append(out, f)
	}
	return out, nil
}
