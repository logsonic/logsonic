package storage

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/types"
)

func row(fields map[string]interface{}) map[string]interface{} { return fields }

func findField(t *testing.T, f *types.FacetsResponse, name string) *types.FacetField {
	t.Helper()
	for i := range f.Fields {
		if f.Fields[i].Name == name {
			return &f.Fields[i]
		}
	}
	return nil
}

// B1: counts, sorted by count desc then value asc.
func TestAggregateFacetsCountsAndOrder(t *testing.T) {
	hits := []map[string]interface{}{
		row(map[string]interface{}{"level": "INFO", "service": "api"}),
		row(map[string]interface{}{"level": "ERROR", "service": "auth"}),
		row(map[string]interface{}{"level": "INFO", "service": "auth"}),
	}
	f := AggregateFacets(hits)
	if f.ComputedOver != 3 {
		t.Fatalf("computed_over = %d, want 3", f.ComputedOver)
	}
	if len(f.Fields) != 2 || f.Fields[0].Name != "level" || f.Fields[1].Name != "service" {
		t.Fatalf("fields = %+v, want level, service (sorted by name)", f.Fields)
	}
	level := f.Fields[0]
	if level.Distinct != 2 || len(level.Values) != 2 {
		t.Fatalf("level = %+v", level)
	}
	if level.Values[0].Value != "INFO" || level.Values[0].Count != 2 || level.Values[1].Value != "ERROR" || level.Values[1].Count != 1 {
		t.Errorf("level values not count-desc: %+v", level.Values)
	}
	service := f.Fields[1] // api:1, auth:2 -> auth first; ties would sort by value asc
	if service.Values[0].Value != "auth" || service.Values[1].Value != "api" {
		t.Errorf("service values order: %+v", service.Values)
	}
}

// B2: high cardinality -> distinct only, no values.
func TestAggregateFacetsHighCardinality(t *testing.T) {
	hits := make([]map[string]interface{}, 0, 210)
	for i := 0; i < 210; i++ {
		hits = append(hits, row(map[string]interface{}{"tid": fmt.Sprintf("t-%d", i%200), "level": "INFO"}))
	}
	f := AggregateFacets(hits)
	tid := findField(t, f, "tid")
	if tid == nil || !tid.HighCardinality || tid.Distinct != 200 || len(tid.Values) != 0 {
		t.Fatalf("tid = %+v, want high_cardinality with distinct=200 and no values", tid)
	}
	level := findField(t, f, "level")
	if level == nil || level.HighCardinality {
		t.Fatalf("level should not be high cardinality: %+v", level)
	}
}

// Small windows must not trip the high-cardinality rule: on 3 rows every
// field has "100% distinct" and the panel would otherwise be empty.
func TestAggregateFacetsSmallWindowKeepsValues(t *testing.T) {
	hits := []map[string]interface{}{
		row(map[string]interface{}{"host": "a"}),
		row(map[string]interface{}{"host": "b"}),
		row(map[string]interface{}{"host": "c"}),
	}
	f := AggregateFacets(hits)
	host := findField(t, f, "host")
	if host == nil || host.HighCardinality || len(host.Values) != 3 {
		t.Fatalf("host = %+v, want 3 values and not high cardinality", host)
	}
}

// B3/B4: internal fields excluded except _src; timestamp never appears.
func TestAggregateFacetsInternalFields(t *testing.T) {
	hits := []map[string]interface{}{
		row(map[string]interface{}{"_id": "1", "_raw": "x", "_src": "app.log", "_seq": int64(1), "timestamp": time.Now(), "level": "INFO"}),
	}
	f := AggregateFacets(hits)
	for _, name := range []string{"_id", "_raw", "_seq", "timestamp"} {
		if findField(t, f, name) != nil {
			t.Errorf("%s must not be faceted", name)
		}
	}
	if src := findField(t, f, "_src"); src == nil || src.Values[0].Value != "app.log" {
		t.Errorf("_src must be faceted: %+v", src)
	}
}

