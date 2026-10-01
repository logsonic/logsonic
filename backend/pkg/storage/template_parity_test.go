package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
	"time"
)

type parityStorage interface {
	StorageInterface
	Close() error
}

// This is the compatibility oracle for the opt-in template engine. Keep the
// corpus deliberately small so it exercises semantics without turning into a
// benchmark or depending on SearchPage's known large-batch cursor seam.
func TestTemplateStorageParity(t *testing.T) {
	base := t.TempDir()
	var bleveStore parityStorage
	var templateStore parityStorage
	bleveStore, err := NewStorage(base + "/bleve")
	if err != nil {
		t.Fatal(err)
	}
	templateStore, err = NewTemplateStorage(base + "/template")
	if err != nil {
		_ = bleveStore.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = bleveStore.Close()
		_ = templateStore.Close()
	})

	day := time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC)
	rows := []map[string]interface{}{
		{"timestamp": day.Add(10 * time.Hour), "_seq": int64(1), "_raw": "ERROR api connection timeout", "_src": "app.log", "level": "ERROR", "service": "api", "message": "connection timeout", "latency": 125, "tags": []interface{}{"critical", "network"}, "context": map[string]interface{}{"code": 503, "region": "eu"}},
		{"timestamp": day.Add(10 * time.Hour), "_seq": int64(2), "_raw": "WARN api connection retried", "_src": "app.log", "level": "WARN", "service": "api", "message": "connection retried", "latency": 95, "tags": []interface{}{"network"}, "context": map[string]interface{}{"code": 200, "region": "eu"}},
		{"timestamp": day.Add(11 * time.Hour), "_seq": int64(3), "_raw": "ERROR auth invalid credentials", "_src": "My App.log", "level": "ERROR", "service": "auth", "message": "invalid credentials", "latency": 220, "tags": []interface{}{"security"}, "context": map[string]interface{}{"code": 403, "region": "us"}},
		{"timestamp": day.Add(12 * time.Hour), "_seq": int64(4), "_raw": "INFO web connected", "_src": "dir with spaces/app.log", "level": "INFO", "service": "web", "message": "connected", "latency": "100", "tags": []interface{}{"network"}, "context": map[string]interface{}{"code": 200, "region": "us"}},
		{"timestamp": day.AddDate(0, 0, 1).Add(9 * time.Hour), "_seq": int64(5), "_raw": "ERROR db connection refused", "_src": "app.log.1", "level": "ERROR", "service": "db", "message": "connection refused", "latency": 310, "tags": []interface{}{"critical"}, "context": map[string]interface{}{"code": 500, "region": "eu"}},
	}
	bleveIDs, err := bleveStore.StoreWithIDs(rows, "ignored-source")
	if err != nil {
		t.Fatal(err)
	}
	templateIDs, err := templateStore.StoreWithIDs(rows, "ignored-source")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(templateIDs, bleveIDs) {
		t.Fatalf("stored IDs differ: template=%v bleve=%v", templateIDs, bleveIDs)
	}

	start, end := day.Add(9*time.Hour), day.AddDate(0, 0, 1).Add(10*time.Hour)
	queries := []string{
		"error",
		`"connection timeout"`,
		"level:ERROR",
		"+level:ERROR +service:api",
		"service:api OR service:auth",
		"-level:ERROR",
		"message:connec*",
		"message:errro~",
		"latency:[100 TO 250]",
		"tags:critical",
		"context.code:403",
	}
	for _, query := range queries {
		t.Run("query/"+query, func(t *testing.T) {
			compareTemplatePage(t, bleveStore, templateStore, SearchOptions{
				Query: query, StartDate: start, EndDate: end, Limit: 20,
				SortBy: "timestamp", SortOrder: "asc",
			})
		})
	}

	for _, source := range []string{"app.log", "app.log.1", "My App.log", "dir with spaces/app.log"} {
		t.Run("source/"+source, func(t *testing.T) {
			got := compareTemplatePage(t, bleveStore, templateStore, SearchOptions{
				StartDate: start, EndDate: end, Sources: []string{source}, Limit: 20,
				SortBy: "timestamp", SortOrder: "desc",
			})
			if got.TotalCount == 0 {
				t.Fatalf("expected exact source %q to match rows", source)
			}
			for _, row := range got.Logs {
				if row["_src"] != source {
					t.Fatalf("source %q returned row from %v", source, row["_src"])
				}
			}
		})
	}

	// Equal timestamps exercise the sequence tie-breaker; a small offset checks
	// pagination without crossing the documented large-batch search-after seam.
	compareTemplatePage(t, bleveStore, templateStore, SearchOptions{
		StartDate: start, EndDate: end, Limit: 2, Offset: 1,
		SortBy: "timestamp", SortOrder: "asc", Fields: []string{"message", "level"},
	})
	compareTemplatePage(t, bleveStore, templateStore, SearchOptions{
		StartDate: start, EndDate: end, Limit: 20,
		SortBy: "timestamp", SortOrder: "desc", SkipDistribution: false,
	})

	bleveFacets, err := bleveStore.Facets(context.Background(), SearchOptions{Query: "+level:ERROR", StartDate: start, EndDate: end})
	if err != nil {
		t.Fatal(err)
	}
	templateFacets, err := templateStore.Facets(context.Background(), SearchOptions{Query: "+level:ERROR", StartDate: start, EndDate: end})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(templateFacets, bleveFacets) {
		t.Fatalf("facets differ:\n template=%+v\n bleve=%+v", templateFacets, bleveFacets)
	}

	compareSourceStats(t, bleveStore, templateStore, "2024-01-15")
	compareSourceStats(t, bleveStore, templateStore, "2024-01-16")

	// Upsert the first ID with changed fields, then remove another ID. Verify
	// state survives close/reopen as well as the mutation sequence.
	updated := map[string]interface{}{
		"timestamp": rows[0]["timestamp"], "_seq": int64(1), "_raw": "ERROR api refreshed",
		"_src": "app.log", "level": "ERROR", "service": "api", "message": "refreshed",
		"latency": 150, "context": map[string]interface{}{"code": 504},
	}
	for _, store := range []parityStorage{bleveStore, templateStore} {
		ids, err := store.StoreWithIDs([]map[string]interface{}{updated}, "ignored-source")
		if err != nil {
			t.Fatal(err)
		}
		if ids[0] != bleveIDs[0] {
			t.Fatalf("upsert ID changed: got %q want %q", ids[0], bleveIDs[0])
		}
		deleted, err := store.DeleteByIds([]string{bleveIDs[2]})
		if err != nil || deleted != 1 {
			t.Fatalf("DeleteByIds = %d, %v; want 1, nil", deleted, err)
		}
		deletedRows, days, err := store.DeleteBySource(context.Background(), "app.log", []string{"2024-01-15"})
		if err != nil || deletedRows != 2 || !reflect.DeepEqual(days, []string{"2024-01-15"}) {
			t.Fatalf("DeleteBySource(app.log) = %d, %v, %v; want 2 rows in Jan 15", deletedRows, days, err)
		}
		// Dotted prefixes and case differences must retain their own rows.
		if count, err := store.GetDocCount("2024-01-15"); err != nil || count != 1 {
			t.Fatalf("count after exact source delete = %d, %v; want 1", count, err)
		}
		stats, err := store.SourceStats("2024-01-16")
		if err != nil || len(stats) != 1 || stats[0].Source != "app.log.1" {
			t.Fatalf("dotted source lost after exact delete: %+v, %v", stats, err)
		}
	}
	_ = bleveStore.Close()
	_ = templateStore.Close()
	bleveStore, err = NewStorage(base + "/bleve")
	if err != nil {
		t.Fatal(err)
	}
	templateStore, err = NewTemplateStorage(base + "/template")
	if err != nil {
		t.Fatal(err)
	}
	for _, store := range []parityStorage{bleveStore, templateStore} {
		if _, err := store.StoreWithIDs([]map[string]interface{}{updated}, "ignored-source"); err != nil {
			t.Fatal(err)
		}
	}
	compareTemplatePage(t, bleveStore, templateStore, SearchOptions{
		Query: "message:refreshed", StartDate: start, EndDate: end, Limit: 10,
		SortBy: "timestamp", SortOrder: "asc",
	})
	compareTemplatePage(t, bleveStore, templateStore, SearchOptions{
		StartDate: start, EndDate: end, Limit: 20, SortBy: "timestamp", SortOrder: "asc",
	})
}

