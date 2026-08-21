package storage

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/blevesearch/bleve/v2"
	"github.com/blevesearch/bleve/v2/mapping"
)

func TestSearchPageReturnsBoundedRowsAndExactMetadata(t *testing.T) {
	store, _ := setupTestStorage(t)
	dayOne := time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC)
	dayTwo := dayOne.AddDate(0, 0, 1)

	appLogs := []map[string]interface{}{
		{"timestamp": dayOne.Add(8 * time.Hour), "_raw": "outside before", "_src": "app.log", "message": "outside-before", "_seq": int64(0)},
		{"timestamp": dayOne.Add(10 * time.Hour), "_raw": "first equal", "_src": "app.log", "message": "first-equal", "_seq": int64(1)},
		{"timestamp": dayOne.Add(10 * time.Hour), "_raw": "second equal", "_src": "app.log", "message": "second-equal", "_seq": int64(2)},
		{"timestamp": dayTwo.Add(9 * time.Hour), "_raw": "next day", "_src": "app.log", "message": "next-day", "_seq": int64(3)},
		{"timestamp": dayTwo.Add(12 * time.Hour), "_raw": "outside after", "_src": "app.log", "message": "outside-after", "_seq": int64(4)},
	}
	if _, err := store.StoreWithIDs(appLogs, "app.log"); err != nil {
		t.Fatalf("store app logs: %v", err)
	}
	systemLogs := []map[string]interface{}{
		{"timestamp": dayOne.Add(11 * time.Hour), "_raw": "system row", "_src": "system.log", "message": "system-row", "_seq": int64(5)},
	}
	if _, err := store.StoreWithIDs(systemLogs, "system.log"); err != nil {
		t.Fatalf("store system logs: %v", err)
	}

	result, err := store.SearchPage(context.Background(), SearchOptions{
		StartDate: dayOne.Add(9 * time.Hour),
		EndDate:   dayTwo.Add(10 * time.Hour),
		Sources:   []string{"app.log", "system.log"},
		Limit:     2,
		Offset:    1,
		SortBy:    "timestamp",
		SortOrder: "desc",
	})
	if err != nil {
		t.Fatalf("SearchPage: %v", err)
	}
	if result.TotalCount != 4 {
		t.Fatalf("total count = %d, want 4", result.TotalCount)
	}
	if len(result.Logs) != 2 {
		t.Fatalf("page size = %d, want 2", len(result.Logs))
	}
	if got := result.Logs[0]["message"]; got != "system-row" {
		t.Fatalf("first page row = %v, want system-row", got)
	}
	if got := result.Logs[1]["message"]; got != "second-equal" {
		t.Fatalf("second page row = %v, want second-equal", got)
	}
	if _, exposed := result.Logs[1]["_seq"]; exposed {
		t.Fatal("internal _seq field was exposed")
	}

	columnSet := make(map[string]bool, len(result.AvailableColumns))
	for _, column := range result.AvailableColumns {
		columnSet[column] = true
	}
	for _, expected := range []string{"_id", "_raw", "_src", "message", "timestamp"} {
		if !columnSet[expected] {
			t.Errorf("available columns missing %q: %v", expected, result.AvailableColumns)
		}
	}
	if columnSet["_seq"] {
		t.Errorf("available columns exposed _seq: %v", result.AvailableColumns)
	}

	total := 0
	sourceTotals := map[string]int{}
	for _, bucket := range result.Distribution {
		total += bucket.Count
		for source, count := range bucket.SourceCounts {
			sourceTotals[source] += count
		}
	}
	if total != 4 {
		t.Fatalf("distribution total = %d, want 4", total)
	}
	if sourceTotals["app.log"] != 3 || sourceTotals["system.log"] != 1 {
		t.Fatalf("source totals = %v, want app=3 system=1", sourceTotals)
	}

	filtered, err := store.SearchPage(context.Background(), SearchOptions{
		Query:     "message:second",
		StartDate: dayOne.Add(9 * time.Hour),
		EndDate:   dayTwo.Add(10 * time.Hour),
		Sources:   []string{"app.log"},
		Limit:     10,
		SortBy:    "timestamp",
		SortOrder: "desc",
	})
	if err != nil {
		t.Fatalf("filtered SearchPage: %v", err)
	}
	if filtered.TotalCount != 1 || len(filtered.Logs) != 1 || filtered.Logs[0]["message"] != "second-equal" {
		t.Fatalf("unexpected filtered result: %#v", filtered)
	}
}

