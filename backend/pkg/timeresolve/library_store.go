package timeresolve

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// LibraryStore persists per-pattern Resolution alongside log2grok's
// KnownPatterns library. log2grok itself doesn't carry a timestamp
// resolution field on its KnownPattern, so we keep this side-file in
// the logsonic storage directory rather than touching the upstream
// schema. Saved patterns thus get their preferred anchor / year
// strategy / timezone restored on next import.
//
// The on-disk shape is a flat map keyed by pattern name:
//
//	{
//	  "Spark":  { "anchor": ..., "year_strategy": ..., ... },
//	  "Syslog": { ... }
//	}
//
// Lookups are case-sensitive on the pattern name, mirroring log2grok.
type LibraryStore struct {
	path string
	mu   sync.RWMutex
	data map[string]Resolution
}

// NewLibraryStore opens (or lazily creates) the side-file at
// <dir>/pattern_timestamps.json. A missing file is not an error —
// the store starts empty and the first Set() flushes to disk.
func NewLibraryStore(dir string) (*LibraryStore, error) {
	if dir == "" {
		return nil, errors.New("timeresolve: empty storage dir")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &LibraryStore{
		path: filepath.Join(dir, "pattern_timestamps.json"),
		data: map[string]Resolution{},
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *LibraryStore) load() error {
	b, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(b) == 0 {
		return nil
	}
	parsed := map[string]Resolution{}
	if err := json.Unmarshal(b, &parsed); err != nil {
		// A corrupt side-file shouldn't bring down logsonic — log
		// patterns themselves still load from log2grok. Treat as
		// empty and let the next Set() rewrite it cleanly.
		return nil
	}
	s.data = parsed
	return nil
}

func (s *LibraryStore) flush() error {
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Get returns the saved Resolution for a pattern, or (zero, false)
// when none was saved. Callers should NOT mutate the returned value.
func (s *LibraryStore) Get(name string) (Resolution, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.data[name]
	return r, ok
}

// Set persists a Resolution under the given pattern name. Overwrites
// any existing entry. A nil receiver is a no-op so callers can pass
// an unconfigured store without an extra check.
func (s *LibraryStore) Set(name string, res Resolution) error {
	if s == nil {
		return nil
	}
	if name == "" {
		return errors.New("timeresolve: empty pattern name")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data[name] = res
	return s.flush()
}

// Delete removes the entry for a pattern name. Missing entries are
// silently ignored.
func (s *LibraryStore) Delete(name string) error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.data[name]; !ok {
		return nil
	}
	delete(s.data, name)
	return s.flush()
}

// Snapshot returns a shallow copy of the in-memory state. Useful
// for tests and for bulk-merging into the GET /grok response.
func (s *LibraryStore) Snapshot() map[string]Resolution {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]Resolution, len(s.data))
	for k, v := range s.data {
		out[k] = v
	}
	return out
}
