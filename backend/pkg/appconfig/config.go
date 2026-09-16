// Package appconfig owns <storage>/config.json, the server-side settings
// file the UI writes (spec now-10: retention days; next-10 and next-11 add
// their own keys). The file is decoded into a map and re-encoded on save so
// a key this version doesn't know about — written by a newer build or by a
// later feature — survives a Set from here; only the key being changed is
// touched. Writes are atomic (temp + rename) and the file carries a version.
package appconfig

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

const (
	fileName      = "config.json"
	schemaVersion = 1
	// KeyRetentionDays is the retention override: absent = use the CLI
	// flag / env default; 0 = explicitly disabled; N > 0 = N days.
	KeyRetentionDays = "retention_days"
)

// Store is the in-memory view of config.json plus its path.
type Store struct {
	path string
	mu   sync.Mutex
	keys map[string]json.RawMessage
}

// Open reads <dir>/config.json. A missing file is an empty config; a
// corrupt one is logged and treated as empty (the next Save rewrites it),
// since a settings side file must never keep the server from starting.
func Open(dir string) (*Store, error) {
	if dir == "" {
		return nil, errors.New("appconfig: empty storage dir")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, fileName), keys: map[string]json.RawMessage{}}
	b, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return s, nil
		}
		log.Printf("appconfig: %s unreadable (%v); starting with defaults", s.path, err)
		return s, nil
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		log.Printf("appconfig: %s is not valid JSON (%v); starting with defaults — fix or delete the file to silence this", s.path, err)
		return s, nil
	}
	delete(raw, "version")
	s.keys = raw
	return s, nil
}

// Path is the file's location.
func (s *Store) Path() string { return s.path }

// RetentionDays returns the override and whether one is set.
func (s *Store) RetentionDays() (days int, set bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, ok := s.keys[KeyRetentionDays]
	if !ok {
		return 0, false
	}
	if err := json.Unmarshal(raw, &days); err != nil || days < 0 {
		// A malformed value behaves like "unset" rather than like "0".
		return 0, false
	}
	return days, true
}

// SetRetentionDays writes the override (nil clears it) and saves.
func (s *Store) SetRetentionDays(days *int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if days == nil {
		delete(s.keys, KeyRetentionDays)
	} else {
		if *days < 0 {
			return fmt.Errorf("retention_days must be >= 0, got %d", *days)
		}
		b, _ := json.Marshal(*days)
		s.keys[KeyRetentionDays] = b
	}
	return s.saveLocked()
}

// Keys lists the keys present (for diagnostics/tests).
func (s *Store) Keys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.keys))
	for k := range s.keys {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (s *Store) saveLocked() error {
	doc := make(map[string]interface{}, len(s.keys)+1)
	doc["version"] = schemaVersion
	for k, v := range s.keys {
		doc[k] = v
	}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	tmp := s.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return err
	}
	if dir, err := os.Open(filepath.Dir(s.path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}
