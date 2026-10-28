package handlers

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"
	"logsonic/pkg/storage"
	"logsonic/pkg/types"
)

func TestAutomaticJSONIngestPreservesTimestampAndStringFields(t *testing.T) {
	dir := t.TempDir()
	store, err := storage.NewStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := l2g.LoadConfig(filepath.Join(dir, "log2grok"), os.Stderr); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(store, dir)
	id, startErr := newIngestSession(types.IngestSessionOptions{Name: "AUTO", Pattern: "auto", Source: "demo.jsonl", Meta: map[string]interface{}{"_src": "demo.jsonl"}})
	if startErr != nil {
		t.Fatal(startErr)
	}
	defer h.endIngestSession(id)
	if _, _, err := h.ingestBatch(id, []string{`{"timestamp":"2026-10-28T10:18:00Z","level":"ERROR","service":"payments","message":"pool exhausted"}`}); err != nil {
		t.Fatal(err)
	}
	result, err := h.agentQuery(context.Background(), map[string]any{"query": "pool", "start_time": "2026-10-28T10:17:00Z", "end_time": "2026-10-28T10:19:00Z"}, false)
	if err != nil {
		t.Fatal(err)
	}
	logs := result.(map[string]any)["logs"].([]map[string]interface{})
	if len(logs) != 1 {
		t.Fatalf("matching rows: %v", result)
	}
	if logs[0]["level"] != "ERROR" || logs[0]["service"] != "payments" {
		t.Fatalf("string fields: %v", logs[0])
	}
	ts, ok := logs[0]["timestamp"].(time.Time)
	if !ok || !ts.Equal(time.Date(2026, 10, 28, 10, 18, 0, 0, time.UTC)) {
		t.Fatalf("timestamp: %v", logs[0]["timestamp"])
	}
}
