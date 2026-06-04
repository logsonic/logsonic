package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/blevesearch/bleve/v2"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func setupTestStorage(t *testing.T) (*Storage, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "test-storage")
	store, err := NewStorage(dir)
	if err != nil {
		t.Fatalf("NewStorage failed: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	return store, dir
}

func makeLogs(timestamps []time.Time, source string) []map[string]interface{} {
	logs := make([]map[string]interface{}, len(timestamps))
	for i, ts := range timestamps {
		logs[i] = map[string]interface{}{
			"timestamp": ts,
			"_raw":      "test log line " + ts.String(),
			"_src":      source,
			"message":   "test message",
		}
	}
	return logs
}

// ---------------------------------------------------------------------------
// NewStorage
// ---------------------------------------------------------------------------

func TestNewStorage_CreatesDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "new-dir", "storage")
	_, err := NewStorage(dir)
	if err != nil {
		t.Fatalf("NewStorage failed: %v", err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("storage directory not created: %v", err)
	}
	if !info.IsDir() {
		t.Error("expected directory, got file")
	}
}

func TestNewStorage_EmptyIndices(t *testing.T) {
	store, _ := setupTestStorage(t)
	dates, err := store.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(dates) != 0 {
		t.Errorf("expected 0 dates, got %d", len(dates))
	}
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

func TestStore_SingleDay(t *testing.T) {
	store, _ := setupTestStorage(t)

	ts := time.Date(2024, 1, 15, 10, 30, 0, 0, time.UTC)
	logs := makeLogs([]time.Time{ts, ts.Add(time.Hour)}, "test.log")

	err := store.Store(logs, "test.log")
	if err != nil {
		t.Fatalf("Store failed: %v", err)
	}

	// Verify index was created
	dates, _ := store.List()
	if len(dates) != 1 {
		t.Errorf("expected 1 date index, got %d", len(dates))
	}
	if dates[0] != "2024-01-15" {
		t.Errorf("expected date 2024-01-15, got %s", dates[0])
	}

	// Verify doc count
	count, err := store.GetDocCount("2024-01-15")
	if err != nil {
		t.Fatalf("GetDocCount failed: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 docs, got %d", count)
	}
}

func TestStore_MultipleDays(t *testing.T) {
	store, _ := setupTestStorage(t)

	day1 := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	day2 := time.Date(2024, 1, 16, 10, 0, 0, 0, time.UTC)
	day3 := time.Date(2024, 1, 17, 10, 0, 0, 0, time.UTC)

	logs := makeLogs([]time.Time{day1, day2, day3}, "multi.log")
	err := store.Store(logs, "multi.log")
	if err != nil {
		t.Fatalf("Store failed: %v", err)
	}

	dates, _ := store.List()
	if len(dates) != 3 {
		t.Errorf("expected 3 date indices, got %d", len(dates))
	}
}

func TestStore_EmptyLogs(t *testing.T) {
	store, _ := setupTestStorage(t)

	err := store.Store([]map[string]interface{}{}, "empty.log")
	if err != nil {
		t.Fatalf("Store with empty logs should not fail: %v", err)
	}

	dates, _ := store.List()
	if len(dates) != 0 {
		t.Errorf("expected 0 date indices for empty store, got %d", len(dates))
	}
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

func TestClear(t *testing.T) {
	store, dir := setupTestStorage(t)

	// Store some data
	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	_ = store.Store(makeLogs([]time.Time{ts}, "test.log"), "test.log")

	// Verify data exists
	dates, _ := store.List()
	if len(dates) != 1 {
		t.Fatalf("expected 1 date before clear, got %d", len(dates))
	}

	// Clear
	err := store.Clear()
	if err != nil {
		t.Fatalf("Clear failed: %v", err)
	}

	// Verify indices are empty
	dates, _ = store.List()
	if len(dates) != 0 {
		t.Errorf("expected 0 dates after clear, got %d", len(dates))
	}

	// Verify .bleve directories are removed
	matches, _ := filepath.Glob(filepath.Join(dir, "logs-*.bleve"))
	if len(matches) != 0 {
		t.Errorf("expected 0 .bleve dirs after clear, got %d", len(matches))
	}
}

// ---------------------------------------------------------------------------
// PruneOlderThan
// ---------------------------------------------------------------------------

func TestPruneOlderThan(t *testing.T) {
	store, dir := setupTestStorage(t)

	now := time.Now().UTC()
	old := now.AddDate(0, 0, -40) // 40 days ago
	recent := now.AddDate(0, 0, -5)

	if err := store.Store(makeLogs([]time.Time{old}, "old.log"), "old.log"); err != nil {
		t.Fatalf("store old: %v", err)
	}
	if err := store.Store(makeLogs([]time.Time{recent}, "recent.log"), "recent.log"); err != nil {
		t.Fatalf("store recent: %v", err)
	}

	// Prune everything older than 30 days — only the 40-day-old index should go.
	removed, err := store.PruneOlderThan(30 * 24 * time.Hour)
	if err != nil {
		t.Fatalf("PruneOlderThan failed: %v", err)
	}
	if removed != 1 {
		t.Fatalf("expected 1 index removed, got %d", removed)
	}

	dates, _ := store.List()
	if len(dates) != 1 || dates[0] != recent.Format("2006-01-02") {
		t.Errorf("expected only the recent date to remain, got %v", dates)
	}

	// The pruned index's directory must be gone from disk and from the map.
	oldPath := filepath.Join(dir, "logs-"+old.Format("2006-01-02")+".bleve")
	if _, statErr := os.Stat(oldPath); !os.IsNotExist(statErr) {
		t.Errorf("expected %s to be removed from disk", oldPath)
	}
	if _, ok := store.indices[old.Format("2006-01-02")]; ok {
		t.Errorf("expected old index removed from open-indices map")
	}
}

func TestPruneOlderThan_Disabled(t *testing.T) {
	store, _ := setupTestStorage(t)

	ts := time.Now().UTC().AddDate(0, 0, -100) // very old
	_ = store.Store(makeLogs([]time.Time{ts}, "old.log"), "old.log")

	// A non-positive maxAge means retention is disabled — nothing is removed.
	removed, err := store.PruneOlderThan(0)
	if err != nil {
		t.Fatalf("PruneOlderThan(0) failed: %v", err)
	}
	if removed != 0 {
		t.Errorf("expected 0 removed when disabled, got %d", removed)
	}
	if dates, _ := store.List(); len(dates) != 1 {
		t.Errorf("expected index retained when disabled, got %d dates", len(dates))
	}
}

// ---------------------------------------------------------------------------
// BaseDir
// ---------------------------------------------------------------------------

func TestBaseDir(t *testing.T) {
	store, dir := setupTestStorage(t)
	if store.BaseDir() != dir {
		t.Errorf("expected BaseDir=%s, got %s", dir, store.BaseDir())
	}
}

// ---------------------------------------------------------------------------
// GetDocCount
// ---------------------------------------------------------------------------

func TestGetDocCount_NonexistentDate(t *testing.T) {
	store, _ := setupTestStorage(t)

	// Getting doc count for a date that doesn't exist should create the index
	count, err := store.GetDocCount("2099-12-31")
	if err != nil {
		t.Fatalf("GetDocCount failed: %v", err)
	}
	if count != 0 {
		t.Errorf("expected 0 docs for new index, got %d", count)
	}
}

// ---------------------------------------------------------------------------
// Search (basic integration)
// ---------------------------------------------------------------------------

func TestSearch_EmptyStore(t *testing.T) {
	store, _ := setupTestStorage(t)

	results, duration, err := store.Search("", nil, nil, nil)
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results from empty store, got %d", len(results))
	}
	if duration < 0 {
		t.Error("duration should be non-negative")
	}
}

func TestSearch_MatchAll(t *testing.T) {
	store, _ := setupTestStorage(t)

	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	logs := makeLogs([]time.Time{ts, ts.Add(time.Hour), ts.Add(2 * time.Hour)}, "test.log")
	_ = store.Store(logs, "test.log")

	start := time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC)
	end := time.Date(2024, 1, 15, 23, 59, 59, 0, time.UTC)

	results, _, err := store.Search("", &start, &end, nil)
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if len(results) != 3 {
		t.Errorf("expected 3 results, got %d", len(results))
	}
}

