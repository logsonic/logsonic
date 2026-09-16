package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"

	"logsonic/pkg/server"
	"logsonic/pkg/types"
)

// testServer runs a real server (real storage on a temp dir, background
// services on) behind an httptest listener, so runOpen talks to the
// production routes.
func testServer(t *testing.T) (*httptest.Server, *server.Server) {
	t.Helper()
	dir := t.TempDir()
	if err := l2g.LoadConfig(filepath.Join(dir, "log2grok"), nil); err != nil {
		t.Fatal(err)
	}
	srv, err := server.NewServer(server.Config{Host: "localhost", Port: ":0", StoragePath: dir, Timeout: 30 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	srv.StartBackground(ctx)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() {
		ts.Close()
		cancel()
		_ = srv.Close()
	})
	return ts, srv
}

func total(t *testing.T, base, source string) int {
	t.Helper()
	q := url.Values{"limit": {"1"}, "_src": {source}, "start_date": {"2000-01-01T00:00:00Z"}, "end_date": {"2100-01-01T00:00:00Z"}}
	resp, err := http.Get(base + "/api/v1/logs?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out types.LogResponse
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return out.TotalCount
}

type noLauncher struct{}

func (noLauncher) AppBundlePresent() bool       { return false }
func (noLauncher) OpenWithApp() (string, error) { return "", fmt.Errorf("no app") }
func (noLauncher) SpawnServer(string, string, bool) (string, error) {
	return "", fmt.Errorf("not expected")
}

// O1: a running server, one file, auto-detect: rows searchable, progress
// and the final URL on the right streams, exit 0.
func TestO1_OpenImportsAFile(t *testing.T) {
	ts, _ := testServer(t)
	sample := filepath.Join("..", "sample-logs", "apache.log")
	if _, err := os.Stat(sample); err != nil {
		t.Skip("sample-logs not available")
	}
	var stdout, stderr bytes.Buffer
	code := runOpen([]string{"--url", ts.URL, sample}, &stdout, &stderr, noLauncher{})
	if code != 0 {
		t.Fatalf("exit %d\nstderr: %s", code, stderr.String())
	}
	if n := total(t, ts.URL, "apache.log"); n != 2000 {
		t.Fatalf("rows: %d", n)
	}
	out := strings.TrimSpace(stdout.String())
	if !strings.HasPrefix(out, ts.URL+"/#/?") || !strings.Contains(out, "_src") || !strings.Contains(out, "since=") {
		t.Fatalf("stdout must be the UI URL with the source and time span: %q", out)
	}
	if !strings.Contains(stderr.String(), "imported 2,000 rows as apache.log") || !strings.Contains(stderr.String(), "lines") {
		t.Fatalf("stderr must show progress and the summary: %q", stderr.String())
	}

	// O5 through the CLI flag: --pattern with the name auto-detect chose
	// imports the same file with the same field set.
	resp, err := http.Get(ts.URL + "/api/v1/sources/apache.log")
	if err != nil {
		t.Fatal(err)
	}
	var entry types.SourceEntry
	_ = json.NewDecoder(resp.Body).Decode(&entry)
	resp.Body.Close()
	if entry.PatternName == "" {
		t.Fatalf("detected pattern not recorded: %+v", entry)
	}
	stdout.Reset()
	stderr.Reset()
	if code := runOpen([]string{"--url", ts.URL, "--pattern", entry.PatternName, "--source", "explicit.log", sample}, &stdout, &stderr, noLauncher{}); code != 0 {
		t.Fatalf("--pattern %q: exit %d: %s", entry.PatternName, code, stderr.String())
	}
	if n := total(t, ts.URL, "explicit.log"); n != 2000 {
		t.Fatalf("--pattern import rows: %d", n)
	}
	fieldsOf := func(source string) string {
		q := url.Values{"limit": {"1"}, "_src": {source}, "start_date": {"2000-01-01T00:00:00Z"}, "end_date": {"2100-01-01T00:00:00Z"}}
		r, _ := http.Get(ts.URL + "/api/v1/logs?" + q.Encode())
		var out types.LogResponse
		_ = json.NewDecoder(r.Body).Decode(&out)
		r.Body.Close()
		var keys []string
		for k := range out.Logs[0] {
			if !strings.HasPrefix(k, "_") && k != "timestamp" {
				keys = append(keys, k)
			}
		}
		for i := 1; i < len(keys); i++ {
			for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
				keys[j], keys[j-1] = keys[j-1], keys[j]
			}
		}
		return strings.Join(keys, ",")
	}
	if a, b := fieldsOf("apache.log"), fieldsOf("explicit.log"); a != b {
		t.Fatalf("O5: auto %q vs --pattern %q", a, b)
	}
}

// O2: two paths with --source: one source, both files, file order kept
// (every row of the first file sorts before every row of the second).
func TestO2_TwoPathsOneSourceOrdered(t *testing.T) {
	ts, _ := testServer(t)
	dir := t.TempDir()
	a, b := filepath.Join(dir, "a.log"), filepath.Join(dir, "b.log")
	var la, lb strings.Builder
	for i := 0; i < 30; i++ {
		fmt.Fprintf(&la, "2026-03-01T10:00:%02dZ INFO api first %d\n", i, i)
		fmt.Fprintf(&lb, "2026-03-01T10:00:%02dZ INFO api second %d\n", i, i)
	}
	_ = os.WriteFile(a, []byte(la.String()), 0o644)
	_ = os.WriteFile(b, []byte(lb.String()), 0o644)
	var stdout, stderr bytes.Buffer
	if code := runOpen([]string{"--url", ts.URL, "--source", "combined", a, b}, &stdout, &stderr, noLauncher{}); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if n := total(t, ts.URL, "combined"); n != 60 {
		t.Fatalf("combined rows: %d", n)
	}
	// Both files carry the same timestamps, so the sort falls through to
	// the seq tie-breaker: at every timestamp the first file's row must
	// precede the second file's, which is only true if file 2 was ingested
	// after file 1 on one seq counter.
	q := url.Values{"limit": {"100"}, "_src": {"combined"}, "sort_order": {"asc"}, "start_date": {"2000-01-01T00:00:00Z"}, "end_date": {"2100-01-01T00:00:00Z"}}
	resp, _ := http.Get(ts.URL + "/api/v1/logs?" + q.Encode())
	var out types.LogResponse
	_ = json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if len(out.Logs) != 60 {
		t.Fatalf("page: %d rows", len(out.Logs))
	}
	for i := 0; i+1 < len(out.Logs); i += 2 {
		m1, _ := out.Logs[i]["message"].(string)
		m2, _ := out.Logs[i+1]["message"].(string)
		if !strings.HasPrefix(m1, "first ") || !strings.HasPrefix(m2, "second ") {
			t.Fatalf("at pair %d: %q then %q — the first file's row must come first at each timestamp", i/2, m1, m2)
		}
	}
}

// O6: a missing file: exit 1, the message names the path, nothing started.
func TestO6_MissingFile(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := runOpen([]string{"--url", "http://127.0.0.1:1", "/no/such/file.log"}, &stdout, &stderr, noLauncher{})
	if code != 1 || !strings.Contains(stderr.String(), "/no/such/file.log") {
		t.Fatalf("exit %d stderr %q", code, stderr.String())
	}
	if code := runOpen([]string{"--url", "http://127.0.0.1:1"}, &stdout, &stderr, noLauncher{}); code != 2 {
		t.Fatalf("no paths must be usage (2), got %d", code)
	}
	if code := runOpen([]string{"-h"}, &stdout, &stderr, noLauncher{}); code != 0 || !strings.Contains(stdout.String(), "Usage:") {
		t.Fatalf("-h: %d", code)
	}
}

// spawningLauncher stands in for "start a headless server": it serves a
// real server on the requested port only when asked, so the first ping
// fails and the retry loop has to find it.
type spawningLauncher struct {
	t       *testing.T
	mu      sync.Mutex
	spawned string
}

func (l *spawningLauncher) AppBundlePresent() bool       { return false }
func (l *spawningLauncher) OpenWithApp() (string, error) { return "", fmt.Errorf("no app") }
func (l *spawningLauncher) SpawnServer(host, port string, open bool) (string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	dir := l.t.TempDir()
	if err := l2g.LoadConfig(filepath.Join(dir, "log2grok"), nil); err != nil {
		return "", err
	}
	srv, err := server.NewServer(server.Config{Host: host, Port: ":" + port, StoragePath: dir, Timeout: 30 * time.Second})
	if err != nil {
		return "", err
	}
	ln, err := net.Listen("tcp", host+":"+port)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithCancel(context.Background())
	srv.StartBackground(ctx)
	hs := &http.Server{Handler: srv.Handler()}
	go func() { _ = hs.Serve(ln) }()
	l.t.Cleanup(func() { _ = hs.Close(); cancel(); _ = srv.Close() })
	l.spawned = fmt.Sprintf("test-server -host %s -port %s open=%v", host, port, open)
	return l.spawned, nil
}

// The app bundle is only used for the default URL: a custom --url must get
// a headless server on its own port even on a Mac with the app installed.
func TestLaunchPrefersAppOnlyForDefaultURL(t *testing.T) {
	for _, c := range []struct {
		url  string
		want bool
	}{
		{"http://localhost:8080", true}, {"http://127.0.0.1:8080", true}, {"http://localhost", true},
		{"http://127.0.0.1:8097", false}, {"http://other-host:8080", false},
	} {
		u, _ := url.Parse(c.url)
		if got := isDefaultServerURL(u); got != c.want {
			t.Errorf("%s: %v", c.url, got)
		}
	}
	// With the app "present" and a non-default URL, SpawnServer is what runs.
	l := &recordingLauncher{app: true}
	var stderr bytes.Buffer
	_ = ensureServer("http://127.0.0.1:1", nil, false, l, &stderr)
	if !l.spawnCalled || l.openCalled {
		t.Fatalf("non-default URL must spawn headless, not open the app: spawn=%v open=%v", l.spawnCalled, l.openCalled)
	}
}

type recordingLauncher struct {
	app                     bool
	spawnCalled, openCalled bool
}

func (l *recordingLauncher) AppBundlePresent() bool { return l.app }
func (l *recordingLauncher) OpenWithApp() (string, error) {
	l.openCalled = true
	return "open", nil
}
func (l *recordingLauncher) SpawnServer(string, string, bool) (string, error) {
	l.spawnCalled = true
	return "spawn", fmt.Errorf("not really")
}

// O3: nothing answers at --url; open spawns, retries the ping, imports,
// and says what it did.
func TestO3_LaunchIfNeeded(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := fmt.Sprint(ln.Addr().(*net.TCPAddr).Port)
	ln.Close() // free it; the launcher will bind it
	base := "http://127.0.0.1:" + port
	dir := t.TempDir()
	p := filepath.Join(dir, "x.log")
	_ = os.WriteFile(p, []byte("2026-03-01T10:00:00Z INFO api one\n2026-03-01T10:00:01Z INFO api two\n"), 0o644)
	launcher := &spawningLauncher{t: t}
	var stdout, stderr bytes.Buffer
	if code := runOpen([]string{"--url", base, p}, &stdout, &stderr, launcher); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "was not running at "+base+"; started it: test-server") {
		t.Fatalf("must say what it did: %q", stderr.String())
	}
	if n := total(t, base, "x.log"); n != 2 {
		t.Fatalf("rows after launch: %d", n)
	}
}
