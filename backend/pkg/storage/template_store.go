package storage

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/blevesearch/bleve/v2"
	bolt "go.etcd.io/bbolt"
)

const templateDirectory = "template-v1"

// The common root lock prevents different engines from claiming an empty
// directory simultaneously, before either has written its first shard.
func openStorageLock(dir string) (*bolt.DB, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	lock, err := bolt.Open(filepath.Join(dir, ".storage.lock"), 0600, &bolt.Options{Timeout: 100 * time.Millisecond})
	if err != nil {
		return nil, fmt.Errorf("lock storage (another process may have it open): %w", err)
	}
	return lock, nil
}

// StorageEngine adds lifecycle management to the server's storage contract.
type StorageEngine interface {
	StorageInterface
	Close() error
}

// NewStorageWithEngine never converts an existing directory in place. Auto
// keeps Bleve for new directories and recognizes an explicitly created template store.
func NewStorageWithEngine(dir, engine string) (StorageEngine, error) {
	_, statErr := os.Stat(filepath.Join(dir, templateDirectory))
	if statErr != nil && !os.IsNotExist(statErr) {
		return nil, statErr
	}
	hasTemplates := statErr == nil
	switch engine {
	case "", "auto":
		if hasTemplates {
			return NewTemplateStorage(dir)
		}
		return NewStorage(dir)
	case "template":
		return NewTemplateStorage(dir)
	case "bleve":
		if hasTemplates {
			return nil, errors.New("storage contains template data; use storage-engine auto/template or a separate directory")
		}
		return NewStorage(dir)
	default:
		return nil, fmt.Errorf("unknown storage engine %q: use auto, bleve, or template", engine)
	}
}

// TemplateStorage persists immutable lossless compressed segments and uses
// memory-only Scorch indexes as disposable query caches. Query syntax, analyzers,
// projection and facets therefore share the established Storage implementation.
// This experimental backend trades disk footprint for replay time and index RAM.
type TemplateStorage struct {
	mu       sync.RWMutex // operation lease: readers cannot race close, commit or deletion
	store    *Storage
	dir      string
	lock     *bolt.DB
	sequence map[string]uint64
	closed   bool
	failed   error // fail closed if durable and memory state may have diverged
}

func NewTemplateStorage(baseDir string) (_ *TemplateStorage, err error) {
	abs, err := filepath.Abs(baseDir)
	if err != nil {
		return nil, err
	}
	lock, err := openStorageLock(abs)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			_ = lock.Close()
		}
	}()
	legacy, err := filepath.Glob(filepath.Join(abs, "logs-*.bleve"))
	if err != nil {
		return nil, err
	}
	if len(legacy) > 0 {
		return nil, errors.New("storage contains Bleve shards; select a separate directory for the template experiment")
	}
	dir := filepath.Join(abs, templateDirectory)
	if err = os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if err = syncTemplateDir(abs); err != nil {
		return nil, err
	}
	s := &TemplateStorage{store: &Storage{baseDir: abs, memoryOnly: true, indices: map[string]bleve.Index{}}, dir: dir, lock: lock, sequence: map[string]uint64{}}
	defer func() {
		if err != nil {
			_ = s.Close()
		}
	}()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		// A renamed day is already logically deleted. Finish reclaiming its
		// bytes after a crash between the rename and RemoveAll.
		if entry.IsDir() && isDeletedTemplateDay(entry.Name()) {
			if err = os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
				return nil, err
			}
			if err = syncTemplateDir(dir); err != nil {
				return nil, err
			}
			continue
		}
		if strings.HasPrefix(entry.Name(), ".") || entry.Name() == "writer.lock" {
			continue
		}
		if !entry.IsDir() || validTemplateDate(entry.Name()) != nil {
			return nil, fmt.Errorf("unexpected template storage entry %q", entry.Name())
		}
		if err = s.replayDay(entry.Name()); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func isDeletedTemplateDay(name string) bool {
	const prefix = ".deleted-"
	if !strings.HasPrefix(name, prefix) {
		return false
	}
	rest := strings.TrimPrefix(name, prefix)
	if len(rest) < 12 || rest[10] != '-' || validTemplateDate(rest[:10]) != nil {
		return false
	}
	_, err := strconv.ParseUint(rest[11:], 10, 64)
	return err == nil
}

func validTemplateDate(date string) error {
	parsed, err := time.Parse("2006-01-02", date)
	if err != nil || parsed.Format("2006-01-02") != date {
		return fmt.Errorf("invalid storage day %q", date)
	}
	return nil
}