func TestSearch_WithQuery(t *testing.T) {
	store, _ := setupTestStorage(t)

	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	logs := []map[string]interface{}{
		{"timestamp": ts, "_raw": "error: something failed", "_src": "app.log", "level": "error"},
		{"timestamp": ts.Add(time.Hour), "_raw": "info: all good", "_src": "app.log", "level": "info"},
	}
	_ = store.Store(logs, "app.log")

	start := time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC)
	end := time.Date(2024, 1, 15, 23, 59, 59, 0, time.UTC)

	results, _, err := store.Search("error", &start, &end, nil)
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	// Should find at least the "error" entry
	if len(results) == 0 {
		t.Error("expected at least 1 result for 'error' query")
	}
}

func TestSearch_DateRangeExclusion(t *testing.T) {
	store, _ := setupTestStorage(t)

	day1 := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	day2 := time.Date(2024, 1, 20, 10, 0, 0, 0, time.UTC)

	_ = store.Store(makeLogs([]time.Time{day1}, "test.log"), "test.log")
	_ = store.Store(makeLogs([]time.Time{day2}, "test.log"), "test.log")

	// Search only day 1
	start := time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC)
	end := time.Date(2024, 1, 15, 23, 59, 59, 0, time.UTC)

	results, _, err := store.Search("", &start, &end, nil)
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 result within date range, got %d", len(results))
	}
}

