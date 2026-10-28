package handlers

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/storage"
)

// agentIncidentStore indexes a baseline of INFO rows from two services and a
// burst of payments ERROR rows at 10:18.
func agentIncidentStore(t *testing.T) (*Services, time.Time) {
	t.Helper()
	store, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	base := time.Now().UTC().Truncate(time.Hour).Add(-2 * time.Hour)
	seq := int64(0)
	add := func(at time.Time, source, level, msg string) {
		seq++
		row := map[string]interface{}{"timestamp": at, "_raw": level + " " + msg, "_src": source, "level": level, "message": msg, "_seq": seq}
		if err := store.Store([]map[string]interface{}{row}, source); err != nil {
			t.Fatal(err)
		}
	}
	for m := 0; m < 10; m++ {
		add(base.Add(time.Duration(m)*time.Minute), "checkout.log", "INFO", "order ok")
		add(base.Add(time.Duration(m)*time.Minute+time.Second), "payments.log", "INFO", "charge ok")
	}
	incident := base.Add(18 * time.Minute)
	for i := 0; i < 6; i++ {
		add(incident.Add(time.Duration(i)*time.Second), "payments.log", "ERROR", "pool exhausted "+strings.Repeat("x", 3000*(i%2)))
	}
	return &Services{storage: store}, incident
}

func asJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestAgentFacetLogsTopValues(t *testing.T) {
	h, _ := agentIncidentStore(t)
	out, err := h.runAgentTool(context.Background(), "facet_logs", map[string]any{"query": "level:ERROR", "fields": []any{"level", "_src"}, "top": float64(3)})
	if err != nil {
		t.Fatal(err)
	}
	got := out.(map[string]any)
	if got["total_count"] != 6 || got["sampled"] != false {
		t.Fatalf("facets: %s", asJSON(t, out))
	}
	fields := got["fields"].([]agentFacetField)
	if len(fields) != 2 {
		t.Fatalf("field filter: %s", asJSON(t, fields))
	}
	for _, f := range fields {
		if len(f.Top) != 1 || f.Top[0].Count != 6 {
			t.Errorf("field %s: %+v", f.Field, f.Top)
		}
	}
}

func TestAgentHistogramFindsPeak(t *testing.T) {
	h, incident := agentIncidentStore(t)
	out, err := h.runAgentTool(context.Background(), "log_histogram", map[string]any{"source": "checkout.log, payments.log", "start_time": incident.Add(-30 * time.Minute).Format(time.RFC3339), "end_time": incident.Add(10 * time.Minute).Format(time.RFC3339)})
	if err != nil {
		t.Fatal(err)
	}
	got := out.(map[string]any)
	if got["total_count"] != 26 {
		t.Fatalf("histogram: %s", asJSON(t, out))
	}
	peak := got["peak"].(agentBucket)
	if peak.Count < 6 || peak.BySource["payments.log"] < 6 {
		t.Fatalf("peak: %+v", peak)
	}
	if buckets := got["buckets"].([]agentBucket); len(buckets) == 0 || buckets[0].Count == 0 || buckets[len(buckets)-1].Count == 0 {
		t.Fatalf("empty edge buckets not trimmed: %s", asJSON(t, buckets))
	}
}

func TestAgentLogContextIsAscendingAndTrimmed(t *testing.T) {
	h, incident := agentIncidentStore(t)
	out, err := h.runAgentTool(context.Background(), "log_context", map[string]any{"timestamp": incident.Format(time.RFC3339), "source": "payments.log", "before_seconds": float64(5), "after_seconds": float64(10)})
	if err != nil {
		t.Fatal(err)
	}
	got := out.(map[string]any)
	logs := got["logs"].([]map[string]interface{})
	if got["total_count"] != 6 || len(logs) != 6 {
		t.Fatalf("context: %s", asJSON(t, out))
	}
	var prev time.Time
	for _, row := range logs {
		ts := row["timestamp"].(time.Time)
		if ts.Before(prev) {
			t.Fatalf("not ascending: %v before %v", ts, prev)
		}
		prev = ts
		if msg := row["message"].(string); len(msg) > agentMaxFieldChars+40 {
			t.Fatalf("long field not trimmed: %d bytes", len(msg))
		}
	}
	if _, err := h.runAgentTool(context.Background(), "log_context", map[string]any{"timestamp": "yesterday"}); err == nil {
		t.Fatal("accepted a non-RFC3339 timestamp")
	}
}

func TestAgentCompareWindowsReportsDeltas(t *testing.T) {
	h, incident := agentIncidentStore(t)
	base := incident.Add(-18 * time.Minute)
	out, err := h.runAgentTool(context.Background(), "compare_windows", map[string]any{
		"baseline_start": base.Format(time.RFC3339), "baseline_end": base.Add(10 * time.Minute).Format(time.RFC3339),
		"incident_start": incident.Add(-time.Minute).Format(time.RFC3339), "incident_end": incident.Add(time.Minute).Format(time.RFC3339),
	})
	if err != nil {
		t.Fatal(err)
	}
	got := out.(map[string]any)
	baseline, inc := got["baseline"].(agentWindowSummary), got["incident"].(agentWindowSummary)
	if baseline.TotalCount != 20 || inc.TotalCount != 6 || inc.ByLevel["ERROR"] != 6 || baseline.BySource["checkout.log"] != 10 {
		t.Fatalf("windows: %s", asJSON(t, out))
	}
	levels := got["level_changes"].([]map[string]any)
	if len(levels) != 2 || levels[0]["key"] != "INFO" || levels[0]["change"] != -20 {
		t.Fatalf("level deltas: %v", levels)
	}
	if _, err := h.runAgentTool(context.Background(), "compare_windows", map[string]any{"baseline_start": base.Format(time.RFC3339)}); err == nil {
		t.Fatal("accepted missing window bounds")
	}
}

func TestAgentToolSchemasAreWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, schema := range agentToolSchemas {
		name := schema["name"].(string)
		if seen[name] {
			t.Errorf("duplicate tool %s", name)
		}
		seen[name] = true
		input := schema["input_schema"].(map[string]any)
		if input["type"] != "object" || input["properties"] == nil {
			t.Errorf("tool %s schema: %v", name, input)
		}
	}
	for _, want := range []string{"facet_logs", "log_histogram", "log_context", "compare_windows"} {
		if !seen[want] {
			t.Errorf("missing tool %s", want)
		}
	}
}

func TestAgentCompareWindowsDoesNotCountSharedBoundaryTwice(t *testing.T) {
	h, incident := agentIncidentStore(t)
	start, split, end := incident.Add(-3*time.Minute), incident, incident.Add(2*time.Minute)
	out, err := h.runAgentTool(context.Background(), "compare_windows", map[string]any{
		"baseline_start": start.Format(time.RFC3339), "baseline_end": split.Format(time.RFC3339),
		"incident_start": split.Format(time.RFC3339), "incident_end": end.Format(time.RFC3339),
	})
	if err != nil {
		t.Fatal(err)
	}
	got := out.(map[string]any)
	baseline, inc := got["baseline"].(agentWindowSummary), got["incident"].(agentWindowSummary)
	whole, err := h.agentTotal(context.Background(), "", nil, start, end.Add(-time.Nanosecond))
	if err != nil {
		t.Fatal(err)
	}
	if baseline.TotalCount+inc.TotalCount != whole || inc.TotalCount == 0 {
		t.Fatalf("baseline %d + incident %d != whole %d", baseline.TotalCount, inc.TotalCount, whole)
	}
	if baseline.End != split.UTC().Format(time.RFC3339) {
		t.Fatalf("baseline end shown as %s", baseline.End)
	}
}
