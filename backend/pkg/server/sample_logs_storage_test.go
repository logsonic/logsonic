package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/storage"
	"logsonic/pkg/types"
)

// TestSampleLogsCompactStorageMatchesLegacy is the end-to-end oracle for the
// compact storage format: every file in sample-logs/ is imported with
// automatic parsing into a legacy-format store and a compact store, and the
// HTTP answers the UI relies on must be identical. The legacy store is then
// migrated in place and must still give the same answers, before and after
// a restart.
func TestSampleLogsCompactStorageMatchesLegacy(t *testing.T) {
	var files []string
	for _, glob := range sampleGlobs() {
		matches, _ := filepath.Glob("../../../sample-logs/" + glob)
		files = append(files, matches...)
	}
	if len(files) == 0 {
		t.Skip("sample-logs not available")
	}
	sort.Strings(files)
	t.Setenv(storage.MigrationEnv, "off")

	legacyDir, compactDir := t.TempDir(), t.TempDir()
	legacySrv, legacyTS := openFormatServer(t, legacyDir, "legacy")
	compactSrv, compactTS := openFormatServer(t, compactDir, "compact")

	sources := make([]string, 0, len(files))
	for _, file := range files {
		source := filepath.Base(file)
		sources = append(sources, source)
		legacyRows := importSample(t, legacyTS, file, source)
		compactRows := importSample(t, compactTS, file, source)
		if legacyRows != compactRows || legacyRows == 0 {
			t.Fatalf("%s: stored %d rows (legacy) vs %d (compact)", source, legacyRows, compactRows)
		}
	}

	want := captureSampleAnswers(t, legacyTS, sources, nil)
	got := captureSampleAnswers(t, compactTS, sources, &want)
	compareSampleAnswers(t, "compact import", want, got)

	// The background pass finalizes closed days (one segment, compact
	// metadata); run it now and check nothing the UI sees changes.
	if _, err := compactSrv.store.(*storage.Storage).MigrateLegacyDays(context.Background()); err != nil {
		t.Fatalf("finalize compact days: %v", err)
	}
	compareSampleAnswers(t, "compact after finalize", want, captureSampleAnswers(t, compactTS, sources, &want))

	legacyBytes, compactBytes := storageTotal(t, legacyTS), storageTotal(t, compactTS)
	rawBytes := int64(0)
	for _, file := range files {
		info, _ := os.Stat(file)
		rawBytes += info.Size()
	}
	t.Logf("sample logs: %d files, %d raw bytes; legacy %d bytes (%.2fx raw); compact %d bytes (%.2fx raw, %.0f%% smaller)",
		len(files), rawBytes, legacyBytes, float64(legacyBytes)/float64(rawBytes),
		compactBytes, float64(compactBytes)/float64(rawBytes), 100*(1-float64(compactBytes)/float64(legacyBytes)))
	if compactBytes >= legacyBytes {
		t.Errorf("compact storage (%d bytes) is not smaller than legacy (%d bytes)", compactBytes, legacyBytes)
	}

	legacyTS.Close()
	if err := legacySrv.Close(); err != nil {
		t.Fatal(err)
	}
	compactTS.Close()
	if err := compactSrv.Close(); err != nil {
		t.Fatal(err)
	}

	// Upgrade path: the legacy directory opened by a compact-format build.
	migratedSrv, migratedTS := openFormatServer(t, legacyDir, "compact")
	store := migratedSrv.store.(*storage.Storage)
	converted, err := store.MigrateLegacyDays(context.Background())
	if err != nil {
		t.Fatalf("migrate: %v", err)
	}
	status := store.MigrationStatus()
	t.Logf("migrated %d day(s); %d day(s) left legacy (today or later: not closed yet)", converted, status.LegacyDays)
	if converted == 0 && status.LegacyDays > 0 && hasDayBefore(t, store, time.Now().Format("2006-01-02")) {
		t.Fatal("no legacy day was migrated")
	}
	compareSampleAnswers(t, "after migration", want, captureSampleAnswers(t, migratedTS, sources, &want))
	migratedBytes := storageTotal(t, migratedTS)
	t.Logf("migrated store %d bytes (%.0f%% smaller than legacy)", migratedBytes, 100*(1-float64(migratedBytes)/float64(legacyBytes)))

	migratedTS.Close()
	if err := migratedSrv.Close(); err != nil {
		t.Fatal(err)
	}
	reopenedSrv, reopenedTS := openFormatServer(t, legacyDir, "compact")
	defer func() {
		reopenedTS.Close()
		_ = reopenedSrv.Close()
	}()
	compareSampleAnswers(t, "migrated store after restart", want, captureSampleAnswers(t, reopenedTS, sources, &want))
}

