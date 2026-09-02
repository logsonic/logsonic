package server

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"logsonic/pkg/types"
)

// fixtureLines has everything the browser upload path normalises -- a BOM,
// CRLF, an empty line, and no trailing newline -- so the parity test would
// catch a divergence between the two ingest routes.
func fixtureLines(n int) (raw string, expected []string) {
	var b strings.Builder
	b.WriteString("\xEF\xBB\xBF")
	for i := 0; i < n; i++ {
		line := "INFO api request " + strings.Repeat("x", i%7) + " #" + strconv.Itoa(i)
		expected = append(expected, line)
		b.WriteString(line)
		if i == 2 {
			b.WriteString("\r\n\r\n") // blank line dropped
		} else if i < n-1 {
			b.WriteString("\r\n")
		}
	}
	return b.String(), expected
}

func startSession(t *testing.T, ts *httptest.Server, source string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"name": "PARITY", "pattern": "%{WORD:level} %{WORD:service} %{GREEDYDATA:message}", "source": source, "meta": map[string]string{"_src": source},
	})
	resp, err := http.Post(ts.URL+"/api/v1/ingest/start", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	sid, _ := out["session_id"].(string)
	if sid == "" {
		t.Fatalf("no session: %v", out)
	}
	return sid
}

func endSession(t *testing.T, ts *httptest.Server, sid string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"session_id": sid})
	resp, err := http.Post(ts.URL+"/api/v1/ingest/end", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
}

