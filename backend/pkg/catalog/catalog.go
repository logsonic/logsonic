// Package catalog persists what LogSonic knows about each ingested source
// (spec now-10): where it came from, which pattern parsed it, how many rows
// and bytes it contributed, the timestamp span, and which day-indices hold
// it. It is maintained on the write path — every handler that stores a batch
// calls Record — and reconciled against the indices by Rebuild, which is the
// only place that queries storage. It replaced GetSourceNames, a stored-field
// scan of every index on every /info cache miss.
package catalog

import (
	"context"
	"encoding/json"
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

	"logsonic/pkg/storage"
	"logsonic/pkg/types"
)

const (
	fileName = "sources.json"
	// markerSuffix names the unclean-exit marker: <sources.json>.dirty is
	// created by Open and removed only by a clean Close. If it is already
	// there at Open, the previous process died with up to flushInterval of
	// Records unflushed — and possibly a batch stored but never recorded —
	// so the file cannot be trusted and a full Rebuild runs.
	markerSuffix  = ".dirty"
	schemaVersion = 1
	// flushInterval is the debounce for persisting Record updates. Ingest
	// calls Record once per batch (thousands of times per import); a
	// two-second coalesce keeps sources.json off the hot path while bounding
	// how much a crash can lose to a rebuild.
	flushInterval = 2 * time.Second
	// maxImportsPerSource caps the per-source import history.
	maxImportsPerSource = 50
	dayLayout           = "2006-01-02"
)

var (
	ErrNotFound = errors.New("source not found")
	// ErrNameTaken is returned by Rename when the display name collides
	// with another entry's name, display name or alias — ResolveSources
	// would otherwise be ambiguous.
	ErrNameTaken = errors.New("display name already refers to another source")
	ErrBadName   = errors.New("invalid display name")
)

const maxDisplayNameLen = 120

// Indexer is what Rebuild needs from storage: the day list and per-day
// per-source stats. *storage.Storage satisfies it.
type Indexer interface {
	List() ([]string, error)
	SourceStats(date string) ([]storage.SourceDayStats, error)
	LegacySourceShard(date string) bool
}

type diskFile struct {
	Version int                 `json:"version"`
	Sources []types.SourceEntry `json:"sources"`
}

// Batch is what one stored batch tells the catalog. Rows is the number of
// documents stored; Days and the timestamp bounds come from those rows;
// Bytes is the raw line bytes that produced them.
type Batch struct {
	Source      string
	Origin      types.SourceOrigin
	PatternName string
	Pattern     string
	Rows        int64
	Bytes       int64
	FirstTS     time.Time
	LastTS      time.Time
	DayRows     map[string]int64
	// ImportID groups batches of one ingest session/job into one entry of
	// the source's import history; ImportPath/ImportJobID label it.
	ImportID    string
	ImportPath  string
	ImportJobID string
	// ImportOptions, when set, becomes the entry's replayable options.
	// Callers pass it only for path-backed imports.
	ImportOptions *types.IngestSessionOptions
}

// Catalog is the in-memory catalog plus its on-disk file.
type Catalog struct {
	path    string
	indexer Indexer
	now     func() time.Time

	mu      sync.Mutex
	entries map[string]*types.SourceEntry
	// lastImport maps source -> ImportID of the import entry currently
	// being extended, so a session's many batches collapse into one
	// history row. Not persisted: after a restart a resumed session
	// starts a new row, which is the truth anyway.
	lastImport map[string]string
	dirty      bool
	closed     bool
	loadErr    error
	// rebuiltAtOpen records that Open found no usable file and rebuilt.
	rebuiltAtOpen bool
}