func openFormatServer(t *testing.T, dir, format string) (*Server, *httptest.Server) {
	t.Helper()
	t.Setenv(storage.StorageFormatEnv, format)
	srv, err := NewServer(Config{Host: "localhost", Port: ":0", StoragePath: dir, Timeout: 30 * time.Second})
	if err != nil {
		t.Fatalf("NewServer(%s): %v", format, err)
	}
	return srv, httptest.NewServer(srv.router)
}

func importSample(t *testing.T, ts *httptest.Server, file, source string) int64 {
	t.Helper()
	var started types.IngestResponse
	if code := do(t, ts, http.MethodPost, "/api/v1/ingest/start", map[string]any{
		"pattern": "auto", "source": source, "meta": map[string]string{"_src": source},
	}, &started); code != http.StatusOK || started.SessionID == "" {
		t.Fatalf("start %s: %d %+v", source, code, started)
	}
	abs, _ := filepath.Abs(file)
	status, accepted := ingestFile(t, ts, started.SessionID, abs, false)
	if status != http.StatusAccepted {
		t.Fatalf("ingest %s: %d", source, status)
	}
	job := pollIngestJob(t, ts, accepted.JobID, 60*time.Second)
	endSession(t, ts, started.SessionID)
	if job.State != "done" {
		t.Fatalf("ingest %s: %+v", source, job)
	}
	return job.RowsStored
}

type sampleAnswers struct {
	queries map[string][]string // source -> queries derived from the legacy rows
	// clockStamped marks sources whose lines carry no parseable date, so the
	// importer stamped them with the wall clock: their IDs, timestamps and
	// chart differ between two imports and are left out of the comparison.
	clockStamped map[string]bool
	answers      map[string]string // "source|query|page" -> normalized JSON
	sources      string
}

var sampleWord = regexp.MustCompile(`[A-Za-z][A-Za-z0-9]{3,}`)

