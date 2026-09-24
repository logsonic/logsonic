package watch

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"

	"logsonic/pkg/types"
)

const (
	fileName      = "watches.json"
	schemaVersion = 1
)

// fileState is what the watch remembers about one file between sweeps and
// across restarts. Offset and Seq are recorded together at a complete-line
// boundary (FollowObserver.Progress), so a resume re-creates the same
// document IDs. Dev/Ino tell a rotation from growth. SourceID is the live
// follower's id and is not persisted.
type fileState struct {
	Path    string `json:"path"`
	Dev     uint64 `json:"dev,omitempty"`
	Ino     uint64 `json:"ino,omitempty"`
	Offset  int64  `json:"offset"`
	Seq     int64  `json:"seq"`
	Size    int64  `json:"size"`
	State   string `json:"state"`
	Error   string `json:"error,omitempty"`
	Source  string `json:"source"`
	Pattern string `json:"pattern,omitempty"`

	sourceID string
}

// watchState is one watch's config plus its files, as persisted.
type watchState struct {
	ID        string    `json:"id"`
	Dir       string    `json:"dir"`
	Glob      string    `json:"glob"`
	Pattern   string    `json:"pattern,omitempty"`
	Recursive bool      `json:"recursive,omitempty"`
	Paused    bool      `json:"paused"`
	CreatedAt time.Time `json:"created_at"`
	// Files is keyed by path in memory and sorted by path on disk.
	Files map[string]*fileState `json:"-"`
	Error string                `json:"error,omitempty"`

	FilesList []fileState `json:"files"`
}

type diskFile struct {
	Version int          `json:"version"`
	Watches []watchState `json:"watches"`
}

func (w *watchState) toAPI() types.Watch {
	out := types.Watch{
		ID: w.ID,
		WatchRequest: types.WatchRequest{
			Dir: w.Dir, Glob: w.Glob, Pattern: w.Pattern, Recursive: w.Recursive,
		},
		Paused:    w.Paused,
		CreatedAt: w.CreatedAt,
		Error:     w.Error,
		Files:     make([]types.WatchFile, 0, len(w.Files)),
	}
	for _, f := range w.Files {
		out.Files = append(out.Files, types.WatchFile{
			Path: f.Path, Offset: f.Offset, Size: f.Size, State: f.State, Error: f.Error, Source: f.Source, Pattern: f.Pattern,
		})
	}
	sort.Slice(out.Files, func(i, j int) bool { return out.Files[i].Path < out.Files[j].Path })
	return out
}

func loadState(path string) ([]*watchState, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var f diskFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if f.Version != schemaVersion {
		return nil, fmt.Errorf("%s: schema version %d, want %d", path, f.Version, schemaVersion)
	}
	out := make([]*watchState, 0, len(f.Watches))
	for i := range f.Watches {
		w := f.Watches[i]
		w.Files = make(map[string]*fileState, len(w.FilesList))
		for j := range w.FilesList {
			fsCopy := w.FilesList[j]
			// A follower is never "following" after a restart; the sweep
			// decides whether to resume it.
			if fsCopy.State == "following" || fsCopy.State == "ingesting" {
				fsCopy.State = "pending"
			}
			w.Files[fsCopy.Path] = &fsCopy
		}
		w.FilesList = nil
		out = append(out, &w)
	}
	return out, nil
}

// saveState writes atomically (temp + rename), files sorted by path.
func saveState(path string, watches []*watchState) error {
	doc := diskFile{Version: schemaVersion, Watches: make([]watchState, 0, len(watches))}
	for _, w := range watches {
		cp := *w
		cp.Files = nil
		cp.FilesList = make([]fileState, 0, len(w.Files))
		for _, f := range w.Files {
			cp.FilesList = append(cp.FilesList, *f)
		}
		sort.Slice(cp.FilesList, func(i, j int) bool { return cp.FilesList[i].Path < cp.FilesList[j].Path })
		doc.Watches = append(doc.Watches, cp)
	}
	sort.Slice(doc.Watches, func(i, j int) bool { return doc.Watches[i].CreatedAt.Before(doc.Watches[j].CreatedAt) })
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	tmp := path + ".tmp"
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
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}
