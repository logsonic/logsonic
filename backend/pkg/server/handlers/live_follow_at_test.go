package handlers

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	storagepkg "logsonic/pkg/storage"
	"logsonic/pkg/types"
)

type recordingObserver struct {
	mu       sync.Mutex
	offset   int64
	seq      int64
	rotated  int
	finished string
}

func (o *recordingObserver) Progress(offset, seq int64, _ os.FileInfo) {
	o.mu.Lock()
	o.offset, o.seq = offset, seq
	o.mu.Unlock()
}
func (o *recordingObserver) Rotated(os.FileInfo) { o.mu.Lock(); o.rotated++; o.mu.Unlock() }
func (o *recordingObserver) Finished(status, _ string) {
	o.mu.Lock()
	o.finished = status
	o.mu.Unlock()
}
func (o *recordingObserver) snapshot() (int64, int64, int, string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.offset, o.seq, o.rotated, o.finished
}

func docCount(t *testing.T, st *storagepkg.Storage) uint64 {
	t.Helper()
	dates, _ := st.List()
	var n uint64
	for _, d := range dates {
		c, _ := st.GetDocCount(d)
		n += c
	}
	return n
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// StartFileAt reads from a given offset (0 = the whole file, unlike
// StartFile's end-of-file), reports (offset, seq) at complete-line
// boundaries, and a restart from that pair re-creates the same document
// IDs — so a resume after an unclean stop upserts instead of duplicating.
func TestStartFileAtResumesWithoutDuplicates(t *testing.T) {
	dir := activateL2GConfig(t)
	st, err := storagepkg.NewStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	h := NewHandler(st, dir)
	t.Cleanup(func() { _ = h.Catalog.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	h.StartLive(ctx)

	path := filepath.Join(t.TempDir(), "w.log")
	if err := os.WriteFile(path, []byte("2026-03-01T10:00:00Z INFO api one\n2026-03-01T10:00:01Z INFO api two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	opts := types.IngestSessionOptions{
		Name: "T", Pattern: "%{TIMESTAMP_ISO8601:timestamp} %{WORD:level} %{WORD:service} %{GREEDYDATA:message}",
		Source: "watch.d.w.log", Meta: map[string]interface{}{"_src": "watch.d.w.log"},
	}
	obs := &recordingObserver{}
	id, err := h.Live.StartFileAt(path, opts, 0, 0, obs, "watch")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "progress past two lines", func() bool { o, _, _, _ := obs.snapshot(); return o >= 68 })
	if n := docCount(t, st); n != 2 {
		t.Fatalf("rows from offset 0: %d, want 2", n)
	}
	off, seq, _, _ := obs.snapshot()
	if off != 68 || seq != 2 {
		t.Fatalf("progress after two lines: offset %d seq %d (want 68, 2)", off, seq)
	}
	// Origin kind reaches the catalog.
	if e, err := h.Catalog.Get("watch.d.w.log"); err != nil || e.Origin.Kind != "watch" || e.Origin.Path != path {
		t.Fatalf("catalog origin: %v %+v", err, e)
	}
	if !h.Live.StopSource(id) {
		t.Fatal("stop")
	}
	waitFor(t, "finished", func() bool { _, _, _, f := obs.snapshot(); return f == "stopped" })

	// Simulate a stale resume: restart from the *first* line's boundary
	// with seq 1, so line two is re-read. Same IDs → upsert, count stays 2.
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString("2026-03-01T10:00:02Z INFO api three\n")
	f.Close()
	obs2 := &recordingObserver{}
	id2, err := h.Live.StartFileAt(path, opts, 34, 1, obs2, "watch")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "resume to reach line three", func() bool { o, _, _, _ := obs2.snapshot(); return o >= 104 })
	time.Sleep(300 * time.Millisecond)
	if n := docCount(t, st); n != 3 {
		t.Fatalf("re-reading line two must upsert: %d docs, want 3", n)
	}
	h.Live.StopSource(id2)

	// A stored offset beyond the file (rotated while away) starts at 0.
	obs3 := &recordingObserver{}
	id3, err := h.Live.StartFileAt(path, opts, 10_000, 3, obs3, "watch")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "read from 0 after a too-large offset", func() bool { o, _, _, _ := obs3.snapshot(); return o >= 104 })
	h.Live.StopSource(id3)
}