// sampleQueries derives realistic queries from a source's own rows: a free
// word, a two-word phrase, a field value, its negation and a numeric range.
func sampleQueries(rows []map[string]any) []string {
	queries := []string{""}
	if len(rows) == 0 {
		return queries
	}
	mid := rows[len(rows)/2]
	if raw, _ := mid["_raw"].(string); raw != "" {
		words := sampleWord.FindAllString(raw, -1)
		if len(words) > 0 {
			queries = append(queries, strings.ToLower(words[len(words)/2]))
		}
		if len(words) > 1 {
			queries = append(queries, fmt.Sprintf("%q", words[0]+" "+words[1]))
		}
	}
	keys := make([]string, 0, len(mid))
	for key := range mid {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	stringDone, numberDone := false, false
	for _, key := range keys {
		if strings.HasPrefix(key, "_") || key == "timestamp" || strings.ContainsAny(key, " :") {
			continue
		}
		switch value := mid[key].(type) {
		case string:
			if word := sampleWord.FindString(value); word != "" && !stringDone {
				queries = append(queries, fmt.Sprintf("%s:%s", key, strings.ToLower(word)), fmt.Sprintf("-%s:%s", key, strings.ToLower(word)))
				stringDone = true
			}
		case float64:
			if !numberDone {
				queries = append(queries, fmt.Sprintf("%s:>=%v", key, value))
				numberDone = true
			}
		}
	}
	return queries
}

func captureSampleAnswers(t *testing.T, ts *httptest.Server, sources []string, baseline *sampleAnswers) sampleAnswers {
	t.Helper()
	out := sampleAnswers{queries: map[string][]string{}, answers: map[string]string{}, clockStamped: map[string]bool{}}
	for _, source := range sources {
		var qs []string
		if baseline != nil {
			qs = baseline.queries[source]
			out.clockStamped[source] = baseline.clockStamped[source]
		} else {
			rows := rowsFor(t, ts, source)
			qs = sampleQueries(rows)
			out.clockStamped[source] = clockStamped(rows)
		}
		out.queries[source] = qs
		for _, q := range qs {
			for _, page := range []struct{ offset, limit int }{{0, 100}, {150, 50}} {
				params := url.Values{
					"_src": {source}, "query": {q}, "limit": {fmt.Sprint(page.limit)}, "offset": {fmt.Sprint(page.offset)},
					"sort_order": {"desc"}, "start_date": {"2000-01-01T00:00:00Z"}, "end_date": {"2100-01-01T00:00:00Z"},
					"include_distribution": {"true"}, "include_facets": {"true"},
				}
				out.answers[fmt.Sprintf("%s|%s|%d", source, q, page.offset)] = getNormalized(t, ts, "/api/v1/logs?"+params.Encode(), out.clockStamped[source])
			}
		}
	}
	// The sources catalog rebuilt from the indexes exercises SourceStats.
	if code := do(t, ts, http.MethodPost, "/api/v1/sources/rebuild", nil, nil); code != http.StatusOK {
		t.Fatalf("rebuild sources: %d", code)
	}
	var list types.SourcesResponse
	if code := do(t, ts, http.MethodGet, "/api/v1/sources", nil, &list); code != http.StatusOK {
		t.Fatalf("list sources: %d", code)
	}
	var summary []string
	for _, entry := range list.Sources {
		if out.clockStamped[entry.Name] {
			summary = append(summary, fmt.Sprintf("%s rows=%d", entry.Name, entry.Rows))
			continue
		}
		summary = append(summary, fmt.Sprintf("%s rows=%d days=%v first=%s last=%s", entry.Name, entry.Rows, entry.Days, formatTSPtr(entry.FirstTS), formatTSPtr(entry.LastTS)))
	}
	sort.Strings(summary)
	out.sources = strings.Join(summary, "\n")
	return out
}

// sampleRunStart separates wall-clock-stamped rows from real log times.
var sampleRunStart = time.Now().Add(-time.Minute)

func clockStamped(rows []map[string]any) bool {
	for _, row := range rows {
		raw, _ := row["timestamp"].(string)
		if ts, err := time.Parse(time.RFC3339Nano, raw); err == nil && ts.After(sampleRunStart) {
			return true
		}
	}
	return false
}

func getNormalized(t *testing.T, ts *httptest.Server, path string, clockStamped bool) string {
	t.Helper()
	resp, err := http.Get(ts.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Sprintf("HTTP %d %s", resp.StatusCode, body)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	delete(decoded, "time_taken")
	delete(decoded, "index_query_time")
	if clockStamped {
		delete(decoded, "log_distribution")
		if logs, ok := decoded["logs"].([]any); ok {
			for _, entry := range logs {
				if row, ok := entry.(map[string]any); ok {
					delete(row, "_id")
					delete(row, "timestamp")
				}
			}
		}
	}
	normalized, _ := json.Marshal(decoded)
	return string(normalized)
}

func compareSampleAnswers(t *testing.T, stage string, want, got sampleAnswers) {
	t.Helper()
	if !reflect.DeepEqual(got.queries, want.queries) {
		t.Fatalf("%s: query sets differ", stage)
	}
	checked := 0
	for key, wantBody := range want.answers {
		if gotBody := got.answers[key]; gotBody != wantBody {
			at := firstDifference(gotBody, wantBody)
			t.Errorf("%s: %s differs at byte %d\n got: …%s…\nwant: …%s…", stage, key, at, window(gotBody, at), window(wantBody, at))
		}
		checked++
	}
	if got.sources != want.sources {
		t.Errorf("%s: sources catalog differs\n got: %s\nwant: %s", stage, got.sources, want.sources)
	}
	t.Logf("%s: %d answers identical across %d sources", stage, checked, len(want.queries))
}

func storageTotal(t *testing.T, ts *httptest.Server) int64 {
	t.Helper()
	var resp types.StorageResponse
	if code := do(t, ts, http.MethodGet, "/api/v1/storage", nil, &resp); code != http.StatusOK {
		t.Fatalf("GET /storage: %d", code)
	}
	return resp.TotalBytes
}

func formatTSPtr(ts *time.Time) string {
	if ts == nil {
		return "-"
	}
	return ts.UTC().Format(time.RFC3339Nano)
}

// sampleGlobs picks the sample files. The default covers each input shape
// (bracketed dates, JSON, multiline, no-year syslog, wall-clock-stamped)
// quickly enough for the per-PR race run; LOGSONIC_SAMPLE_GLOB='*.log' runs
// every file (the nightly workflow does), or names one file to debug.
func sampleGlobs() []string {
	if glob := os.Getenv("LOGSONIC_SAMPLE_GLOB"); glob != "" {
		return []string{glob}
	}
	return []string{"apache.log", "app-json.log", "hdfs.log", "java-stacktrace.log", "syslog-multiline.log"}
}

func firstDifference(a, b string) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return i
		}
	}
	if len(a) < len(b) {
		return len(a)
	}
	return len(b)
}

func window(s string, at int) string {
	start, end := at-200, at+300
	if start < 0 {
		start = 0
	}
	if end > len(s) {
		end = len(s)
	}
	return s[start:end]
}

func hasDayBefore(t *testing.T, store *storage.Storage, today string) bool {
	t.Helper()
	dates, err := store.List()
	if err != nil {
		t.Fatal(err)
	}
	for _, date := range dates {
		if date < today {
			return true
		}
	}
	return false
}