// Open loads <dir>/sources.json. A missing file, a corrupt file, or a file
// from another schema version triggers a synchronous Rebuild from the
// indices (the migration path from versions that had no catalog). Open
// never fails on catalog-file problems — a log tool must start even if
// this side file is unreadable — but does fail if the directory can't be
// created.
func Open(dir string, indexer Indexer) (*Catalog, error) {
	if dir == "" {
		return nil, errors.New("catalog: empty storage dir")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	c := &Catalog{
		path:       filepath.Join(dir, fileName),
		indexer:    indexer,
		now:        time.Now,
		entries:    map[string]*types.SourceEntry{},
		lastImport: map[string]string{},
	}
	reason := c.load()
	if reason == "" {
		if _, err := os.Stat(c.markerPath()); err == nil {
			reason = "previous run did not exit cleanly (" + filepath.Base(c.markerPath()) + " present)"
		}
	}
	if reason != "" {
		start := c.now()
		if err := c.Rebuild(); err != nil {
			log.Printf("catalog: %s; rebuild from indices failed: %v", reason, err)
			c.loadErr = err
		} else {
			c.mu.Lock()
			n := len(c.entries)
			saveErr := c.saveLocked()
			if saveErr == nil {
				c.dirty = false
			}
			c.mu.Unlock()
			if saveErr != nil {
				log.Printf("catalog: save after rebuild: %v", saveErr)
			}
			log.Printf("catalog: %s; rebuilt %d source(s) from indices in %s", reason, n, c.now().Sub(start).Round(time.Millisecond))
		}
		c.rebuiltAtOpen = true
	}
	// From here on this process owns the file; the marker says so until
	// Close removes it.
	if f, err := os.OpenFile(c.markerPath(), os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
		_ = f.Close()
	} else {
		log.Printf("catalog: cannot create %s: %v (an unclean exit will not trigger a rebuild)", c.markerPath(), err)
	}
	return c, nil
}

func (c *Catalog) markerPath() string { return c.path + markerSuffix }

// load reads the file into entries. It returns a non-empty reason when a
// rebuild is needed instead.
func (c *Catalog) load() string {
	b, err := os.ReadFile(c.path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "no sources.json"
		}
		return fmt.Sprintf("sources.json unreadable (%v)", err)
	}
	var f diskFile
	if err := json.Unmarshal(b, &f); err != nil {
		return fmt.Sprintf("sources.json corrupt (%v)", err)
	}
	if f.Version != schemaVersion {
		return fmt.Sprintf("sources.json schema version %d, want %d", f.Version, schemaVersion)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := range f.Sources {
		e := f.Sources[i]
		if e.Name == "" {
			continue
		}
		normalize(&e)
		c.entries[e.Name] = &e
	}
	return ""
}

// RebuiltAtOpen reports whether Open had to reconstruct the catalog.
func (c *Catalog) RebuiltAtOpen() bool { return c.rebuiltAtOpen }

// Start runs the debounced flush loop until ctx is cancelled, then flushes
// once more. Close is still required for the final flush on a shutdown
// path that doesn't cancel ctx first.
func (c *Catalog) Start(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(flushInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				c.Flush()
				return
			case <-ticker.C:
				c.Flush()
			}
		}
	}()
}

