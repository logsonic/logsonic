package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/types"
)

// O7: importing a bundled sample on empty storage gives a catalog entry
// named sample.apache with origin "sample", searchable rows, and writes no
// sample bytes anywhere under the storage dir except the index itself.
func TestO7_ImportSampleOnEmptyStorage(t *testing.T) {
	srv, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	var list types.SamplesResponse
	if code := do(t, ts, http.MethodGet, "/api/v1/samples", nil, &list); code != 200 || len(list.Samples) == 0 || list.Samples[0].Name != "nginx-access" {
		t.Fatalf("GET /samples: %d %+v", code, list)
	}
	s := list.Samples[0]
	if s.License == "" || s.Lines == 0 || s.Source != "sample.nginx-access" {
		t.Fatalf("sample info: %+v", s)
	}
	var errResp types.ErrorResponse
	if code := do(t, ts, http.MethodPost, "/api/v1/samples/nope/import", nil, &errResp); code != 404 || errResp.Code != "SAMPLE_NOT_FOUND" {
		t.Fatalf("unknown sample: %d %+v", code, errResp)
	}

	var accepted types.IngestFileResponse
	if code := do(t, ts, http.MethodPost, "/api/v1/samples/nginx-access/import", nil, &accepted); code != http.StatusAccepted || accepted.JobID == "" {
		t.Fatalf("import: %d %+v", code, accepted)
	}
	job := pollIngestJob(t, ts, accepted.JobID, 10*time.Second)
	if job.State != "done" || job.RowsStored != int64(s.Lines) || job.RowsFailed != 0 {
		t.Fatalf("job: %+v (want %d rows)", job, s.Lines)
	}
	if n := totalFor(t, ts, "sample.nginx-access"); n != s.Lines {
		t.Fatalf("searchable rows: %d", n)
	}
	var entry types.SourceEntry
	do(t, ts, http.MethodGet, "/api/v1/sources/sample.nginx-access", nil, &entry)
	if entry.Origin.Kind != "sample" || entry.Origin.Path != "" || entry.PatternName != s.PatternName {
		t.Fatalf("catalog entry: %+v", entry)
	}
	// The session ended itself (auto-end): a chunk against it is refused.
	body := map[string]any{"logs": []string{"x"}, "session_id": job.SessionID}
	var ingestResp types.IngestResponse
	do(t, ts, http.MethodPost, "/api/v1/ingest/logs", body, &ingestResp)
	if ingestResp.Processed > 0 {
		t.Fatal("sample session should have ended with the job")
	}
	// No sample bytes outside the index: nothing under storage but the
	// day-indices and the known side files.
	entries, _ := os.ReadDir(srv.config.StoragePath)
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, "logs-") || n == "log2grok" || strings.HasSuffix(n, ".json") || strings.HasSuffix(n, ".dirty") || strings.HasSuffix(n, ".tmp") {
			continue
		}
		t.Fatalf("unexpected file in storage after a sample import: %s", filepath.Join(srv.config.StoragePath, n))
	}
	// Importing again upserts, not duplicates.
	do(t, ts, http.MethodPost, "/api/v1/samples/nginx-access/import", nil, &accepted)
	pollIngestJob(t, ts, accepted.JobID, 10*time.Second)
	if n := totalFor(t, ts, "sample.nginx-access"); n != s.Lines {
		t.Fatalf("second import must upsert: %d rows", n)
	}
}

// POST /ui/focus broadcasts ui_focus on /live/events past the per-source
// subscriber filter, with the route.
func TestUIFocusBroadcast(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	sseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(sseCtx, http.MethodGet, ts.URL+"/api/v1/live/events?source_id=__none__", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	if name, _ := nextSSEEvent(t, reader); name != "hello" {
		t.Fatalf("first event %q", name)
	}
	if code := do(t, ts, http.MethodPost, "/api/v1/ui/focus", types.UIFocusRequest{Route: "#/?q=x"}, nil); code != http.StatusNoContent {
		t.Fatalf("POST /ui/focus: %d", code)
	}
	name, data := nextSSEEvent(t, reader)
	var ev types.UIFocusEvent
	_ = json.Unmarshal([]byte(data), &ev)
	if name != "ui_focus" || ev.Route != "#/?q=x" {
		t.Fatalf("got %s %s", name, data)
	}
}
