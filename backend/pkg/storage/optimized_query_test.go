package storage

import (
	"math"
	"testing"
	"time"

	"github.com/blevesearch/bleve/v2"
	"github.com/blevesearch/bleve/v2/search/query"
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

func TestCloneFieldableQueryIsIndependentAndKeepsBounds(t *testing.T) {
	inf := math.Inf(1)
	min := 2.0
	original := query.NewNumericRangeQuery(&min, &inf)
	original.SetField("orig")

	clone, err := cloneFieldableQuery(original)
	if err != nil {
		t.Fatal(err)
	}
	clone.SetField("other")
	if original.Field() != "orig" {
		t.Fatalf("clone mutated the original: %q", original.Field())
	}
	got := clone.(*query.NumericRangeQuery)
	if got.Field() != "other" || got.Min == nil || *got.Min != 2 || got.Max == nil || !math.IsInf(*got.Max, 1) {
		t.Fatalf("clone lost bounds: field=%q min=%v max=%v", got.Field(), got.Min, got.Max)
	}

	for _, q := range []query.FieldableQuery{
		query.NewMatchQuery("x"), query.NewTermQuery("x"), query.NewPrefixQuery("x"),
		query.NewWildcardQuery("x*"), query.NewRegexpQuery("x.*"), query.NewFuzzyQuery("x"),
		query.NewMatchPhraseQuery("x y"), query.NewBoolFieldQuery(true),
		query.NewTermRangeInclusiveQuery("a", "b", nil, nil),
	} {
		c, err := cloneFieldableQuery(q)
		if err != nil {
			t.Fatalf("%T: %v", q, err)
		}
		c.SetField("f")
		if q.Field() == "f" {
			t.Fatalf("%T clone aliased the original", q)
		}
	}
}

func BenchmarkCloneFieldableQuery(b *testing.B) {
	q := query.NewMatchQuery("connection timeout")
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		c, err := cloneFieldableQuery(q)
		if err != nil {
			b.Fatal(err)
		}
		c.SetField("f")
	}
}
