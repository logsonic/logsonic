// Package watch implements folder watches (spec now-04): the user points
// LogSonic at a directory and every matching file that appears is ingested
// and then followed as it grows, without touching the Import flow. It owns
// detection (fsnotify as the hint, a periodic sweep as the truth) and the
// per-file state that lets a watch resume after a restart; the reading
// itself is done by the pieces that already exist — the live-tail follower
// for growth and the path-import reader for a new file's contents — through
// the Deps interfaces, so this package never imports the handlers.
package watch

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/google/uuid"

	"logsonic/pkg/types"
)

const (
	// MaxFilesPerWatch is the spec's cap; files beyond it (oldest mtime
	// first) are marked skipped and a warning is logged once per sweep.
	MaxFilesPerWatch = 100
	defaultGlob      = "*.log"
	// detectLines is how many lines an "auto" watch reads to pick a pattern.
	detectLines = 200
	// flushInterval debounces state writes; every follower Progress would
	// otherwise be a file write.
	flushInterval = 2 * time.Second
	// eventSettle coalesces a burst of fsnotify events into one sweep.
	eventSettle = 500 * time.Millisecond
)

// SweepInterval is how often each watch reconciles the directory listing
// against its state. fsnotify events only bring the next sweep forward. A
// var so tests can shrink it.
var SweepInterval = 60 * time.Second

var (
	ErrNotFound = errors.New("watch not found")
	ErrInvalid  = errors.New("invalid watch")
	// ErrExists: a second watch on the same directory would give the same
	// files the same source names from two independent seq counters —
	// colliding document IDs.
	ErrExists = errors.New("a watch on that directory already exists")
)

// FollowObserver mirrors handlers.FollowObserver (kept here so this package
// does not import handlers).
type FollowObserver interface {
	Progress(offset, seq int64, info os.FileInfo)
	Rotated(info os.FileInfo)
	Finished(status, message string)
}

// Follower is the live-tail machinery: start following a file from an
// offset with a starting seq, and stop by source id.
type Follower interface {
	StartFileAt(path string, opts types.IngestSessionOptions, offset, seq int64, observer FollowObserver, kind string) (string, error)
	StopSource(sourceID string) bool
}

// ImportResult is what a one-shot ingest of a file's current contents
// reports: the byte offset the read finished at (for a plain file, where a
// follower takes over) and the seq the numbering reached.
type ImportResult struct {
	Offset     int64
	Seq        int64
	Rows       int64
	Compressed bool
}

// Importer reads a file's current contents through the path-import path
// (pkg/ingestfile: gzip/zstd sniffed, bounded batches).
type Importer interface {
	ImportFile(ctx context.Context, path string, opts types.IngestSessionOptions) (ImportResult, error)
}

// Detector picks a pattern for a file from its first lines (an "auto"
// watch). It returns the session options to ingest with.
type Detector interface {
	Detect(path string, lines int) (types.IngestSessionOptions, error)
}

// Deps is everything the manager borrows from the server.
type Deps struct {
	Follower Follower
	Importer Importer
	Detector Detector
	// PatternOptions resolves a saved pattern name to session options
	// (name only; the decoder looks the library pattern up).
	PatternOptions func(name string) (types.IngestSessionOptions, error)
	Logf           func(format string, args ...interface{})
}

// Manager owns every watch and the one fsnotify watcher they share.
type Manager struct {
	path string
	deps Deps

	mu      sync.Mutex
	watches map[string]*watchState
	loops   map[string]*watchLoop
	dirty   bool
	closed  bool
	ctx     context.Context
	cancel  context.CancelFunc
	started bool

	notifier *fsnotify.Watcher
	// dirOwners maps a watched directory to the watch ids interested in it.
	dirOwners map[string]map[string]bool
	wg        sync.WaitGroup
}