// Record folds one stored batch into its source's entry. Safe to call from
// concurrent ingest goroutines; a no-op after Close.
func (c *Catalog) Record(b Batch) {
	if b.Source == "" || b.Rows <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	now := c.now()
	e := c.entries[b.Source]
	if e == nil {
		e = &types.SourceEntry{
			Name:      b.Source,
			CreatedAt: now,
			DayRows:   map[string]int64{},
		}
		c.entries[b.Source] = e
	}
	// First real origin wins, except that a path is always worth taking:
	// a browser upload followed by a path import of the same source should
	// end up re-importable (phase 2 gates that on origin.path).
	if e.Origin.Kind == "" || e.Origin.Kind == "unknown" || (e.Origin.Path == "" && b.Origin.Path != "") {
		e.Origin = b.Origin
	}
	if b.PatternName != "" {
		e.PatternName = b.PatternName
	}
	if b.Pattern != "" {
		e.Pattern = b.Pattern
	}
	e.Rows += b.Rows
	e.BytesRaw += b.Bytes
	for day, n := range b.DayRows {
		e.DayRows[day] += n
	}
	if !b.FirstTS.IsZero() && (e.FirstTS == nil || b.FirstTS.Before(*e.FirstTS)) {
		t := b.FirstTS
		e.FirstTS = &t
	}
	if !b.LastTS.IsZero() && (e.LastTS == nil || b.LastTS.After(*e.LastTS)) {
		t := b.LastTS
		e.LastTS = &t
	}
	if b.ImportOptions != nil {
		opts := *b.ImportOptions
		e.ImportOptions = &opts
	}
	if b.ImportID != "" {
		if c.lastImport[b.Source] == b.ImportID && len(e.Imports) > 0 {
			e.Imports[len(e.Imports)-1].Rows += b.Rows
		} else {
			e.Imports = append(e.Imports, types.SourceImport{At: now, Rows: b.Rows, Path: b.ImportPath, JobID: b.ImportJobID})
			if len(e.Imports) > maxImportsPerSource {
				e.Imports = e.Imports[len(e.Imports)-maxImportsPerSource:]
			}
			c.lastImport[b.Source] = b.ImportID
		}
	}
	e.UpdatedAt = now
	normalize(e)
	c.dirty = true
}

// Rebuild reconciles the catalog with the indices. With no arguments every
// day (on disk or referenced by an entry) is re-read; with days, only those.
// It is a merge, not a replace: rows, day membership and timestamp bounds
// are recomputed from the index, while origin, pattern, import history and
// created_at — which the index cannot know — are kept. Sources found in the
// index with no entry get origin.kind "unknown"; entries whose rows reach
// zero are dropped. Idempotent.
func (c *Catalog) Rebuild(days ...string) error {
	if c.indexer == nil {
		return errors.New("catalog: no indexer")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return errors.New("catalog: closed")
	}

	scope := map[string]bool{}
	if len(days) == 0 {
		onDisk, err := c.indexer.List()
		if err != nil {
			return fmt.Errorf("catalog rebuild: list indices: %w", err)
		}
		for _, d := range onDisk {
			scope[d] = true
		}
		for _, e := range c.entries {
			for d := range e.DayRows {
				scope[d] = true
			}
		}
	} else {
		for _, d := range days {
			scope[d] = true
		}
	}

	statsCache := map[string]map[string]storage.SourceDayStats{}
	legacy := 0
	dayStats := func(day string) (map[string]storage.SourceDayStats, error) {
		if m, ok := statsCache[day]; ok {
			return m, nil
		}
		if c.indexer.LegacySourceShard(day) {
			legacy++
		}
		stats, err := c.indexer.SourceStats(day)
		if err != nil {
			return nil, fmt.Errorf("catalog rebuild: %s: %w", day, err)
		}
		m := make(map[string]storage.SourceDayStats, len(stats))
		for _, s := range stats {
			m[s.Source] = s
		}
		statsCache[day] = m
		return m, nil
	}

	touched := map[string]bool{}
	for day := range scope {
		m, err := dayStats(day)
		if err != nil {
			return err
		}
		// Drop this day from every entry first, then re-add what the index
		// actually holds, so sources with zero rows for the day lose it.
		for name, e := range c.entries {
			if _, had := e.DayRows[day]; had {
				delete(e.DayRows, day)
				touched[name] = true
			}
		}
		for name, s := range m {
			e := c.entries[name]
			if e == nil {
				e = &types.SourceEntry{
					Name:      name,
					Origin:    types.SourceOrigin{Kind: "unknown"},
					CreatedAt: c.now(),
					DayRows:   map[string]int64{},
				}
				c.entries[name] = e
			}
			e.DayRows[day] = int64(s.Rows)
			touched[name] = true
		}
	}

	now := c.now()
	for name := range touched {
		e := c.entries[name]
		var rows int64
		for _, n := range e.DayRows {
			rows += n
		}
		if rows == 0 {
			delete(c.entries, name)
			continue
		}
		e.Rows = rows
		// Bounds: only worth recomputing when a scoped day could hold the
		// current first or last timestamp (±1 day absorbs the row's own
		// timezone vs the day key) or when there are no bounds yet. The
		// daily prune of a middle day then costs nothing here; a prune of
		// the oldest day recomputes across the remaining days, which are
		// cached per SourceStats call.
		if !boundsAffected(e, scope) {
			e.UpdatedAt = now
			normalize(e)
			continue
		}
		var first, last time.Time
		for day := range e.DayRows {
			m, err := dayStats(day)
			if err != nil {
				return err
			}
			s, ok := m[name]
			if !ok {
				continue
			}
			if !s.FirstTS.IsZero() && (first.IsZero() || s.FirstTS.Before(first)) {
				first = s.FirstTS
			}
			if s.LastTS.After(last) {
				last = s.LastTS
			}
		}
		e.FirstTS, e.LastTS = nil, nil
		if !first.IsZero() {
			e.FirstTS = &first
		}
		if !last.IsZero() {
			e.LastTS = &last
		}
		e.UpdatedAt = now
		normalize(e)
	}
	if legacy > 0 {
		log.Printf("catalog: rebuild read stored fields on %d pre-keyword-mapping day index(es); newer indices use a facet", legacy)
	}
	c.dirty = true
	return nil
}

