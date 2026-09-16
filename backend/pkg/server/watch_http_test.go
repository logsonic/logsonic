package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/types"
	"logsonic/pkg/watch"
)

const watchPattern = "%{TIMESTAMP_ISO8601:timestamp} %{WORD:level} %{WORD:service} %{GREEDYDATA:message}"

// watchServer is a test server with the background services the harness
// normally leaves to Start(): live tail and the watch manager, on a short
// sweep. It also registers a saved pattern the watches can name.
func watchServer(t *testing.T, storagePath string) (*Server, *httptest.Server, string) {
	t.Helper()
	old := watch.SweepInterval
	watch.SweepInterval = 100 * time.Millisecond
	t.Cleanup(func() { watch.SweepInterval = old })
	cfg := Config{Host: "localhost", Port: ":0"}
	if storagePath != "" {
		cfg.StoragePath = storagePath
	}
	srv, ts := newTestServer(t, cfg)
	ctx, cancel := context.WithCancel(context.Background())
	srv.services.StartLive(ctx)
	srv.services.StartWatches(ctx)
	t.Cleanup(func() {
		cancel()
		_ = srv.services.Watches.Close()
	})
	name := "W_TIMED_" + strings.ReplaceAll(t.Name(), "/", "_")
	code := do(t, ts, http.MethodPost, "/api/v1/grok", types.GrokPatternRequest{Name: name, Pattern: watchPattern}, nil)
	if code != 200 && code != 201 && code != 409 {
		t.Fatalf("save pattern: %d", code)
	}
	return srv, ts, name
}

func lines(day string, from, n int) string {
	var b strings.Builder
	for i := from; i < from+n; i++ {
		fmt.Fprintf(&b, "%sT10:%02d:%02dZ INFO api line %d\n", day, (i/60)%60, i%60, i)
	}
	return b.String()
}

func watchFile(t *testing.T, ts *httptest.Server, id, path string) types.WatchFile {
	t.Helper()
	var list types.WatchesResponse
	do(t, ts, http.MethodGet, "/api/v1/watches", nil, &list)
	for _, w := range list.Watches {
		if w.ID != id {
			continue
		}
		for _, f := range w.Files {
			if f.Path == path {
				return f
			}
		}
	}
	return types.WatchFile{}
}