func TestSearch_NoDateRange(t *testing.T) {
	store, _ := setupTestStorage(t)

	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	_ = store.Store(makeLogs([]time.Time{ts}, "test.log"), "test.log")

	// nil dates should default to 1 year ago → now
	results, _, err := store.Search("", nil, nil, nil)
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	// The log from 2024-01-15 may or may not be in range depending on current date
	// This just tests that nil dates don't crash
	_ = results
}

// ---------------------------------------------------------------------------
// DeleteByIds
// ---------------------------------------------------------------------------

func TestDeleteByIds(t *testing.T) {
	store, _ := setupTestStorage(t)

	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	_ = store.Store(makeLogs([]time.Time{ts}, "test.log"), "test.log")

	// Search to get document IDs
	start := time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC)
	end := time.Date(2024, 1, 15, 23, 59, 59, 0, time.UTC)
	results, _, _ := store.Search("", &start, &end, nil)

	if len(results) == 0 {
		t.Fatal("need at least 1 result to test deletion")
	}

	// Get the ID of the first result
	id, ok := results[0]["_id"].(string)
	if !ok {
		t.Fatal("expected _id field in search result")
	}

	// Delete by ID
	deleted, err := store.DeleteByIds([]string{id})
	if err != nil {
		t.Fatalf("DeleteByIds failed: %v", err)
	}
	if deleted == 0 {
		t.Error("expected at least 1 deletion")
	}
}

func TestDeleteByIds_EmptyList(t *testing.T) {
	store, _ := setupTestStorage(t)
	deleted, err := store.DeleteByIds([]string{})
	if err != nil {
		t.Fatalf("DeleteByIds with empty list should not fail: %v", err)
	}
	if deleted != 0 {
		t.Errorf("expected 0 deletions, got %d", deleted)
	}
}

// ---------------------------------------------------------------------------
// GetSourceNames (integration)
// ---------------------------------------------------------------------------

func TestGetSourceNames(t *testing.T) {
	store, _ := setupTestStorage(t)

	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	_ = store.Store(makeLogs([]time.Time{ts}, "app.log"), "app.log")
	_ = store.Store(makeLogs([]time.Time{ts.Add(time.Hour)}, "sys.log"), "sys.log")

	sources, err := store.GetSourceNames()
	if err != nil {
		t.Fatalf("GetSourceNames failed: %v", err)
	}
	if len(sources) < 2 {
		t.Errorf("expected at least 2 sources, got %d: %v", len(sources), sources)
	}
}

// ---------------------------------------------------------------------------
// Search: Source filtering
// ---------------------------------------------------------------------------

func TestSearch_WithSourceFilter(t *testing.T) {
	store, _ := setupTestStorage(t)

	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	_ = store.Store(makeLogs([]time.Time{ts}, "app.log"), "app.log")
	_ = store.Store(makeLogs([]time.Time{ts.Add(time.Hour)}, "sys.log"), "sys.log")

	start := time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC)
	end := time.Date(2024, 1, 15, 23, 59, 59, 0, time.UTC)

	// Search with source filter — the filter goes through Bleve query string
	results, _, err := store.Search("_src:app.log", &start, &end, nil)
	if err != nil {
		t.Fatalf("Search with source filter failed: %v", err)
	}
	// Should only find logs from app.log
	for _, r := range results {
		if src, ok := r["_src"].(string); ok && src != "app.log" {
			t.Errorf("expected only app.log source, got %s", src)
		}
	}
}