// boundsAffected reports whether any day in scope lies within a day of the
// entry's first or last timestamp, or the entry has no bounds.
func boundsAffected(e *types.SourceEntry, scope map[string]bool) bool {
	if e.FirstTS == nil || e.LastTS == nil {
		return true
	}
	near := func(ts time.Time) bool {
		t := ts.UTC()
		for _, d := range []time.Time{t.AddDate(0, 0, -1), t, t.AddDate(0, 0, 1)} {
			if scope[d.Format(dayLayout)] {
				return true
			}
		}
		return false
	}
	return near(*e.FirstTS) || near(*e.LastTS)
}

// DaysForDocIDs returns the candidate day-indices for a set of document IDs
// (format "<unixnano>-<source>-<seq>", see storage.BuildDocID). The stored
// day came from the row's own timezone, which the ID no longer carries, so
// the UTC day and both neighbours are returned; a scoped Rebuild over an
// extra day is just an exact recount.
func DaysForDocIDs(ids []string) []string {
	seen := map[string]bool{}
	for _, id := range ids {
		var nanos int64
		if _, err := fmt.Sscanf(id, "%d-", &nanos); err != nil {
			continue
		}
		t := time.Unix(0, nanos).UTC()
		for _, d := range []time.Time{t.AddDate(0, 0, -1), t, t.AddDate(0, 0, 1)} {
			seen[d.Format(dayLayout)] = true
		}
	}
	out := make([]string, 0, len(seen))
	for d := range seen {
		out = append(out, d)
	}
	sort.Strings(out)
	return out
}

// Delete removes an entry. The caller has already deleted the rows.
func (c *Catalog) Delete(name string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.entries[name]; !ok {
		return ErrNotFound
	}
	delete(c.entries, name)
	delete(c.lastImport, name)
	c.dirty = true
	return nil
}

// Rename sets the entry's display name and remembers it as an alias so
// searches by any previous display name keep resolving. An empty display
// name clears it (aliases are kept). The name must not collide with any
// other entry's name, display name or alias.
func (c *Catalog) Rename(name, displayName string) (types.SourceEntry, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[name]
	if !ok {
		return types.SourceEntry{}, ErrNotFound
	}
	if len(displayName) > maxDisplayNameLen || displayName != strings.TrimSpace(displayName) {
		return types.SourceEntry{}, ErrBadName
	}
	if displayName != "" && displayName != name {
		for other, oe := range c.entries {
			if other == name {
				continue
			}
			if other == displayName || oe.DisplayName == displayName || contains(oe.Aliases, displayName) {
				return types.SourceEntry{}, ErrNameTaken
			}
		}
	}
	e.DisplayName = displayName
	if displayName != "" && displayName != name && !contains(e.Aliases, displayName) {
		e.Aliases = append(e.Aliases, displayName)
	}
	if displayName == name {
		e.DisplayName = ""
	}
	e.UpdatedAt = c.now()
	normalize(e)
	c.dirty = true
	return cloneEntry(e), nil
}

