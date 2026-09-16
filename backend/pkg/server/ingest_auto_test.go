package server

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/types"
)

// pattern "auto" (spec now-12): the session compiles no decoder; the first
// batch — from a chunk upload or a path-import job — detects one from its
// lines and locks it in. O5: the auto result on apache.log yields the same
// field set as the explicit pattern.
func TestIngestAutoDetectsOnFirstBatch(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	src, err := os.ReadFile("../../../sample-logs/apache.log")
	if err != nil {
		t.Skip("sample-logs not available")
	}
	lines := strings.Split(strings.TrimSpace(string(src)), "\n")

	// Path job with auto.
	var started types.IngestResponse
	if code := do(t, ts, http.MethodPost, "/api/v1/ingest/start", map[string]any{"pattern": "auto", "source": "auto.log", "meta": map[string]string{"_src": "auto.log"}}, &started); code != 200 {
		t.Fatalf("start auto: %d", code)
	}
	path := filepath.Join(t.TempDir(), "apache.log")
	_ = os.WriteFile(path, src, 0o644)
	status, accepted := ingestFile(t, ts, started.SessionID, path, false)
	if status != http.StatusAccepted {
		t.Fatalf("ingest/file: %d", status)
	}
	job := pollIngestJob(t, ts, accepted.JobID, 10*time.Second)
	endSession(t, ts, started.SessionID)
	if job.State != "done" || job.RowsStored != int64(len(lines)) {
		t.Fatalf("auto job: %+v", job)
	}
	autoRows := rowsFor(t, ts, "auto.log")
	var entry types.SourceEntry
	do(t, ts, http.MethodGet, "/api/v1/sources/auto.log", nil, &entry)
	if entry.PatternName == "" {
		t.Fatalf("the detected pattern name must be recorded on the source: %+v", entry)
	}

	// O5: the same library pattern requested by name (--pattern NAME).
	var started2 types.IngestResponse
	do(t, ts, http.MethodPost, "/api/v1/ingest/start", map[string]any{
		"name": entry.PatternName, "source": "explicit.log", "meta": map[string]string{"_src": "explicit.log"},
	}, &started2)
	if started2.SessionID == "" {
		t.Fatalf("name-only start with %q failed", entry.PatternName)
	}
	postChunk(t, ts, started2.SessionID, lines)
	endSession(t, ts, started2.SessionID)
	explicitRows := rowsFor(t, ts, "explicit.log")
	if len(autoRows) == 0 || len(explicitRows) != len(autoRows) {
		t.Fatalf("rows: auto %d explicit %d", len(autoRows), len(explicitRows))
	}
	fields := func(r map[string]any) string {
		keys := make([]string, 0, len(r))
		for k := range r {
			if strings.HasPrefix(k, "_") || k == "timestamp" {
				continue
			}
			keys = append(keys, k)
		}
		return strings.Join(sortStrings(keys), ",")
	}
	if fields(autoRows[0]) != fields(explicitRows[0]) {
		t.Fatalf("O5 field set differs: auto %q explicit %q", fields(autoRows[0]), fields(explicitRows[0]))
	}

	// Chunk path with auto, and a sticky failure on undetectable lines.
	var started3 types.IngestResponse
	do(t, ts, http.MethodPost, "/api/v1/ingest/start", map[string]any{"pattern": "auto", "source": "chunk-auto.log", "meta": map[string]string{"_src": "chunk-auto.log"}}, &started3)
	postChunk(t, ts, started3.SessionID, lines[:50])
	endSession(t, ts, started3.SessionID)
	if n := len(rowsFor(t, ts, "chunk-auto.log")); n != 50 {
		t.Fatalf("chunk auto: %d rows", n)
	}
}

func sortStrings(s []string) []string {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
	return s
}
