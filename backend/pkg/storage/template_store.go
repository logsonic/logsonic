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
	// writeMu serializes every mutator (store, delete, prune, clear, close) and is
	// always taken before mu. A commit releases mu during its file I/O so readers
	// are not stalled by fsyncs; writeMu is what keeps other mutators out meanwhile.
	writeMu  sync.Mutex
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

// templateReplayBatchOps bounds the operations replay holds in one bleve batch.
const templateReplayBatchOps = 5000

func (s *TemplateStorage) replayDay(date string) error {
	index, err := s.store.getOrCreateIndex(date)
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(filepath.Join(s.dir, date))
	if err != nil {
		return err
	}
	// Many small live-tail segments are folded into a few bleve batches: one
	// batch per segment made startup cost grow with write count.
	batch := index.NewBatch()
	flush := func() error {
		if batch.Size() == 0 {
			return nil
		}
		err := index.Batch(batch)
		batch = index.NewBatch()
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		// Match the store root: skip crash leftovers and OS metadata such as
		// .DS_Store. A real segment is never dot-prefixed.
		if strings.HasPrefix(name, ".") {
			// A crash between CreateTemp and Rename leaves an unreferenced
			// temp segment; it was never acknowledged, so it is garbage.
			if strings.HasPrefix(name, ".segment-") && strings.HasSuffix(name, ".tmp") && !entry.IsDir() {
				_ = os.Remove(filepath.Join(s.dir, date, name))
			}
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
		if err = addTemplateSegment(index, batch, segment); err != nil {
			return err
		}
		s.sequence[date] = n
		if batch.Size() >= templateReplayBatchOps {
			if err = flush(); err != nil {
				return err
			}
		}
	}
	return flush()
}

func prepareTemplateBatch(index bleve.Index, segment templateSegment) (*bleve.Batch, error) {
	batch := index.NewBatch()
	if err := addTemplateSegment(index, batch, segment); err != nil {
		return nil, err
	}
	return batch, nil
}

// addTemplateSegment appends a segment's operations to batch. A bleve batch
// keeps the last operation per ID, so adding segments in order yields the same
// state as applying them one batch at a time.
func addTemplateSegment(index bleve.Index, batch *bleve.Batch, segment templateSegment) error {
	for _, record := range segment.Records {
		if record.ID == "" {
			return errors.New("empty template record ID")
		}
		doc, err := buildOptimizedDocument(index.Mapping(), record.ID, record.Fields)
		if err != nil {
			return err
		}
		if err = batch.IndexAdvanced(doc); err != nil {
			return err
		}
	}
	for _, id := range segment.Deleted {
		if id == "" {
			return errors.New("empty deleted record ID")
		}
		batch.Delete(id)
	}
	return nil
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
	return s.commitEncoded(date, segment, encoded)
}

// commitEncoded makes an already-encoded segment durable and indexes it. If it
// fails before the segment is acknowledged, a day index created for it is
// dropped again so no phantom empty day outlives the error.
func (s *TemplateStorage) commitEncoded(date string, segment templateSegment, encoded []byte) (err error) {
	s.store.mu.RLock()
	_, existed := s.store.indices[date]
	s.store.mu.RUnlock()
	index, err := s.store.getOrCreateIndex(date)
	if err != nil {
		return err
	}
	acknowledged := false
	defer func() {
		if !acknowledged && !existed {
			s.dropEmptyDay(date)
		}
	}()
	batch, err := prepareTemplateBatch(index, segment)
	if err != nil {
		return err
	}
	next := s.sequence[date] + 1
	if next == 0 {
		return errors.New("template sequence exhausted")
	}
	// The segment write needs neither the index nor any reader-visible state,
	// so release readers for its fsyncs; they would otherwise stall behind
	// every commit. writeMu, which every mutator holds, keeps all other
	// writers, deletions and Close out until the lock is retaken below.
	s.mu.Unlock()
	if templateCommitIOHook != nil {
		templateCommitIOHook()
	}
	renamed, ioErr := writeTemplateSegment(s.dir, filepath.Join(s.dir, date), next, encoded)
	s.mu.Lock()
	if renamed {
		s.sequence[date] = next
		acknowledged = true
	}
	if ioErr != nil {
		if renamed {
			s.failed = ioErr // durable state is ahead of memory: fail closed
		}
		return ioErr
	}
	if err = index.Batch(batch); err != nil {
		s.failed = err
		return err
	}
	return nil
}

// templateCommitIOHook runs while a commit's file I/O is in flight and the
// operation lock is released. Tests use it to observe that readers proceed.
var templateCommitIOHook func()

// writeTemplateSegment durably writes one segment as <dayDir>/<next>.tzs. It
// reports renamed once the segment is acknowledged on disk; a later error (the
// directory fsync) then leaves durable state uncertain.
func writeTemplateSegment(root, dayDir string, next uint64, encoded []byte) (renamed bool, err error) {
	// Only a new day directory needs its parent entry synced.
	if _, statErr := os.Stat(dayDir); os.IsNotExist(statErr) {
		if err = os.MkdirAll(dayDir, 0700); err != nil {
			return false, err
		}
		if err = syncTemplateDir(root); err != nil {
			return false, err
		}
	}
	f, err := os.CreateTemp(dayDir, ".segment-*.tmp")
	if err != nil {
		return false, err
	}
	name := f.Name()
	defer func() { _ = f.Close(); _ = os.Remove(name) }()
	if _, err = f.Write(encoded); err != nil {
		return false, err
	}
	if err = f.Sync(); err != nil {
		return false, err
	}
	if err = f.Close(); err != nil {
		return false, err
	}
	if err = os.Rename(name, filepath.Join(dayDir, fmt.Sprintf("%020d.tzs", next))); err != nil {
		return false, err
	}
	return true, syncTemplateDir(dayDir)
}

// dropEmptyDay forgets a day whose first segment never became durable: it
// closes and unregisters the in-memory index and removes the directory if it
// is still empty. Best effort; the original commit error is what the caller sees.
func (s *TemplateStorage) dropEmptyDay(date string) {
	s.store.mu.Lock()
	index := s.store.indices[date]
	delete(s.store.indices, date)
	s.store.mu.Unlock()
	if index != nil {
		_ = index.Close()
	}
	_ = os.Remove(filepath.Join(s.dir, date))
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
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
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
	// Encode every segment before committing any: validation and size limits
	// fail here, while nothing is durable yet.
	type pendingSegment struct {
		day     string
		segment templateSegment
		encoded []byte
	}
	var pending []pendingSegment
	for _, day := range days {
		if err := validTemplateDate(day); err != nil {
			return nil, err
		}
		// Bound codec working sets independently of the total import size.
		records := byDay[day]
		for len(records) > 0 {
			n := min(len(records), 1000)
			segment := templateSegment{Records: records[:n]}
			encoded, err := encodeTemplateSegment(segment)
			if err != nil {
				return nil, err
			}
			pending = append(pending, pendingSegment{day, segment, encoded})
			records = records[n:]
		}
	}
	for i, p := range pending {
		err := s.commitEncoded(p.day, p.segment, p.encoded)
		if err == nil {
			continue
		}
		if s.failed != nil {
			// Uncertain post-rename state: the engine is already failed closed.
			return nil, err
		}
		// Roll back segments already acknowledged so the caller's error means
		// "nothing was stored". If a rollback fails the state is uncertain.
		for _, done := range pending[:i] {
			deleted := make([]string, len(done.segment.Records))
			for j, r := range done.segment.Records {
				deleted[j] = r.ID
			}
			if rbErr := s.commitDay(done.day, templateSegment{Deleted: deleted}); rbErr != nil {
				if s.failed == nil {
					s.failed = rbErr
				}
				return nil, errors.Join(err, fmt.Errorf("rollback of partial write failed: %w", rbErr))
			}
		}
		return nil, err
	}
	return ids, nil
}

func (s *TemplateStorage) Close() error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
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
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ready(); err != nil {
		return err
	}
	return s.removeDay(date)
}

func (s *TemplateStorage) Clear() error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
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
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
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
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
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
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
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