// ---------------------------------------------------------------------------
// Search: multiple date shards
// ---------------------------------------------------------------------------

func TestSearch_AcrossMultipleDateShards(t *testing.T) {
	store, _ := setupTestStorage(t)

	day1 := time.Date(2024, 3, 10, 10, 0, 0, 0, time.UTC)
	day2 := time.Date(2024, 3, 11, 10, 0, 0, 0, time.UTC)
	day3 := time.Date(2024, 3, 12, 10, 0, 0, 0, time.UTC)

	_ = store.Store(makeLogs([]time.Time{day1}, "test.log"), "test.log")
	_ = store.Store(makeLogs([]time.Time{day2}, "test.log"), "test.log")
	_ = store.Store(makeLogs([]time.Time{day3}, "test.log"), "test.log")

	// Search spanning all 3 days
	start := time.Date(2024, 3, 10, 0, 0, 0, 0, time.UTC)
	end := time.Date(2024, 3, 12, 23, 59, 59, 0, time.UTC)

	results, _, err := store.Search("", &start, &end, nil)
	if err != nil {
		t.Fatalf("Search across shards failed: %v", err)
	}
	if len(results) != 3 {
		t.Errorf("expected 3 results across 3 shards, got %d", len(results))
	}
}

// ---------------------------------------------------------------------------
// Store: numeric field conversion
// ---------------------------------------------------------------------------

func TestStore_NumericFieldConversion(t *testing.T) {
	store, _ := setupTestStorage(t)

	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	logs := []map[string]interface{}{
		{
			"timestamp":   ts,
			"_raw":        "status=200 latency=1.5",
			"_src":        "app.log",
			"status_code": "200",
			"latency":     "1.5",
		},
	}

	err := store.Store(logs, "app.log")
	if err != nil {
		t.Fatalf("Store with numeric fields failed: %v", err)
	}

	// Verify doc was stored
	count, err := store.GetDocCount("2024-01-15")
	if err != nil {
		t.Fatalf("GetDocCount failed: %v", err)
	}
	if count != 1 {
		t.Errorf("expected 1 doc, got %d", count)
	}
}

// ---------------------------------------------------------------------------
// Store: multiple sources same date
// ---------------------------------------------------------------------------

func TestStore_MultipleSourcesSameDate(t *testing.T) {
	store, _ := setupTestStorage(t)

	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	_ = store.Store(makeLogs([]time.Time{ts}, "app.log"), "app.log")
	_ = store.Store(makeLogs([]time.Time{ts.Add(time.Minute)}, "sys.log"), "sys.log")
	_ = store.Store(makeLogs([]time.Time{ts.Add(2 * time.Minute)}, "auth.log"), "auth.log")

	count, err := store.GetDocCount("2024-01-15")
	if err != nil {
		t.Fatalf("GetDocCount failed: %v", err)
	}
	if count != 3 {
		t.Errorf("expected 3 docs from 3 sources, got %d", count)
	}

	sources, err := store.GetSourceNames()
	if err != nil {
		t.Fatalf("GetSourceNames failed: %v", err)
	}
	if len(sources) != 3 {
		t.Errorf("expected 3 source names, got %d: %v", len(sources), sources)
	}
}

