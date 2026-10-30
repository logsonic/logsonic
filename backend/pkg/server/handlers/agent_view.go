package handlers

import (
	"context"
	"strconv"
	"strings"
	"time"

	"logsonic/pkg/types"
)

// Tools that search a window of rows. When the model passes no window,
// they default to the span of the data instead of the last year, because
// imported logs are often years old.
var agentWindowTools = map[string]bool{
	"query_logs": true, "analyze_logs": true, "facet_logs": true,
	"log_histogram": true, "log_patterns": true,
}

// agentDataSpan is the first and last timestamp of the named sources (all
// sources when none are named), from the catalog. The end is one second
// past the last row, so a window ending there includes it.
func (h *Services) agentDataSpan(sources []string) (time.Time, time.Time, bool) {
	if h.Catalog == nil {
		return time.Time{}, time.Time{}, false
	}
	want := map[string]bool{}
	for _, s := range h.Catalog.ResolveSources(sources) {
		want[s] = true
	}
	var first, last time.Time
	for _, e := range h.Catalog.List() {
		if len(want) > 0 && !want[e.Name] {
			continue
		}
		if e.FirstTS != nil && (first.IsZero() || e.FirstTS.Before(first)) {
			first = *e.FirstTS
		}
		if e.LastTS != nil && e.LastTS.After(last) {
			last = *e.LastTS
		}
	}
	if first.IsZero() || last.IsZero() {
		return time.Time{}, time.Time{}, false
	}
	return first.UTC(), last.UTC().Add(time.Second), true
}

// agentFillWindow returns the tool input with start_time and end_time set
// to the data span when the model gave neither. The input is copied: the
// original is what the model sent and is replayed to it unchanged.
func (h *Services) agentFillWindow(name string, in map[string]any) map[string]any {
	if !agentWindowTools[name] || toolString(in, "start_time") != "" || toolString(in, "end_time") != "" {
		return in
	}
	start, end, ok := h.agentDataSpan(agentSources(in))
	if !ok {
		return in
	}
	out := make(map[string]any, len(in)+2)
	for k, v := range in {
		out[k] = v
	}
	out["start_time"] = start.Format(time.RFC3339)
	out["end_time"] = end.Format(time.RFC3339)
	return out
}

// agentAutoViewID prefixes the step id of the view applied after a turn. The
// suffix keeps it unique across turns, since the dock marks one step id as
// the one shown in the table.
const agentAutoViewID = "view-auto-"

