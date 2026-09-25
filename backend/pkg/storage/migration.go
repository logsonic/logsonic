package storage

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/blevesearch/bleve/v2"
	"github.com/blevesearch/bleve/v2/analysis/datetime/timestamp/microseconds"
	"github.com/blevesearch/bleve/v2/analysis/datetime/timestamp/milliseconds"
	"github.com/blevesearch/bleve/v2/analysis/datetime/timestamp/nanoseconds"
	"github.com/blevesearch/bleve/v2/analysis/datetime/timestamp/seconds"
	"github.com/blevesearch/bleve/v2/index/scorch"
	"github.com/blevesearch/bleve/v2/index/scorch/mergeplan"
	index "github.com/blevesearch/bleve_index_api"
	bolt "go.etcd.io/bbolt"
)

// MigrationEnv turns the background conversion of legacy day shards off
// ("off", "0", "false", "no"). Legacy shards stay fully usable either way.
const MigrationEnv = "LOGSONIC_STORAGE_MIGRATION"

var (
	// migrationStartDelay keeps startup and the first searches unhurried.
	migrationStartDelay = 30 * time.Second
	// migrationInterval rechecks for days that became eligible (for example
	// yesterday's shard after midnight, or a day that stopped receiving rows).
	migrationInterval = 10 * time.Minute
	// migrationQuietPeriod is how long a day must go without writes before
	// it is converted, so an active import or tail is never raced.
	migrationQuietPeriod = 2 * time.Minute
)

// migrationAfterCopyHook lets tests change a day between copy and swap.
var migrationAfterCopyHook func(date string)

// errMigrationRetry means the day changed while it was being converted; the
// partial copy was discarded and the day is retried on a later pass.
var errMigrationRetry = errors.New("day changed during migration")

func migrationEnabledFromEnv() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(MigrationEnv))) {
	case "off", "0", "false", "no":
		return false
	}
	return true
}

// MigrationStatus is the Storage tab's view of the background conversion.
type MigrationStatus struct {
	Enabled      bool
	Running      bool
	LegacyDays   int
	CompactDays  int
	CurrentDay   string
	MigratedDays int
	BytesBefore  int64 // legacy size of the days converted by this process
	BytesAfter   int64 // compact size of the same days
	LastError    string
}

type migrator struct {
	cancel context.CancelFunc
	done   chan struct{}
	mu     sync.Mutex
	status MigrationStatus
}

func (m *migrator) stop() {
	m.cancel()
	<-m.done
}

func (m *migrator) update(fn func(*MigrationStatus)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	fn(&m.status)
}

func (s *Storage) startMigration() {
	ctx, cancel := context.WithCancel(context.Background())
	m := &migrator{cancel: cancel, done: make(chan struct{}), status: MigrationStatus{Enabled: true}}
	s.migration = m
	go func() {
		defer close(m.done)
		wait := migrationStartDelay
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			if _, err := s.migrateLegacyDays(ctx, false); err != nil && ctx.Err() == nil {
				log.Printf("storage: migration pass: %v", err)
			}
			if _, err := s.finalizeCompactDays(ctx, false); err != nil && ctx.Err() == nil {
				log.Printf("storage: finalize pass: %v", err)
			}
			wait = migrationInterval
		}
	}()
}

// MigrationStatus reports conversion progress and the current format mix.
func (s *Storage) MigrationStatus() MigrationStatus {
	var status MigrationStatus
	if s.migration != nil {
		s.migration.mu.Lock()
		status = s.migration.status
		s.migration.mu.Unlock()
	}
	s.mu.RLock()
	for _, idx := range s.indices {
		if isCompactIndex(idx) {
			status.CompactDays++
		} else {
			status.LegacyDays++
		}
	}
	s.mu.RUnlock()
	return status
}

// ShardFormat reports "compact" or "legacy" for an open day, "" otherwise.
func (s *Storage) ShardFormat(date string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	idx, ok := s.indices[date]
	if !ok {
		return ""
	}
	if isCompactIndex(idx) {
		return "compact"
	}
	return "legacy"
}

// MigrateLegacyDays converts every legacy day before today now, regardless of
// recent writes, and returns how many days were converted.
func (s *Storage) MigrateLegacyDays(ctx context.Context) (int, error) {
	converted, err := s.migrateLegacyDays(ctx, true)
	if err != nil {
		return converted, err
	}
	_, err = s.finalizeCompactDays(ctx, true)
	return converted, err
}

