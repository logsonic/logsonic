package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/types"
)

func TestMixedAutoIngestSurvivesRestartAndReimport(t *testing.T) {
	for _, engine := range []string{"bleve", "template"} {
		t.Run(engine, func(t *testing.T) {
			storagePath := t.TempDir()
			cfg := Config{Host: "localhost", Port: ":0", StoragePath: storagePath, StorageEngine: engine, Timeout: 10 * time.Second}
			open := func() (*Server, *httptest.Server) {
				srv, err := NewServer(cfg)
				if err != nil {
					t.Fatalf("NewServer(%s): %v", engine, err)
				}
				return srv, httptest.NewServer(srv.router)
			}
			srv, ts := open()
			t.Cleanup(func() {
				ts.Close()
				if err := srv.Close(); err != nil {
					t.Errorf("close server: %v", err)
				}
			})

			apache := []string{
				`192.168.1.1 - - [23/Jan/2026:14:05:01 +0000] "GET / HTTP/1.1" 200 1 "-" "ua"`,
				`10.0.0.1 - - [23/Jan/2026:14:05:02 +0000] "GET /a HTTP/1.1" 200 2 "-" "ua"`,
				`10.0.0.2 - - [23/Jan/2026:14:05:03 +0000] "GET /b HTTP/1.1" 200 3 "-" "ua"`,
			}
			syslog := []string{
				`Jan 23 14:05:04 host sshd[111]: Accepted password for root from 10.0.0.3 port 22 ssh2`,
				`Jan 23 14:05:05 host sshd[112]: Failed password for invalid user x from 10.0.0.4 port 22 ssh2`,
			}
			mixedSource := "mixed.auto.log"
			var started types.IngestResponse
			if code := do(t, ts, http.MethodPost, "/api/v1/ingest/start", map[string]any{
				"pattern": "auto", "source": mixedSource, "meta": map[string]string{"_src": mixedSource},
			}, &started); code != http.StatusOK || started.SessionID == "" {
				t.Fatalf("start mixed auto: status=%d response=%+v", code, started)
			}
			postChunk(t, ts, started.SessionID, apache)
			rawLines := []string{"", "  \t", "@@@ !? [punctuation]"}
			postChunk(t, ts, started.SessionID, append(append([]string{}, syslog...), rawLines...))
			endSession(t, ts, started.SessionID)

			wantRaw := append(append(append([]string{}, apache...), syslog...), rawLines...)
			assertMixedRows(t, rowsFor(t, ts, mixedSource), mixedSource, wantRaw, syslog, rawLines)
			var mixedEntry types.SourceEntry
			if code := do(t, ts, http.MethodGet, "/api/v1/sources/"+mixedSource, nil, &mixedEntry); code != http.StatusOK {
				t.Fatalf("get mixed source: %d", code)
			}
			if mixedEntry.Rows != int64(len(wantRaw)) || mixedEntry.Pattern != "auto" || mixedEntry.PatternName == "" || mixedEntry.PatternName == "auto" {
				t.Fatalf("mixed source catalog should retain auto options and primary label: %+v", mixedEntry)
			}

			// Seed a path-backed auto import so a restart followed by reimport
			// proves the catalog persisted pattern=auto rather than a frozen winner.
			pathSource := "path.auto.log"
			path := filepath.Join(t.TempDir(), "apache.log")
			if err := os.WriteFile(path, []byte(strings.Join(apache, "\n")+"\n"), 0600); err != nil {
				t.Fatal(err)
			}
			var pathSession types.IngestResponse
			if code := do(t, ts, http.MethodPost, "/api/v1/ingest/start", map[string]any{
				"pattern": "auto", "source": pathSource, "meta": map[string]string{"_src": pathSource},
			}, &pathSession); code != http.StatusOK || pathSession.SessionID == "" {
				t.Fatalf("start path auto: %d %+v", code, pathSession)
			}
			status, accepted := ingestFile(t, ts, pathSession.SessionID, path, false)
			if status != http.StatusAccepted {
				t.Fatalf("accept path auto import: %d %+v", status, accepted)
			}
			job := pollIngestJob(t, ts, accepted.JobID, 10*time.Second)
			endSession(t, ts, pathSession.SessionID)
			if job.State != "done" || job.RowsStored != int64(len(apache)) {
				t.Fatalf("initial path auto job: %+v", job)
			}
			var pathEntry types.SourceEntry
			if code := do(t, ts, http.MethodGet, "/api/v1/sources/"+pathSource, nil, &pathEntry); code != http.StatusOK || pathEntry.ImportOptions == nil || pathEntry.ImportOptions.Pattern != "auto" {
				t.Fatalf("path import options did not preserve auto: status=%d entry=%+v", code, pathEntry)
			}

			// Reopen the same engine and verify indexed rows and catalog totals.
			ts.Close()
			if err := srv.Close(); err != nil {
				t.Fatalf("close before restart: %v", err)
			}
			srv, ts = open()
			if got := rowsFor(t, ts, mixedSource); len(got) != len(wantRaw) {
				t.Fatalf("rows after restart = %d, want %d", len(got), len(wantRaw))
			} else {
				assertMixedRows(t, got, mixedSource, wantRaw, syslog, rawLines)
			}
			if got := totalFor(t, ts, mixedSource); got != len(wantRaw) {
				t.Fatalf("mixed source search total after restart = %d, want %d", got, len(wantRaw))
			}
			if code := do(t, ts, http.MethodGet, "/api/v1/sources/"+mixedSource, nil, &mixedEntry); code != http.StatusOK || mixedEntry.Rows != int64(len(wantRaw)) {
				t.Fatalf("mixed catalog after restart: status=%d entry=%+v", code, mixedEntry)
			}
			if code := do(t, ts, http.MethodGet, "/api/v1/sources/"+pathSource, nil, &pathEntry); code != http.StatusOK || pathEntry.ImportOptions == nil || pathEntry.ImportOptions.Pattern != "auto" {
				t.Fatalf("path import options after restart: status=%d entry=%+v", code, pathEntry)
			}

			var reimport types.SourceReimportResponse
			if code := do(t, ts, http.MethodPost, "/api/v1/sources/"+pathSource+"/reimport", nil, &reimport); code != http.StatusAccepted || reimport.RowsDeleted != len(apache) {
				t.Fatalf("reimport auto source: status=%d response=%+v", code, reimport)
			}
			reimportJob := pollIngestJob(t, ts, reimport.JobID, 10*time.Second)
			if reimportJob.State != "done" || reimportJob.RowsStored != int64(len(apache)) {
				t.Fatalf("reimport job: %+v", reimportJob)
			}
			if got := totalFor(t, ts, pathSource); got != len(apache) {
				t.Fatalf("path source total after reimport = %d, want %d", got, len(apache))
			}
			if code := do(t, ts, http.MethodGet, "/api/v1/sources/"+pathSource, nil, &pathEntry); code != http.StatusOK || pathEntry.Rows != int64(len(apache)) || pathEntry.ImportOptions == nil || pathEntry.ImportOptions.Pattern != "auto" {
				t.Fatalf("path source after reimport: status=%d entry=%+v", code, pathEntry)
			}

			if code := do(t, ts, http.MethodDelete, "/api/v1/sources/"+mixedSource, nil, nil); code != http.StatusOK {
				t.Fatalf("delete mixed source: %d", code)
			}
			if got := totalFor(t, ts, mixedSource); got != 0 {
				t.Fatalf("mixed source rows after delete = %d", got)
			}
			if code := do(t, ts, http.MethodGet, "/api/v1/sources/"+mixedSource, nil, nil); code != http.StatusNotFound {
				t.Fatalf("mixed catalog entry after delete: status=%d", code)
			}
		})
	}
}

