package storage

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/blevesearch/bleve/v2"
	"github.com/blevesearch/bleve/v2/index/upsidedown/store/goleveldb"
	"github.com/blevesearch/bleve/v2/mapping"
)

// Storage handles log data persistence using Bleve with time-based sharding
type Storage struct {
	baseDir string
	mu      sync.RWMutex           // protects indices map
	indices map[string]bleve.Index // Map of date -> index
}

// StorageInterface defines the methods implemented by *Storage.
type StorageInterface interface {
	Store(logs []map[string]interface{}, source string) error
	StoreWithIDs(logs []map[string]interface{}, source string) ([]string, error)
	Search(query string, startDate, endDate *time.Time, sources []string) ([]map[string]interface{}, time.Duration, error)
	SearchPage(ctx context.Context, options SearchOptions) (SearchPageResult, error)
	List() ([]string, error)
	GetSourceNames() ([]string, error)
	Clear() error
	BaseDir() string
	GetDocCount(date string) (uint64, error)
	DeleteByIds(ids []string) (int, error)
	PruneOlderThan(maxAge time.Duration) (int, error)
}

// NewStorage initializes a new Storage instance
func NewStorage(baseDir string) (*Storage, error) {
	// Canonicalize the path to prevent directory traversal via symlinks or
	// relative segments before we create or open anything under it.
	absDir, err := filepath.Abs(baseDir)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve storage path: %w", err)
	}
	baseDir = absDir

	if err := os.MkdirAll(baseDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create storage directory: %w", err)
	}

	storage := &Storage{
		baseDir: baseDir,
		indices: make(map[string]bleve.Index),
	}

	// Attempt to load existing indices
	pattern := filepath.Join(baseDir, "logs-*.bleve")
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return nil, fmt.Errorf("failed to list existing indices: %w", err)
	}

	// Load each existing index
	for _, indexPath := range matches {
		// Extract date from filename
		base := filepath.Base(indexPath)
		date := base[5 : len(base)-6] // Extract date from "logs-2024-01-01.bleve"

		// Open the existing index
		index, err := bleve.Open(indexPath)
		if err != nil {
			continue // Skip this index if it can't be opened
		}

		// Add to indices map
		storage.indices[date] = index
	}

	return storage, nil
}

// Close cleanly shuts down all open Bleve indices. Should be called on
// server shutdown or at the end of tests to prevent goroutine leaks.
func (s *Storage) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	var firstErr error
	for date, index := range s.indices {
		if err := index.Close(); err != nil && firstErr == nil {
			firstErr = fmt.Errorf("failed to close index %s: %w", date, err)
		}
		delete(s.indices, date)
	}
	return firstErr
}

// buildIndexMapping returns the standard Bleve index mapping used for all shards.
func buildIndexMapping() mapping.IndexMapping {
	indexMapping := bleve.NewIndexMapping()
	logMapping := bleve.NewDocumentMapping()

	dateField := bleve.NewDateTimeFieldMapping()
	dateField.Store = true
	// Timestamp postings enable bounded date-range queries and facets. Older
	// shards created with Index=false remain readable through SearchPage's
	// compatibility aggregation path.
	dateField.Index = true
	dateField.IncludeInAll = false
	logMapping.AddFieldMappingsAt("timestamp", dateField)

	textField := bleve.NewTextFieldMapping()
	textField.Store = true
	textField.Analyzer = "standard"
	textField.IncludeTermVectors = false
	textField.IncludeInAll = false
	// Doc values build a columnar copy of every term, used only for sorting
	// and faceting at the Bleve layer. LogSonic sorts results in Go and never
	// facets, so the _raw doc-values payload is dead weight — disable it.
	textField.DocValues = false
	logMapping.AddFieldMappingsAt("_raw", textField)

	// _seq is internal ordering metadata (the sort tie-breaker). Persist it
	// so it round-trips for sorting, but keep it out of the field index.
	seqField := bleve.NewNumericFieldMapping()
	seqField.Store = true
	seqField.Index = false
	seqField.IncludeInAll = false
	logMapping.AddFieldMappingsAt("_seq", seqField)

	// The default _all composite re-indexed _raw plus every parsed field,
	// causing several copies of the same content on disk. Search replaces it
	// with an all-fields query at runtime, so disable the stored composite.
	logMapping.AddSubDocumentMapping("_all", bleve.NewDocumentDisabledMapping())
	indexMapping.DefaultField = "_raw"
	indexMapping.DefaultMapping = logMapping
	indexMapping.DefaultAnalyzer = "standard"
	indexMapping.IndexDynamic = true
	indexMapping.StoreDynamic = true
	indexMapping.DocValuesDynamic = false
	return indexMapping
}