// B5: long values truncated with the flag set.
func TestAggregateFacetsTruncation(t *testing.T) {
	long := strings.Repeat("é", 500) // multi-byte, so truncation must be rune-safe
	f := AggregateFacets([]map[string]interface{}{row(map[string]interface{}{"message": long})})
	v := findField(t, f, "message").Values[0]
	if !v.Truncated || len([]rune(v.Value)) != MaxFacetValueLen {
		t.Fatalf("value not truncated to %d runes: truncated=%v len=%d", MaxFacetValueLen, v.Truncated, len([]rune(v.Value)))
	}
}

// B6: field cap.
func TestAggregateFacetsFieldCap(t *testing.T) {
	r := map[string]interface{}{}
	for i := 0; i < 80; i++ {
		r[fmt.Sprintf("f%02d", i)] = "v"
	}
	f := AggregateFacets([]map[string]interface{}{r})
	if len(f.Fields) != MaxFacetFields {
		t.Fatalf("fields = %d, want %d", len(f.Fields), MaxFacetFields)
	}
	if f.Fields[0].Name != "f00" || f.Fields[len(f.Fields)-1].Name != "f49" {
		t.Errorf("field cap must keep the first %d by name: %s..%s", MaxFacetFields, f.Fields[0].Name, f.Fields[len(f.Fields)-1].Name)
	}
}

// Value cap: 8 values kept out of 12.
func TestAggregateFacetsValueCap(t *testing.T) {
	hits := make([]map[string]interface{}, 0, 12)
	for i := 0; i < 12; i++ {
		hits = append(hits, row(map[string]interface{}{"code": fmt.Sprintf("c%02d", i)}))
	}
	f := AggregateFacets(hits)
	code := findField(t, f, "code")
	if code.Distinct != 12 || len(code.Values) != MaxFacetValues {
		t.Fatalf("code = distinct %d values %d, want 12 / %d", code.Distinct, len(code.Values), MaxFacetValues)
	}
}

// B7: empty input.
func TestAggregateFacetsEmpty(t *testing.T) {
	f := AggregateFacets(nil)
	if f.ComputedOver != 0 || len(f.Fields) != 0 || f.Fields == nil {
		t.Fatalf("empty = %+v, want computed_over 0 and an empty (non-nil) fields slice", f)
	}
}

// B8: mixed value types from JSON logs stringify deterministically; nested
// values are skipped rather than rendered as Go syntax.
func TestAggregateFacetsMixedTypes(t *testing.T) {
	hits := []map[string]interface{}{
		row(map[string]interface{}{"status": float64(200), "ok": true, "obj": map[string]interface{}{"a": 1}, "list": []interface{}{1}, "none": nil}),
		row(map[string]interface{}{"status": float64(200), "ok": false}),
		row(map[string]interface{}{"status": int64(500)}),
	}
	f := AggregateFacets(hits)
	status := findField(t, f, "status")
	if status == nil || status.Distinct != 2 || status.Values[0].Value != "200" || status.Values[0].Count != 2 || status.Values[1].Value != "500" {
		t.Fatalf("status = %+v", status)
	}
	if ok := findField(t, f, "ok"); ok == nil || ok.Distinct != 2 {
		t.Errorf("bool values must facet: %+v", ok)
	}
	for _, skipped := range []string{"obj", "list", "none"} {
		if findField(t, f, skipped) != nil {
			t.Errorf("%s must be skipped", skipped)
		}
	}
}

