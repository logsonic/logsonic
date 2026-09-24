package handlers

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/types"
)

func TestMixedAutoIngestRetainsBlankThenLearnsLaterFormat(t *testing.T) {
	h, store := setupHandler(t)
	id, err := newIngestSession(types.IngestSessionOptions{Pattern: "auto", Source: "mixed.log"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.endIngestSession(id) })
	first := []string{"", " \t "}
	if _, _, err := h.ingestBatch(id, first); err != nil {
		t.Fatalf("undetectable lines must be retained, not poison session: %v", err)
	}
	second := []string{`127.0.0.1 - alice [24/Sep/2026:10:20:30 +0000] "GET /health HTTP/1.1" 200 42`, "@@@"}
	if _, _, err := h.ingestBatch(id, second); err != nil {
		t.Fatal(err)
	}
	if len(store.logs) != 4 {
		t.Fatalf("stored %d rows, want 4", len(store.logs))
	}
	for i, raw := range append(first, second...) {
		row := store.logs[i]
		if row["_raw"] != raw || row["_src"] != "mixed.log" || row["_seq"] != int64(i+1) {
			t.Fatalf("row %d lost raw/source/order: %#v", i, row)
		}
	}
	if _, failed := store.logs[2]["error"]; failed {
		t.Fatalf("late known format did not recover: %#v", store.logs[2])
	}
	if store.logs[2]["_parse_status"] != "parsed" || store.logs[3]["_parse_status"] != "raw" {
		t.Fatalf("parse provenance missing: %#v", store.logs[2:])
	}
	sessionMapMutex.RLock()
	opts := sessionMap[id].Options
	sessionMapMutex.RUnlock()
	if opts.Pattern != "auto" {
		t.Fatalf("reimport must remain automatic, got %q", opts.Pattern)
	}
}

func TestMixedAutoIngestFlushesFirstPendingMultilineRecord(t *testing.T) {
	h, store := setupHandler(t)
	id, err := newIngestSession(types.IngestSessionOptions{Pattern: "auto", Source: "stack.log", Multiline: &types.MultilineConfig{Enabled: true, Mode: "header", HeaderPattern: `^2026`}})
	if err != nil {
		t.Fatal(err)
	}
	lines := []string{"2026-09-24T10:00:00Z ERROR first", "  unknown continuation"}
	if _, _, err := h.ingestBatch(id, lines); err != nil {
		t.Fatal(err)
	}
	if len(store.logs) != 0 {
		t.Fatal("record should still be pending")
	}
	h.endIngestSession(id)
	if len(store.logs) != 1 || store.logs[0]["_raw"] != strings.Join(lines, " ") || store.logs[0]["_src"] != "stack.log" {
		t.Fatalf("pending record lost: %#v", store.logs)
	}
}

func TestMixedExplicitMissPreservesSourceWithoutMetadata(t *testing.T) {
	h, store := setupHandler(t)
	id, err := newIngestSession(types.IngestSessionOptions{Name: "ONLY_INFO", Pattern: `INFO %{WORD:message}`, Source: "explicit.log"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.endIngestSession(id) })
	n, misses, batchErr := h.ingestBatch(id, []string{"ERROR keep this untouched"})
	if batchErr != nil || n != 0 || misses != 1 {
		t.Fatalf("explicit semantics changed: %d %d %v", n, misses, batchErr)
	}
	if len(store.logs) != 1 || store.logs[0]["_src"] != "explicit.log" || store.logs[0]["_raw"] != "ERROR keep this untouched" {
		t.Fatalf("raw source missing: %#v", store.logs)
	}
}

func TestMixedLiveAutoLearnsAfterRawInitialBatch(t *testing.T) {
	h, store := setupHandler(t)
	source, err := h.Live.newSource(types.IngestSessionOptions{Pattern: "auto", Source: "live-mixed"})
	if err != nil {
		t.Fatal(err)
	}
	defer source.cancel()
	if err := source.processFoldedLines([]string{"@@@"}); err != nil {
		t.Fatal(err)
	}
	line := `127.0.0.1 - alice [24/Sep/2026:10:20:30 +0000] "GET /health HTTP/1.1" 200 42`
	if err := source.processFoldedLines([]string{line}); err != nil {
		t.Fatal(err)
	}
	if len(store.logs) != 2 {
		t.Fatalf("stored %d rows", len(store.logs))
	}
	if _, failed := store.logs[1]["error"]; failed {
		t.Fatalf("live auto did not adapt: %#v", store.logs[1])
	}
	want := time.Date(2026, 9, 24, 10, 20, 30, 0, time.UTC)
	if ts, ok := store.logs[1]["timestamp"].(time.Time); !ok || !ts.Equal(want) {
		t.Fatalf("late real timestamp replaced by synthetic time: %v", store.logs[1]["timestamp"])
	}
}

func TestMixedWatchDetectionKeepsAutomaticRouting(t *testing.T) {
	h, store := setupHandler(t)
	path := filepath.Join(t.TempDir(), "mixed.log")
	raw := "@@@"
	known := `127.0.0.1 - alice [24/Sep/2026:10:20:30 +0000] "GET /health HTTP/1.1" 200 42`
	if err := os.WriteFile(path, []byte(raw+"\n"+known+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	deps := watchDeps{h: h}
	opts, err := deps.Detect(path, 1)
	if err != nil || opts.Pattern != "auto" {
		t.Fatalf("watch froze its first-line guess: %+v %v", opts, err)
	}
	opts.Source = "watch.mixed"
	if _, err := deps.ImportFile(context.Background(), path, opts); err != nil {
		t.Fatal(err)
	}
	if len(store.logs) != 2 || store.logs[0]["_raw"] != raw || store.logs[0]["_src"] != "watch.mixed" || store.logs[1]["_parse_status"] != "parsed" {
		t.Fatalf("watch did not preserve mixed rows: %#v", store.logs)
	}
}
