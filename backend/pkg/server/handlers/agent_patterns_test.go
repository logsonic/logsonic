package handlers

import (
	"context"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/storage"
	"logsonic/pkg/workspaces"
)

func TestMaskMessage(t *testing.T) {
	cases := map[string]string{
		"Accepted publickey for deploy from 10.0.4.17 port 52144 ssh2": "Accepted publickey for deploy from <*> port <*> <*>",
		"charge ch_9f8e7d declined code=DO_NOT_HONOR amount=1299":      "charge <*> declined code=DO_NOT_HONOR amount=<*>",
		"user alice@example.com   logged in":                           "user <*> logged in",
		"GET /admin/export took 42ms":                                  "GET /admin/export took <*>",
		"charge authorized order=ord-bfaebefdda":                       "charge authorized order=ord-<*>",
	}
	for in, want := range cases {
		if got := maskMessage(in); got != want {
			t.Errorf("maskMessage(%q) = %q, want %q", in, got, want)
		}
	}
}

// A single unusual INFO line among thousands of routine ones must surface
// first under sort=rare, with its rare field value, even though facet_logs
// would only show it beyond its top values.
func TestAgentLogPatternsFindsNeedle(t *testing.T) {
	store, err := storage.NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	base := time.Now().UTC().Truncate(time.Hour).Add(-3 * time.Hour)
	rows := []map[string]interface{}{}
	for i := 0; i < 3000; i++ {
		rows = append(rows, map[string]interface{}{"timestamp": base.Add(time.Duration(i) * time.Second), "_raw": "x", "_src": "auth.log", "_seq": int64(i), "level": "INFO", "method": "publickey", "message": "Accepted publickey for deploy from 10.0.0." + string(rune('0'+i%10)) + " port 5" + string(rune('0'+i%10))})
	}
	needle := base.Add(1234 * time.Second)
	rows = append(rows, map[string]interface{}{"timestamp": needle, "_raw": "x", "_src": "auth.log", "_seq": int64(5000), "level": "INFO", "method": "password", "message": "Accepted password for svc-backup from 185.220.101.47 port 40022"})
	if _, err := store.StoreWithIDs(rows, "auth.log"); err != nil {
		t.Fatal(err)
	}
	h := &Services{storage: store}
	out, err := h.runAgentTool(context.Background(), "log_patterns", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	got := out.(map[string]any)
	if got["scanned"] != 3001 || got["truncated"] != false || got["distinct_patterns"] != 2 {
		t.Fatalf("scan summary: %s", asJSON(t, out))
	}
	first := got["patterns"].([]*patternGroup)[0]
	if first.Count != 1 || !strings.Contains(first.Example, "svc-backup") || !first.First.Equal(needle) {
		t.Fatalf("rarest pattern = %s", asJSON(t, first))
	}
	rare := got["rare_values"].([]rareField)
	if len(rare) == 0 || rare[0].Field != "method" || rare[0].Rare[0].Value != "password" || rare[0].Rare[0].Count != 1 {
		t.Fatalf("rare values = %s", asJSON(t, rare))
	}

	capped, err := h.runAgentTool(context.Background(), "log_patterns", map[string]any{"max_rows": float64(1000), "sort": "count"})
	if err != nil {
		t.Fatal(err)
	}
	if c := capped.(map[string]any); c["scanned"] != 1000 || c["truncated"] != true || !strings.Contains(c["note"].(string), "max_rows") {
		t.Fatalf("capped scan: %s", asJSON(t, capped))
	}
}

func TestAgentSaveView(t *testing.T) {
	h, incident := agentIncidentStore(t)
	ws, err := workspaces.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h.Workspaces = ws
	in := map[string]any{"name": "Payments pool exhaustion", "query": "level:ERROR", "source": "payments.log", "start_time": incident.Add(-time.Minute).Format(time.RFC3339), "end_time": incident.Add(time.Minute).Format(time.RFC3339), "columns": []any{"timestamp", "message"}, "highlight_field": "message", "highlight_value": "pool"}
	out, err := h.runAgentTool(context.Background(), "save_view", in)
	if err != nil {
		t.Fatal(err)
	}
	got := out.(map[string]any)
	if got["matching_rows"] != 6 || got["warning"] != nil {
		t.Fatalf("save_view: %s", asJSON(t, out))
	}
	saved, err := ws.Get(got["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if saved.Time.Mode != "absolute" || saved.Query != "level:ERROR" || len(saved.Sources) != 1 || len(saved.ColorRules) != 1 || saved.ColorRules[0].Value != "pool" {
		t.Fatalf("saved workspace = %s", asJSON(t, saved))
	}

	in["query"] = "level:FATAL"
	in["name"] = "Nothing"
	out, err = h.runAgentTool(context.Background(), "save_view", in)
	if err != nil {
		t.Fatal(err)
	}
	if out.(map[string]any)["warning"] == nil {
		t.Fatalf("empty view must warn: %s", asJSON(t, out))
	}
	delete(in, "end_time")
	if _, err := h.runAgentTool(context.Background(), "save_view", in); err == nil {
		t.Fatal("save_view without end_time must fail")
	}
}