// TestSearch_OpenNumericRangeExcludesTextTerms guards the numeric-range
// rewrite against leaking non-numeric values from a mixed-type field. An
// open-upper range (>, >=) must not match text terms, which sort above the
// shift-0 numeric terms in the same field's dictionary.
func TestSearch_OpenNumericRangeExcludesTextTerms(t *testing.T) {
	store, _ := setupTestStorage(t)

	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	logs := []map[string]interface{}{
		{"timestamp": ts, "_raw": "fast", "_src": "x.log", "latency": "100"},
		{"timestamp": ts.Add(time.Minute), "_raw": "slow", "_src": "x.log", "latency": "timeout"},
		{"timestamp": ts.Add(2 * time.Minute), "_raw": "quick", "_src": "x.log", "latency": "20"},
	}
	if err := store.Store(logs, "x.log"); err != nil {
		t.Fatalf("Store failed: %v", err)
	}

	start := time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC)
	end := time.Date(2024, 1, 15, 23, 59, 59, 0, time.UTC)

	cases := []struct {
		query string
		want  []string
	}{
		{"latency:>50", []string{"100"}},
		{"latency:>=100", []string{"100"}},
		{"latency:>0", []string{"20", "100"}},
		{"latency:<200", []string{"20", "100"}},
		{"latency:>600", nil},
	}
	for _, tc := range cases {
		results, _, err := store.Search(tc.query, &start, &end, nil)
		if err != nil {
			t.Fatalf("Search(%q) failed: %v", tc.query, err)
		}
		got := make(map[string]bool, len(results))
		for _, result := range results {
			got[fmt.Sprintf("%v", result["latency"])] = true
			if result["latency"] == "timeout" {
				t.Errorf("Search(%q) leaked non-numeric latency value: %#v", tc.query, result)
			}
		}
		if len(got) != len(tc.want) {
			t.Errorf("Search(%q) returned %v, want %v", tc.query, results, tc.want)
			continue
		}
		for _, want := range tc.want {
			if !got[want] {
				t.Errorf("Search(%q) missing latency %q; got %v", tc.query, want, results)
			}
		}
	}
}

