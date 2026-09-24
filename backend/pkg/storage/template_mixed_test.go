package storage

import (
	"fmt"
	"reflect"
	"testing"
	"time"
)

func TestTemplateCodecKeepsRawStringsAlongsideMultipleTemplates(t *testing.T) {
	segment := mixedLogSegment()
	encoded, err := encodeTemplateSegment(segment)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeTemplateSegment(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decoded, segment) {
		t.Fatal("mixed-template segment changed a value during round trip")
	}

	// Template selection is adaptive: a small size difference may vary with
	// map iteration order, so exercise a valid mixed wire representation
	// directly instead of requiring the size optimizer to choose it here.
	mixedWire, err := templateCodecPlainWire(segment)
	if err != nil {
		t.Fatal(err)
	}
	access := segment.Records[0].Fields["message"].(string)
	audit := segment.Records[80].Fields["message"].(string)
	accessParts, accessVariables := splitTemplateString(access)
	auditParts, auditVariables := splitTemplateString(audit)
	if len(accessVariables) == 0 || len(auditVariables) == 0 {
		t.Fatal("structured fixtures no longer contain template variables")
	}
	indexes := map[string]int{
		templatePartsKey(accessParts): 0,
		templatePartsKey(auditParts):  1,
	}
	if indexes[templatePartsKey(accessParts)] == indexes[templatePartsKey(auditParts)] {
		t.Fatal("access and audit fixtures unexpectedly share a template")
	}
	mixedWire.Templates = [][]string{accessParts, auditParts}
	applyTemplates(&mixedWire, indexes)
	if mixedWire.Records[0].Fields["message"].Kind != valueTemplate || mixedWire.Records[0].Fields["message"].Template != 0 {
		t.Fatal("access-family string was not represented by its template")
	}
	if mixedWire.Records[80].Fields["message"].Kind != valueTemplate || mixedWire.Records[80].Fields["message"].Template != 1 {
		t.Fatal("audit-family string was not represented by its template")
	}
	fallback := mixedWire.Records[len(mixedWire.Records)-1].Fields["_raw"]
	if fallback.Kind != valueString || fallback.Text != " \t雪☃ one-off 000007\\quoted\\\n" {
		t.Fatal("unique Unicode/whitespace/leading-zero string was not retained literally beside templates")
	}
	for i, want := range []struct {
		value templateWireValue
		text  string
	}{
		{mixedWire.Records[0].Fields["message"], access},
		{mixedWire.Records[80].Fields["message"], audit},
	} {
		got, err := readTemplateWireValue(want.value, mixedWire.Templates, 0)
		if err != nil || got != want.text {
			t.Fatalf("template %d expansion = %v, %v; want %q", i, got, err, want.text)
		}
	}
}

func TestTemplateStorageMixedLogFamiliesMatchBleveAfterReopen(t *testing.T) {
	base := t.TempDir()
	baseline, err := NewStorage(base + "/bleve")
	if err != nil {
		t.Fatal(err)
	}
	templateStore, err := NewTemplateStorage(base + "/template")
	if err != nil {
		_ = baseline.Close()
		t.Fatal(err)
	}
	defer func() {
		_ = baseline.Close()
		_ = templateStore.Close()
	}()

	rows := mixedLogSegment().Records
	logs := make([]map[string]interface{}, len(rows))
	for i, record := range rows {
		logs[i] = record.Fields
	}
	bleveIDs, err := baseline.StoreWithIDs(logs, "mixed.log")
	if err != nil {
		t.Fatal(err)
	}
	templateIDs, err := templateStore.StoreWithIDs(logs, "mixed.log")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(templateIDs, bleveIDs) {
		t.Fatalf("IDs differ: template=%v Bleve=%v", templateIDs, bleveIDs)
	}

	day := time.Date(2026, 9, 24, 0, 0, 0, 0, time.UTC)
	options := SearchOptions{
		Sources: []string{"mixed.log"}, StartDate: day, EndDate: day.Add(24 * time.Hour),
		Limit: 200, SortBy: "timestamp", SortOrder: "asc",
	}
	compareMixedRows := func() {
		t.Helper()
		got := compareTemplatePage(t, baseline, templateStore, options)
		if got.TotalCount != len(logs) {
			t.Fatalf("search count = %d, want %d mixed rows", got.TotalCount, len(logs))
		}
		foundFallback := false
		for _, row := range got.Logs {
			if row["_raw"] == " \t雪☃ one-off 000007\\quoted\\\n" {
				foundFallback = true
			}
		}
		if !foundFallback {
			t.Fatal("search results lost the raw nonmatching log line")
		}
	}
	compareMixedRows()
	for _, query := range []string{"message:accepted", "message:authenticated", "message:rareoneoff"} {
		options.Query = query
		compareTemplatePage(t, baseline, templateStore, options)
	}
	options.Query = ""

	if err := templateStore.Close(); err != nil {
		t.Fatal(err)
	}
	templateStore, err = NewTemplateStorage(base + "/template")
	if err != nil {
		t.Fatalf("reopen template storage: %v", err)
	}
	compareMixedRows()
	for _, query := range []string{"message:accepted", "message:authenticated", "message:rareoneoff"} {
		options.Query = query
		compareTemplatePage(t, baseline, templateStore, options)
	}
}

func mixedLogSegment() templateSegment {
	day := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	rows := make([]templateRecord, 0, 121)
	for i := 1; i <= 80; i++ {
		raw := fmt.Sprintf("2026-09-24T12:%02d:00Z INFO source=api req=%08d accepted", i, i)
		rows = append(rows, templateRecord{ID: fmt.Sprintf("access-%02d", i), Fields: map[string]interface{}{
			"timestamp": day.Add(time.Duration(i) * time.Minute), "_seq": int64(i), "_src": "mixed.log",
			"_raw": raw, "family": "access", "message": fmt.Sprintf("source=api req=%08d accepted", i),
		}})
	}
	for i := 1; i <= 40; i++ {
		seq := i + 80
		raw := fmt.Sprintf("2026-09-24T12:%02d:00Z AUDIT principal=user%04d action=login result=authenticated", seq, i)
		rows = append(rows, templateRecord{ID: fmt.Sprintf("audit-%02d", i), Fields: map[string]interface{}{
			"timestamp": day.Add(time.Duration(seq) * time.Minute), "_seq": int64(seq), "_src": "mixed.log",
			"_raw": raw, "family": "audit", "message": fmt.Sprintf("principal=user%04d action=login result=authenticated", i),
		}})
	}
	seq := int64(len(rows) + 1)
	rows = append(rows, templateRecord{ID: "unmatched-one-off", Fields: map[string]interface{}{
		"timestamp": day.Add(time.Duration(seq) * time.Minute), "_seq": seq, "_src": "mixed.log",
		"_raw": " \t雪☃ one-off 000007\\quoted\\\n", "family": "unmatched",
		"message": "rareoneoff Ω 00000091",
	}})
	return templateSegment{Records: rows}
}
