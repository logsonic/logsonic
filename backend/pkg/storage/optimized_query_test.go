package storage

import (
	"testing"
	"time"

	"github.com/blevesearch/bleve/v2"
)

// An index alias searches its shards concurrently with one query instance.
// A field expansion must leave that shared query unchanged throughout search.
func TestAllFieldsQueryConcurrentShardSearchDoesNotMutateOriginal(t *testing.T) {
	store, err := NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	firstDay := time.Date(2026, 9, 23, 10, 0, 0, 0, time.UTC)
	secondDay := firstDay.AddDate(0, 0, 1)
	rows := []map[string]interface{}{
		{"timestamp": firstDay, "_raw": "needle", "_src": "app.log", "message": "needle", "service": "api"},
		{"timestamp": secondDay, "_raw": "needle", "_src": "app.log", "message": "needle", "service": "api"},
	}
	if err := store.Store(rows, "app.log"); err != nil {
		t.Fatal(err)
	}
	first, err := store.getOrCreateIndex(firstDay.Format("2006-01-02"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.getOrCreateIndex(secondDay.Format("2006-01-02"))
	if err != nil {
		t.Fatal(err)
	}
	shared := optimizeQuery(bleve.NewMatchQuery("needle")).(*allFieldsQuery)
	alias := bleve.NewIndexAlias(first, second)
	for i := 0; i < 20; i++ {
		result, err := alias.Search(bleve.NewSearchRequest(shared))
		if err != nil {
			t.Fatal(err)
		}
		if result.Total != 2 || shared.child.Field() != "" {
			t.Fatalf("iteration %d: total=%d original field=%q", i, result.Total, shared.child.Field())
		}
	}
}