// Open loads <dir>/watches.json. Nothing runs until Start.
func Open(dir string, deps Deps) (*Manager, error) {
	if dir == "" {
		return nil, errors.New("watch: empty storage dir")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if deps.Logf == nil {
		deps.Logf = log.Printf
	}
	m := &Manager{
		path:      filepath.Join(dir, fileName),
		deps:      deps,
		watches:   map[string]*watchState{},
		loops:     map[string]*watchLoop{},
		dirOwners: map[string]map[string]bool{},
	}
	loaded, err := loadState(m.path)
	if err != nil {
		// A corrupt side file must not keep the server from starting; the
		// watches it held are gone until re-created, and the log says so.
		deps.Logf("watch: %v; starting with no watches", err)
	}
	for _, w := range loaded {
		m.watches[w.ID] = w
	}
	return m, nil
}

// Path is the state file's location.
func (m *Manager) Path() string { return m.path }

// Start launches every loaded watch and the flush loop; ctx cancel stops
// them all (Close does the same and flushes).
func (m *Manager) Start(ctx context.Context) {
	m.mu.Lock()
	if m.started {
		m.mu.Unlock()
		return
	}
	m.started = true
	m.ctx, m.cancel = context.WithCancel(ctx)
	if n, err := fsnotify.NewWatcher(); err == nil {
		m.notifier = n
	} else {
		m.deps.Logf("watch: fsnotify unavailable (%v); relying on the %s sweep", err, SweepInterval)
	}
	ids := make([]string, 0, len(m.watches))
	for id := range m.watches {
		ids = append(ids, id)
	}
	m.mu.Unlock()

	if m.notifier != nil {
		m.wg.Add(1)
		go m.dispatchEvents()
	}
	m.wg.Add(1)
	go m.flushLoop()
	for _, id := range ids {
		m.startLoop(id)
	}
	go func() {
		<-m.ctx.Done()
		_ = m.Close()
	}()
}

// Close stops every watch, flushes state, and makes later writes no-ops.
func (m *Manager) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	loops := make([]*watchLoop, 0, len(m.loops))
	for _, l := range m.loops {
		loops = append(loops, l)
	}
	cancel := m.cancel
	notifier := m.notifier
	m.mu.Unlock()

	for _, l := range loops {
		l.stop()
	}
	if cancel != nil {
		cancel()
	}
	if notifier != nil {
		_ = notifier.Close()
	}
	m.wg.Wait()
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.saveLocked()
}

// ----------------------------------------------------------------------------
// CRUD

// List returns every watch with its file snapshot, oldest first.
func (m *Manager) List() []types.Watch {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]types.Watch, 0, len(m.watches))
	for _, w := range m.watches {
		out = append(out, w.toAPI())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

// Get returns one watch.
func (m *Manager) Get(id string) (types.Watch, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	w, ok := m.watches[id]
	if !ok {
		return types.Watch{}, ErrNotFound
	}
	return w.toAPI(), nil
}

// Create validates the request, persists the watch, and starts it if the
// manager is running.
func (m *Manager) Create(req types.WatchRequest) (types.Watch, error) {
	if !filepath.IsAbs(req.Dir) {
		return types.Watch{}, fmt.Errorf("%w: dir must be an absolute path, got %q", ErrInvalid, req.Dir)
	}
	dir := filepath.Clean(req.Dir)
	info, err := os.Stat(dir)
	if err != nil {
		return types.Watch{}, fmt.Errorf("%w: %s: %v", ErrInvalid, dir, err)
	}
	if !info.IsDir() {
		return types.Watch{}, fmt.Errorf("%w: %s is not a directory", ErrInvalid, dir)
	}
	glob := strings.TrimSpace(req.Glob)
	if glob == "" {
		glob = defaultGlob
	}
	if _, err := filepath.Match(glob, "probe"); err != nil {
		return types.Watch{}, fmt.Errorf("%w: glob %q: %v", ErrInvalid, glob, err)
	}
	pattern := strings.TrimSpace(req.Pattern)
	if pattern == "auto" {
		pattern = ""
	}
	if pattern != "" && m.deps.PatternOptions != nil {
		if _, err := m.deps.PatternOptions(pattern); err != nil {
			return types.Watch{}, fmt.Errorf("%w: pattern %q: %v", ErrInvalid, pattern, err)
		}
	}

	w := &watchState{
		ID: uuid.New().String(), Dir: dir, Glob: glob, Pattern: pattern, Recursive: req.Recursive,
		CreatedAt: time.Now(), Files: map[string]*fileState{},
	}
	m.mu.Lock()
	for _, existing := range m.watches {
		if existing.Dir == dir {
			m.mu.Unlock()
			return types.Watch{}, fmt.Errorf("%w: %s (watch %s)", ErrExists, dir, existing.ID)
		}
	}
	m.watches[w.ID] = w
	m.dirty = true
	started := m.started && !m.closed
	m.mu.Unlock()
	if started {
		m.startLoop(w.ID)
	}
	return m.Get(w.ID)
}

// Delete stops the watch and forgets it. Indexed rows stay.
func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	w, ok := m.watches[id]
	if !ok {
		m.mu.Unlock()
		return ErrNotFound
	}
	l := m.loops[id]
	delete(m.loops, id)
	m.mu.Unlock()
	// Stop the loop while the watch is still known: its exit path stops
	// the followers by looking the files up in m.watches.
	if l != nil {
		l.stop()
	}
	m.mu.Lock()
	delete(m.watches, id)
	m.dirty = true
	m.mu.Unlock()
	m.unwatchDirs(id, w)
	return nil
}