func TestSearch_MultipleSourcesKeepIndependentFields(t *testing.T) {
	store, _ := setupTestStorage(t)

	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	nginxLogs := []map[string]interface{}{
		{
			"timestamp": ts,
			"_raw":      `GET /checkout returned 503 from upstream`,
			"_src":      "nginx.access.log",
			"method":    "GET",
			"url":       "/checkout",
			"status":    "503",
		},
		{
			"timestamp": ts.Add(time.Minute),
			"_raw":      `GET /health returned 200`,
			"_src":      "nginx.access.log",
			"method":    "GET",
			"url":       "/health",
			"status":    "200",
		},
	}
	appLogs := []map[string]interface{}{
		{
			"timestamp":  ts.Add(2 * time.Minute),
			"_raw":       `billing worker connection timeout after retry`,
			"_src":       "app.service.log",
			"level":      "error",
			"service":    "billing-worker",
			"message":    "connection timeout after retry",
			"deployment": "blue canary",
		},
		{
			"timestamp": ts.Add(3 * time.Minute),
			"_raw":      `billing worker completed request`,
			"_src":      "app.service.log",
			"level":     "info",
			"service":   "billing-worker",
			"message":   "completed request",
		},
	}

	if err := store.Store(nginxLogs, "nginx.access.log"); err != nil {
		t.Fatalf("Store nginx logs failed: %v", err)
	}
	if err := store.Store(appLogs, "app.service.log"); err != nil {
		t.Fatalf("Store app logs failed: %v", err)
	}

	start := time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC)
	end := time.Date(2024, 1, 15, 23, 59, 59, 0, time.UTC)

	assertSearch := func(query string, sources []string, want int, verify func(map[string]interface{})) {
		t.Helper()
		results, _, err := store.Search(query, &start, &end, sources)
		if err != nil {
			t.Fatalf("Search(%q, %v) failed: %v", query, sources, err)
		}
		if len(results) != want {
			t.Fatalf("Search(%q, %v) returned %d results, want %d: %#v", query, sources, len(results), want, results)
		}
		for _, result := range results {
			verify(result)
		}
	}

	assertSearch("status:>=500", nil, 1, func(result map[string]interface{}) {
		if result["_src"] != "nginx.access.log" || result["url"] != "/checkout" {
			t.Errorf("numeric range returned wrong nginx row: %#v", result)
		}
		if _, exists := result["service"]; exists {
			t.Errorf("nginx row unexpectedly contains app-only service field: %#v", result)
		}
	})
	assertSearch("status:503", nil, 1, func(result map[string]interface{}) {
		if result["_src"] != "nginx.access.log" {
			t.Errorf("numeric equality returned wrong source: %#v", result)
		}
	})
	assertSearch("503", nil, 1, func(result map[string]interface{}) {
		if result["_src"] != "nginx.access.log" {
			t.Errorf("bare numeric query returned wrong source: %#v", result)
		}
	})
	assertSearch("status:>200", nil, 1, func(result map[string]interface{}) {
		if result["url"] != "/checkout" {
			t.Errorf("exclusive numeric range returned wrong row: %#v", result)
		}
	})
	assertSearch(`message:"connection timeout"`, nil, 1, func(result map[string]interface{}) {
		if result["_src"] != "app.service.log" || result["service"] != "billing-worker" {
			t.Errorf("field phrase returned wrong app row: %#v", result)
		}
		if _, exists := result["status"]; exists {
			t.Errorf("app row unexpectedly contains nginx-only status field: %#v", result)
		}
	})
	assertSearch(`"connection timeout"`, nil, 1, func(result map[string]interface{}) {
		if result["_src"] != "app.service.log" {
			t.Errorf("bare phrase returned wrong source: %#v", result)
		}
	})
	assertSearch("canary", nil, 1, func(result map[string]interface{}) {
		if result["deployment"] != "blue canary" {
			t.Errorf("bare parsed-field term returned wrong row: %#v", result)
		}
	})
	assertSearch(`"blue canary"`, nil, 1, func(result map[string]interface{}) {
		if result["deployment"] != "blue canary" {
			t.Errorf("bare parsed-field phrase returned wrong row: %#v", result)
		}
	})
	assertSearch("canar*", nil, 1, func(result map[string]interface{}) {
		if result["deployment"] != "blue canary" {
			t.Errorf("bare wildcard returned wrong row: %#v", result)
		}
	})
	assertSearch("/canar.*/", nil, 1, func(result map[string]interface{}) {
		if result["deployment"] != "blue canary" {
			t.Errorf("bare regexp returned wrong row: %#v", result)
		}
	})
	assertSearch("canarz~1", nil, 1, func(result map[string]interface{}) {
		if result["deployment"] != "blue canary" {
			t.Errorf("bare fuzzy query returned wrong row: %#v", result)
		}
	})
	assertSearch("+level:error +deployment:canary", nil, 1, func(result map[string]interface{}) {
		if result["deployment"] != "blue canary" {
			t.Errorf("boolean query returned wrong row: %#v", result)
		}
	})
	assertSearch(`message:"timeout connection"`, nil, 0, func(map[string]interface{}) {})
	assertSearch("", []string{"nginx.access.log"}, 2, func(result map[string]interface{}) {
		if result["_src"] != "nginx.access.log" {
			t.Errorf("source filter returned wrong row: %#v", result)
		}
	})
	assertSearch("level:error", []string{"app.service.log"}, 1, func(result map[string]interface{}) {
		if result["_src"] != "app.service.log" {
			t.Errorf("field query and source filter returned wrong row: %#v", result)
		}
	})

	sources, err := store.GetSourceNames()
	if err != nil {
		t.Fatalf("GetSourceNames failed: %v", err)
	}
	sourceSet := make(map[string]bool, len(sources))
	for _, source := range sources {
		sourceSet[source] = true
	}
	if !sourceSet["nginx.access.log"] || !sourceSet["app.service.log"] || len(sourceSet) != 2 {
		t.Fatalf("GetSourceNames returned wrong sources: %v", sources)
	}
}