func TestTemplateStorageLifecycleParity(t *testing.T) {
	base := t.TempDir()
	bleveStore, err := NewStorage(filepath.Join(base, "bleve"))
	if err != nil {
		t.Fatal(err)
	}
	templateStore, err := NewTemplateStorage(filepath.Join(base, "template"))
	if err != nil {
		_ = bleveStore.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = bleveStore.Close()
		_ = templateStore.Close()
	})

	stores := []parityStorage{bleveStore, templateStore}
	metadata := []byte("catalog metadata must survive storage lifecycle operations\n")
	for _, store := range stores {
		marker := filepath.Join(store.BaseDir(), "catalog.json")
		if err := os.WriteFile(marker, metadata, 0600); err != nil {
			t.Fatal(err)
		}
	}

	now := time.Now().UTC()
	oldDay := now.AddDate(0, 0, -20).Format("2006-01-02")
	oldTime, _ := time.ParseInLocation("2006-01-02", oldDay, time.UTC)
	removeRow := map[string]interface{}{
		"timestamp": oldTime.Add(12 * time.Hour), "_seq": int64(1),
		"_raw": "remove-day", "_src": "old.log", "message": "remove-day",
	}
	for _, store := range stores {
		if err := store.Store([]map[string]interface{}{removeRow}, "old.log"); err != nil {
			t.Fatal(err)
		}
		if err := store.RemoveDay(oldDay); err != nil {
			t.Fatalf("RemoveDay(%s): %v", oldDay, err)
		}
	}
	compareTemplateList(t, bleveStore, templateStore)

	pruneDay := now.AddDate(0, 0, -10).Format("2006-01-02")
	pruneTime, _ := time.ParseInLocation("2006-01-02", pruneDay, time.UTC)
	keepDay := now.AddDate(0, 0, -1).Format("2006-01-02")
	keepTime, _ := time.ParseInLocation("2006-01-02", keepDay, time.UTC)
	retentionRows := []map[string]interface{}{
		{"timestamp": pruneTime.Add(12 * time.Hour), "_seq": int64(2), "_raw": "expired", "_src": "retention.log", "message": "expired"},
		{"timestamp": keepTime.Add(12 * time.Hour), "_seq": int64(3), "_raw": "retained", "_src": "retention.log", "message": "retained"},
	}
	for _, store := range stores {
		if err := store.Store(retentionRows, "retention.log"); err != nil {
			t.Fatal(err)
		}
	}
	blevePruned, err := bleveStore.PruneOlderThan(3 * 24 * time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	templatePruned, err := templateStore.PruneOlderThan(3 * 24 * time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if templatePruned != blevePruned || templatePruned != 1 {
		t.Fatalf("PruneOlderThan removed template=%d bleve=%d days, want 1", templatePruned, blevePruned)
	}
	compareTemplateList(t, bleveStore, templateStore)
	for _, store := range stores {
		if count, err := store.GetDocCount(keepDay); err != nil || count != 1 {
			t.Fatalf("retained day count=%d err=%v, want 1", count, err)
		}
		if count, err := store.GetDocCount(pruneDay); err != nil || count != 0 {
			t.Fatalf("pruned day count=%d err=%v, want 0", count, err)
		}
	}

	for _, store := range stores {
		if err := store.Clear(); err != nil {
			t.Fatalf("Clear: %v", err)
		}
		marker := filepath.Join(store.BaseDir(), "catalog.json")
		got, err := os.ReadFile(marker)
		if err != nil || !reflect.DeepEqual(got, metadata) {
			t.Fatalf("Clear damaged unrelated metadata: bytes=%q err=%v", got, err)
		}
	}
	compareTemplateList(t, bleveStore, templateStore)

	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	options := SearchOptions{StartDate: now.Add(-time.Hour), EndDate: now, Limit: 1, SortBy: "timestamp", SortOrder: "desc"}
	_, bleveErr := bleveStore.SearchPage(canceled, options)
	_, templateErr := templateStore.SearchPage(canceled, options)
	if !errors.Is(bleveErr, context.Canceled) || !errors.Is(templateErr, context.Canceled) {
		t.Fatalf("canceled SearchPage errors: template=%v bleve=%v", templateErr, bleveErr)
	}
}

func compareTemplateList(t *testing.T, baseline, candidate parityStorage) {
	t.Helper()
	want, err := baseline.List()
	if err != nil {
		t.Fatal(err)
	}
	got, err := candidate.List()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("List differs: template=%v bleve=%v", got, want)
	}
}

func compareTemplatePage(t *testing.T, baseline, candidate parityStorage, options SearchOptions) SearchPageResult {
	t.Helper()
	want, err := baseline.SearchPage(context.Background(), options)
	if err != nil {
		t.Fatalf("baseline SearchPage(%q): %v", options.Query, err)
	}
	got, err := candidate.SearchPage(context.Background(), options)
	if err != nil {
		t.Fatalf("template SearchPage(%q): %v", options.Query, err)
	}
	want.QueryTime, got.QueryTime = 0, 0
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("SearchPage(%q) differs:\n template=%#v\n bleve=%#v", options.Query, got, want)
	}
	return got
}

func compareSourceStats(t *testing.T, baseline, candidate parityStorage, date string) {
	t.Helper()
	want, err := baseline.SourceStats(date)
	if err != nil {
		t.Fatal(err)
	}
	got, err := candidate.SourceStats(date)
	if err != nil {
		t.Fatal(err)
	}
	less := func(values []SourceDayStats) func(int, int) bool {
		return func(i, j int) bool { return values[i].Source < values[j].Source }
	}
	sort.Slice(got, less(got))
	sort.Slice(want, less(want))
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("SourceStats(%q) differ:\n template=%+v\n bleve=%+v", date, got, want)
	}
}