// Pause stops the watch's followers and sweeps; offsets are kept.
func (m *Manager) Pause(id string) (types.Watch, error) {
	m.mu.Lock()
	w, ok := m.watches[id]
	if !ok {
		m.mu.Unlock()
		return types.Watch{}, ErrNotFound
	}
	if w.Paused {
		m.mu.Unlock()
		return m.Get(id)
	}
	w.Paused = true
	m.dirty = true
	l := m.loops[id]
	delete(m.loops, id)
	m.mu.Unlock()
	if l != nil {
		l.stop()
	}
	return m.Get(id)
}

// Resume restarts a paused watch; the first sweep runs immediately.
func (m *Manager) Resume(id string) (types.Watch, error) {
	m.mu.Lock()
	w, ok := m.watches[id]
	if !ok {
		m.mu.Unlock()
		return types.Watch{}, ErrNotFound
	}
	if !w.Paused {
		m.mu.Unlock()
		return m.Get(id)
	}
	w.Paused = false
	m.dirty = true
	started := m.started && !m.closed
	m.mu.Unlock()
	if started {
		m.startLoop(id)
	}
	return m.Get(id)
}

// ----------------------------------------------------------------------------
// Persistence

func (m *Manager) flushLoop() {
	defer m.wg.Done()
	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.Flush()
		}
	}
}

// Flush writes the state file if anything changed.
func (m *Manager) Flush() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.dirty {
		return
	}
	if err := m.saveLocked(); err != nil {
		m.deps.Logf("watch: save %s: %v", m.path, err)
	}
}

func (m *Manager) saveLocked() error {
	list := make([]*watchState, 0, len(m.watches))
	for _, w := range m.watches {
		list = append(list, w)
	}
	if err := saveState(m.path, list); err != nil {
		return err
	}
	m.dirty = false
	return nil
}

// ----------------------------------------------------------------------------
// Per-watch loop

type watchLoop struct {
	m      *Manager
	id     string
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
	kick   chan struct{}
}

