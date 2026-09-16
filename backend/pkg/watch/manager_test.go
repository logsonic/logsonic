package watch

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"logsonic/pkg/types"
)

// fakeDeps records what the manager asked for. Import "reads" the whole file
// (offset = size, seq = line count); Follow just remembers the call.
type fakeDeps struct {
	mu        sync.Mutex
	imports   []string
	follows   []followCall
	stops     []string
	nextID    int
	detected  []string
	logs      []string
	importErr error
}

type followCall struct {
	path        string
	offset, seq int64
	obs         FollowObserver
	source      string
}

func (f *fakeDeps) StartFileAt(path string, opts types.IngestSessionOptions, offset, seq int64, obs FollowObserver, kind string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	f.follows = append(f.follows, followCall{path, offset, seq, obs, opts.Source})
	return fmt.Sprintf("src-%d", f.nextID), nil
}
func (f *fakeDeps) StopSource(id string) bool {
	f.mu.Lock()
	f.stops = append(f.stops, id)
	f.mu.Unlock()
	return true
}
func (f *fakeDeps) ImportFile(_ context.Context, path string, _ types.IngestSessionOptions) (ImportResult, error) {
	f.mu.Lock()
	f.imports = append(f.imports, path)
	err := f.importErr
	f.mu.Unlock()
	if err != nil {
		return ImportResult{}, err
	}
	b, _ := os.ReadFile(path)
	return ImportResult{Offset: int64(len(b)), Seq: int64(strings.Count(string(b), "\n")), Rows: int64(strings.Count(string(b), "\n")), Compressed: strings.HasSuffix(path, ".gz")}, nil
}
func (f *fakeDeps) Detect(path string, _ int) (types.IngestSessionOptions, error) {
	f.mu.Lock()
	f.detected = append(f.detected, path)
	f.mu.Unlock()
	return types.IngestSessionOptions{Name: "DETECTED"}, nil
}
func (f *fakeDeps) logf(format string, args ...interface{}) {
	f.mu.Lock()
	f.logs = append(f.logs, fmt.Sprintf(format, args...))
	f.mu.Unlock()
}
func (f *fakeDeps) deps() Deps {
	return Deps{Follower: f, Importer: f, Detector: f, Logf: f.logf, PatternOptions: func(name string) (types.IngestSessionOptions, error) {
		if name == "bogus" {
			return types.IngestSessionOptions{}, fmt.Errorf("unknown pattern")
		}
		return types.IngestSessionOptions{Name: name}, nil
	}}
}
func (f *fakeDeps) snapshot() (imports []string, follows []followCall, stops []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.imports...), append([]followCall(nil), f.follows...), append([]string(nil), f.stops...)
}

