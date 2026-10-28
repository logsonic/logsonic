package storage

import (
	"context"
	"testing"
	"time"
)

// ScanRows crosses batch seams, honors maxRows and the field projection,
// and reports truncation only when rows were left unscanned.
func TestScanRowsCapAndProjection(t *testing.T) {
	store, err := NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	base := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	rows := make([]map[string]interface{}, 0, 2500)
	for i := 0; i < 2500; i++ {
		rows = append(rows, map[string]interface{}{"timestamp": base.Add(time.Duration(i) * time.Second), "_raw": "line", "_src": "app.log", "_seq": int64(i), "level": "INFO", "message": "served", "user": "u1"})
	}
	if _, err := store.StoreWithIDs(rows, "app.log"); err != nil {
		t.Fatal(err)
	}
	window := SearchOptions{StartDate: base.Add(-time.Hour), EndDate: base.Add(2 * time.Hour)}

	seen := map[string]bool{}
	full, err := store.ScanRows(context.Background(), window, 10_000, func(row map[string]interface{}) {
		seen[row["_id"].(string)] = true
		if _, ok := row["_raw"]; ok {
			t.Fatalf("_raw must not be loaded by a scan")
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if full.Rows != 2500 || len(seen) != 2500 || full.Truncated {
		t.Fatalf("full scan = %+v, distinct %d; want 2500 rows, not truncated", full, len(seen))
	}

	capped, err := store.ScanRows(context.Background(), window, 1200, func(map[string]interface{}) {})
	if err != nil {
		t.Fatal(err)
	}
	if capped.Rows != 1200 || !capped.Truncated || capped.Total != 2500 {
		t.Fatalf("capped scan = %+v; want 1200 rows of 2500, truncated", capped)
	}

	projected := window
	projected.Fields = []string{"message"}
	_, err = store.ScanRows(context.Background(), projected, 5, func(row map[string]interface{}) {
		if _, ok := row["user"]; ok {
			t.Fatalf("projection loaded unrequested field: %v", row)
		}
		if row["message"] != "served" {
			t.Fatalf("projection dropped requested field: %v", row)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
}

// Above scanSliceRows the scan walks time slices; every row must still be
// seen exactly once, newest first, with slice boundaries landing on rows.
func TestScanRowsSlicesWindow(t *testing.T) {
	store, err := NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	base := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	const n = 3*scanSliceRows + 7
	rows := make([]map[string]interface{}, 0, n)
	for i := 0; i < n; i++ {
		// Three rows per second at sub-second offsets, so slice edges fall
		// inside a second. Stored timestamps keep whole seconds only, which
		// once dropped rows near an edge.
		rows = append(rows, map[string]interface{}{"timestamp": base.Add(time.Duration(i)*333*time.Millisecond + 137*time.Millisecond), "_raw": "line", "_src": "app.log", "_seq": int64(i), "message": "m"})
	}
	if _, err := store.StoreWithIDs(rows, "app.log"); err != nil {
		t.Fatal(err)
	}
	window := SearchOptions{StartDate: base, EndDate: base.Add(time.Duration(n/3+1) * time.Second)}
	seen := map[string]int{}
	var last time.Time
	ordered := true
	full, err := store.ScanRows(context.Background(), window, n+10, func(row map[string]interface{}) {
		seen[row["_id"].(string)]++
		ts := row["timestamp"].(time.Time)
		if !last.IsZero() && ts.After(last) {
			ordered = false
		}
		last = ts
	})
	if err != nil {
		t.Fatal(err)
	}
	if full.Rows != n || len(seen) != n || full.Truncated {
		t.Fatalf("sliced scan = %+v, distinct %d; want %d rows", full, len(seen), n)
	}
	if !ordered {
		t.Fatalf("sliced scan must stay newest first")
	}
	// A window far wider than the data slices the data's own span.
	wide := SearchOptions{StartDate: base.AddDate(-1, 0, 0), EndDate: base.AddDate(0, 0, 1)}
	wideSeen := map[string]bool{}
	wideScan, err := store.ScanRows(context.Background(), wide, n+10, func(row map[string]interface{}) { wideSeen[row["_id"].(string)] = true })
	if err != nil {
		t.Fatal(err)
	}
	if wideScan.Rows != n || len(wideSeen) != n {
		t.Fatalf("wide-window scan = %+v, distinct %d; want %d", wideScan, len(wideSeen), n)
	}

	var oldest time.Time
	capped, err := store.ScanRows(context.Background(), window, scanSliceRows+1, func(row map[string]interface{}) { oldest = row["timestamp"].(time.Time) })
	if err != nil {
		t.Fatal(err)
	}
	if capped.Rows != scanSliceRows+1 || !capped.Truncated {
		t.Fatalf("capped sliced scan = %+v", capped)
	}
	if want := base.Add(time.Duration(n-scanSliceRows-1) * 333 * time.Millisecond).Truncate(time.Second); oldest.Before(want) {
		t.Fatalf("capped scan reached %v, older than the newest rows (%v)", oldest, want)
	}
}
