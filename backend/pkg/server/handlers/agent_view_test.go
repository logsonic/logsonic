package handlers

import "testing"

func TestAgentFinalViewKeepsModelChoicesUnlessTableIsEmpty(t *testing.T) {
	h := &Services{}
	query := agentStep{Tool: "query_logs", Input: map[string]any{"query": "level:error", "source": "api.log", "start_time": "2005-06-03T00:00:00Z", "end_time": "2005-06-05T00:00:00Z"}, Output: map[string]any{"total_count": 7}}

	// No view tool: show the evidence sources, window and query.
	got := h.agentFinalView([]agentStep{query})
	if got["query"] != "level:error" || got["start_date"] != "2005-06-03T00:00:00Z" || got["end_date"] != "2005-06-05T00:00:00Z" {
		t.Fatalf("no view: %v", got)
	}
	if s, _ := got["sources"].([]any); len(s) != 1 || s[0] != "api.log" {
		t.Fatalf("sources: %v", got["sources"])
	}

	// The model's view had rows: nothing to change.
	shown := agentStep{Tool: "ui_show_view", Input: map[string]any{"query": "x", "sources": []any{"api.log"}, "relative_time": "last-24-hours"}, Output: map[string]any{"result_count": float64(12)}}
	if got := h.agentFinalView([]agentStep{query, shown}); got != nil {
		t.Fatalf("overrode a working view: %v", got)
	}

	// The model's relative range left the table empty: fix only the time.
	shown.Output = map[string]any{"id": "x", "state": map[string]any{"result_count": float64(0)}}
	got = h.agentFinalView([]agentStep{query, shown})
	if got["start_date"] != "2005-06-03T00:00:00Z" || got["sources"] != nil || got["query"] != nil {
		t.Fatalf("empty view: %v", got)
	}

	// A failed tool and chat-only turns leave the view alone.
	if got := h.agentFinalView([]agentStep{{Tool: "query_logs", Input: query.Input, IsError: true}}); got != nil {
		t.Fatalf("failed step: %v", got)
	}
	if got := h.agentFinalView(nil); got != nil {
		t.Fatalf("no steps: %v", got)
	}

	// A tool given no source searched every source, so the view shows all.
	all := agentStep{Tool: "log_histogram", Input: map[string]any{"start_time": "2005-06-03T00:00:00Z", "end_time": "2005-06-04T00:00:00Z"}}
	got = h.agentFinalView([]agentStep{query, all})
	if s, ok := got["sources"].([]any); !ok || len(s) != 0 {
		t.Fatalf("all sources: %v", got["sources"])
	}

	// A last probe that matched nothing does not become the view's query.
	probe := agentStep{Tool: "query_logs", Input: map[string]any{"query": "nothing-here", "source": "api.log", "start_time": "2005-06-03T00:00:00Z", "end_time": "2005-06-05T00:00:00Z"}, Output: map[string]any{"total_count": 0}}
	if got := h.agentFinalView([]agentStep{query, probe}); got["query"] != "level:error" {
		t.Fatalf("query after empty probe: %v", got["query"])
	}
	if got := h.agentFinalView([]agentStep{probe}); got["query"] != nil {
		t.Fatalf("empty probe became the query: %v", got["query"])
	}
}