func fileStateOf(t *testing.T, m *Manager, id, path string) types.WatchFile {
	t.Helper()
	w, err := m.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range w.Files {
		if f.Path == path {
			return f
		}
	}
	return types.WatchFile{}
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out: %s", what)
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newManager(t *testing.T, storage string, deps Deps) *Manager {
	t.Helper()
	old := SweepInterval
	SweepInterval = 50 * time.Millisecond
	t.Cleanup(func() { SweepInterval = old })
	m, err := Open(storage, deps)
	if err != nil {
		t.Fatal(err)
	}
	// Close before the temp dirs go: the flush loop would otherwise write
	// watches.json into a directory being removed.
	t.Cleanup(func() { _ = m.Close() })
	return m
}

func TestCreateValidation(t *testing.T) {
	m := newManager(t, t.TempDir(), (&fakeDeps{}).deps())
	dir := t.TempDir()
	for _, bad := range []types.WatchRequest{
		{Dir: "relative/dir"},
		{Dir: filepath.Join(dir, "missing")},
		{Dir: filepath.Join(dir, "afile")},
		{Dir: dir, Glob: "["},
		{Dir: dir, Pattern: "bogus"},
	} {
		if bad.Dir == filepath.Join(dir, "afile") {
			write(t, bad.Dir, "x")
		}
		if _, err := m.Create(bad); err == nil {
			t.Errorf("expected ErrInvalid for %+v", bad)
		}
	}
	w, err := m.Create(types.WatchRequest{Dir: dir, Pattern: "auto"})
	if err != nil || w.Glob != "*.log" || w.Pattern != "" || w.ID == "" || len(w.Files) != 0 {
		t.Fatalf("defaults: %v %+v", err, w)
	}
	if _, err := m.Create(types.WatchRequest{Dir: dir}); !errors.Is(err, ErrExists) {
		t.Fatalf("same dir twice must be ErrExists: %v", err)
	}
	if got := sourceName("/var/logs", "/var/logs/x/app.log"); got != "watch.logs.x.app.log" {
		t.Fatalf("nested source name: %s", got)
	}
	if got := sourceName("/var/logs", "/var/logs/app.log"); got != "watch.logs.app.log" {
		t.Fatalf("flat source name: %s", got)
	}
	if _, err := m.Get("nope"); err != ErrNotFound {
		t.Error("Get unknown")
	}
	if err := m.Delete("nope"); err != ErrNotFound {
		t.Error("Delete unknown")
	}
}

// New matching files are imported then followed from where the import
// stopped, with the watch.<dir>.<file> source; non-matching files are
// ignored; a compressed file is imported once and marked done.
func TestSweepImportsThenFollows(t *testing.T) {
	deps := &fakeDeps{}
	m := newManager(t, t.TempDir(), deps.deps())
	dir := filepath.Join(t.TempDir(), "logs")
	_ = os.Mkdir(dir, 0o755)
	write(t, filepath.Join(dir, "a.log"), "one\ntwo\n")
	write(t, filepath.Join(dir, "notes.txt"), "ignored\n")
	write(t, filepath.Join(dir, "old.log.gz"), "gz")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m.Start(ctx)
	w, err := m.Create(types.WatchRequest{Dir: dir, Glob: "*.log*"})
	if err != nil {
		t.Fatal(err)
	}
	a := filepath.Join(dir, "a.log")
	eventually(t, "a.log following", func() bool { return fileStateOf(t, m, w.ID, a).State == "following" })
	eventually(t, "old.log.gz done", func() bool { return fileStateOf(t, m, w.ID, filepath.Join(dir, "old.log.gz")).State == "done" })
	imports, follows, _ := deps.snapshot()
	if len(imports) != 2 || len(follows) != 1 {
		t.Fatalf("imports %v follows %+v", imports, follows)
	}
	if follows[0].offset != 8 || follows[0].seq != 2 || follows[0].source != "watch.logs.a.log" {
		t.Fatalf("follow from the import's end with its seq and the watch source: %+v", follows[0])
	}
	if f := fileStateOf(t, m, w.ID, filepath.Join(dir, "notes.txt")); f.Path != "" {
		t.Fatal(".txt must be ignored")
	}
	if got := fileStateOf(t, m, w.ID, a); got.Pattern != "DETECTED" || got.Source != "watch.logs.a.log" {
		t.Fatalf("auto-detect + source recorded: %+v", got)
	}

	// A new file after the fact is picked up by the sweep.
	write(t, filepath.Join(dir, "b.log"), "x\n")
	eventually(t, "b.log following", func() bool { return fileStateOf(t, m, w.ID, filepath.Join(dir, "b.log")).State == "following" })

	// Progress from the follower lands in state; a rotation resets it.
	_, follows, _ = deps.snapshot()
	follows[0].obs.Progress(40, 9, fakeInfo{size: 40})
	if f := fileStateOf(t, m, w.ID, a); f.Offset != 40 {
		t.Fatalf("progress recorded: %+v", f)
	}
	follows[0].obs.Rotated(fakeInfo{size: 3})
	if f := fileStateOf(t, m, w.ID, a); f.Offset != 0 {
		t.Fatalf("rotation resets the offset: %+v", f)
	}
	// A follower error is surfaced on the file.
	follows[0].obs.Finished("error", "boom")
	if f := fileStateOf(t, m, w.ID, a); f.State != "error" || f.Error != "boom" {
		t.Fatalf("error surfaced: %+v", f)
	}
}

type fakeInfo struct{ size int64 }

func (fakeInfo) Name() string       { return "x" }
func (f fakeInfo) Size() int64      { return f.size }
func (fakeInfo) Mode() os.FileMode  { return 0o644 }
func (fakeInfo) ModTime() time.Time { return time.Time{} }
func (fakeInfo) IsDir() bool        { return false }
func (fakeInfo) Sys() interface{}   { return nil }

// Restart with the same state file: an unchanged file resumes from its
// (offset, seq) without a new import; a shrunk file (rotated while away)
// is imported from 0 again.
func TestRestartResumesFromState(t *testing.T) {
	storage := t.TempDir()
	deps := &fakeDeps{}
	m := newManager(t, storage, deps.deps())
	dir := filepath.Join(t.TempDir(), "d")
	_ = os.Mkdir(dir, 0o755)
	a, b := filepath.Join(dir, "a.log"), filepath.Join(dir, "b.log")
	write(t, a, "1\n2\n3\n")
	write(t, b, "1\n2\n3\n4\n")
	ctx, cancel := context.WithCancel(context.Background())
	m.Start(ctx)
	w, _ := m.Create(types.WatchRequest{Dir: dir, Pattern: "P"})
	eventually(t, "both following", func() bool {
		return fileStateOf(t, m, w.ID, a).State == "following" && fileStateOf(t, m, w.ID, b).State == "following"
	})
	_, follows, _ := deps.snapshot()
	// Simulate follower progress before the stop.
	for _, fc := range follows {
		fc.obs.Progress(6, 3, fakeInfo{size: 6})
	}
	cancel()
	_ = m.Close()
	if _, err := os.Stat(filepath.Join(storage, "watches.json")); err != nil {
		t.Fatal("state not persisted")
	}

	// b is rotated (shorter) while the manager is down.
	write(t, b, "n\n")
	deps2 := &fakeDeps{}
	m2 := newManager(t, storage, deps2.deps())
	ctx2, cancel2 := context.WithCancel(context.Background())
	t.Cleanup(cancel2)
	m2.Start(ctx2)
	eventually(t, "resumed", func() bool {
		return fileStateOf(t, m2, w.ID, a).State == "following" && fileStateOf(t, m2, w.ID, b).State == "following"
	})
	imports, follows2, _ := deps2.snapshot()
	var aFollow, bFollow followCall
	for _, fc := range follows2 {
		if fc.path == a {
			aFollow = fc
		} else {
			bFollow = fc
		}
	}
	if aFollow.offset != 6 || aFollow.seq != 3 {
		t.Fatalf("a must resume from (6, 3), got %+v", aFollow)
	}
	if len(imports) != 1 || imports[0] != b || bFollow.offset != 2 || bFollow.seq != 1 {
		t.Fatalf("b must be re-imported from 0 after shrinking: imports %v follow %+v", imports, bFollow)
	}
	if got := m2.List(); len(got) != 1 || got[0].Pattern != "P" || got[0].ID != w.ID {
		t.Fatalf("config round-trip: %+v", got)
	}
	_ = m2.Close()
}

func TestPauseResumeDelete(t *testing.T) {
	deps := &fakeDeps{}
	m := newManager(t, t.TempDir(), deps.deps())
	dir := t.TempDir()
	write(t, filepath.Join(dir, "a.log"), "x\n")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m.Start(ctx)
	w, _ := m.Create(types.WatchRequest{Dir: dir, Pattern: "P"})
	a := filepath.Join(dir, "a.log")
	eventually(t, "following", func() bool { return fileStateOf(t, m, w.ID, a).State == "following" })

	paused, err := m.Pause(w.ID)
	if err != nil || !paused.Paused {
		t.Fatal("pause")
	}
	_, _, stops := deps.snapshot()
	if len(stops) != 1 {
		t.Fatalf("pause stops the follower: %v", stops)
	}
	if f := fileStateOf(t, m, w.ID, a); f.State != "pending" {
		t.Fatalf("paused file state: %+v", f)
	}
	// Nothing happens while paused.
	write(t, filepath.Join(dir, "b.log"), "y\n")
	time.Sleep(150 * time.Millisecond)
	if f := fileStateOf(t, m, w.ID, filepath.Join(dir, "b.log")); f.Path != "" {
		t.Fatal("paused watch must not pick up new files")
	}
	if _, err := m.Resume(w.ID); err != nil {
		t.Fatal(err)
	}
	eventually(t, "b.log after resume", func() bool { return fileStateOf(t, m, w.ID, filepath.Join(dir, "b.log")).State == "following" })
	_, follows, _ := deps.snapshot()
	if len(follows) != 3 { // a, then a again + b after resume
		t.Fatalf("follows after resume: %+v", follows)
	}

	if err := m.Delete(w.ID); err != nil {
		t.Fatal(err)
	}
	_, _, stops = deps.snapshot()
	if len(stops) != 3 {
		t.Fatalf("delete stops both followers: %v", stops)
	}
	if len(m.List()) != 0 {
		t.Fatal("deleted watch still listed")
	}
	m.Flush()
	b, _ := os.ReadFile(m.Path())
	if strings.Contains(string(b), w.ID) {
		t.Fatal("deleted watch still in the state file")
	}
}

func TestCapAndDirGone(t *testing.T) {
	deps := &fakeDeps{}
	m := newManager(t, t.TempDir(), deps.deps())
	dir := filepath.Join(t.TempDir(), "many")
	_ = os.Mkdir(dir, 0o755)
	for i := 0; i < 150; i++ {
		p := filepath.Join(dir, fmt.Sprintf("f%03d.log", i))
		write(t, p, "x\n")
		// Older mtime for lower numbers so the cap skips them.
		_ = os.Chtimes(p, time.Now(), time.Now().Add(-time.Duration(150-i)*time.Minute))
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m.Start(ctx)
	w, _ := m.Create(types.WatchRequest{Dir: dir, Pattern: "P"})
	eventually(t, "100 following", func() bool {
		got, _ := m.Get(w.ID)
		n := 0
		for _, f := range got.Files {
			if f.State == "following" {
				n++
			}
		}
		return n == MaxFilesPerWatch
	})
	got, _ := m.Get(w.ID)
	skipped := 0
	for _, f := range got.Files {
		if f.State == "skipped" {
			skipped++
		}
	}
	if skipped != 50 || fileStateOf(t, m, w.ID, filepath.Join(dir, "f000.log")).State != "skipped" {
		t.Fatalf("50 oldest skipped: %d", skipped)
	}
	deps.mu.Lock()
	warned := false
	for _, l := range deps.logs {
		if strings.Contains(l, "beyond the 100-file cap") {
			warned = true
		}
	}
	deps.mu.Unlock()
	if !warned {
		t.Fatal("cap warning not logged")
	}

	// Directory removed: watch errors, followers stop, no panic; it
	// recovers when the directory returns.
	_ = os.RemoveAll(dir)
	eventually(t, "watch error", func() bool { g, _ := m.Get(w.ID); return g.Error != "" })
	_, _, stops := deps.snapshot()
	if len(stops) < MaxFilesPerWatch {
		t.Fatalf("followers stopped on dir loss: %d", len(stops))
	}
	_ = os.Mkdir(dir, 0o755)
	write(t, filepath.Join(dir, "new.log"), "z\n")
	eventually(t, "recovered", func() bool {
		g, _ := m.Get(w.ID)
		return g.Error == "" && fileStateOf(t, m, w.ID, filepath.Join(dir, "new.log")).State == "following"
	})
}