func (s *TemplateStorage) ready() error {
	if s.closed {
		return errors.New("template storage is closed")
	}
	if s.failed != nil {
		return fmt.Errorf("template storage requires reopening: %w", s.failed)
	}
	return nil
}

func (s *TemplateStorage) replayDay(date string) error {
	index, err := s.store.getOrCreateIndex(date)
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(filepath.Join(s.dir, date))
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") && strings.HasSuffix(name, ".tmp") {
			continue
		}
		if entry.IsDir() || len(name) != 24 || !strings.HasSuffix(name, ".tzs") {
			return fmt.Errorf("unexpected template segment %q", name)
		}
		n, err := strconv.ParseUint(strings.TrimSuffix(name, ".tzs"), 10, 64)
		if err != nil || n == 0 || n <= s.sequence[date] {
			return fmt.Errorf("invalid template sequence %q", name)
		}
		b, err := os.ReadFile(filepath.Join(s.dir, date, name))
		if err != nil {
			return err
		}
		segment, err := decodeTemplateSegment(b)
		if err != nil {
			return fmt.Errorf("read template segment %s/%s: %w", date, name, err)
		}
		batch, err := prepareTemplateBatch(index, segment)
		if err != nil {
			return err
		}
		if err = index.Batch(batch); err != nil {
			return err
		}
		s.sequence[date] = n
	}
	return nil
}

func prepareTemplateBatch(index bleve.Index, segment templateSegment) (*bleve.Batch, error) {
	batch := index.NewBatch()
	for _, record := range segment.Records {
		if record.ID == "" {
			return nil, errors.New("empty template record ID")
		}
		doc, err := buildOptimizedDocument(index.Mapping(), record.ID, record.Fields)
		if err != nil {
			return nil, err
		}
		if err = batch.IndexAdvanced(doc); err != nil {
			return nil, err
		}
	}
	for _, id := range segment.Deleted {
		if id == "" {
			return nil, errors.New("empty deleted record ID")
		}
		batch.Delete(id)
	}
	return batch, nil
}

// commitDay is called under the operation write lease. Every acknowledged
// segment is durable; a post-rename failure is uncertain and fails the engine closed.
func (s *TemplateStorage) commitDay(date string, segment templateSegment) error {
	if err := validTemplateDate(date); err != nil {
		return err
	}
	encoded, err := encodeTemplateSegment(segment)
	if err != nil {
		return err
	}
	index, err := s.store.getOrCreateIndex(date)
	if err != nil {
		return err
	}
	batch, err := prepareTemplateBatch(index, segment)
	if err != nil {
		return err
	}
	dayDir := filepath.Join(s.dir, date)
	if err = os.MkdirAll(dayDir, 0700); err != nil {
		return err
	}
	if err = syncTemplateDir(s.dir); err != nil {
		return err
	}
	f, err := os.CreateTemp(dayDir, ".segment-*.tmp")
	if err != nil {
		return err
	}
	name := f.Name()
	defer func() { _ = f.Close(); _ = os.Remove(name) }()
	if _, err = f.Write(encoded); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	next := s.sequence[date] + 1
	if next == 0 {
		return errors.New("template sequence exhausted")
	}
	final := filepath.Join(dayDir, fmt.Sprintf("%020d.tzs", next))
	if err = os.Rename(name, final); err != nil {
		return err
	}
	s.sequence[date] = next
	if err = syncTemplateDir(dayDir); err != nil {
		s.failed = err
		return err
	}
	if err = index.Batch(batch); err != nil {
		s.failed = err
		return err
	}
	return nil
}

