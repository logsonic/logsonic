package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/types"
)

func do(t *testing.T, ts *httptest.Server, method, path string, body any, out any) int {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	} else {
		reader = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, ts.URL+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil {
		_ = json.NewDecoder(resp.Body).Decode(out)
	}
	return resp.StatusCode
}

// timedLines produces n lines with explicit timestamps spread across the
// given days so the pattern's timestamp resolution puts them there.
func timedLines(days []string, perDay int) []string {
	var out []string
	for _, d := range days {
		for i := 0; i < perDay; i++ {
			out = append(out, fmt.Sprintf("%sT10:%02d:%02dZ INFO api line %d", d, i/60%60, i%60, i))
		}
	}
	return out
}

func startTimedSession(t *testing.T, ts *httptest.Server, source string) string {
	t.Helper()
	var started types.IngestResponse
	code := do(t, ts, http.MethodPost, "/api/v1/ingest/start", map[string]any{
		"name": "TIMED", "pattern": "%{TIMESTAMP_ISO8601:timestamp} %{WORD:level} %{WORD:service} %{GREEDYDATA:message}",
		"source": source, "meta": map[string]string{"_src": source},
	}, &started)
	if code != 200 || started.SessionID == "" {
		t.Fatalf("start: %d %+v", code, started)
	}
	return started.SessionID
}

func totalFor(t *testing.T, ts *httptest.Server, source string) int {
	t.Helper()
	params := url.Values{"limit": {"1"}, "_src": {source}, "start_date": {"2000-01-01T00:00:00Z"}, "end_date": {"2100-01-01T00:00:00Z"}}
	var out types.LogResponse
	do(t, ts, http.MethodGet, "/api/v1/logs?"+params.Encode(), nil, &out)
	return out.TotalCount
}

// C3: DELETE a source spanning 3 days with 30k rows; the other source on a
// shared day is intact; a day that held only the deleted source is removed
// from disk; the catalog no longer lists it and /info follows.
func TestC3_DeleteSourceAcrossDays(t *testing.T) {
	srv, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	days := []string{"2026-03-01", "2026-03-02", "2026-03-03"}
	sid := startTimedSession(t, ts, "a.log")
	lines := timedLines(days, 10000)
	for i := 0; i < len(lines); i += 5000 {
		postChunk(t, ts, sid, lines[i:i+5000])
	}
	endSession(t, ts, sid)
	sidB := startTimedSession(t, ts, "b.log")
	postChunk(t, ts, sidB, timedLines(days[:1], 25)) // shares 03-01 only
	endSession(t, ts, sidB)

	if n := totalFor(t, ts, "a.log"); n != 30000 {
		t.Fatalf("seed a.log: %d", n)
	}
	var entry types.SourceEntry
	do(t, ts, http.MethodGet, "/api/v1/sources/a.log", nil, &entry)
	if entry.Rows != 30000 || len(entry.Days) != 3 {
		t.Fatalf("catalog before: %+v", entry)
	}

	var resp types.SourceDeleteResponse
	code := do(t, ts, http.MethodDelete, "/api/v1/sources/a.log", nil, &resp)
	if code != 200 || resp.RowsDeleted != 30000 || len(resp.DaysTouched) != 3 {
		t.Fatalf("delete: %d %+v", code, resp)
	}
	if len(resp.DaysRemoved) != 2 || resp.DaysRemoved[0] != "2026-03-02" || resp.DaysRemoved[1] != "2026-03-03" {
		t.Fatalf("days removed (03-01 still holds b.log): %v", resp.DaysRemoved)
	}
	for _, d := range resp.DaysRemoved {
		if _, err := os.Stat(filepath.Join(srv.config.StoragePath, "logs-"+d+".bleve")); !os.IsNotExist(err) {
			t.Errorf("day %s still on disk", d)
		}
	}
	if n := totalFor(t, ts, "a.log"); n != 0 {
		t.Errorf("a.log rows after delete: %d", n)
	}
	if n := totalFor(t, ts, "b.log"); n != 25 {
		t.Errorf("b.log must be intact: %d", n)
	}
	if code := do(t, ts, http.MethodGet, "/api/v1/sources/a.log", nil, nil); code != 404 {
		t.Errorf("entry should be gone: %d", code)
	}
	var b types.SourceEntry
	do(t, ts, http.MethodGet, "/api/v1/sources/b.log", nil, &b)
	if b.Rows != 25 || len(b.Days) != 1 || b.Origin.Kind != "file" {
		t.Errorf("b.log entry after a.log delete: %+v", b)
	}
	var info types.SystemInfoResponse
	do(t, ts, http.MethodGet, "/api/v1/info", nil, &info)
	if names := info.StorageInfo.SourceNames; len(names) != 1 || names[0] != "b.log" {
		t.Errorf("/info after delete: %v", names)
	}
	if info.StorageInfo.TotalIndices != 1 {
		t.Errorf("/info total_indices after two days removed: %d", info.StorageInfo.TotalIndices)
	}
	// Second delete: 404, nothing to do.
	if code := do(t, ts, http.MethodDelete, "/api/v1/sources/a.log", nil, nil); code != 404 {
		t.Errorf("double delete: %d", code)
	}
}

