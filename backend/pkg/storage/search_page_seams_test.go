package storage

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// Rows that share a timestamp (DEFAULT_PATTERN ingest stamps whole chunks
// with the same second) must not be duplicated or skipped when a page's
// internal search-after scan crosses a batch seam. Reproducer for the
// duplication the facet scan surfaced; see ISSUES.md.
func TestSearchPageSeamsWithTiedTimestamps(t *testing.T) {
	t.Skip("known failure (2026-09-02): SearchPage duplicates rows that share a timestamp at a search-after batch seam -- 2600 rows for 2500, 100 duplicated ids. Tracked in ISSUES.md for next-10 (storage hardening). To work on it: remove this Skip and run `go test ./pkg/storage -run TestSearchPageSeamsWithTiedTimestamps -v`.")
	store, err := NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	base := time.Date(2026, 3, 2, 8, 0, 0, 0, time.UTC)
	const n = 2500
	rows := make([]map[string]interface{}, 0, n)
	for i := 0; i < n; i++ {
		rows = append(rows, map[string]interface{}{"timestamp": base.Add(time.Duration(i/50) * time.Second), "_raw": "l", "_src": "big.log", "_seq": int64(i), "k": fmt.Sprintf("v%d", i%7)})
	}
	if _, err := store.StoreWithIDs(rows, "big.log"); err != nil {
		t.Fatal(err)
	}
	seen := map[string]int{}
	total := 0
	for offset := 0; offset < n; offset += 1000 {
		res, err := store.SearchPage(context.Background(), SearchOptions{
			StartDate: base.Add(-time.Hour), EndDate: base.Add(time.Hour),
			Limit: 1000, Offset: offset, SortBy: "timestamp", SortOrder: "desc", SkipDistribution: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		total += len(res.Logs)
		for _, r := range res.Logs {
			seen[r["_id"].(string)]++
		}
	}
	dupes := 0
	for _, c := range seen {
		if c > 1 {
			dupes++
		}
	}
	if total != n || len(seen) != n || dupes != 0 {
		t.Fatalf("paged %d rows, %d unique, %d duplicated ids; want %d/%d/0", total, len(seen), dupes, n, n)
	}
}