func TestSearch_OptimizedQueriesReadLegacyIndex(t *testing.T) {
	dir := t.TempDir()
	date := "2024-01-15"
	indexPath := filepath.Join(dir, "logs-"+date+".bleve")
	legacyIndex, err := bleve.New(indexPath, bleve.NewIndexMapping())
	if err != nil {
		t.Fatalf("create legacy index: %v", err)
	}

	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	if err := legacyIndex.Index("legacy-1", map[string]interface{}{
		"timestamp": ts,
		"_raw":      "legacy connection timeout",
		"_src":      "legacy.log",
		"message":   "connection timeout",
		"status":    503,
	}); err != nil {
		legacyIndex.Close()
		t.Fatalf("index legacy document: %v", err)
	}

	store := &Storage{
		baseDir: dir,
		indices: map[string]bleve.Index{date: legacyIndex},
	}
	t.Cleanup(func() { store.Close() })
	if err := store.Store([]map[string]interface{}{{
		"timestamp": ts.Add(time.Minute),
		"_raw":      "new connection timeout",
		"_src":      "legacy.log",
		"message":   "connection timeout",
		"status":    "504",
	}}, "legacy.log"); err != nil {
		t.Fatalf("append optimized document to legacy index: %v", err)
	}

	start := time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC)
	end := time.Date(2024, 1, 15, 23, 59, 59, 0, time.UTC)
	for _, query := range []string{`"connection timeout"`, `message:"connection timeout"`, "status:>=500"} {
		results, _, err := store.Search(query, &start, &end, nil)
		if err != nil {
			t.Fatalf("Search(%q) on legacy index failed: %v", query, err)
		}
		if len(results) != 2 {
			t.Fatalf("Search(%q) on legacy index returned wrong rows: %#v", query, results)
		}
		for _, result := range results {
			if result["_src"] != "legacy.log" {
				t.Fatalf("Search(%q) on legacy index returned wrong source: %#v", query, result)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Concurrent storage access
// ---------------------------------------------------------------------------

func TestStore_ConcurrentWrites(t *testing.T) {
	store, _ := setupTestStorage(t)

	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	done := make(chan error, 5)

	for i := 0; i < 5; i++ {
		go func(i int) {
			logs := makeLogs([]time.Time{ts.Add(time.Duration(i) * time.Minute)}, "concurrent.log")
			done <- store.Store(logs, "concurrent.log")
		}(i)
	}

	for i := 0; i < 5; i++ {
		if err := <-done; err != nil {
			t.Errorf("concurrent Store failed: %v", err)
		}
	}

	count, _ := store.GetDocCount("2024-01-15")
	if count != 5 {
		t.Errorf("expected 5 docs from concurrent writes, got %d", count)
	}
}

func TestStore_ConcurrentReads(t *testing.T) {
	store, _ := setupTestStorage(t)

	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	_ = store.Store(makeLogs([]time.Time{ts, ts.Add(time.Hour)}, "test.log"), "test.log")

	start := time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC)
	end := time.Date(2024, 1, 15, 23, 59, 59, 0, time.UTC)

	done := make(chan error, 10)
	for i := 0; i < 10; i++ {
		go func() {
			results, _, err := store.Search("", &start, &end, nil)
			if err != nil {
				done <- err
				return
			}
			if len(results) != 2 {
				done <- fmt.Errorf("expected 2 results, got %d", len(results))
				return
			}
			done <- nil
		}()
	}

	for i := 0; i < 10; i++ {
		if err := <-done; err != nil {
			t.Errorf("concurrent read failed: %v", err)
		}
	}
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

func TestClose(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "close-test")
	store, err := NewStorage(dir)
	if err != nil {
		t.Fatalf("NewStorage failed: %v", err)
	}

	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	_ = store.Store(makeLogs([]time.Time{ts}, "test.log"), "test.log")

	err = store.Close()
	if err != nil {
		t.Errorf("Close failed: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Persistence: Reopen existing indices
// ---------------------------------------------------------------------------

func TestStorage_ReopenExistingIndices(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "persist-test")

	// Create and store data
	store1, err := NewStorage(dir)
	if err != nil {
		t.Fatalf("NewStorage (first) failed: %v", err)
	}
	ts := time.Date(2024, 6, 1, 12, 0, 0, 0, time.UTC)
	_ = store1.Store(makeLogs([]time.Time{ts}, "persist.log"), "persist.log")

	// Verify data is stored
	count1, _ := store1.GetDocCount("2024-06-01")
	if count1 != 1 {
		t.Fatalf("expected 1 doc after first store, got %d", count1)
	}

	// Close first instance before reopening (required by Bleve)
	store1.Close()

	// Create a new storage instance pointing to the same directory
	store2, err := NewStorage(dir)
	if err != nil {
		t.Fatalf("NewStorage (second) failed: %v", err)
	}
	t.Cleanup(func() { store2.Close() })

	// Should be able to read the existing data
	dates, _ := store2.List()
	if len(dates) != 1 {
		t.Errorf("reopened storage should have 1 date index, got %d", len(dates))
	}

	count2, _ := store2.GetDocCount("2024-06-01")
	if count2 != 1 {
		t.Errorf("reopened storage should have 1 doc, got %d", count2)
	}
}
