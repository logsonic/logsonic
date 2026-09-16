package storage

import (
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/blevesearch/bleve/v2"
)

func statsByName(stats []SourceDayStats) map[string]SourceDayStats {
	out := make(map[string]SourceDayStats, len(stats))
	for _, s := range stats {
		out[s.Source] = s
	}
	return out
}

// Keyword-mapped shard: one facet + two bounds queries per source, exact
// names even when one name is a prefix/token of another.
func TestSourceStats_KeywordShardIsExact(t *testing.T) {
	store, _ := setupTestStorage(t)
	base := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	mk := func(n int, source string) []map[string]interface{} {
		ts := make([]time.Time, n)
		for i := range ts {
			ts[i] = base.Add(time.Duration(i) * time.Minute)
		}
		return makeLogs(ts, source)
	}
	for _, c := range []struct {
		n    int
		name string
	}{{5, "app.log"}, {3, "app.log.1"}, {2, "My App"}, {4, "nginx-access"}} {
		if err := store.Store(mk(c.n, c.name), c.name); err != nil {
			t.Fatal(err)
		}
	}
	if store.LegacySourceShard("2024-01-15") {
		t.Fatal("freshly created shard should be keyword-mapped")
	}
	stats, err := store.SourceStats("2024-01-15")
	if err != nil {
		t.Fatal(err)
	}
	got := statsByName(stats)
	want := map[string]uint64{"app.log": 5, "app.log.1": 3, "My App": 2, "nginx-access": 4}
	if len(got) != len(want) {
		t.Fatalf("expected %d sources, got %v", len(want), stats)
	}
	for name, rows := range want {
		s, ok := got[name]
		if !ok {
			t.Fatalf("source %q missing from %v", name, stats)
		}
		if s.Rows != rows {
			t.Errorf("%s: rows %d, want %d", name, s.Rows, rows)
		}
		if !s.FirstTS.Equal(base) {
			t.Errorf("%s: first %v, want %v", name, s.FirstTS, base)
		}
		wantLast := base.Add(time.Duration(rows-1) * time.Minute)
		if !s.LastTS.Equal(wantLast) {
			t.Errorf("%s: last %v, want %v", name, s.LastTS, wantLast)
		}
	}

	if stats, err := store.SourceStats("1999-01-01"); err != nil || stats != nil {
		t.Fatalf("missing day: want nil, nil; got %v, %v", stats, err)
	}
}

// Legacy shard (default Bleve mapping, tokenized _src): the facet would split
// names, so SourceStats reads stored fields and must still be exact.
func TestSourceStats_LegacyShardReadsStoredFields(t *testing.T) {
	dir := t.TempDir()
	date := "2024-01-15"
	legacyIndex, err := bleve.New(filepath.Join(dir, "logs-"+date+".bleve"), bleve.NewIndexMapping())
	if err != nil {
		t.Fatal(err)
	}
	base := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	i := 0
	for _, c := range []struct {
		n    int
		name string
	}{{3, "app.log"}, {2, "app.log.1"}, {1, "My App"}} {
		for k := 0; k < c.n; k++ {
			if err := legacyIndex.Index(
				"legacy-"+string(rune('a'+i)),
				map[string]interface{}{"timestamp": base.Add(time.Duration(k) * time.Minute), "_raw": "x", "_src": c.name},
			); err != nil {
				t.Fatal(err)
			}
			i++
		}
	}
	store := &Storage{baseDir: dir, indices: map[string]bleve.Index{date: legacyIndex}}
	t.Cleanup(func() { store.Close() })

	if !store.LegacySourceShard(date) {
		t.Fatal("default-mapping shard should be reported as legacy")
	}
	stats, err := store.SourceStats(date)
	if err != nil {
		t.Fatal(err)
	}
	got := statsByName(stats)
	names := make([]string, 0, len(got))
	for n := range got {
		names = append(names, n)
	}
	sort.Strings(names)
	if len(names) != 3 || names[0] != "My App" || names[1] != "app.log" || names[2] != "app.log.1" {
		t.Fatalf("legacy names not exact: %v", names)
	}
	if got["app.log"].Rows != 3 || got["app.log.1"].Rows != 2 || got["My App"].Rows != 1 {
		t.Errorf("legacy counts wrong: %+v", stats)
	}
	if !got["app.log"].FirstTS.Equal(base) || !got["app.log"].LastTS.Equal(base.Add(2*time.Minute)) {
		t.Errorf("legacy bounds wrong: %+v", got["app.log"])
	}
}

// The keyword mapping also makes the source filter exact on new shards —
// the behavior phase 2's per-source delete depends on.
func TestSourceFilter_ExactOnKeywordShard(t *testing.T) {
	store, _ := setupTestStorage(t)
	ts := time.Date(2024, 1, 15, 10, 0, 0, 0, time.UTC)
	_ = store.Store(makeLogs([]time.Time{ts}, "app.log"), "app.log")
	_ = store.Store(makeLogs([]time.Time{ts.Add(time.Minute)}, "app.log.1"), "app.log.1")
	start, end := ts.Add(-time.Hour), ts.Add(time.Hour)
	results, _, err := store.Search("", &start, &end, []string{"app.log"})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0]["_src"] != "app.log" {
		t.Fatalf("filter app.log should match exactly one row on a keyword shard, got %v", results)
	}
}