func TestSearchPageAscendingUsesSequenceTieBreaker(t *testing.T) {
	store, _ := setupTestStorage(t)
	timestamp := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	logs := []map[string]interface{}{
		{"timestamp": timestamp, "_raw": "second", "_src": "app.log", "message": "second", "_seq": int64(2)},
		{"timestamp": timestamp, "_raw": "first", "_src": "app.log", "message": "first", "_seq": int64(1)},
	}
	if _, err := store.StoreWithIDs(logs, "app.log"); err != nil {
		t.Fatalf("store logs: %v", err)
	}

	result, err := store.SearchPage(context.Background(), SearchOptions{
		StartDate: timestamp.Add(-time.Hour),
		EndDate:   timestamp.Add(time.Hour),
		Sources:   []string{"app.log"},
		Limit:     2,
		SortBy:    "timestamp",
		SortOrder: "asc",
	})
	if err != nil {
		t.Fatalf("SearchPage: %v", err)
	}
	if len(result.Logs) != 2 || result.Logs[0]["message"] != "first" || result.Logs[1]["message"] != "second" {
		t.Fatalf("unexpected ascending order: %#v", result.Logs)
	}
}

func TestSearchPageHonorsCanceledContext(t *testing.T) {
	store, _ := setupTestStorage(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := store.SearchPage(ctx, SearchOptions{
		StartDate: time.Now().Add(-time.Hour),
		EndDate:   time.Now(),
		Limit:     10,
		SortBy:    "timestamp",
		SortOrder: "desc",
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func TestSearchPageRejectsOversizedPage(t *testing.T) {
	store, _ := setupTestStorage(t)
	_, err := store.SearchPage(context.Background(), SearchOptions{
		StartDate: time.Now().Add(-time.Hour),
		EndDate:   time.Now(),
		Limit:     MaxSearchPageSize + 1,
		SortBy:    "timestamp",
		SortOrder: "desc",
	})
	if err == nil {
		t.Fatal("expected oversized page to be rejected")
	}
}

func TestSearchPageSupportsLegacyUnindexedTimestampShard(t *testing.T) {
	dir := t.TempDir()
	date := "2024-01-15"
	indexMapping := buildIndexMapping().(*mapping.IndexMappingImpl)
	indexMapping.DefaultMapping.Properties["timestamp"].Fields[0].Index = false
	index, err := bleve.New(filepath.Join(dir, "logs-"+date+".bleve"), indexMapping)
	if err != nil {
		t.Fatalf("create legacy index: %v", err)
	}
	store := &Storage{baseDir: dir, indices: map[string]bleve.Index{date: index}}
	t.Cleanup(func() { _ = store.Close() })

	day := time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC)
	logs := []map[string]interface{}{
		{"timestamp": day.Add(8 * time.Hour), "_raw": "before", "_src": "legacy.log", "message": "before", "_seq": int64(1)},
		{"timestamp": day.Add(10 * time.Hour), "_raw": "inside", "_src": "legacy.log", "message": "inside", "_seq": int64(2)},
		{"timestamp": day.Add(12 * time.Hour), "_raw": "after", "_src": "legacy.log", "message": "after", "_seq": int64(3)},
	}
	if _, err := store.StoreWithIDs(logs, "legacy.log"); err != nil {
		t.Fatalf("store legacy logs: %v", err)
	}

	result, err := store.SearchPage(context.Background(), SearchOptions{
		StartDate: day.Add(9 * time.Hour),
		EndDate:   day.Add(11 * time.Hour),
		Sources:   []string{"legacy.log"},
		Limit:     10,
		SortBy:    "timestamp",
		SortOrder: "desc",
	})
	if err != nil {
		t.Fatalf("SearchPage legacy shard: %v", err)
	}
	if result.TotalCount != 1 || len(result.Logs) != 1 || result.Logs[0]["message"] != "inside" {
		t.Fatalf("unexpected legacy result: %#v", result)
	}
	if len(result.Distribution) == 0 || distributionTotal(result.Distribution) != 1 {
		t.Fatalf("unexpected legacy distribution: %#v", result.Distribution)
	}

	wholeDay, err := store.SearchPage(context.Background(), SearchOptions{
		StartDate: day,
		EndDate:   day.Add(24*time.Hour - time.Nanosecond),
		Sources:   []string{"legacy.log"},
		Limit:     2,
		SortBy:    "timestamp",
		SortOrder: "desc",
	})
	if err != nil {
		t.Fatalf("whole-day legacy SearchPage: %v", err)
	}
	if wholeDay.TotalCount != 3 || len(wholeDay.Distribution) != 1 || wholeDay.Distribution[0].Count != 3 {
		t.Fatalf("unexpected whole-day legacy result: %#v", wholeDay)
	}
}