func ingestFile(t *testing.T, ts *httptest.Server, sid, path string, rotated bool) (int, types.IngestFileResponse) {
	t.Helper()
	body, _ := json.Marshal(types.IngestFileRequest{SessionID: sid, Path: path, IncludeRotated: rotated})
	resp, err := http.Post(ts.URL+"/api/v1/ingest/file", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out types.IngestFileResponse
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func rowsFor(t *testing.T, ts *httptest.Server, source string) []map[string]any {
	t.Helper()
	params := url.Values{"limit": {"1000"}, "_src": {source}, "sort_order": {"asc"}, "start_date": {"2000-01-01T00:00:00Z"}, "end_date": {"2100-01-01T00:00:00Z"}}
	resp, err := http.Get(ts.URL + "/api/v1/logs?" + params.Encode())
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out types.LogResponse
	json.NewDecoder(resp.Body).Decode(&out)
	return out.Logs
}

// H2: the chunk endpoint and the path endpoint store identical documents for
// the same input (field-for-field, in the same order), which is the property
// that makes the ingestBatch extraction safe.
func TestIngestFileParityWithChunkUpload(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	raw, expected := fixtureLines(500)
	dir := t.TempDir()
	path := filepath.Join(dir, "parity.log")
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}

	// Chunk route: two JSON chunks, lines normalised the way FileSelectionService does.
	sidChunk := startSession(t, ts, "chunk.log")
	for _, chunk := range [][]string{expected[:200], expected[200:]} {
		body, _ := json.Marshal(map[string]any{"logs": chunk, "session_id": sidChunk})
		resp, err := http.Post(ts.URL+"/api/v1/ingest/logs", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	endSession(t, ts, sidChunk)

	// Path route: the same bytes, straight from disk.
	sidFile := startSession(t, ts, "file.log")
	status, out := ingestFile(t, ts, sidFile, path, false)
	endSession(t, ts, sidFile)
	if status != http.StatusOK || out.Status != "success" {
		t.Fatalf("ingest/file: %d %+v", status, out)
	}
	if out.Processed != 500 || out.Failed != 0 || out.Lines != 501 || out.Compression != "" {
		t.Fatalf("response = %+v, want 500 processed, 501 physical lines (one blank), no compression", out)
	}

	a := rowsFor(t, ts, "chunk.log")
	b := rowsFor(t, ts, "file.log")
	if len(a) != 500 || len(b) != 500 {
		t.Fatalf("rows: chunk %d, file %d", len(a), len(b))
	}
	for i := range a {
		for _, field := range []string{"_raw", "level", "service", "message"} {
			if a[i][field] != b[i][field] {
				t.Fatalf("row %d field %s: chunk=%v file=%v", i, field, a[i][field], b[i][field])
			}
		}
	}
	if raw, _ := a[0]["_raw"].(string); !strings.HasPrefix(raw, "INFO api request") || strings.ContainsRune(raw, '\uFEFF') {
		t.Fatalf("first row must be BOM-free and start with the fixture text: %q", raw)
	}
}

// H4: rotated members under one session and source, oldest first, gzip member
// sniffed; a bad path fails before any row is stored.
func TestIngestFileRotatedAndErrors(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	dir := t.TempDir()
	write := func(name, content string) string {
		p := filepath.Join(dir, name)
		os.WriteFile(p, []byte(content), 0o644)
		return p
	}
	var gzBuf bytes.Buffer
	gw := gzip.NewWriter(&gzBuf)
	gw.Write([]byte("INFO api oldest\n"))
	gw.Close()
	write("app.log.2.gz", gzBuf.String())
	write("app.log.1", "INFO api middle\n")
	base := write("app.log", "INFO api newest\n")

	sid := startSession(t, ts, "rot.log")
	status, out := ingestFile(t, ts, sid, base, true)
	endSession(t, ts, sid)
	if status != http.StatusOK || out.Processed != 3 || len(out.Members) != 3 {
		t.Fatalf("rotated ingest: %d %+v", status, out)
	}
	if filepath.Base(out.Members[0]) != "app.log.2.gz" || filepath.Base(out.Members[2]) != "app.log" {
		t.Fatalf("member order: %v", out.Members)
	}
	rows := rowsFor(t, ts, "rot.log")
	if len(rows) != 3 || !strings.Contains(rows[0]["_raw"].(string), "oldest") || !strings.Contains(rows[2]["_raw"].(string), "newest") {
		t.Fatalf("rows out of order: %v", rows)
	}

	// Error paths: relative, directory, missing, bad session.
	for _, bad := range []string{"relative.log", dir, filepath.Join(dir, "missing.log")} {
		status, out := ingestFile(t, ts, sid, bad, false)
		if status != http.StatusBadRequest {
			t.Errorf("path %q: status %d (%+v)", bad, status, out)
		}
	}
	status, _ = ingestFile(t, ts, "no-such-session", base, false)
	if status != http.StatusBadRequest {
		t.Errorf("bad session: status %d", status)
	}
}

// The now-09 threat model requires JSON-only bodies on mutating routes so a
// cross-origin `<form enctype="text/plain">` can't reach them without a CORS
// preflight; /ingest/file sits outside the timeout group that normally
// carries that check, so it needs its own. This also confirms the session is
// validated before the path is ever opened, so an invalid session can't be
// used to probe whether an arbitrary local path exists.
func TestIngestFileRejectsNonJSONAndChecksSessionFirst(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	dir := t.TempDir()

	body, _ := json.Marshal(types.IngestFileRequest{SessionID: "whatever", Path: filepath.Join(dir, "app.log")})
	resp, err := http.Post(ts.URL+"/api/v1/ingest/file", "text/plain", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("text/plain body: status %d, want 415", resp.StatusCode)
	}

	body, _ = json.Marshal(types.IngestFileRequest{SessionID: "no-such-session", Path: filepath.Join(dir, "does-not-exist.log")})
	resp, err = http.Post(ts.URL+"/api/v1/ingest/file", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var errOut types.ErrorResponse
	json.NewDecoder(resp.Body).Decode(&errOut)
	if resp.StatusCode != http.StatusBadRequest || errOut.Code != "INVALID_SESSION" {
		t.Fatalf("bad session + missing path: status %d, code %q, want 400 INVALID_SESSION (session must be checked before the path is opened)", resp.StatusCode, errOut.Code)
	}
}