// migrateLegacyDays converts every legacy day before today, oldest first.
// Unless force is set, days written within migrationQuietPeriod are left for
// a later pass. It returns how many days were converted.
func (s *Storage) migrateLegacyDays(ctx context.Context, force bool) (int, error) {
	today := time.Now().Format("2006-01-02")
	s.mu.RLock()
	var days []string
	for date, idx := range s.indices {
		if !isCompactIndex(idx) && date < today {
			days = append(days, date)
		}
	}
	s.mu.RUnlock()
	sort.Strings(days)

	converted := 0
	var errs error
	for _, date := range days {
		if err := ctx.Err(); err != nil {
			return converted, err
		}
		if !force && time.Since(s.generation(date).lastWrite) < migrationQuietPeriod {
			continue
		}
		if s.migration != nil {
			s.migration.update(func(st *MigrationStatus) { st.Running, st.CurrentDay = true, date })
		}
		before, after, err := s.MigrateDay(ctx, date)
		if s.migration != nil {
			s.migration.update(func(st *MigrationStatus) {
				st.Running, st.CurrentDay = false, ""
				if err == nil && after > 0 {
					st.MigratedDays++
					st.BytesBefore += before
					st.BytesAfter += after
				} else if err != nil && !errors.Is(err, errMigrationRetry) && ctx.Err() == nil {
					st.LastError = fmt.Sprintf("%s: %v", date, err)
				}
			})
		}
		switch {
		case err == nil:
			if after > 0 {
				converted++
				log.Printf("storage: converted %s to compact storage (%d → %d bytes)", date, before, after)
			}
		case errors.Is(err, errMigrationRetry), ctx.Err() != nil:
		default:
			errs = errors.Join(errs, fmt.Errorf("%s: %w", date, err))
		}
	}
	return converted, errs
}

// MigrateDay converts one legacy day shard to the compact format in place.
// The new shard is built beside the old one from the old shard's stored
// fields, keeping every document ID, then swapped in with two renames. If
// the day receives a write, delete or removal meanwhile, the copy is
// discarded (errMigrationRetry). A crash at any point leaves either the old
// or the new shard, never both or neither (see recoverMigrations). Returns
// the day's size before and after; both are 0 when nothing was converted.
func (s *Storage) MigrateDay(ctx context.Context, date string) (before, after int64, err error) {
	if s.memoryOnly {
		return 0, 0, nil
	}
	lock := s.dayLock(date)
	lock.Lock()
	s.mu.RLock()
	old, ok := s.indices[date]
	s.mu.RUnlock()
	gen := s.generation(date)
	lock.Unlock()
	if !ok || isCompactIndex(old) {
		return 0, 0, nil
	}

	finalPath := filepath.Join(s.baseDir, "logs-"+date+".bleve")
	newPath := finalPath + ".new"
	asidePath := finalPath + ".old"
	if err := os.RemoveAll(newPath); err != nil {
		return 0, 0, err
	}
	before, err = directoryBytes(finalPath)
	if err != nil {
		return 0, 0, err
	}

	if _, err := s.buildCompactCopy(ctx, old, date, newPath); err != nil {
		_ = os.RemoveAll(newPath)
		return 0, 0, err
	}
	if migrationAfterCopyHook != nil {
		migrationAfterCopyHook(date)
	}

	lock.Lock()
	defer lock.Unlock()
	s.mu.Lock()
	current, ok := s.indices[date]
	if !ok || current != old || s.generation(date).count != gen.count {
		s.mu.Unlock()
		_ = os.RemoveAll(newPath)
		return 0, 0, errMigrationRetry
	}
	if err := old.Close(); err != nil {
		s.mu.Unlock()
		_ = os.RemoveAll(newPath)
		return 0, 0, fmt.Errorf("close legacy shard: %w", err)
	}
	delete(s.indices, date)
	swapErr := func() error {
		if err := os.Rename(finalPath, asidePath); err != nil {
			return err
		}
		if err := os.Rename(newPath, finalPath); err != nil {
			return err
		}
		return syncTemplateDir(s.baseDir)
	}()
	if swapErr != nil {
		// Put whichever shard is complete back in service.
		if _, statErr := os.Stat(finalPath); os.IsNotExist(statErr) {
			_ = os.Rename(asidePath, finalPath)
		}
	}
	reopenErr := s.openShardLocked(date, finalPath)
	s.mu.Unlock()
	if swapErr != nil || reopenErr != nil {
		return 0, 0, errors.Join(swapErr, reopenErr)
	}
	if err := os.RemoveAll(asidePath); err != nil {
		log.Printf("storage: could not remove converted shard %s: %v", asidePath, err)
	}
	s.layout.Add(1)
	after, err = directoryBytes(finalPath)
	return before, after, err
}