func syncTemplateDir(path string) error {
	// Windows does not support fsync on directory handles through os.File.
	if runtime.GOOS == "windows" {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func (s *TemplateStorage) Store(rows []map[string]interface{}, source string) error {
	_, err := s.StoreWithIDs(rows, source)
	return err
}

func (s *TemplateStorage) StoreWithIDs(rows []map[string]interface{}, source string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(); err != nil {
		return nil, err
	}
	ids := make([]string, len(rows))
	byDay := map[string][]templateRecord{}
	for i, row := range rows {
		ts, ok := row["timestamp"].(time.Time)
		if !ok {
			return nil, fmt.Errorf("row %d has no time.Time timestamp", i)
		}
		fields := make(map[string]interface{}, len(row))
		for k, v := range row {
			fields[k] = v
			if k == "timestamp" || strings.HasPrefix(k, "_") {
				continue
			}
			if str, ok := v.(string); ok {
				if n, err := strconv.ParseInt(str, 10, 64); err == nil {
					fields[k] = n
				} else if f, err := strconv.ParseFloat(str, 64); err == nil {
					fields[k] = f
				}
			}
		}
		ids[i] = BuildDocID(row, source, i)
		day := ts.Format("2006-01-02")
		byDay[day] = append(byDay[day], templateRecord{ID: ids[i], Fields: fields})
	}
	days := make([]string, 0, len(byDay))
	for day := range byDay {
		days = append(days, day)
	}
	sort.Strings(days)
	for _, day := range days {
		// Bound codec working sets independently of the total import size.
		records := byDay[day]
		for len(records) > 0 {
			n := len(records)
			if n > 1000 {
				n = 1000
			}
			if err := s.commitDay(day, templateSegment{Records: records[:n]}); err != nil {
				return nil, err
			}
			records = records[n:]
		}
	}
	return ids, nil
}

func (s *TemplateStorage) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	return errors.Join(s.store.Close(), s.lock.Close())
}

func (s *TemplateStorage) BaseDir() string { return s.store.BaseDir() }

func (s *TemplateStorage) removeDay(date string) error {
	if err := validTemplateDate(date); err != nil {
		return err
	}
	old := filepath.Join(s.dir, date)
	removed := filepath.Join(s.dir, fmt.Sprintf(".deleted-%s-%d", date, time.Now().UnixNano()))
	if err := os.Rename(old, removed); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := syncTemplateDir(s.dir); err != nil {
		s.failed = err
		return err
	}
	s.store.mu.Lock()
	index := s.store.indices[date]
	delete(s.store.indices, date)
	delete(s.sequence, date)
	s.store.mu.Unlock()
	if index != nil {
		if err := index.Close(); err != nil {
			s.failed = err
			return err
		}
	}
	return os.RemoveAll(removed)
}

func (s *TemplateStorage) RemoveDay(date string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(); err != nil {
		return err
	}
	return s.removeDay(date)
}

func (s *TemplateStorage) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(); err != nil {
		return err
	}
	days, err := s.store.List()
	if err != nil {
		return err
	}
	for _, day := range days {
		if err = s.removeDay(day); err != nil {
			return err
		}
	}
	return nil
}

func (s *TemplateStorage) PruneOlderThan(age time.Duration) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(); err != nil {
		return 0, err
	}
	if age <= 0 {
		return 0, nil
	}
	days, err := s.store.List()
	if err != nil {
		return 0, err
	}
	cutoff := time.Now().Add(-age)
	n := 0
	for _, day := range days {
		ts, _ := time.Parse("2006-01-02", day)
		if ts.Before(cutoff) {
			if err = s.removeDay(day); err != nil {
				return n, err
			}
			n++
		}
	}
	return n, nil
}

func (s *TemplateStorage) DeleteByIds(ids []string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(); err != nil {
		return 0, err
	}
	wanted := map[string]bool{}
	for _, id := range ids {
		if id != "" {
			wanted[id] = true
		}
	}
	days, err := s.store.List()
	if err != nil {
		return 0, err
	}
	deleted := 0
	for _, day := range days {
		index := s.store.indices[day]
		var found []string
		for id := range wanted {
			doc, err := index.Document(id)
			if err != nil {
				return deleted, err
			}
			if doc != nil {
				found = append(found, id)
			}
		}
		if len(found) == 0 {
			continue
		}
		sort.Strings(found)
		if err = s.commitDay(day, templateSegment{Deleted: found}); err != nil {
			return deleted, err
		}
		deleted += len(found)
	}
	return deleted, nil
}

func (s *TemplateStorage) DeleteBySource(ctx context.Context, source string, days []string) (int, []string, error) {
	if err := ctx.Err(); err != nil {
		return 0, nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(); err != nil {
		return 0, nil, err
	}
	if source == "" {
		return 0, nil, errors.New("empty source name")
	}
	deleted := 0
	var touched []string
	for _, day := range days {
		if err := validTemplateDate(day); err != nil {
			return deleted, touched, err
		}
		index, ok := s.store.indices[day]
		if !ok {
			continue
		}
		dayDeleted := false
		for {
			if err := ctx.Err(); err != nil {
				return deleted, touched, err
			}
			ids, err := sourceCandidateIDs(index, source, false)
			if err != nil {
				return deleted, touched, err
			}
			if len(ids) == 0 {
				break
			}
			if err = s.commitDay(day, templateSegment{Deleted: ids}); err != nil {
				return deleted, touched, err
			}
			deleted += len(ids)
			if !dayDeleted {
				touched = append(touched, day)
				dayDeleted = true
			}
		}
	}
	return deleted, touched, nil
}

var _ StorageEngine = (*TemplateStorage)(nil)