// kvConfig is the LevelDB configuration shared by all Bleve shards.
var kvConfig = map[string]interface{}{
	"create_if_missing":         true,
	"error_if_exists":           false,
	"block_size":                32768,
	"write_buffer_size":         16777216,
	"lru_cache_capacity":        33554432,
	"bloom_filter_bits_per_key": 15,
	"compression":               "snappy",
}

// getOrCreateIndex returns the Bleve index for the given date, creating it if
// it does not exist yet.  s.mu is held for the duration of index creation to
// prevent concurrent goroutines from initialising the same shard twice.
func (s *Storage) getOrCreateIndex(date string) (bleve.Index, error) {
	// Fast path: index already open.
	s.mu.RLock()
	index, exists := s.indices[date]
	s.mu.RUnlock()
	if exists {
		return index, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// Re-check inside write lock (another goroutine may have created it).
	if index, exists = s.indices[date]; exists {
		return index, nil
	}

	indexPath := filepath.Join(s.baseDir, fmt.Sprintf("logs-%s.bleve", date))
	var err error

	if _, statErr := os.Stat(indexPath); os.IsNotExist(statErr) {
		indexConfig := map[string]interface{}{"store": kvConfig}
		index, err = bleve.NewUsing(indexPath, buildIndexMapping(), "scorch", goleveldb.Name, indexConfig)
	} else {
		index, err = bleve.Open(indexPath)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to initialize index for date %s: %w", date, err)
	}

	s.indices[date] = index
	return index, nil
}

// BuildDocID returns the Bleve document ID used for a row. It is shared by
// StoreWithIDs and live publishing so callers do not duplicate ID semantics.
func BuildDocID(log map[string]interface{}, source string, fallbackSeq int) string {
	seqID := int64(fallbackSeq)
	if v, ok := log["_seq"].(int64); ok {
		seqID = v
	}
	return fmt.Sprintf("%d-%s-%d", log["timestamp"].(time.Time).UnixNano(), source, seqID)
}

// Store saves the parsed log data to appropriate daily indices.
func (s *Storage) Store(logs []map[string]interface{}, source string) error {
	_, err := s.StoreWithIDs(logs, source)
	return err
}

type datedLog struct {
	index int
	log   map[string]interface{}
}

// StoreWithIDs saves parsed log data and returns the generated document IDs in
// the same order as the input rows.
func (s *Storage) StoreWithIDs(logs []map[string]interface{}, source string) ([]string, error) {
	docIDs := make([]string, len(logs))

	// Group logs by date.
	logsByDate := make(map[string][]datedLog)
	for i, log := range logs {
		ts := log["timestamp"].(time.Time)
		date := ts.Format("2006-01-02")
		logsByDate[date] = append(logsByDate[date], datedLog{index: i, log: log})
	}

	for date, dateLogs := range logsByDate {
		index, err := s.getOrCreateIndex(date)
		if err != nil {
			return nil, fmt.Errorf("failed to get index for date %s: %w", date, err)
		}

		batch := index.NewBatch()
		for _, entry := range dateLogs {
			log := entry.log
			logCopy := make(map[string]interface{}, len(log))
			for k, v := range log {
				logCopy[k] = v
			}
			for k, v := range log {
				if k == "timestamp" || strings.HasPrefix(k, "_") {
					continue
				}
				str, ok := v.(string)
				if !ok {
					continue
				}
				if intVal, err := strconv.ParseInt(str, 10, 64); err == nil {
					logCopy[k] = intVal
					continue
				}
				if floatVal, err := strconv.ParseFloat(str, 64); err == nil {
					logCopy[k] = floatVal
				}
			}
			// Disambiguate by the session-global `_seq` when present:
			// the batch index resets every ingest chunk, so two lines from
			// different chunks that share a timestamp + source would otherwise
			// produce the same docID and silently overwrite each other. `_seq`
			// is monotonic across the whole session, so it keeps every line a
			// distinct document. Falls back to the original input index for
			// callers (tests) that don't stamp `_seq`.
			docID := BuildDocID(log, source, entry.index)
			docIDs[entry.index] = docID
			doc, err := buildOptimizedDocument(index.Mapping(), docID, logCopy)
			if err != nil {
				return nil, fmt.Errorf("failed to index log entry: %w", err)
			}
			if err := batch.IndexAdvanced(doc); err != nil {
				return nil, fmt.Errorf("failed to add log entry to batch: %w", err)
			}
		}
		if err := index.Batch(batch); err != nil {
			return nil, fmt.Errorf("failed to commit batch for date %s: %w", date, err)
		}
	}

	return docIDs, nil
}

// Clear removes all indices
func (s *Storage) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Close all open indices first
	for date, index := range s.indices {
		if err := index.Close(); err != nil {
			return fmt.Errorf("failed to close index for date %s: %w", date, err)
		}
		delete(s.indices, date)
	}

	// Remove all .bleve directories in baseDir
	pattern := filepath.Join(s.baseDir, "logs-*.bleve")
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return fmt.Errorf("failed to list indices: %w", err)
	}

	for _, indexPath := range matches {
		if err := os.RemoveAll(indexPath); err != nil {
			return fmt.Errorf("failed to remove index directory %s: %w", indexPath, err)
		}
	}

	return nil
}