// openShardLocked opens an existing shard directory; callers hold s.mu.
func (s *Storage) openShardLocked(date, path string) error {
	idx, err := bleve.Open(path)
	if err != nil {
		return err
	}
	if isCompactIndex(idx) {
		rs, err := openRowStore(path, date, s.blockCache())
		if err == nil {
			_, err = repairOpenBlock(idx, rs)
		}
		if err != nil {
			_ = idx.Close()
			return err
		}
		s.setRowStore(date, rs)
	}
	s.indices[date] = idx
	return nil
}

// buildCompactCopy writes a compact shard at newPath holding every document
// of old, verifies the count and closes it. Returns the rows copied.
func (s *Storage) buildCompactCopy(ctx context.Context, old bleve.Index, date, newPath string) (uint64, error) {
	newIdx, err := newPersistentIndex(newPath, buildCompactIndexMapping())
	if err != nil {
		return 0, err
	}
	rs, err := openRowStore(newPath, date, s.blockCache())
	if err != nil {
		_ = newIdx.Close()
		return 0, err
	}
	closeAll := func() error {
		return errors.Join(rs.close(), newIdx.Close())
	}

	copied, expected, err := copyLegacyRows(ctx, old, func(records []templateRecord) error {
		return s.indexCompactRecords(newIdx, rs, records)
	})
	if err == nil && copied != expected {
		err = fmt.Errorf("copied %d rows, legacy shard has %d", copied, expected)
	}
	if err == nil {
		var count uint64
		if count, err = newIdx.DocCount(); err == nil && count != expected {
			err = fmt.Errorf("compact shard has %d documents, legacy shard has %d", count, expected)
		}
	}
	if err == nil {
		err = forceMergeIndex(ctx, newIdx)
	}
	if closeErr := closeAll(); err == nil {
		err = closeErr
	}
	if err == nil {
		_, err = compactRootBolt(newPath)
	}
	return copied, err
}

// rootBoltCompactThreshold is the root.bolt size above which a closed day's
// metadata database is rewritten. Scorch grows it with every small commit
// and never shrinks it: a day holding one row still occupies 256 KiB, which
// dominates storage for logs spread over many days.
const rootBoltCompactThreshold = 64 << 10

func rootBoltPath(shardPath string) string {
	return filepath.Join(shardPath, "store", "root.bolt")
}

// compactRootBolt rewrites a closed shard's root.bolt keeping only live
// pages. The copy is published with an atomic rename. Returns bytes saved.
func compactRootBolt(shardPath string) (int64, error) {
	src := rootBoltPath(shardPath)
	info, err := os.Stat(src)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	if info.Size() <= rootBoltCompactThreshold {
		return 0, nil
	}
	tmp := src + ".compact"
	_ = os.Remove(tmp)
	srcDB, err := bolt.Open(src, 0o600, &bolt.Options{ReadOnly: true, Timeout: time.Second})
	if err != nil {
		return 0, err
	}
	// Scorch creates root.bolt with the OS page size, 16 KiB on Apple
	// silicon, so its dozen pages of metadata take 256 KiB. bbolt reads the
	// page size from the file, so a copy made with 4 KiB pages stays small
	// and keeps working when Scorch reopens it.
	dstDB, err := bolt.Open(tmp, info.Mode().Perm(), &bolt.Options{Timeout: time.Second, PageSize: 4096})
	if err != nil {
		_ = srcDB.Close()
		return 0, err
	}
	err = bolt.Compact(dstDB, srcDB, 1<<20)
	err = errors.Join(err, dstDB.Close(), srcDB.Close())
	if err == nil {
		err = os.Rename(tmp, src)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return 0, err
	}
	if err := syncTemplateDir(filepath.Dir(src)); err != nil {
		return 0, err
	}
	compacted, err := os.Stat(src)
	if err != nil {
		return 0, err
	}
	return info.Size() - compacted.Size(), nil
}

