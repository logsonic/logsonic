package server

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"logsonic/pkg/server/handlers"
	"logsonic/pkg/types"
)

// previewMaxLines mirrors handlers.maxPreviewLines, which isn't exported
// (it happens to equal the exported handlers.MaxIngestLines, used here so
// the two can't silently drift without this test noticing).
const previewMaxLines = handlers.MaxIngestLines

// previewMaxBytes mirrors the unexported handlers.maxPreviewBytes; kept as
// a literal since nothing exported carries this value.
const previewMaxBytes = 1 << 20

func previewFile(t *testing.T, ts *httptest.Server, path string, lines int) (int, types.PreviewFileResponse) {
	t.Helper()
	body, _ := json.Marshal(types.PreviewFileRequest{Path: path, Lines: lines})
	resp, err := http.Post(ts.URL+"/api/v1/parse/preview-file", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out types.PreviewFileResponse
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// H8 (plain half): a request for fewer lines than the file has returns
// exactly that many lines and an exact approx_lines only once the whole
// file has actually been read -- here it hasn't, so approx_lines is an
// estimate, not the true count, and this test checks the estimate lands
// close to the truth for a file with uniform line lengths.
func TestPreviewFilePlainDefaultAndCappedLines(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	dir := t.TempDir()

	var b strings.Builder
	for i := 0; i < 500; i++ {
		b.WriteString("INFO api request line #" + strconv.Itoa(i) + "\n")
	}
	path := filepath.Join(dir, "plain.log")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}

	// Default (no "lines" given) is 100.
	status, out := previewFile(t, ts, path, 0)
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if len(out.Lines) != 100 {
		t.Fatalf("len(lines) = %d, want 100 (default)", len(out.Lines))
	}
	if out.Compressed != "" {
		t.Fatalf("compressed = %q, want empty for a plain file", out.Compressed)
	}
	if out.SizeBytes != int64(b.Len()) {
		t.Fatalf("size_bytes = %d, want %d", out.SizeBytes, b.Len())
	}
	// 500 uniform-length lines, sampled the first 100: the estimate should
	// land close to 500, not be wildly off.
	if out.ApproxLines < 450 || out.ApproxLines > 550 {
		t.Fatalf("approx_lines = %d, want ~500", out.ApproxLines)
	}
	if out.Lines[0] != "INFO api request line #0" {
		t.Fatalf("first line = %q", out.Lines[0])
	}

	// A file shorter than the requested line count reads to EOF and
	// reports the exact count.
	status, out = previewFile(t, ts, path, 10_000)
	if status != http.StatusOK || len(out.Lines) != 500 || out.ApproxLines != 500 {
		t.Fatalf("full read: status %d, %d lines, approx %d, want 200 / 500 lines / approx 500", status, len(out.Lines), out.ApproxLines)
	}
}

// A caller-requested "lines" above the server's previewMaxLines is
// silently clamped, not rejected. The fixture has more lines than the cap
// so the clamp is actually exercised (500 lines was not enough to tell a
// clamp from an unlimited read).
func TestPreviewFileLinesClampedToServerMax(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	dir := t.TempDir()

	var b strings.Builder
	for i := 0; i < previewMaxLines+50; i++ {
		b.WriteString("INFO x\n")
	}
	path := filepath.Join(dir, "huge-line-count.log")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}

	status, out := previewFile(t, ts, path, previewMaxLines*5)
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if len(out.Lines) != previewMaxLines {
		t.Fatalf("len(lines) = %d, want the server cap %d, not the requested %d", len(out.Lines), previewMaxLines, previewMaxLines*5)
	}
}

// The byte cap (previewMaxBytes) stops a preview short even when the line
// cap hasn't been reached, so a handful of huge lines (a JSON-per-line
// dump, say) can't turn "preview" into shipping most of the file.
func TestPreviewFileStopsAtByteCap(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	dir := t.TempDir()

	// Each line is ~100 KB; previewMaxBytes is 1 MB, so this must stop
	// around line 10-11, nowhere near the requested 100 or the 10,000
	// line-count cap.
	bigLine := strings.Repeat("x", 100*1024)
	var b strings.Builder
	for i := 0; i < 100; i++ {
		b.WriteString(bigLine)
		b.WriteString("\n")
	}
	path := filepath.Join(dir, "huge-lines.log")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}

	status, out := previewFile(t, ts, path, 100)
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if len(out.Lines) == 0 || len(out.Lines) >= 100 {
		t.Fatalf("len(lines) = %d, want a small number well under the requested 100 (byte cap should have stopped it)", len(out.Lines))
	}
	var total int
	for _, l := range out.Lines {
		total += len(l) + 1
	}
	if total > previewMaxBytes+len(bigLine) {
		t.Fatalf("returned %d bytes of lines, want at most ~%d (one line's worth over the %d-byte cap)", total, previewMaxBytes+len(bigLine), previewMaxBytes)
	}
}

// H8: gzip is sniffed by magic bytes regardless of extension, and the
// decoded lines come back correctly.
func TestPreviewFileGzip(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	dir := t.TempDir()

	var raw bytes.Buffer
	gw := gzip.NewWriter(&raw)
	gw.Write([]byte("INFO first\nINFO second\nINFO third\n"))
	gw.Close()
	path := filepath.Join(dir, "app.log") // wrong extension on purpose
	if err := os.WriteFile(path, raw.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}

	status, out := previewFile(t, ts, path, 2)
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if out.Compressed != "gzip" {
		t.Fatalf("compressed = %q, want gzip", out.Compressed)
	}
	if len(out.Lines) != 2 || out.Lines[0] != "INFO first" || out.Lines[1] != "INFO second" {
		t.Fatalf("lines = %v", out.Lines)
	}
	if out.SizeBytes != int64(raw.Len()) {
		t.Fatalf("size_bytes = %d, want the on-disk (compressed) size %d", out.SizeBytes, raw.Len())
	}
	// Compressed and not fully read (1 of 3 lines withheld): approx_lines
	// is documented as a floor (= lines actually returned), not an
	// extrapolation against the compressed on-disk size.
	if out.ApproxLines != 2 {
		t.Fatalf("approx_lines = %d, want 2 (a floor, not an estimate, for an unfinished compressed read)", out.ApproxLines)
	}

	// Reading the whole (small) gzip file makes approx_lines exact.
	status, out = previewFile(t, ts, path, 100)
	if status != http.StatusOK || len(out.Lines) != 3 || out.ApproxLines != 3 {
		t.Fatalf("full gzip read: status %d, %d lines, approx %d, want 200 / 3 lines / approx 3", status, len(out.Lines), out.ApproxLines)
	}
}

// H8 (error half): relative path, directory, and missing file are all 400s,
// same policy as /ingest/file, and no session is required at all.
func TestPreviewFileErrors(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	dir := t.TempDir()

	for _, bad := range []string{"relative.log", dir, filepath.Join(dir, "missing.log")} {
		status, _ := previewFile(t, ts, bad, 0)
		if status != http.StatusBadRequest {
			t.Errorf("path %q: status %d, want 400", bad, status)
		}
	}

	status, _ := previewFile(t, ts, "", 0)
	if status != http.StatusBadRequest {
		t.Errorf("empty path: status %d, want 400", status)
	}
}

func TestPreviewFileEmptyFile(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.log")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	status, out := previewFile(t, ts, path, 0)
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if len(out.Lines) != 0 || out.ApproxLines != 0 {
		t.Fatalf("out = %+v, want no lines and approx_lines 0", out)
	}
}