func until(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(40 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func createWatch(t *testing.T, ts *httptest.Server, req types.WatchRequest) types.Watch {
	t.Helper()
	var w types.Watch
	if code := do(t, ts, http.MethodPost, "/api/v1/watches", req, &w); code != http.StatusCreated {
		t.Fatalf("create watch: %d %+v", code, w)
	}
	return w
}

// W1 + W4: two matching files are imported and followed with watch.<dir>.<file>
// sources; a .txt is ignored. Handler shapes along the way.
func TestW1W4_CreateWatchIngestsMatchingFiles(t *testing.T) {
	_, ts, pattern := watchServer(t, "")
	dir := filepath.Join(t.TempDir(), "logs")
	_ = os.Mkdir(dir, 0o755)
	a, b := filepath.Join(dir, "a.log"), filepath.Join(dir, "b.log")
	_ = os.WriteFile(a, []byte(lines("2026-03-01", 0, 30)), 0o644)
	_ = os.WriteFile(b, []byte(lines("2026-03-02", 0, 12)), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "notes.txt"), []byte(lines("2026-03-03", 0, 5)), 0o644)

	var errResp types.ErrorResponse
	if code := do(t, ts, http.MethodPost, "/api/v1/watches", types.WatchRequest{Dir: "relative"}, &errResp); code != 400 || errResp.Code != "INVALID_WATCH" {
		t.Fatalf("relative dir: %d %+v", code, errResp)
	}
	if code := do(t, ts, http.MethodPost, "/api/v1/watches", types.WatchRequest{Dir: a}, &errResp); code != 400 {
		t.Fatalf("file, not dir: %d", code)
	}
	w := createWatch(t, ts, types.WatchRequest{Dir: dir, Pattern: pattern})
	if w.Glob != "*.log" || w.Paused {
		t.Fatalf("created: %+v", w)
	}
	if code := do(t, ts, http.MethodPost, "/api/v1/watches", types.WatchRequest{Dir: dir}, &errResp); code != 409 || errResp.Code != "WATCH_EXISTS" {
		t.Fatalf("same dir twice: %d %+v", code, errResp)
	}
	until(t, "both following", func() bool {
		return watchFile(t, ts, w.ID, a).State == "following" && watchFile(t, ts, w.ID, b).State == "following"
	})
	until(t, "rows searchable", func() bool {
		return totalFor(t, ts, "watch.logs.a.log") == 30 && totalFor(t, ts, "watch.logs.b.log") == 12
	})
	if fa := watchFile(t, ts, w.ID, a); fa.Offset == 0 || fa.Source != "watch.logs.a.log" || fa.Pattern != pattern {
		t.Fatalf("file snapshot: %+v", fa)
	}
	if watchFile(t, ts, w.ID, filepath.Join(dir, "notes.txt")).Path != "" {
		t.Fatal("W4: .txt must be ignored")
	}
	var entry types.SourceEntry
	do(t, ts, http.MethodGet, "/api/v1/sources/watch.logs.a.log", nil, &entry)
	if entry.Origin.Kind != "watch" || entry.Origin.Path != a {
		t.Fatalf("catalog origin: %+v", entry.Origin)
	}
	// Deleting a watched source is refused with wording that names the watch.
	if code := do(t, ts, http.MethodDelete, "/api/v1/sources/watch.logs.a.log", nil, &errResp); code != 409 || errResp.Code != "SOURCE_IN_USE" || !strings.Contains(errResp.Details, "folder watch") {
		t.Fatalf("delete watched source: %d %+v", code, errResp)
	}
	if code := do(t, ts, http.MethodPost, "/api/v1/watches/nope/pause", nil, &errResp); code != 404 || errResp.Code != "WATCH_NOT_FOUND" {
		t.Fatalf("pause unknown: %d", code)
	}
}

// W2 + W3: appended lines are followed; a new file is detected. W5: a
// rotation (rename + recreate) re-ingests from 0 with no duplicates.
func TestW2W3W5_GrowthNewFileAndRotation(t *testing.T) {
	_, ts, pattern := watchServer(t, "")
	dir := filepath.Join(t.TempDir(), "d")
	_ = os.Mkdir(dir, 0o755)
	a := filepath.Join(dir, "app.log")
	_ = os.WriteFile(a, []byte(lines("2026-03-01", 0, 10)), 0o644)
	w := createWatch(t, ts, types.WatchRequest{Dir: dir, Pattern: pattern})
	until(t, "initial 10", func() bool { return totalFor(t, ts, "watch.d.app.log") == 10 })

	// W2: growth
	f, _ := os.OpenFile(a, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString(lines("2026-03-01", 10, 5))
	f.Close()
	until(t, "W2 appended lines searchable", func() bool { return totalFor(t, ts, "watch.d.app.log") == 15 })

	// W3: new file
	n := filepath.Join(dir, "new.log")
	_ = os.WriteFile(n, []byte(lines("2026-03-05", 0, 7)), 0o644)
	until(t, "W3 new file", func() bool { return totalFor(t, ts, "watch.d.new.log") == 7 })

	// W5: rotate app.log: rename away, recreate with fresh content.
	_ = os.Rename(a, a+".1")
	_ = os.WriteFile(a, []byte(lines("2026-03-02", 0, 4)), 0o644)
	until(t, "W5 re-ingested from 0", func() bool { return totalFor(t, ts, "watch.d.app.log") == 19 })
	time.Sleep(400 * time.Millisecond)
	if n := totalFor(t, ts, "watch.d.app.log"); n != 19 {
		t.Fatalf("W5: 15 pre-rotation + 4 new, no duplicates: %d", n)
	}
	if fa := watchFile(t, ts, w.ID, a); fa.State != "following" {
		t.Fatalf("after rotation: %+v", fa)
	}
	// The rotated-away file matches nothing (*.log vs .log.1) and is not tracked.
	if watchFile(t, ts, w.ID, a+".1").Path != "" {
		t.Fatal("app.log.1 must not be tracked by *.log")
	}
}

// W6: restart on the same storage — offsets resume, unchanged files are not
// re-ingested (a unique line has one hit, the count is unchanged).
func TestW6_RestartResumesWithoutReingest(t *testing.T) {
	storage := t.TempDir()
	srvA, tsA, pattern := watchServer(t, storage)
	dir := filepath.Join(t.TempDir(), "r")
	_ = os.Mkdir(dir, 0o755)
	a := filepath.Join(dir, "a.log")
	_ = os.WriteFile(a, []byte(lines("2026-03-01", 0, 20)+"2026-03-01T11:00:00Z INFO api UNIQUE-MARKER\n"), 0o644)
	w := createWatch(t, tsA, types.WatchRequest{Dir: dir, Pattern: pattern})
	until(t, "21 rows", func() bool { return totalFor(t, tsA, "watch.r.a.log") == 21 })
	// Let the follower's progress land in state, then stop cleanly.
	until(t, "offset recorded", func() bool { return watchFile(t, tsA, w.ID, a).Offset > 0 })
	_ = srvA.services.Watches.Close()
	_ = srvA.services.CloseStorage()
	tsA.Close()

	srvB, tsB, _ := watchServer(t, storage)
	var list types.WatchesResponse
	do(t, tsB, http.MethodGet, "/api/v1/watches", nil, &list)
	if len(list.Watches) != 1 || list.Watches[0].ID != w.ID {
		t.Fatalf("watch not persisted: %+v", list.Watches)
	}
	until(t, "resumed following", func() bool { return watchFile(t, tsB, w.ID, a).State == "following" })
	// Append after the restart proves the follower is live from the old offset.
	f, _ := os.OpenFile(a, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString(lines("2026-03-01", 30, 3))
	f.Close()
	until(t, "post-restart append", func() bool { return totalFor(t, tsB, "watch.r.a.log") == 24 })
	params := "limit=1&_src=watch.r.a.log&query=UNIQUE-MARKER&start_date=2000-01-01T00:00:00Z&end_date=2100-01-01T00:00:00Z"
	var out types.LogResponse
	do(t, tsB, http.MethodGet, "/api/v1/logs?"+params, nil, &out)
	if out.TotalCount != 1 {
		t.Fatalf("unique line must have exactly one hit after restart, got %d", out.TotalCount)
	}
	_ = srvB
}

// W7: pause → append → resume: the appended lines land only after resume.
func TestW7_PauseResume(t *testing.T) {
	_, ts, pattern := watchServer(t, "")
	dir := filepath.Join(t.TempDir(), "p")
	_ = os.Mkdir(dir, 0o755)
	a := filepath.Join(dir, "a.log")
	_ = os.WriteFile(a, []byte(lines("2026-03-01", 0, 5)), 0o644)
	w := createWatch(t, ts, types.WatchRequest{Dir: dir, Pattern: pattern})
	until(t, "5 rows", func() bool { return totalFor(t, ts, "watch.p.a.log") == 5 })
	var paused types.Watch
	if code := do(t, ts, http.MethodPost, "/api/v1/watches/"+w.ID+"/pause", nil, &paused); code != 200 || !paused.Paused {
		t.Fatalf("pause: %d %+v", code, paused)
	}
	f, _ := os.OpenFile(a, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString(lines("2026-03-01", 5, 5))
	f.Close()
	time.Sleep(500 * time.Millisecond)
	if n := totalFor(t, ts, "watch.p.a.log"); n != 5 {
		t.Fatalf("paused watch must not ingest: %d", n)
	}
	var resumed types.Watch
	if code := do(t, ts, http.MethodPost, "/api/v1/watches/"+w.ID+"/resume", nil, &resumed); code != 200 || resumed.Paused {
		t.Fatalf("resume: %d", code)
	}
	until(t, "W7 after resume", func() bool { return totalFor(t, ts, "watch.p.a.log") == 10 })
}

// W8: delete stops the goroutines, removes the state entry, keeps the rows.
func TestW8_DeleteStopsGoroutinesKeepsData(t *testing.T) {
	srv, ts, pattern := watchServer(t, "")
	dir := filepath.Join(t.TempDir(), "x")
	_ = os.Mkdir(dir, 0o755)
	for i := 0; i < 3; i++ {
		_ = os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%d.log", i)), []byte(lines("2026-03-01", 0, 4)), 0o644)
	}
	w := createWatch(t, ts, types.WatchRequest{Dir: dir, Pattern: pattern})
	until(t, "3 following", func() bool {
		var list types.WatchesResponse
		do(t, ts, http.MethodGet, "/api/v1/watches", nil, &list)
		n := 0
		for _, f := range list.Watches[0].Files {
			if f.State == "following" {
				n++
			}
		}
		return n == 3
	})
	if code := do(t, ts, http.MethodDelete, "/api/v1/watches/"+w.ID, nil, nil); code != http.StatusNoContent {
		t.Fatalf("delete: %d", code)
	}
	// Leak check: no watchLoop goroutine may survive the delete (by stack
	// frame — HTTP keep-alive and storage goroutines make an absolute count
	// meaningless), and this server's tail manager must own no follower
	// (other tests' tails may still be winding down in the same process).
	until(t, "watch goroutines exit", func() bool {
		buf := make([]byte, 1<<20)
		n := runtime.Stack(buf, true)
		stacks := string(buf[:n])
		return !strings.Contains(stacks, "watch.(*watchLoop).run") && !strings.Contains(stacks, "watch.(*watchLoop).startFile")
	})
	until(t, "followers released", func() bool { return len(srv.services.Live.ActiveSourceIDs()) == 0 })
	var list types.WatchesResponse
	do(t, ts, http.MethodGet, "/api/v1/watches", nil, &list)
	if len(list.Watches) != 0 {
		t.Fatal("deleted watch still listed")
	}
	srv.services.Watches.Flush()
	b, _ := os.ReadFile(srv.services.Watches.Path())
	if strings.Contains(string(b), w.ID) {
		t.Fatal("state file still has the watch")
	}
	if n := totalFor(t, ts, "watch.x.f0.log"); n != 4 {
		t.Fatalf("indexed data must stay: %d", n)
	}
}

// W10: the directory disappears — the watch reports an error, nothing
// panics, and it recovers when the directory returns.
func TestW10_DirectoryDeleted(t *testing.T) {
	_, ts, pattern := watchServer(t, "")
	dir := filepath.Join(t.TempDir(), "gone")
	_ = os.Mkdir(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "a.log"), []byte(lines("2026-03-01", 0, 3)), 0o644)
	w := createWatch(t, ts, types.WatchRequest{Dir: dir, Pattern: pattern})
	until(t, "following", func() bool { return watchFile(t, ts, w.ID, filepath.Join(dir, "a.log")).State == "following" })
	_ = os.RemoveAll(dir)
	until(t, "watch error", func() bool {
		var list types.WatchesResponse
		do(t, ts, http.MethodGet, "/api/v1/watches", nil, &list)
		return len(list.Watches) == 1 && list.Watches[0].Error != "" && list.Watches[0].Files[0].State == "error"
	})
	_ = os.Mkdir(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "b.log"), []byte(lines("2026-03-02", 0, 2)), 0o644)
	until(t, "recovered", func() bool {
		var list types.WatchesResponse
		do(t, ts, http.MethodGet, "/api/v1/watches", nil, &list)
		return list.Watches[0].Error == "" && watchFile(t, ts, w.ID, filepath.Join(dir, "b.log")).State == "following"
	})
}

// Auto-detect: a watch with no pattern picks one per file (the Apache
// error sample, which log2grok knows).
func TestWatchAutoDetect(t *testing.T) {
	_, ts, _ := watchServer(t, "")
	dir := filepath.Join(t.TempDir(), "auto")
	_ = os.Mkdir(dir, 0o755)
	src, err := os.ReadFile("../../../sample-logs/apache.log")
	if err != nil {
		t.Skip("sample-logs not available")
	}
	_ = os.WriteFile(filepath.Join(dir, "apache.log"), src, 0o644)
	w := createWatch(t, ts, types.WatchRequest{Dir: dir, Pattern: "auto"})
	until(t, "detected + following", func() bool {
		f := watchFile(t, ts, w.ID, filepath.Join(dir, "apache.log"))
		return f.State == "following" && f.Pattern != ""
	})
	until(t, "rows", func() bool { return totalFor(t, ts, "watch.auto.apache.log") > 1000 })
}
