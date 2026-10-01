package handlers

import (
	"sync/atomic"
	"testing"
	"time"

	"logsonic/pkg/timeresolve"
	"logsonic/pkg/types"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"
)

func TestAutoTimestampRollsYearlessRowAcrossBatches(t *testing.T) {
	first := []l2g.LineResult{{Raw: "full-year", Matched: true, Fields: map[string]string{"timestamp": "2025-12-31T23:59:59Z"}}}
	second := []l2g.LineResult{{Raw: "yearless", Matched: true, Fields: map[string]string{"timestamp": "Jan 1 00:00:01"}}}
	opts := types.IngestSessionOptions{Pattern: "auto", Source: "mixed.log"}
	resolution, inference := buildResolution(first, opts)
	if resolution.Rollover {
		t.Fatal("fixture must model the frozen full-year resolution")
	}
	resolver := timeresolve.New(resolution)
	seq := new(atomic.Int64)
	firstRows, _, _ := postProcessWithResolver(first, opts, resolver, seq, inference.Status == timeresolve.StatusMissing, resolution.Anchor.Value)
	secondRows, _, _ := postProcessWithResolver(second, opts, resolver, seq, false, resolution.Anchor.Value)
	if want := time.Date(2025, 12, 31, 23, 59, 59, 0, time.UTC); !firstRows[0]["timestamp"].(time.Time).Equal(want) {
		t.Fatalf("first timestamp = %s, want %s", firstRows[0]["timestamp"], want)
	}
	if want := time.Date(2026, 1, 1, 0, 0, 1, 0, time.UTC); !secondRows[0]["timestamp"].(time.Time).Equal(want) {
		t.Fatalf("yearless timestamp = %s, want %s", secondRows[0]["timestamp"], want)
	}
}

func TestAutomaticTimestampStateRetainsYearAcrossChunks(t *testing.T) {
	state := newAutomaticTimestampState()
	seq := new(atomic.Int64)
	opts := types.IngestSessionOptions{Pattern: "auto", Source: "mixed.log"}
	first := []l2g.LineResult{{Raw: "2025-12-31T23:59:59Z", Matched: true, Fields: map[string]string{"timestamp": "2025-12-31T23:59:59Z"}}}
	second := []l2g.LineResult{{Raw: "Jan 1 00:00:01", Matched: true, Fields: map[string]string{"timestamp": "Jan 1 00:00:01"}}}
	firstRows, _, _ := state.process(first, opts, seq)
	secondRows, _, _ := state.process(second, opts, seq)
	if got, want := firstRows[0]["timestamp"].(time.Time), time.Date(2025, 12, 31, 23, 59, 59, 0, time.UTC); !got.Equal(want) {
		t.Fatalf("first chunk timestamp = %s, want %s", got, want)
	}
	if got, want := secondRows[0]["timestamp"].(time.Time), time.Date(2026, 1, 1, 0, 0, 1, 0, time.UTC); !got.Equal(want) {
		t.Fatalf("second chunk timestamp = %s, want %s", got, want)
	}
}

func TestAutomaticTimestampStateLeavesSyntheticModeWhenTimeArrives(t *testing.T) {
	state := newAutomaticTimestampState()
	seq := new(atomic.Int64)
	opts := types.IngestSessionOptions{Pattern: "auto", Source: "mixed.log"}
	firstRows, _, _ := state.process([]l2g.LineResult{{Raw: "raw", Error: "no match"}}, opts, seq)
	secondRows, _, _ := state.process([]l2g.LineResult{{Raw: "known", Matched: true, Fields: map[string]string{"timestamp": "2025-12-31T23:59:59Z"}}}, opts, seq)
	if got, want := secondRows[0]["timestamp"].(time.Time), time.Date(2025, 12, 31, 23, 59, 59, 0, time.UTC); !got.Equal(want) {
		t.Fatalf("timestamp after raw-only chunk = %s, want %s (first raw was %s)", got, want, firstRows[0]["timestamp"])
	}
}

func TestAutoTimestampRollsMixedBatchButRespectsExplicitResolution(t *testing.T) {
	results := []l2g.LineResult{
		{Raw: "full-year", Matched: true, Fields: map[string]string{"timestamp": "2025-12-31T23:59:59Z"}},
		{Raw: "yearless", Matched: true, Fields: map[string]string{"timestamp": "Jan 1 00:00:01"}},
	}
	auto := types.IngestSessionOptions{Pattern: "auto", Source: "mixed.log"}
	rows, _, _, inference := postProcess(results, auto, nil)
	if want := time.Date(2026, 1, 1, 0, 0, 1, 0, time.UTC); !rows[1]["timestamp"].(time.Time).Equal(want) {
		t.Fatalf("mixed batch yearless timestamp = %s, want %s", rows[1]["timestamp"], want)
	}
	if got, want := inference.Preview[1].Resolved, "2026-01-01T00:00:01.000Z"; got != want {
		t.Fatalf("mixed batch preview timestamp = %s, want %s", got, want)
	}

	resolution := timeresolve.Resolution{Rollover: false}
	auto.TimestampConfig = &resolution
	rows, _, _, _ = postProcess(results, auto, nil)
	if want := time.Date(2025, 1, 1, 0, 0, 1, 0, time.UTC); !rows[1]["timestamp"].(time.Time).Equal(want) {
		t.Fatalf("explicit no-rollover timestamp = %s, want %s", rows[1]["timestamp"], want)
	}
}

func TestPostProcessPreservesRawAgainstMetadataOnMatchesAndMisses(t *testing.T) {
	results := []l2g.LineResult{
		{Raw: "original matched\x00", Matched: true, Fields: map[string]string{"timestamp": "2025-12-31T23:59:59Z", "message": "parsed"}},
		{Raw: "original raw\xff", Error: "no match"},
	}
	opts := types.IngestSessionOptions{Pattern: "auto", Source: "mixed.log", Meta: map[string]interface{}{"_raw": "spoofed"}}
	rows, _, _, _ := postProcess(results, opts, nil)
	for i, result := range results {
		if rows[i]["_raw"] != result.Raw {
			t.Fatalf("row %d raw = %q, want %q", i, rows[i]["_raw"], result.Raw)
		}
	}
}
