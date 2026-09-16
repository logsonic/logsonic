package storage

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// Rows sharing a timestamp come back in seq order — including past 9,
// where a string comparison of the seq would put 10 before 2.
func TestSameTimestampRowsSortBySeqNumerically(t *testing.T) {
	store, _ := setupTestStorage(t)
	ts := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)
	var logs []map[string]interface{}
	for i := 1; i <= 25; i++ {
		logs = append(logs, map[string]interface{}{"timestamp": ts, "_raw": fmt.Sprint("line ", i), "_src": "s", "_seq": int64(i)})
	}
	if err := store.Store(logs, "s"); err != nil {
		t.Fatal(err)
	}
	start, end := ts.Add(-time.Hour), ts.Add(time.Hour)
	for _, order := range []string{"asc", "desc"} {
		res, err := store.SearchPage(context.Background(), SearchOptions{StartDate: start, EndDate: end, Limit: 50, SortBy: "timestamp", SortOrder: order, Sources: []string{"s"}})
		if err != nil {
			t.Fatal(err)
		}
		for i, r := range res.Logs {
			want := i + 1
			if order == "desc" {
				want = 25 - i
			}
			if got := fmt.Sprint(r["_raw"]); got != fmt.Sprint("line ", want) {
				t.Fatalf("%s: position %d is %q, want line %d", order, i, got, want)
			}
		}
	}
}