// agentFinalView decides what the log view should show after a turn, so the
// user sees the evidence the answer is about whether or not the model
// called ui_show_view. It returns the ui_show_view arguments to apply, or
// nil when the model's own view already covers it or no data was read.
//
// Sources come from imports and the source arguments of data tools; the
// time window is the union of the windows those tools searched. A field the
// model set itself with a view tool is kept, except a time range that left
// the table empty while there is evidence to show.
func (h *Services) agentFinalView(steps []agentStep) map[string]any {
	var sources []string
	seen := map[string]bool{}
	addSource := func(s string) {
		if s = strings.TrimSpace(s); s != "" && !seen[s] {
			seen[s] = true
			sources = append(sources, s)
		}
	}
	allSources := false
	var start, end time.Time
	addWindow := func(s, e time.Time) {
		if start.IsZero() || s.Before(start) {
			start = s
		}
		if e.After(end) {
			end = e
		}
	}
	dataRead := false
	modelSetSources, modelSetTime, modelSetQuery := false, false, false
	emptyView := false
	lastQuery, haveQuery := "", false

	for _, step := range steps {
		if step.IsError {
			continue
		}
		switch {
		case strings.HasPrefix(step.Tool, "ingest_"):
			dataRead = true
			if out, ok := step.Output.(map[string]any); ok {
				if imports, ok := out["imports"].([]any); ok {
					for _, item := range imports {
						if m, ok := item.(map[string]any); ok {
							addSource(toolString(m, "source"))
						}
					}
				}
				addSource(toolString(out, "source"))
			}
		case agentWindowTools[step.Tool] || step.Tool == "compare_windows" || step.Tool == "log_context":
			dataRead = true
			names := agentSources(step.Input)
			if len(names) == 0 {
				allSources = true
			}
			for _, s := range names {
				addSource(s)
			}
			for _, keys := range [][2]string{{"start_time", "end_time"}, {"baseline_start", "baseline_end"}, {"incident_start", "incident_end"}} {
				if toolString(step.Input, keys[0]) == "" || toolString(step.Input, keys[1]) == "" {
					continue
				}
				if s, e, err := agentTimeRange(step.Input, keys[0], keys[1]); err == nil {
					addWindow(s, e)
				}
			}
			if step.Tool == "log_context" {
				if t, err := time.Parse(time.RFC3339Nano, toolString(step.Input, "timestamp")); err == nil {
					addWindow(t.Add(-15*time.Minute), t.Add(15*time.Minute))
				}
			}
			// Only a query that found rows is worth showing: a last probe
			// that matched nothing would leave the table empty again.
			if step.Tool == "query_logs" && agentCount(step.Output, "total_count") > 0 {
				lastQuery, haveQuery = toolString(step.Input, "query"), true
			}
		case step.Tool == "ui_show_view":
			if _, ok := step.Input["sources"]; ok {
				modelSetSources = true
			}
			if toolString(step.Input, "relative_time") != "" || toolString(step.Input, "start_date") != "" {
				modelSetTime = true
			}
			if _, ok := step.Input["query"]; ok {
				modelSetQuery = true
			}
			emptyView = agentViewEmpty(step.Output)
		case step.Tool == "ui_set_sources":
			modelSetSources = true
			emptyView = agentViewEmpty(step.Output)
		case step.Tool == "ui_set_time":
			modelSetTime = true
			emptyView = agentViewEmpty(step.Output)
		case step.Tool == "ui_set_query" || step.Tool == "ui_add_filter" || step.Tool == "ui_clear_filters" || step.Tool == "ui_remove_filter":
			modelSetQuery = true
			emptyView = agentViewEmpty(step.Output)
		}
	}
	if !dataRead {
		return nil
	}
	// Tools given no source searched everything, so the view does too.
	if allSources {
		sources = nil
	}
	if start.IsZero() {
		var ok bool
		if start, end, ok = h.agentDataSpan(sources); !ok {
			start, end = time.Time{}, time.Time{}
		}
	}
	args := map[string]any{}
	if !modelSetSources {
		if sources == nil {
			args["sources"] = []any{}
		} else {
			list := make([]any, 0, len(sources))
			for _, s := range h.agentResolveSources(sources) {
				list = append(list, s)
			}
			args["sources"] = list
		}
	}
	if !start.IsZero() && (!modelSetTime || emptyView) {
		args["start_date"] = start.UTC().Format(time.RFC3339)
		args["end_date"] = end.UTC().Format(time.RFC3339)
	}
	if !modelSetQuery && haveQuery {
		args["query"] = lastQuery
	}
	if len(args) == 0 {
		return nil
	}
	return args
}

func (h *Services) agentResolveSources(names []string) []string {
	if h.Catalog == nil {
		return names
	}
	return h.Catalog.ResolveSources(names)
}

// agentViewEmpty reports whether a UI tool result says the table shows no
// rows after its search. UI commands answer {id, status, state: {...}}.
func agentViewEmpty(output any) bool {
	m, ok := output.(map[string]any)
	if !ok {
		return false
	}
	if state, ok := m["state"].(map[string]any); ok {
		m = state
	}
	return agentCount(m, "result_count") == 0
}

// agentCount reads a numeric field of a tool output; -1 when absent.
func agentCount(output any, key string) int64 {
	m, ok := output.(map[string]any)
	if !ok {
		return -1
	}
	switch n := m[key].(type) {
	case float64:
		return int64(n)
	case int:
		return int64(n)
	case int64:
		return n
	case uint64:
		return int64(n)
	}
	return -1
}

// applyAgentFinalView shows the turn's evidence in the log view (see
// agentFinalView) and records it as a step. A missing UI or a failed command
// never fails the turn.
func (h *Services) applyAgentFinalView(ctx context.Context, steps []agentStep, events agentEvents) []agentStep {
	// No LogSonic window is open (an API caller): nothing to show.
	if h.AgentUITools == nil || h.Live == nil || h.Live.countSubscribers(types.UIBridgeSourceFilter) == 0 {
		return steps
	}
	args := h.agentFinalView(steps)
	if args == nil {
		return steps
	}
	output, err := h.AgentUITools.Call(ctx, "ui_show_view", args)
	if err != nil && strings.Contains(err.Error(), "no_ui_connected") {
		// An API caller with no LogSonic window open: nothing to show.
		return steps
	}
	step := agentStep{ID: agentAutoViewID + strconv.FormatInt(time.Now().UnixNano(), 36), Tool: "ui_show_view", Input: args, Output: output}
	if err != nil {
		step.Output, step.IsError = map[string]any{"error": err.Error()}, true
	}
	events.StepStart(step.ID, step.Tool, step.Input)
	events.Step(step)
	return append(steps, step)
}