// ResolveSources maps requested source names to stored _src names: a name
// that is some entry's display name or alias becomes that entry's Name;
// anything else passes through unchanged (it may be a stored name the
// catalog has not seen, or nothing at all — the search decides). Order is
// kept, duplicates dropped.
func (c *Catalog) ResolveSources(names []string) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(names))
	seen := map[string]bool{}
	add := func(n string) {
		if !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	for _, n := range names {
		if _, ok := c.entries[n]; ok {
			add(n)
			continue
		}
		resolved := n
		for stored, e := range c.entries {
			if e.DisplayName == n || contains(e.Aliases, n) {
				resolved = stored
				break
			}
		}
		add(resolved)
	}
	return out
}

// TopSources returns up to n entries by rows descending (ties by name) —
// the _src facet's values, which are corpus-wide by spec (now-02).
func (c *Catalog) TopSources(n int) (values []types.SourceRowsEntry, distinct int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	all := make([]types.SourceRowsEntry, 0, len(c.entries))
	for _, e := range c.entries {
		all = append(all, types.SourceRowsEntry{Name: e.Name, Rows: e.Rows})
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].Rows != all[j].Rows {
			return all[i].Rows > all[j].Rows
		}
		return all[i].Name < all[j].Name
	})
	if n < len(all) {
		all = all[:n]
	}
	return all, len(c.entries)
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// DaysBefore returns every day the catalog references that is older than
// cutoff — the scope for a rebuild after a retention prune, which reports
// only how many indices it removed.
func (c *Catalog) DaysBefore(cutoff time.Time) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	seen := map[string]bool{}
	for _, e := range c.entries {
		for d := range e.DayRows {
			t, err := time.Parse(dayLayout, d)
			if err != nil || !t.Before(cutoff) {
				continue
			}
			seen[d] = true
		}
	}
	out := make([]string, 0, len(seen))
	for d := range seen {
		out = append(out, d)
	}
	sort.Strings(out)
	return out
}

// List returns every entry sorted by name (copies).
func (c *Catalog) List() []types.SourceEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]types.SourceEntry, 0, len(c.entries))
	for _, e := range c.entries {
		out = append(out, cloneEntry(e))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Get returns one entry (a copy) or ErrNotFound.
func (c *Catalog) Get(name string) (types.SourceEntry, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.entries[name]
	if e == nil {
		return types.SourceEntry{}, ErrNotFound
	}
	return cloneEntry(e), nil
}

// Names returns the sorted source names — the /info source_names list.
func (c *Catalog) Names() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(c.entries))
	for name := range c.entries {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// Flush writes the file if anything changed since the last write.
func (c *Catalog) Flush() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.dirty {
		return nil
	}
	if err := c.saveLocked(); err != nil {
		log.Printf("catalog: save %s: %v", c.path, err)
		return err
	}
	c.dirty = false
	return nil
}

// Close flushes and makes every later Record a no-op. The path-ingest jobs
// and tail sources are not awaited before storage closes (see ISSUES.md),
// so a late Record after shutdown must be harmless rather than a write to
// a file the next process may already own.
func (c *Catalog) Close() error {
	err := c.Flush()
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	if err == nil {
		// Only a clean flush earns a clean marker; if the final write
		// failed, the next Open should rebuild.
		if rmErr := os.Remove(c.markerPath()); rmErr != nil && !errors.Is(rmErr, fs.ErrNotExist) {
			log.Printf("catalog: remove %s: %v", c.markerPath(), rmErr)
		}
	}
	return err
}

// Path is the catalog file's location (for diagnostics).
func (c *Catalog) Path() string { return c.path }