// FinalizeDay merges a closed compact day into one segment, seals its rows
// and shrinks its metadata database. It briefly closes the day's index, so
// it runs only for days before today that have been quiet. Returns the
// day's size before and after; both are 0 when there was nothing to do.
func (s *Storage) FinalizeDay(ctx context.Context, date string) (before, after int64, err error) {
	if s.memoryOnly {
		return 0, 0, nil
	}
	path := filepath.Join(s.baseDir, "logs-"+date+".bleve")
	lock := s.dayLock(date)
	lock.Lock()
	defer lock.Unlock()
	s.mu.RLock()
	idx, ok := s.indices[date]
	s.mu.RUnlock()
	if !ok || !isCompactIndex(idx) {
		return 0, 0, nil
	}
	info, err := os.Stat(rootBoltPath(path))
	if err != nil || info.Size() <= rootBoltCompactThreshold {
		return 0, 0, nil
	}
	if before, err = directoryBytes(path); err != nil {
		return 0, 0, err
	}
	// Writes and deletes take the day lock we hold, so only searches remain.
	if err := forceMergeIndex(ctx, idx); err != nil {
		return 0, 0, err
	}
	s.mu.Lock()
	if current, ok := s.indices[date]; !ok || current != idx {
		s.mu.Unlock()
		return 0, 0, nil
	}
	var closeErr error
	s.rowsMu.Lock()
	if rs := s.rows[date]; rs != nil {
		closeErr = rs.close()
		delete(s.rows, date)
	}
	s.rowsMu.Unlock()
	closeErr = errors.Join(closeErr, idx.Close())
	delete(s.indices, date)
	_, compactErr := compactRootBolt(path)
	openErr := s.openShardLocked(date, path)
	s.mu.Unlock()
	if err := errors.Join(closeErr, compactErr, openErr); err != nil {
		return 0, 0, err
	}
	s.layout.Add(1)
	after, err = directoryBytes(path)
	return before, after, err
}

// finalizeCompactDays finalizes every quiet compact day before today.
func (s *Storage) finalizeCompactDays(ctx context.Context, force bool) (int, error) {
	today := time.Now().Format("2006-01-02")
	s.mu.RLock()
	var days []string
	for date, idx := range s.indices {
		if isCompactIndex(idx) && date < today {
			days = append(days, date)
		}
	}
	s.mu.RUnlock()
	sort.Strings(days)
	done := 0
	var errs error
	for _, date := range days {
		if err := ctx.Err(); err != nil {
			return done, err
		}
		if !force && time.Since(s.generation(date).lastWrite) < migrationQuietPeriod {
			continue
		}
		before, after, err := s.FinalizeDay(ctx, date)
		if err != nil {
			if ctx.Err() == nil {
				errs = errors.Join(errs, fmt.Errorf("%s: %w", date, err))
			}
			continue
		}
		if after > 0 {
			done++
			if s.migration != nil {
				s.migration.update(func(st *MigrationStatus) {
					st.BytesBefore += before
					st.BytesAfter += after
				})
			}
		}
	}
	return done, errs
}

// forceMergeIndex compacts a finished day into one segment; a closed day is
// read many times and never written again, so the merge pays for itself.
func forceMergeIndex(ctx context.Context, idx bleve.Index) error {
	advanced, err := idx.Advanced()
	if err != nil {
		return err
	}
	sc, ok := advanced.(*scorch.Scorch)
	if !ok {
		return nil
	}
	options := mergeplan.SingleSegmentMergePlanOptions
	return sc.ForceMerge(ctx, &options)
}

// copyLegacyRows streams every document of a legacy shard as rows, in
// batches of rowBlockSize, from one consistent reader snapshot.
func copyLegacyRows(ctx context.Context, old bleve.Index, emit func([]templateRecord) error) (copied, expected uint64, err error) {
	advanced, err := old.Advanced()
	if err != nil {
		return 0, 0, err
	}
	reader, err := advanced.Reader()
	if err != nil {
		return 0, 0, err
	}
	defer reader.Close()
	if expected, err = reader.DocCount(); err != nil {
		return 0, 0, err
	}
	all, err := reader.DocIDReaderAll()
	if err != nil {
		return 0, expected, err
	}
	defer all.Close()

	batch := make([]templateRecord, 0, rowBlockSize)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		if err := emit(batch); err != nil {
			return err
		}
		copied += uint64(len(batch))
		batch = make([]templateRecord, 0, rowBlockSize)
		return ctx.Err()
	}
	for {
		internal, err := all.Next()
		if err != nil {
			return copied, expected, err
		}
		if internal == nil {
			break
		}
		id, err := reader.ExternalID(internal)
		if err != nil {
			return copied, expected, err
		}
		doc, err := reader.Document(id)
		if err != nil {
			return copied, expected, err
		}
		if doc == nil {
			continue
		}
		batch = append(batch, templateRecord{ID: id, Fields: legacyRow(doc)})
		if len(batch) == rowBlockSize {
			if err := flush(); err != nil {
				return copied, expected, err
			}
		}
	}
	return copied, expected, flush()
}