// Storage-level: the bounded scan honors query, sources and time range, and
// reports what it computed over.
func TestFacetsScanRespectsFilters(t *testing.T) {
	store, err := NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	base := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	var app, sys []map[string]interface{}
	for i := 0; i < 30; i++ {
		level := "INFO"
		if i%3 == 0 {
			level = "ERROR"
		}
		app = append(app, map[string]interface{}{"timestamp": base.Add(time.Duration(i) * time.Minute), "_raw": "app line", "_src": "app.log", "_seq": int64(i), "level": level, "message": "request served"})
		sys = append(sys, map[string]interface{}{"timestamp": base.Add(time.Duration(i) * time.Minute), "_raw": "sys line", "_src": "system.log", "_seq": int64(i), "level": "WARN", "message": "disk almost full"})
	}
	if _, err := store.StoreWithIDs(app, "app.log"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.StoreWithIDs(sys, "system.log"); err != nil {
		t.Fatal(err)
	}

	all, err := store.Facets(context.Background(), SearchOptions{StartDate: base.Add(-time.Hour), EndDate: base.Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if all.ComputedOver != 60 || all.Sampled {
		t.Fatalf("all: computed_over %d sampled %v, want 60/false", all.ComputedOver, all.Sampled)
	}
	src := findField(t, all, "_src")
	if src == nil || src.Distinct != 2 || src.Values[0].Count != 30 {
		t.Fatalf("_src facet = %+v", src)
	}
	if findField(t, all, "_raw") != nil {
		t.Errorf("_raw must never be faceted")
	}

	onlyApp, err := store.Facets(context.Background(), SearchOptions{StartDate: base.Add(-time.Hour), EndDate: base.Add(time.Hour), Sources: []string{"app.log"}})
	if err != nil {
		t.Fatal(err)
	}
	if onlyApp.ComputedOver != 30 {
		t.Fatalf("source filter: computed_over %d, want 30", onlyApp.ComputedOver)
	}
	level := findField(t, onlyApp, "level")
	if level == nil || level.Values[0].Value != "INFO" || level.Values[0].Count != 20 || level.Values[1].Value != "ERROR" || level.Values[1].Count != 10 {
		t.Fatalf("level facet with source filter = %+v", level)
	}

	errorsOnly, err := store.Facets(context.Background(), SearchOptions{Query: "level:ERROR", StartDate: base.Add(-time.Hour), EndDate: base.Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if errorsOnly.ComputedOver != 10 {
		t.Fatalf("query filter: computed_over %d, want 10", errorsOnly.ComputedOver)
	}

	window, err := store.Facets(context.Background(), SearchOptions{StartDate: base, EndDate: base.Add(9 * time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	if window.ComputedOver != 20 {
		t.Fatalf("time range: computed_over %d, want 20 (10 minutes x 2 sources)", window.ComputedOver)
	}
}

// The scan crosses search-after batch boundaries (facetScanBatchSize) on
// anything larger than one batch; computed_over must equal the window
// exactly -- no duplicated or dropped rows at the seams.
func TestFacetsScanCountsExactlyAcrossBatches(t *testing.T) {
	store, err := NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	base := time.Date(2026, 3, 2, 8, 0, 0, 0, time.UTC)
	const n = 2500
	rows := make([]map[string]interface{}, 0, n)
	for i := 0; i < n; i++ {
		// Many rows share a timestamp (same second), as DEFAULT_PATTERN ingest
		// produces; _seq is the tie-breaker.
		rows = append(rows, map[string]interface{}{"timestamp": base.Add(time.Duration(i/50) * time.Second), "_raw": "l", "_src": "big.log", "_seq": int64(i), "k": fmt.Sprintf("v%d", i%7)})
	}
	if _, err := store.StoreWithIDs(rows, "big.log"); err != nil {
		t.Fatal(err)
	}
	f, err := store.Facets(context.Background(), SearchOptions{StartDate: base.Add(-time.Hour), EndDate: base.Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if f.ComputedOver != n {
		t.Fatalf("computed_over = %d, want %d", f.ComputedOver, n)
	}
	k := findField(t, f, "k")
	total := 0
	for _, v := range k.Values {
		total += v.Count
	}
	if k.Distinct != 7 || total != n {
		t.Fatalf("k facet distinct %d, summed counts %d, want 7 / %d", k.Distinct, total, n)
	}
}
