package storage

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/blevesearch/bleve/v2"
)

func timesFrom(start time.Time, n int) []time.Time {
	out := make([]time.Time, n)
	for i := range out {
		out[i] = start.Add(time.Duration(i) * time.Second)
	}
	return out
}

// Keyword shard: exact by term; the prefix-named neighbour survives; the
// loop crosses the 5k batch boundary; an emptied day is reported but not
// removed until RemoveDay.
func TestDeleteBySource_KeywordShardExactAndBatched(t *testing.T) {
	store, dir := setupTestStorage(t)
	d1 := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	d2 := time.Date(2024, 1, 16, 10, 0, 0, 0, time.UTC)
	if err := store.Store(makeLogs(timesFrom(d1, 6000), "app.log"), "app.log"); err != nil {
		t.Fatal(err)
	}
	if err := store.Store(makeLogs(timesFrom(d2, 10), "app.log"), "app.log"); err != nil {
		t.Fatal(err)
	}
	if err := store.Store(makeLogs(timesFrom(d1, 7), "app.log.1"), "app.log.1"); err != nil {
		t.Fatal(err)
	}

	rows, days, err := store.DeleteBySource(context.Background(), "app.log", []string{"2024-01-15", "2024-01-16", "2024-01-17"})
	if err != nil {
		t.Fatal(err)
	}
	if rows != 6010 || len(days) != 2 {
		t.Fatalf("rows %d days %v", rows, days)
	}
	if n, _ := store.GetDocCount("2024-01-15"); n != 7 {
		t.Errorf("app.log.1 must survive on 01-15: %d", n)
	}
	if n, _ := store.GetDocCount("2024-01-16"); n != 0 {
		t.Errorf("01-16 should be empty: %d", n)
	}
	if _, err := os.Stat(filepath.Join(dir, "logs-2024-01-16.bleve")); err != nil {
		t.Fatalf("empty day must still exist until RemoveDay: %v", err)
	}
	if err := store.RemoveDay("2024-01-16"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "logs-2024-01-16.bleve")); !os.IsNotExist(err) {
		t.Fatalf("RemoveDay left the directory: %v", err)
	}
	if dates, _ := store.List(); len(dates) != 1 || dates[0] != "2024-01-15" {
		t.Errorf("List after RemoveDay: %v", dates)
	}
	if err := store.RemoveDay("1999-01-01"); err != nil {
		t.Errorf("missing day must not error: %v", err)
	}
}

// Legacy shard (default mapping): the match query over-selects app.log.1
// for app.log; stored-field verification must keep it. This is the case
// spec now-10's Delete bullet calls out as data loss if skipped.
func TestDeleteBySource_LegacyShardVerifiesStoredSrc(t *testing.T) {
	dir := t.TempDir()
	date := "2024-01-15"
	legacyIndex, err := bleve.New(filepath.Join(dir, "logs-"+date+".bleve"), bleve.NewIndexMapping())
	if err != nil {
		t.Fatal(err)
	}
	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	i := 0
	for _, c := range []struct {
		n    int
		name string
	}{{5, "app.log"}, {3, "app.log.1"}} {
		for k := 0; k < c.n; k++ {
			if err := legacyIndex.Index("l"+string(rune('a'+i)), map[string]interface{}{
				"timestamp": ts.Add(time.Duration(k) * time.Second), "_raw": "x", "_src": c.name,
			}); err != nil {
				t.Fatal(err)
			}
			i++
		}
	}
	store := &Storage{baseDir: dir, indices: map[string]bleve.Index{date: legacyIndex}}
	t.Cleanup(func() { store.Close() })

	// Sanity: on this shard the filter really does over-select.
	req := bleve.NewSearchRequest(sourceFilterQuery("app.log"))
	req.Size = 100
	if res, _ := legacyIndex.Search(req); res.Total != 8 {
		t.Fatalf("expected the legacy filter to over-select 8, got %d", res.Total)
	}

	rows, days, err := store.DeleteBySource(context.Background(), "app.log", []string{date})
	if err != nil {
		t.Fatal(err)
	}
	if rows != 5 || len(days) != 1 {
		t.Fatalf("rows %d days %v", rows, days)
	}
	if n, _ := legacyIndex.DocCount(); n != 3 {
		t.Fatalf("app.log.1 rows must survive on a legacy shard: %d left", n)
	}
}

func TestDeleteBySource_NoMatchAndCancel(t *testing.T) {
	store, _ := setupTestStorage(t)
	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	_ = store.Store(makeLogs(timesFrom(ts, 3), "a.log"), "a.log")
	rows, days, err := store.DeleteBySource(context.Background(), "nope.log", []string{"2024-01-15"})
	if err != nil || rows != 0 || len(days) != 0 {
		t.Fatalf("no match: %d %v %v", rows, days, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := store.DeleteBySource(ctx, "a.log", []string{"2024-01-15"}); err == nil {
		t.Fatal("cancelled context must stop the delete")
	}
	if n, _ := store.GetDocCount("2024-01-15"); n != 3 {
		t.Fatalf("cancelled before the first batch must delete nothing: %d", n)
	}
}

// Legacy shard where the first full page of candidates is entirely
// over-selected non-matches: the delete must page past them by docID and
// still find and remove the real matches.
func TestDeleteBySource_LegacyPagesPastOverselectedNonMatches(t *testing.T) {
	old := deleteSourceBatch
	deleteSourceBatch = 3
	t.Cleanup(func() { deleteSourceBatch = old })

	dir := t.TempDir()
	date := "2024-01-15"
	legacyIndex, err := bleve.New(filepath.Join(dir, "logs-"+date+".bleve"), bleve.NewIndexMapping())
	if err != nil {
		t.Fatal(err)
	}
	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	// IDs sort so the non-matching app.log.1 docs come first in every
	// relevance-tied page: 9 over-selected rows, then 2 real matches.
	for i := 0; i < 9; i++ {
		_ = legacyIndex.Index(fmt.Sprintf("a-%02d", i), map[string]interface{}{"timestamp": ts, "_raw": "x", "_src": "app.log.1"})
	}
	for i := 0; i < 2; i++ {
		_ = legacyIndex.Index(fmt.Sprintf("z-%02d", i), map[string]interface{}{"timestamp": ts, "_raw": "x", "_src": "app.log"})
	}
	store := &Storage{baseDir: dir, indices: map[string]bleve.Index{date: legacyIndex}}
	t.Cleanup(func() { store.Close() })

	rows, _, err := store.DeleteBySource(context.Background(), "app.log", []string{date})
	if err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("rows deleted %d, want 2", rows)
	}
	if n, _ := legacyIndex.DocCount(); n != 9 {
		t.Fatalf("app.log.1 rows must all survive: %d", n)
	}
}
