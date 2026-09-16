package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"logsonic/pkg/types"
)

func getJSON(t *testing.T, ts *httptest.Server, path string, out any) int {
	t.Helper()
	resp, err := http.Get(ts.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil {
		_ = json.NewDecoder(resp.Body).Decode(out)
	}
	return resp.StatusCode
}

func postChunk(t *testing.T, ts *httptest.Server, sid string, lines []string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"logs": lines, "session_id": sid})
	resp, err := http.Post(ts.URL+"/api/v1/ingest/logs", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
}

// Spec now-10 C1 at the HTTP level: a chunk upload and a path import each
// produce a catalog entry with the right rows, origin, pattern and import
// history; /info carries the names and counts; the file is persisted.
func TestSourcesCatalogFollowsBothIngestRoutes(t *testing.T) {
	srv, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	raw, expected := fixtureLines(120)
	path := filepath.Join(t.TempDir(), "imported.log")
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}

	sidChunk := startSession(t, ts, "chunk.log")
	postChunk(t, ts, sidChunk, expected[:50])
	postChunk(t, ts, sidChunk, expected[50:])
	endSession(t, ts, sidChunk)

	// The server records the canonical path (macOS: /var → /private/var).
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}

	sidFile := startSession(t, ts, "file.log")
	status, accepted := ingestFile(t, ts, sidFile, path, false)
	if status != http.StatusAccepted {
		t.Fatalf("ingest/file: %d %+v", status, accepted)
	}
	job := pollIngestJob(t, ts, accepted.JobID, 5*time.Second)
	endSession(t, ts, sidFile)
	if job.State != "done" || job.RowsStored != 120 {
		t.Fatalf("job: %+v", job)
	}

	var list types.SourcesResponse
	if code := getJSON(t, ts, "/api/v1/sources", &list); code != 200 {
		t.Fatalf("GET /sources: %d", code)
	}
	// startSession mirrors the wizard: source "chunk.log" plus
	// meta._src "chunk.log" — the stored _src (what meta stamps) is the
	// catalog key. Here both agree; TestSourcesCatalogKeysOnStoredSrc
	// covers the wizard's real "file.<name>" case.
	if len(list.Sources) != 2 || list.Sources[0].Name != "chunk.log" || list.Sources[1].Name != "file.log" {
		t.Fatalf("sources: %+v", list.Sources)
	}
	chunk, file := list.Sources[0], list.Sources[1]
	if chunk.Rows != 120 || chunk.Origin.Kind != "file" || chunk.Origin.Path != "" || chunk.PatternName != "PARITY" {
		t.Errorf("chunk entry: %+v", chunk)
	}
	if len(chunk.Imports) != 1 || chunk.Imports[0].Rows != 120 || chunk.Imports[0].JobID != "" {
		t.Errorf("chunk imports (two chunks, one session → one import): %+v", chunk.Imports)
	}
	if file.Rows != 120 || file.Origin.Kind != "file" || file.Origin.Path != canonical {
		t.Errorf("file entry: %+v", file)
	}
	if len(file.Imports) != 1 || file.Imports[0].JobID != accepted.JobID || file.Imports[0].Path != canonical {
		t.Errorf("file imports: %+v", file.Imports)
	}
	if file.BytesRaw <= 0 || len(file.Days) != 1 || file.FirstTS == nil || file.LastTS == nil {
		t.Errorf("file derived fields: bytes %d days %v first %v last %v", file.BytesRaw, file.Days, file.FirstTS, file.LastTS)
	}

	var one types.SourceEntry
	if code := getJSON(t, ts, "/api/v1/sources/file.log", &one); code != 200 || one.Name != "file.log" {
		t.Fatalf("GET /sources/file.log: %d %+v", code, one)
	}
	var errResp types.ErrorResponse
	if code := getJSON(t, ts, "/api/v1/sources/nope.log", &errResp); code != 404 || errResp.Code != "SOURCE_NOT_FOUND" {
		t.Fatalf("GET /sources/nope.log: %d %+v", code, errResp)
	}

	var info types.SystemInfoResponse
	getJSON(t, ts, "/api/v1/info", &info)
	if names := info.StorageInfo.SourceNames; len(names) != 2 || names[0] != "chunk.log" || names[1] != "file.log" {
		t.Errorf("/info source_names: %v", names)
	}
	if s := info.StorageInfo.Sources; len(s) != 2 || s[0].Rows != 120 || s[1].Rows != 120 {
		t.Errorf("/info sources: %+v", s)
	}

	// Persisted (debounced): force the flush the ticker would do.
	if err := srv.services.Catalog.Flush(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(srv.config.StoragePath, "sources.json"))
	if err != nil {
		t.Fatal(err)
	}
	var disk struct {
		Version int                 `json:"version"`
		Sources []types.SourceEntry `json:"sources"`
	}
	if err := json.Unmarshal(b, &disk); err != nil || disk.Version != 1 || len(disk.Sources) != 2 {
		t.Fatalf("sources.json: %v %+v", err, disk)
	}
}