func assertMixedRows(t *testing.T, rows []map[string]any, source string, wantRaw, lateParsed, rawFallback []string) {
	t.Helper()
	if len(rows) != len(wantRaw) {
		t.Fatalf("rows for %q = %d, want %d: %#v", source, len(rows), len(wantRaw), rows)
	}
	gotRaw := make([]string, 0, len(rows))
	byRaw := make(map[string]map[string]any, len(rows))
	for _, row := range rows {
		raw, ok := row["_raw"].(string)
		if !ok {
			t.Fatalf("row missing string _raw: %#v", row)
		}
		if row["_src"] != source {
			t.Fatalf("row source = %v, want %q", row["_src"], source)
		}
		gotRaw = append(gotRaw, raw)
		byRaw[raw] = row
	}
	wantSorted := append([]string(nil), wantRaw...)
	sort.Strings(gotRaw)
	sort.Strings(wantSorted)
	if !reflect.DeepEqual(gotRaw, wantSorted) {
		t.Fatalf("raw rows differ:\n got=%q\nwant=%q", gotRaw, wantSorted)
	}
	for _, raw := range lateParsed {
		row := byRaw[raw]
		if row == nil || row["_parse_status"] != "parsed" {
			t.Fatalf("late known-family row was not structured: %q => %#v", raw, row)
		}
		if _, hasError := row["error"]; hasError {
			t.Fatalf("parsed late-family row carries error: %#v", row)
		}
	}
	for _, raw := range rawFallback {
		row := byRaw[raw]
		if row == nil || row["_parse_status"] != "raw" || row["message"] != raw {
			t.Fatalf("raw fallback row changed/lost: %q => %#v", raw, row)
		}
	}
}