func (m *Manager) startLoop(id string) {
	m.mu.Lock()
	if m.closed || m.ctx == nil {
		m.mu.Unlock()
		return
	}
	if _, running := m.loops[id]; running {
		m.mu.Unlock()
		return
	}
	w, ok := m.watches[id]
	if !ok || w.Paused {
		m.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(m.ctx)
	l := &watchLoop{m: m, id: id, ctx: ctx, cancel: cancel, done: make(chan struct{}), kick: make(chan struct{}, 1)}
	m.loops[id] = l
	m.mu.Unlock()
	m.watchDir(id, w.Dir)
	m.wg.Add(1)
	go l.run()
}

func (l *watchLoop) stop() {
	l.cancel()
	<-l.done
}

// kickSoon asks for a sweep after eventSettle; repeated kicks coalesce.
func (l *watchLoop) kickSoon() {
	select {
	case l.kick <- struct{}{}:
	default:
	}
}

func (l *watchLoop) run() {
	defer l.m.wg.Done()
	defer close(l.done)
	defer l.stopFollowers()

	l.sweep()
	ticker := time.NewTicker(SweepInterval)
	defer ticker.Stop()
	var settle <-chan time.Time
	for {
		select {
		case <-l.ctx.Done():
			return
		case <-ticker.C:
			l.sweep()
		case <-l.kick:
			if settle == nil {
				settle = time.After(eventSettle)
			}
		case <-settle:
			settle = nil
			l.sweep()
		}
	}
}

// stopFollowers stops every follower this watch owns and records their
// last state; called when the loop exits (pause, delete, shutdown).
func (l *watchLoop) stopFollowers() {
	l.m.mu.Lock()
	w := l.m.watches[l.id]
	var ids []string
	if w != nil {
		for _, f := range w.Files {
			if f.sourceID != "" {
				ids = append(ids, f.sourceID)
				f.sourceID = ""
				if f.State == "following" {
					f.State = "pending"
				}
				l.m.dirty = true
			}
		}
	}
	l.m.mu.Unlock()
	for _, id := range ids {
		l.m.deps.Follower.StopSource(id)
	}
}

// sweep is the source of truth: list the directory, reconcile with state.
func (l *watchLoop) sweep() {
	l.m.mu.Lock()
	w := l.m.watches[l.id]
	if w == nil {
		l.m.mu.Unlock()
		return
	}
	dir, glob, recursive, pattern := w.Dir, w.Glob, w.Recursive, w.Pattern
	l.m.mu.Unlock()

	candidates, err := listCandidates(dir, glob, recursive)
	if err != nil {
		l.setWatchError(err.Error())
		l.dropAllFiles()
		return
	}
	l.setWatchError("")
	if recursive {
		for _, d := range candidates.dirs {
			l.m.watchDir(l.id, d)
		}
	}

	// Cap: keep the newest MaxFilesPerWatch by mtime; the rest are skipped.
	sort.Slice(candidates.files, func(i, j int) bool {
		return candidates.files[i].info.ModTime().After(candidates.files[j].info.ModTime())
	})
	skipped := 0
	present := map[string]bool{}
	for i, c := range candidates.files {
		present[c.path] = true
		if i >= MaxFilesPerWatch {
			skipped++
			l.markSkipped(c.path, c.info)
			continue
		}
		l.reconcileFile(c.path, c.info, pattern)
	}
	if skipped > 0 {
		l.m.deps.Logf("watch %s: %d file(s) beyond the %d-file cap in %s are skipped (oldest first)", l.id, skipped, MaxFilesPerWatch, dir)
	}
	// Files gone from the listing: stop their followers and forget them;
	// if one comes back it is a new file and is read from 0.
	l.m.mu.Lock()
	var stopIDs []string
	for path, f := range w.Files {
		if present[path] {
			continue
		}
		if f.sourceID != "" {
			stopIDs = append(stopIDs, f.sourceID)
		}
		delete(w.Files, path)
		l.m.dirty = true
	}
	l.m.mu.Unlock()
	for _, id := range stopIDs {
		l.m.deps.Follower.StopSource(id)
	}
}

type candidate struct {
	path string
	info os.FileInfo
}

type listing struct {
	files []candidate
	dirs  []string
}

// listCandidates returns the matching files (by base name) under dir, and
// with recursive the subdirectories to watch too. Symlinked directories are
// never followed; symlinked files are (they're what the user pointed at).
func listCandidates(dir, glob string, recursive bool) (listing, error) {
	var out listing
	var walk func(d string) error
	walk = func(d string) error {
		entries, err := os.ReadDir(d)
		if err != nil {
			return err
		}
		for _, e := range entries {
			p := filepath.Join(d, e.Name())
			if e.IsDir() {
				if recursive {
					out.dirs = append(out.dirs, p)
					if err := walk(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
						return err
					}
				}
				continue
			}
			if e.Type()&os.ModeSymlink != 0 {
				info, err := os.Stat(p)
				if err != nil || info.IsDir() {
					continue
				}
			}
			if ok, _ := filepath.Match(glob, e.Name()); !ok {
				continue
			}
			info, err := os.Stat(p)
			if err != nil {
				continue
			}
			out.files = append(out.files, candidate{path: p, info: info})
		}
		return nil
	}
	if err := walk(dir); err != nil {
		return listing{}, err
	}
	return out, nil
}

func (l *watchLoop) setWatchError(msg string) {
	l.m.mu.Lock()
	defer l.m.mu.Unlock()
	if w := l.m.watches[l.id]; w != nil && w.Error != msg {
		w.Error = msg
		l.m.dirty = true
	}
}

// dropAllFiles stops every follower when the directory itself is gone;
// state entries are kept (marked error) so the UI can show what happened.
func (l *watchLoop) dropAllFiles() {
	l.m.mu.Lock()
	w := l.m.watches[l.id]
	var ids []string
	if w != nil {
		for _, f := range w.Files {
			if f.sourceID != "" {
				ids = append(ids, f.sourceID)
				f.sourceID = ""
			}
			f.State = "error"
			f.Error = "directory unavailable"
		}
		l.m.dirty = true
	}
	l.m.mu.Unlock()
	for _, id := range ids {
		l.m.deps.Follower.StopSource(id)
	}
}

func (l *watchLoop) markSkipped(path string, info os.FileInfo) {
	l.m.mu.Lock()
	defer l.m.mu.Unlock()
	w := l.m.watches[l.id]
	if w == nil {
		return
	}
	f := w.Files[path]
	if f == nil {
		f = &fileState{Path: path, Source: sourceName(w.Dir, path)}
		w.Files[path] = f
	}
	if f.sourceID != "" {
		return // already followed; the cap applies to new files
	}
	f.State, f.Size = "skipped", info.Size()
	f.Error = fmt.Sprintf("beyond the %d-file cap", MaxFilesPerWatch)
	l.m.dirty = true
}

// reconcileFile decides what to do with one matching file.
func (l *watchLoop) reconcileFile(path string, info os.FileInfo, pattern string) {
	l.m.mu.Lock()
	w := l.m.watches[l.id]
	if w == nil {
		l.m.mu.Unlock()
		return
	}
	f := w.Files[path]
	if f == nil {
		f = &fileState{Path: path, Source: sourceName(w.Dir, path), State: "pending"}
		w.Files[path] = f
		l.m.dirty = true
	}
	switch f.State {
	case "following", "ingesting":
		// The follower owns growth and rotation.
		l.m.mu.Unlock()
		return
	case "done":
		// A compressed file: re-ingest only if it was replaced.
		dev, ino := fileID(info)
		if dev == f.Dev && ino == f.Ino && info.Size() == f.Size {
			l.m.mu.Unlock()
			return
		}
	case "skipped":
		f.State, f.Error = "pending", ""
	case "error":
		// Retry on the next sweep only if the file changed since.
		dev, ino := fileID(info)
		if dev == f.Dev && ino == f.Ino && info.Size() == f.Size {
			l.m.mu.Unlock()
			return
		}
		f.State, f.Error = "pending", ""
	}
	// Resume from the stored offset when it is the same file and it has
	// not shrunk; otherwise it was rotated or is new — read from 0.
	dev, ino := fileID(info)
	resume := f.Offset > 0 && dev == f.Dev && ino == f.Ino && info.Size() >= f.Offset
	if !resume {
		f.Offset, f.Seq = 0, 0
	}
	f.Dev, f.Ino, f.Size = dev, ino, info.Size()
	f.State = "ingesting"
	source := f.Source
	offset, seq := f.Offset, f.Seq
	l.m.dirty = true
	l.m.mu.Unlock()

	l.m.wg.Add(1)
	go func() {
		defer l.m.wg.Done()
		l.startFile(path, source, pattern, offset, seq)
	}()
}

// startFile runs in its own goroutine: detect (auto), one-shot import of
// the current contents from the offset (plain and compressed alike), then
// hand a plain file to the follower from where the import stopped.
func (l *watchLoop) startFile(path, source, pattern string, offset, seq int64) {
	opts, err := l.optionsFor(path, pattern)
	if err != nil {
		l.setFileError(path, fmt.Sprintf("pattern: %v", err))
		return
	}
	opts.Source = source
	if opts.Meta == nil {
		opts.Meta = map[string]interface{}{}
	}
	opts.Meta["_src"] = source
	l.setFilePattern(path, opts.Name, opts.Pattern)

	if offset == 0 {
		res, err := l.m.deps.Importer.ImportFile(l.ctx, path, opts)
		if err != nil {
			if l.ctx.Err() != nil {
				return
			}
			l.setFileError(path, fmt.Sprintf("import: %v", err))
			return
		}
		if res.Compressed {
			l.setFileDone(path, res)
			return
		}
		offset, seq = res.Offset, res.Seq
		l.recordProgress(path, offset, seq, res.Offset)
	}
	if l.ctx.Err() != nil {
		return
	}
	obs := &fileObserver{l: l, path: path}
	id, err := l.m.deps.Follower.StartFileAt(path, opts, offset, seq, obs, "watch")
	if err != nil {
		l.setFileError(path, fmt.Sprintf("follow: %v", err))
		return
	}
	l.m.mu.Lock()
	if w := l.m.watches[l.id]; w != nil {
		if f := w.Files[path]; f != nil {
			if l.ctx.Err() != nil {
				// Stopped while we were starting: don't leave an orphan.
				l.m.mu.Unlock()
				l.m.deps.Follower.StopSource(id)
				return
			}
			f.sourceID = id
			f.State = "following"
			l.m.dirty = true
		}
	}
	l.m.mu.Unlock()
}

func (l *watchLoop) optionsFor(path, pattern string) (types.IngestSessionOptions, error) {
	if pattern != "" {
		if l.m.deps.PatternOptions == nil {
			return types.IngestSessionOptions{Name: pattern}, nil
		}
		return l.m.deps.PatternOptions(pattern)
	}
	if l.m.deps.Detector == nil {
		return types.IngestSessionOptions{}, errors.New("no detector configured")
	}
	return l.m.deps.Detector.Detect(path, detectLines)
}

// fileObserver forwards the follower's progress into the watch state.
type fileObserver struct {
	l    *watchLoop
	path string
}

func (o *fileObserver) Progress(offset, seq int64, info os.FileInfo) {
	o.l.recordProgress(o.path, offset, seq, info.Size())
}

func (o *fileObserver) Rotated(info os.FileInfo) {
	o.l.m.mu.Lock()
	defer o.l.m.mu.Unlock()
	if w := o.l.m.watches[o.l.id]; w != nil {
		if f := w.Files[o.path]; f != nil {
			f.Dev, f.Ino = fileID(info)
			f.Offset, f.Seq, f.Size = 0, 0, info.Size()
			o.l.m.dirty = true
		}
	}
}

func (o *fileObserver) Finished(status, message string) {
	o.l.m.mu.Lock()
	defer o.l.m.mu.Unlock()
	w := o.l.m.watches[o.l.id]
	if w == nil {
		return
	}
	f := w.Files[o.path]
	if f == nil {
		return
	}
	f.sourceID = ""
	switch status {
	case "error":
		f.State, f.Error = "error", message
	default:
		if f.State == "following" {
			f.State = "pending"
		}
	}
	o.l.m.dirty = true
}

func (l *watchLoop) recordProgress(path string, offset, seq, size int64) {
	l.m.mu.Lock()
	defer l.m.mu.Unlock()
	if w := l.m.watches[l.id]; w != nil {
		if f := w.Files[path]; f != nil {
			f.Offset, f.Seq, f.Size = offset, seq, size
			l.m.dirty = true
		}
	}
}

func (l *watchLoop) setFilePattern(path, name, pattern string) {
	l.m.mu.Lock()
	defer l.m.mu.Unlock()
	if w := l.m.watches[l.id]; w != nil {
		if f := w.Files[path]; f != nil {
			if name != "" {
				f.Pattern = name
			} else if pattern != "" {
				f.Pattern = pattern
			}
			l.m.dirty = true
		}
	}
}

func (l *watchLoop) setFileDone(path string, res ImportResult) {
	l.m.mu.Lock()
	defer l.m.mu.Unlock()
	if w := l.m.watches[l.id]; w != nil {
		if f := w.Files[path]; f != nil {
			f.State, f.Error, f.Offset, f.Seq = "done", "", res.Offset, res.Seq
			l.m.dirty = true
		}
	}
}

func (l *watchLoop) setFileError(path, msg string) {
	l.m.mu.Lock()
	defer l.m.mu.Unlock()
	if w := l.m.watches[l.id]; w != nil {
		if f := w.Files[path]; f != nil {
			f.State, f.Error, f.sourceID = "error", msg, ""
			l.m.dirty = true
		}
	}
	l.m.deps.Logf("watch %s: %s: %s", l.id, path, msg)
}

// sourceName is the _src for a watched file: watch.<dirname>.<filename>,
// with the path relative to the watch dir in between for a file found by
// a recursive watch (watch.logs.x.app.log), so x/app.log and y/app.log
// don't share a source. Two watches on directories with the same base name
// can still collide; Create refuses the same directory twice, and the
// cross-directory case is recorded in ISSUES.md.
func sourceName(dir, path string) string {
	rel, err := filepath.Rel(dir, path)
	if err != nil || strings.HasPrefix(rel, "..") {
		rel = filepath.Base(path)
	}
	return "watch." + filepath.Base(dir) + "." + strings.ReplaceAll(filepath.ToSlash(rel), "/", ".")
}

// ----------------------------------------------------------------------------
// fsnotify (one watcher for the manager; events only bring a sweep forward)

func (m *Manager) watchDir(id, dir string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.notifier == nil {
		return
	}
	owners := m.dirOwners[dir]
	if owners == nil {
		if err := m.notifier.Add(dir); err != nil {
			m.deps.Logf("watch %s: fsnotify add %s: %v (the %s sweep still covers it)", id, dir, err, SweepInterval)
			return
		}
		owners = map[string]bool{}
		m.dirOwners[dir] = owners
	}
	owners[id] = true
}

func (m *Manager) unwatchDirs(id string, w *watchState) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.notifier == nil {
		return
	}
	for dir, owners := range m.dirOwners {
		if !owners[id] {
			continue
		}
		delete(owners, id)
		if len(owners) == 0 {
			_ = m.notifier.Remove(dir)
			delete(m.dirOwners, dir)
		}
	}
	_ = w
}

func (m *Manager) dispatchEvents() {
	defer m.wg.Done()
	for {
		select {
		case <-m.ctx.Done():
			return
		case ev, ok := <-m.notifier.Events:
			if !ok {
				return
			}
			dir := filepath.Dir(ev.Name)
			m.mu.Lock()
			var loops []*watchLoop
			for owner := range m.dirOwners[dir] {
				if l := m.loops[owner]; l != nil {
					loops = append(loops, l)
				}
			}
			// A new directory under a recursive watch is itself an event on
			// its parent; the sweep it triggers adds it.
			m.mu.Unlock()
			for _, l := range loops {
				l.kickSoon()
			}
		case err, ok := <-m.notifier.Errors:
			if !ok {
				return
			}
			m.deps.Logf("watch: fsnotify: %v", err)
		}
	}
}