// legacyRow turns a legacy shard's stored fields back into a row that maps to
// the same stored document again: repeated names become arrays, the row
// timestamp stays a time.Time, and other datetimes keep the string form
// Bleve displays, so both searching and displaying the row are unchanged.
func legacyRow(doc index.Document) map[string]interface{} {
	row := make(map[string]interface{})
	multi := make(map[string]bool)
	doc.VisitFields(func(field index.Field) {
		name := field.Name()
		var value interface{}
		switch typed := field.(type) {
		case index.TextField:
			value = typed.Text()
		case index.NumericField:
			number, err := typed.Number()
			if err != nil {
				return
			}
			if name == "_seq" {
				value = int64(number)
			} else {
				value = number
			}
		case index.DateTimeField:
			datetime, layout, err := typed.DateTime()
			if err != nil {
				return
			}
			if name == "timestamp" {
				value = datetime
			} else {
				value = storedDateTimeString(datetime, layout)
			}
		case index.BooleanField:
			boolean, err := typed.Boolean()
			if err != nil {
				return
			}
			value = boolean
		default:
			return
		}
		existing, seen := row[name]
		switch {
		case !seen:
			row[name] = value
		case multi[name]:
			row[name] = append(existing.([]interface{}), value)
		default:
			row[name] = []interface{}{existing, value}
			multi[name] = true
		}
	})
	return row
}

// storedDateTimeString mirrors bleve.LoadAndHighlightFields.
func storedDateTimeString(datetime time.Time, layout string) string {
	switch layout {
	case "":
		return datetime.Format(time.RFC3339)
	case seconds.Name:
		return strconv.FormatInt(datetime.Unix(), 10)
	case milliseconds.Name:
		return strconv.FormatInt(datetime.UnixMilli(), 10)
	case microseconds.Name:
		return strconv.FormatInt(datetime.UnixMicro(), 10)
	case nanoseconds.Name:
		return strconv.FormatInt(datetime.UnixNano(), 10)
	default:
		return datetime.Format(layout)
	}
}

// recoverMigrations resolves shards a crash left mid-swap. The swap is
// "logs-D.bleve" → "logs-D.bleve.old", then "logs-D.bleve.new" → "logs-D.bleve".
func recoverMigrations(baseDir string) error {
	leftovers, err := filepath.Glob(filepath.Join(baseDir, "logs-*.bleve.new"))
	if err != nil {
		return err
	}
	aside, err := filepath.Glob(filepath.Join(baseDir, "logs-*.bleve.old"))
	if err != nil {
		return err
	}
	for _, newPath := range leftovers {
		finalPath := strings.TrimSuffix(newPath, ".new")
		if _, err := os.Stat(finalPath); err == nil {
			// The old shard never moved aside: the copy was incomplete.
			if err := os.RemoveAll(newPath); err != nil {
				return err
			}
			continue
		}
		if _, err := os.Stat(finalPath + ".old"); err == nil {
			// Crashed between the two renames: the copy is complete.
			if err := os.Rename(newPath, finalPath); err != nil {
				return err
			}
			continue
		}
		if err := os.RemoveAll(newPath); err != nil {
			return err
		}
	}
	for _, oldPath := range aside {
		finalPath := strings.TrimSuffix(oldPath, ".old")
		if _, err := os.Stat(finalPath); err == nil {
			if err := os.RemoveAll(oldPath); err != nil {
				return err
			}
		} else if err := os.Rename(oldPath, finalPath); err != nil {
			return err
		}
	}
	stale, err := filepath.Glob(filepath.Join(baseDir, "logs-*.bleve", "store", "root.bolt.compact"))
	if err != nil {
		return err
	}
	for _, path := range stale {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if len(leftovers)+len(aside) > 0 {
		return syncTemplateDir(baseDir)
	}
	return nil
}

func directoryBytes(root string) (int64, error) {
	var total int64
	err := filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total, err
}
