package server

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

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

// ingestFile posts the job start request. The 202 response only carries the
// job id and member list now (spec now-08 phase 2) -- callers that need the
// result poll pollIngestJob.
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

// pollIngestJob polls GET /ingest/jobs until jobID reaches a terminal state
// (done|cancelled|error) or timeout elapses.
func pollIngestJob(t *testing.T, ts *httptest.Server, jobID string, timeout time.Duration) types.IngestJob {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		resp, err := http.Get(ts.URL + "/api/v1/ingest/jobs")
		if err != nil {
			t.Fatal(err)
		}
		var out types.IngestJobsListResponse
		json.NewDecoder(resp.Body).Decode(&out)
		resp.Body.Close()
		for _, j := range out.Jobs {
			if j.JobID == jobID && j.State != "running" {
				return j
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("job %s did not reach a terminal state within %s", jobID, timeout)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func cancelIngestJob(t *testing.T, ts *httptest.Server, jobID string) (int, types.IngestJobActionResponse) {
	t.Helper()
	req, err := http.NewRequest(http.MethodDelete, ts.URL+"/api/v1/ingest/jobs/"+jobID, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out types.IngestJobActionResponse
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

	// Path route: the same bytes, straight from disk. Poll to a terminal
	// state before ending the session -- ending it while the job is still
	// running would fail its next batch with an invalid-session error.
	sidFile := startSession(t, ts, "file.log")
	status, accepted := ingestFile(t, ts, sidFile, path, false)
	if status != http.StatusAccepted || accepted.Status != "accepted" || accepted.JobID == "" {
		t.Fatalf("ingest/file: %d %+v", status, accepted)
	}
	job := pollIngestJob(t, ts, accepted.JobID, 5*time.Second)
	endSession(t, ts, sidFile)
	if job.State != "done" || job.RowsStored != 500 || job.RowsFailed != 0 || job.Lines != 501 || job.Compression != "" {
		t.Fatalf("job = %+v, want done/500 stored/501 physical lines (one blank)/no compression", job)
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
// sniffed; a bad path fails synchronously (before any job is even created).
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
	status, accepted := ingestFile(t, ts, sid, base, true)
	if status != http.StatusAccepted || len(accepted.Members) != 3 {
		t.Fatalf("rotated ingest: %d %+v", status, accepted)
	}
	if filepath.Base(accepted.Members[0]) != "app.log.2.gz" || filepath.Base(accepted.Members[2]) != "app.log" {
		t.Fatalf("member order: %v", accepted.Members)
	}
	job := pollIngestJob(t, ts, accepted.JobID, 5*time.Second)
	endSession(t, ts, sid)
	if job.State != "done" || job.RowsStored != 3 {
		t.Fatalf("job = %+v, want done/3 stored", job)
	}
	rows := rowsFor(t, ts, "rot.log")
	if len(rows) != 3 || !strings.Contains(rows[0]["_raw"].(string), "oldest") || !strings.Contains(rows[2]["_raw"].(string), "newest") {
		t.Fatalf("rows out of order: %v", rows)
	}

	// Error paths: relative, directory, missing -- all fail before a job
	// exists, so still a synchronous 400.
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
// preflight; /ingest/file is a fast (202) route inside the normal timeout
// group, which already carries that check via the group's requireJSONBody.
// This also confirms the session is validated before the path is ever
// opened, so an invalid session can't be used to probe whether an arbitrary
// local path exists.
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

// H3: cancelling mid-job via DELETE stops it (state "cancelled", not
// "done"), and the session remains endable afterwards.
func TestIngestFileCancelViaDelete(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	dir := t.TempDir()
	// Large enough that the goroutine is very unlikely to finish before the
	// DELETE below reaches it.
	raw, _ := fixtureLines(200_000)
	path := filepath.Join(dir, "big.log")
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}

	sid := startSession(t, ts, "big.log")
	status, accepted := ingestFile(t, ts, sid, path, false)
	if status != http.StatusAccepted {
		t.Fatalf("ingest/file: %d %+v", status, accepted)
	}
	cancelStatus, cancelOut := cancelIngestJob(t, ts, accepted.JobID)
	if cancelStatus != http.StatusOK {
		t.Fatalf("DELETE ingest job: %d %+v", cancelStatus, cancelOut)
	}
	if cancelOut.Status != "cancelling" && cancelOut.Status != "cancelled" && cancelOut.Status != "done" {
		t.Fatalf("unexpected cancel response: %+v", cancelOut)
	}

	job := pollIngestJob(t, ts, accepted.JobID, 5*time.Second)
	if job.State != "cancelled" {
		t.Fatalf("job state = %q, want cancelled (cancelOut was %+v; if this is flaky the fixture finished before DELETE landed)", job.State, cancelOut)
	}
	if job.RowsStored >= 200_000 {
		t.Fatalf("job stored all %d rows despite cancellation", job.RowsStored)
	}

	// The session must still be closable after a cancelled job.
	body, _ := json.Marshal(map[string]any{"session_id": sid})
	resp, err := http.Post(ts.URL+"/api/v1/ingest/end", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("ingest/end after cancel: %d", resp.StatusCode)
	}

	// Cancelling again (already terminal) is a no-op that reports the
	// terminal state, not an error.
	status2, out2 := cancelIngestJob(t, ts, accepted.JobID)
	if status2 != http.StatusOK || out2.Status != "cancelled" {
		t.Fatalf("re-cancel: %d %+v, want 200 cancelled", status2, out2)
	}
}

func TestCancelUnknownIngestJobReturns404(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	status, _ := cancelIngestJob(t, ts, "no-such-job")
	if status != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", status)
	}
}

// H6 (analog): a server-shutdown cancellation is delivered to a job the same
// way DELETE is -- through the job's context. Rather than exercise the whole
// Start()/signal/Shutdown() sequence, this drives the same mechanism
// directly: StartIngestJobs with an already-cancelled context means the very
// first ctx check inside the reader sees it, so the job started after must
// come back cancelled, deterministically and fast.
func TestIngestFileCancelledByServerShutdownContext(t *testing.T) {
	srv, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // simulate: shutdown already in progress
	srv.services.StartIngestJobs(ctx)

	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	if err := os.WriteFile(path, []byte("INFO api one\nINFO api two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sid := startSession(t, ts, "shutdown.log")
	status, accepted := ingestFile(t, ts, sid, path, false)
	if status != http.StatusAccepted {
		t.Fatalf("ingest/file: %d %+v", status, accepted)
	}
	job := pollIngestJob(t, ts, accepted.JobID, 2*time.Second)
	if job.State != "cancelled" {
		t.Fatalf("job state = %q, want cancelled (shutdown ctx pre-cancelled)", job.State)
	}
}

// nextSSEEvent reads one "event: name\ndata: json\n\n" frame, skipping
// comment-only frames (the heartbeat's ": ping\n\n").
func nextSSEEvent(t *testing.T, reader *bufio.Reader) (name, data string) {
	t.Helper()
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read SSE line: %v", err)
		}
		line = strings.TrimRight(line, "\n")
		switch {
		case line == "":
			if name != "" {
				return name, data
			}
			// comment-only frame (heartbeat); keep reading.
		case strings.HasPrefix(line, "event: "):
			name = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			data = strings.TrimPrefix(line, "data: ")
		}
	}
}

// H1 (SSE half): "ingest_progress" reaches a subscriber on /live/events and
// eventually reports state "done" for the right job.
func TestIngestFilePublishesProgressOverSSE(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	dir := t.TempDir()
	raw, _ := fixtureLines(50)
	path := filepath.Join(dir, "sse.log")
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}

	sseCtx, sseCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer sseCancel()
	req, err := http.NewRequestWithContext(sseCtx, http.MethodGet, ts.URL+"/api/v1/live/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)

	sid := startSession(t, ts, "sse.log")
	status, accepted := ingestFile(t, ts, sid, path, false)
	if status != http.StatusAccepted {
		t.Fatalf("ingest/file: %d %+v", status, accepted)
	}

	var sawDone bool
	for i := 0; i < 200 && !sawDone; i++ {
		name, data := nextSSEEvent(t, reader)
		if name != "ingest_progress" {
			continue // hello / other events
		}
		var job types.IngestJob
		if err := json.Unmarshal([]byte(data), &job); err != nil {
			t.Fatalf("decode ingest_progress: %v (%q)", err, data)
		}
		if job.JobID != accepted.JobID {
			continue
		}
		if job.State == "done" {
			sawDone = true
		}
	}
	if !sawDone {
		t.Fatal("never saw an ingest_progress event with state done for our job")
	}
	endSession(t, ts, sid)
}