func (c *Catalog) saveLocked() error {
	sources := make([]types.SourceEntry, 0, len(c.entries))
	for _, e := range c.entries {
		sources = append(sources, cloneEntry(e))
	}
	sort.Slice(sources, func(i, j int) bool { return sources[i].Name < sources[j].Name })
	b, err := json.MarshalIndent(diskFile{Version: schemaVersion, Sources: sources}, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')

	tmp := c.path + ".tmp"
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
	if err := os.Rename(tmp, c.path); err != nil {
		return err
	}
	if dir, err := os.Open(filepath.Dir(c.path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

// normalize derives Days from DayRows and guarantees non-nil slices/maps so
// the JSON never has null where a client expects [] / {}.
func normalize(e *types.SourceEntry) {
	if e.DayRows == nil {
		e.DayRows = map[string]int64{}
	}
	e.Days = make([]string, 0, len(e.DayRows))
	for d, n := range e.DayRows {
		if n <= 0 {
			delete(e.DayRows, d)
			continue
		}
		e.Days = append(e.Days, d)
	}
	sort.Strings(e.Days)
	if e.Imports == nil {
		e.Imports = []types.SourceImport{}
	}
	if e.Aliases == nil {
		e.Aliases = []string{}
	}
	if e.Origin.Kind == "" {
		e.Origin.Kind = "unknown"
	}
}

// cloneEntry deep-copies an entry. Slices are made, not appended to nil,
// so an empty source still serializes as [] rather than null (the TS type
// says SourceImport[], and the UI will call .length on it).
func cloneEntry(e *types.SourceEntry) types.SourceEntry {
	out := *e
	out.Days = make([]string, len(e.Days))
	copy(out.Days, e.Days)
	out.DayRows = make(map[string]int64, len(e.DayRows))
	for d, n := range e.DayRows {
		out.DayRows[d] = n
	}
	out.Imports = make([]types.SourceImport, len(e.Imports))
	copy(out.Imports, e.Imports)
	out.Aliases = make([]string, len(e.Aliases))
	copy(out.Aliases, e.Aliases)
	if e.ImportOptions != nil {
		opts := *e.ImportOptions
		out.ImportOptions = &opts
	}
	if e.FirstTS != nil {
		t := *e.FirstTS
		out.FirstTS = &t
	}
	if e.LastTS != nil {
		t := *e.LastTS
		out.LastTS = &t
	}
	return out
}

// RowSummary is what SummarizeRows derives for one stored _src value.
type RowSummary struct {
	Rows    int64
	FirstTS time.Time
	LastTS  time.Time
	DayRows map[string]int64
}

// SummarizeRows groups stored rows by their _src field — the catalog key —
// and derives count, timestamp bounds and per-day rows for each (days use
// each row's own timezone, exactly as storage groups them). Rows without a
// _src are attributed to fallback. The stored _src is not always the
// session's Source: the import wizard stamps meta._src = "file.<name>" on
// every row while Source is the bare name, and meta wins in postProcess.
func SummarizeRows(rows []map[string]interface{}, fallback string) map[string]*RowSummary {
	out := map[string]*RowSummary{}
	for _, row := range rows {
		ts, ok := row["timestamp"].(time.Time)
		if !ok {
			continue
		}
		src, _ := row["_src"].(string)
		if src == "" {
			src = fallback
		}
		s := out[src]
		if s == nil {
			s = &RowSummary{DayRows: map[string]int64{}}
			out[src] = s
		}
		s.Rows++
		s.DayRows[ts.Format(dayLayout)]++
		if s.FirstTS.IsZero() || ts.Before(s.FirstTS) {
			s.FirstTS = ts
		}
		if ts.After(s.LastTS) {
			s.LastTS = ts
		}
	}
	return out
}

// SumBytes is the raw-byte size of a batch of lines (plus one newline each).
func SumBytes(lines []string) int64 {
	var n int64
	for _, l := range lines {
		n += int64(len(l)) + 1
	}
	return n
}