// PruneOlderThan deletes every per-day index whose date is older than maxAge,
// returning the number of indices removed. A non-positive maxAge is a no-op
// (retention disabled), so callers can pass the configured window unconditionally.
// Each index dir is named "logs-2006-01-02.bleve"; dates that don't parse are
// skipped rather than treated as expired, so a stray directory is never deleted.
func (s *Storage) PruneOlderThan(maxAge time.Duration) (int, error) {
	if maxAge <= 0 {
		return 0, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	cutoff := time.Now().Add(-maxAge)
	pattern := filepath.Join(s.baseDir, "logs-*.bleve")
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return 0, fmt.Errorf("failed to list indices: %w", err)
	}

	removed := 0
	for _, indexPath := range matches {
		base := filepath.Base(indexPath)
		if len(base) < 12 { // "logs-".."\.bleve" guard
			continue
		}
		date := base[5 : len(base)-6]
		t, err := time.Parse("2006-01-02", date)
		if err != nil {
			continue // not a dated index dir — leave it alone
		}
		if !t.Before(cutoff) {
			continue
		}

		// Close the open handle (if any) before removing the directory.
		if index, ok := s.indices[date]; ok {
			if err := index.Close(); err != nil {
				return removed, fmt.Errorf("failed to close index %s: %w", date, err)
			}
			delete(s.indices, date)
		}
		if err := os.RemoveAll(indexPath); err != nil {
			return removed, fmt.Errorf("failed to remove index directory %s: %w", indexPath, err)
		}
		removed++
	}

	return removed, nil
}

// List returns all available dates that have indices
func (s *Storage) List() ([]string, error) {

	// Get all .bleve directories in baseDir
	pattern := filepath.Join(s.baseDir, "logs-*.bleve")
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return nil, fmt.Errorf("failed to list indices: %w", err)
	}

	// Extract dates from directory names
	dates := make([]string, 0, len(matches))
	for _, match := range matches {
		base := filepath.Base(match)
		// Extract date from "logs-2006-01-02.bleve"
		if date := base[5 : len(base)-6]; len(date) == 10 {
			dates = append(dates, date)
		}
	}

	return dates, nil
}

// BaseDir returns the base directory for storage
func (s *Storage) BaseDir() string {
	return s.baseDir
}

// GetDocCount returns the number of documents in the index for a specific date
func (s *Storage) GetDocCount(date string) (uint64, error) {

	index, err := s.getOrCreateIndex(date)
	if err != nil {
		return 0, fmt.Errorf("failed to get index for date %s: %w", date, err)
	}

	return index.DocCount()
}

// DeleteByIds removes logs with matching document IDs from storage
func (s *Storage) DeleteByIds(ids []string) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}

	// Track how many logs were deleted
	deletedCount := 0

	// Convert ids array to a map for faster lookups
	idMap := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if id == "" {
			continue
		}
		idMap[id] = struct{}{}
	}
	if len(idMap) == 0 {
		return 0, nil
	}

	// Get all available dates
	dates, err := s.List()
	if err != nil {
		return 0, fmt.Errorf("failed to list available dates: %w", err)
	}

	// For each date index, check for matching document IDs
	for _, date := range dates {
		index, err := s.getOrCreateIndex(date)
		if err != nil {
			return deletedCount, fmt.Errorf("failed to get index for date %s: %w", date, err)
		}

		// Create a batch for deletions
		batch := index.NewBatch()
		batchDeletes := 0

		// Process each ID
		for id := range idMap {
			doc, err := index.Document(id)
			if err != nil {
				return deletedCount, fmt.Errorf("failed to read document %s from index %s: %w", id, date, err)
			}
			if doc == nil {
				continue
			}

			batch.Delete(id)
			batchDeletes++
		}

		// Only execute the batch if there are operations to perform
		if batch.Size() > 0 {
			if err := index.Batch(batch); err != nil {
				return deletedCount, fmt.Errorf("error deleting documents from index %s: %w", date, err)
			}
			deletedCount += batchDeletes
		}
	}

	return deletedCount, nil
}