// Clear and delete-by-ids bypass the write path; the catalog must follow
// them, and POST /sources/rebuild must be a no-op afterwards.
func TestSourcesCatalogFollowsClearAndDeleteByIds(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	_, expected := fixtureLines(30)
	sid := startSession(t, ts, "a.log")
	postChunk(t, ts, sid, expected)
	endSession(t, ts, sid)

	rows := rowsFor(t, ts, "a.log")
	if len(rows) != 30 {
		t.Fatalf("rows: %d", len(rows))
	}
	ids := make([]string, 0, 10)
	for _, r := range rows[:10] {
		ids = append(ids, r["_id"].(string))
	}
	body, _ := json.Marshal(map[string]any{"ids": ids})
	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/v1/logs/ids", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("DELETE /logs/ids: %d", resp.StatusCode)
	}
	var one types.SourceEntry
	getJSON(t, ts, "/api/v1/sources/a.log", &one)
	if one.Rows != 20 || one.Origin.Kind != "file" || one.PatternName != "PARITY" {
		t.Fatalf("after deleting 10 of 30 rows: rows %d (merge must keep origin/pattern: %+v)", one.Rows, one)
	}

	var rebuilt types.SourcesResponse
	resp, err = http.Post(ts.URL+"/api/v1/sources/rebuild", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = json.NewDecoder(resp.Body).Decode(&rebuilt)
	resp.Body.Close()
	if resp.StatusCode != 200 || len(rebuilt.Sources) != 1 || rebuilt.Sources[0].Rows != 20 {
		t.Fatalf("POST /sources/rebuild: %d %+v", resp.StatusCode, rebuilt.Sources)
	}

	req, _ = http.NewRequest(http.MethodDelete, ts.URL+"/api/v1/logs", nil)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	var list types.SourcesResponse
	getJSON(t, ts, "/api/v1/sources", &list)
	if len(list.Sources) != 0 {
		t.Fatalf("after DELETE /logs the catalog should be empty, got %+v", list.Sources)
	}
	var info types.SystemInfoResponse
	getJSON(t, ts, "/api/v1/info", &info)
	if len(info.StorageInfo.SourceNames) != 0 || len(info.StorageInfo.Sources) != 0 {
		t.Fatalf("/info after clear: %+v", info.StorageInfo)
	}
}

// The import wizard sends source "<name>" and meta._src "file.<name>";
// postProcess lets meta win, so the stored _src — and therefore the value
// SourceTabs / the _src facet / the source filter all see — is
// "file.<name>". The catalog must key on that, not on Options.Source.
func TestSourcesCatalogKeysOnStoredSrc(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	body, _ := json.Marshal(map[string]any{
		"name": "WIZ", "pattern": "%{WORD:level} %{GREEDYDATA:message}",
		"source": "app.log", "meta": map[string]string{"_src": "file.app.log"},
	})
	resp, err := http.Post(ts.URL+"/api/v1/ingest/start", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var started types.IngestResponse
	_ = json.NewDecoder(resp.Body).Decode(&started)
	resp.Body.Close()
	postChunk(t, ts, started.SessionID, []string{"INFO one", "WARN two"})
	endSession(t, ts, started.SessionID)

	var list types.SourcesResponse
	getJSON(t, ts, "/api/v1/sources", &list)
	if len(list.Sources) != 1 || list.Sources[0].Name != "file.app.log" || list.Sources[0].Rows != 2 {
		t.Fatalf("catalog must be keyed on the stored _src: %+v", list.Sources)
	}
	var info types.SystemInfoResponse
	getJSON(t, ts, "/api/v1/info", &info)
	if names := info.StorageInfo.SourceNames; len(names) != 1 || names[0] != "file.app.log" {
		t.Fatalf("/info source_names: %v", names)
	}
	// And the name the catalog reports is one the source filter accepts.
	if rows := rowsFor(t, ts, "file.app.log"); len(rows) != 2 {
		t.Fatalf("filter by catalog name: %d rows", len(rows))
	}
}