// C4: a delete while a live tail writes the same source is refused with 409
// and a message naming the way out; after the tail stops it succeeds.
func TestC4_DeleteRefusedWhileTailActive(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	path := filepath.Join(t.TempDir(), "tail.log")
	if err := os.WriteFile(path, []byte("2026-03-01T10:00:00Z INFO api one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var live types.LiveSourceResponse
	code := do(t, ts, http.MethodPost, "/api/v1/live/files", types.LiveFileRequest{Path: path, Options: types.IngestSessionOptions{
		Name: "TIMED", Pattern: "%{TIMESTAMP_ISO8601:timestamp} %{WORD:level} %{WORD:service} %{GREEDYDATA:message}",
		Source: "tail.log", Meta: map[string]interface{}{"_src": "tail.log"},
	}}, &live)
	if code != 200 && code != 201 && code != 202 {
		t.Fatalf("live/files: %d %+v", code, live)
	}
	// A tail starts at end-of-file; append so it actually stores a row.
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	fmt.Fprintln(f, "2026-03-01T10:00:01Z INFO api two")
	f.Close()
	deadline := time.Now().Add(5 * time.Second)
	for totalFor(t, ts, "tail.log") == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	var errResp types.ErrorResponse
	if code := do(t, ts, http.MethodDelete, "/api/v1/sources/tail.log", nil, &errResp); code != 409 || errResp.Code != "SOURCE_IN_USE" || !strings.Contains(errResp.Details, "live tail") {
		t.Fatalf("delete during tail: %d %+v", code, errResp)
	}
	// A tail has an origin path, so it is re-importable in principle; the
	// only correct answer while it runs is the in-use conflict.
	if code := do(t, ts, http.MethodPost, "/api/v1/sources/tail.log/reimport", nil, &errResp); code != 409 || errResp.Code != "SOURCE_IN_USE" {
		t.Fatalf("reimport during tail must be 409: %d %+v", code, errResp)
	}
	if code := do(t, ts, http.MethodDelete, "/api/v1/live/sources/"+live.SourceID, nil, nil); code != 200 {
		t.Fatalf("stop tail: %d", code)
	}
	var resp types.SourceDeleteResponse
	if code := do(t, ts, http.MethodDelete, "/api/v1/sources/tail.log", nil, &resp); code != 200 || resp.RowsDeleted != 1 {
		t.Fatalf("delete after tail stopped: %d %+v", code, resp)
	}
}

// C7: rename → alias → the _src parameter finds rows by the stored name,
// the display name, and any previous display name; collisions are 409.
func TestC7_RenameAliasesResolveInSearch(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	for _, src := range []string{"file.app.log", "file.db.log"} {
		sid := startTimedSession(t, ts, src)
		postChunk(t, ts, sid, timedLines([]string{"2026-03-01"}, 5))
		endSession(t, ts, sid)
	}
	var entry types.SourceEntry
	code := do(t, ts, http.MethodPatch, "/api/v1/sources/file.app.log", types.SourceRenameRequest{DisplayName: "prod-app"}, &entry)
	if code != 200 || entry.DisplayName != "prod-app" || len(entry.Aliases) != 1 {
		t.Fatalf("rename: %d %+v", code, entry)
	}
	do(t, ts, http.MethodPatch, "/api/v1/sources/file.app.log", types.SourceRenameRequest{DisplayName: "prod-app-v2"}, &entry)
	for _, name := range []string{"file.app.log", "prod-app", "prod-app-v2"} {
		if n := totalFor(t, ts, name); n != 5 {
			t.Errorf("search by %q: %d rows, want 5", name, n)
		}
	}
	if n := totalFor(t, ts, "prod-app,file.db.log"); n != 10 {
		t.Errorf("alias + stored name together: %d, want 10", n)
	}
	var errResp types.ErrorResponse
	if code := do(t, ts, http.MethodPatch, "/api/v1/sources/file.db.log", types.SourceRenameRequest{DisplayName: "prod-app"}, &errResp); code != 409 || errResp.Code != "SOURCE_NAME_TAKEN" {
		t.Errorf("collision with another source's alias: %d %+v", code, errResp)
	}
	if code := do(t, ts, http.MethodPatch, "/api/v1/sources/file.db.log", types.SourceRenameRequest{DisplayName: " bad "}, &errResp); code != 400 {
		t.Errorf("untrimmed: %d", code)
	}
	if code := do(t, ts, http.MethodPatch, "/api/v1/sources/nope", types.SourceRenameRequest{DisplayName: "x"}, nil); code != 404 {
		t.Errorf("missing: %d", code)
	}
	// /info and the facet keep stored names (a click builds +_src:"…").
	var info types.SystemInfoResponse
	do(t, ts, http.MethodGet, "/api/v1/info", nil, &info)
	if names := info.StorageInfo.SourceNames; len(names) != 2 || names[0] != "file.app.log" {
		t.Errorf("/info must list stored names: %v", names)
	}
}

// Re-import: validates before deleting (a moved file deletes nothing),
// then delete + path job under the same _src; the session is ended by the
// job itself; the entry keeps its origin and gains an import row.
func TestReimportSource(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	path := filepath.Join(t.TempDir(), "re.log")
	if err := os.WriteFile(path, []byte(strings.Join(timedLines([]string{"2026-03-01", "2026-03-02"}, 40), "\n")), 0o644); err != nil {
		t.Fatal(err)
	}
	sid := startTimedSession(t, ts, "file.re.log")
	status, accepted := ingestFile(t, ts, sid, path, false)
	if status != http.StatusAccepted {
		t.Fatalf("ingest/file: %d", status)
	}
	if job := pollIngestJob(t, ts, accepted.JobID, 5*time.Second); job.State != "done" || job.RowsStored != 80 {
		t.Fatalf("seed job: %+v", job)
	}
	endSession(t, ts, sid)
	var before types.SourceEntry
	do(t, ts, http.MethodGet, "/api/v1/sources/file.re.log", nil, &before)
	if before.ImportOptions == nil || before.Origin.Path == "" || len(before.Imports) != 1 {
		t.Fatalf("entry before reimport: %+v", before)
	}
	// A rename must survive the re-import.
	do(t, ts, http.MethodPatch, "/api/v1/sources/file.re.log", types.SourceRenameRequest{DisplayName: "Re-log"}, nil)

	// Failure branch first: move the file away → 400, rows untouched.
	moved := path + ".moved"
	if err := os.Rename(path, moved); err != nil {
		t.Fatal(err)
	}
	var errResp types.ErrorResponse
	if code := do(t, ts, http.MethodPost, "/api/v1/sources/file.re.log/reimport", nil, &errResp); code != 400 || errResp.Code != "INVALID_PATH" || !strings.Contains(errResp.Details, "nothing was deleted") {
		t.Fatalf("reimport with missing file: %d %+v", code, errResp)
	}
	if n := totalFor(t, ts, "file.re.log"); n != 80 {
		t.Fatalf("rows must be untouched after a failed reimport: %d", n)
	}
	if err := os.Rename(moved, path); err != nil {
		t.Fatal(err)
	}

	// Add a line to the file so the re-import provably re-reads it.
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	fmt.Fprintln(f, "\n2026-03-03T10:00:00Z INFO api appended")
	f.Close()

	var re types.SourceReimportResponse
	if code := do(t, ts, http.MethodPost, "/api/v1/sources/file.re.log/reimport", nil, &re); code != http.StatusAccepted || re.RowsDeleted != 80 || re.JobID == "" {
		t.Fatalf("reimport: %d %+v", code, re)
	}
	job := pollIngestJob(t, ts, re.JobID, 5*time.Second)
	if job.State != "done" || job.RowsStored != 81 {
		t.Fatalf("reimport job: %+v", job)
	}
	if n := totalFor(t, ts, "file.re.log"); n != 81 {
		t.Fatalf("rows after reimport: %d", n)
	}
	var after types.SourceEntry
	do(t, ts, http.MethodGet, "/api/v1/sources/file.re.log", nil, &after)
	if after.Rows != 81 || after.Origin.Path != re.Path || after.PatternName != "TIMED" || len(after.Days) != 3 {
		t.Fatalf("entry after reimport: %+v", after)
	}
	if after.DisplayName != "Re-log" || len(after.Aliases) != 1 || !after.CreatedAt.Equal(before.CreatedAt) {
		t.Fatalf("re-import must keep the rename, aliases and created_at: %+v", after)
	}
	if len(after.Imports) != 2 || after.Imports[1].JobID != re.JobID {
		t.Fatalf("re-import appends to the import history: %+v", after.Imports)
	}
	// Between the 202 and the first batch the entry is present with zero
	// rows rather than absent (checked here after the fact through the
	// history: the original import row is still there).
	if after.Imports[0].JobID != accepted.JobID {
		t.Fatalf("original import row lost: %+v", after.Imports)
	}
	// The server-started session was ended by the job (no client calls
	// /ingest/end): a chunk against it is rejected as an invalid session.
	body, _ := json.Marshal(map[string]any{"logs": []string{"x"}, "session_id": re.SessionID})
	resp, _ := http.Post(ts.URL+"/api/v1/ingest/logs", "application/json", bytes.NewReader(body))
	var ingestResp types.IngestResponse
	_ = json.NewDecoder(resp.Body).Decode(&ingestResp)
	resp.Body.Close()
	if ingestResp.Status == "success" && ingestResp.Processed > 0 {
		t.Fatalf("re-import session should have been ended by the job: %+v", ingestResp)
	}
	// A browser-uploaded source is not re-importable.
	sidUp := startTimedSession(t, ts, "up.log")
	postChunk(t, ts, sidUp, timedLines([]string{"2026-03-01"}, 2))
	endSession(t, ts, sidUp)
	if code := do(t, ts, http.MethodPost, "/api/v1/sources/up.log/reimport", nil, &errResp); code != 400 || errResp.Code != "SOURCE_NOT_REIMPORTABLE" {
		t.Fatalf("browser upload reimport: %d %+v", code, errResp)
	}
}

// The _src facet is corpus-wide from the catalog (now-02 spec): every
// source with exact rows, regardless of the query's time window, stored
// names only; other fields stay window-scoped.
func TestSourceFacetComesFromCatalog(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	sidA := startTimedSession(t, ts, "file.a.log")
	postChunk(t, ts, sidA, timedLines([]string{"2026-03-01"}, 30))
	endSession(t, ts, sidA)
	sidB := startTimedSession(t, ts, "file.b.log")
	postChunk(t, ts, sidB, timedLines([]string{"2026-04-01"}, 7))
	endSession(t, ts, sidB)
	do(t, ts, http.MethodPatch, "/api/v1/sources/file.a.log", types.SourceRenameRequest{DisplayName: "A"}, nil)

	// Window covers only March → level facet sees 30 rows, _src sees both.
	params := url.Values{"limit": {"1"}, "include_facets": {"true"}, "start_date": {"2026-03-01T00:00:00Z"}, "end_date": {"2026-03-31T00:00:00Z"}}
	var out types.LogResponse
	do(t, ts, http.MethodGet, "/api/v1/logs?"+params.Encode(), nil, &out)
	if out.Facets == nil {
		t.Fatal("no facets")
	}
	var src, level *types.FacetField
	for i := range out.Facets.Fields {
		switch out.Facets.Fields[i].Name {
		case "_src":
			src = &out.Facets.Fields[i]
		case "level":
			level = &out.Facets.Fields[i]
		}
	}
	if src == nil || level == nil {
		t.Fatalf("fields: %+v", out.Facets.Fields)
	}
	if src.Distinct != 2 || len(src.Values) != 2 || src.Values[0].Value != "file.a.log" || src.Values[0].Count != 30 || src.Values[1].Value != "file.b.log" || src.Values[1].Count != 7 {
		t.Errorf("_src facet must be corpus-wide with stored names: %+v", src)
	}
	if level.Values[0].Count != 30 {
		t.Errorf("other facets stay window-scoped: %+v", level)
	}
}
