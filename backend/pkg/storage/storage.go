package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/blevesearch/bleve/v2"
	"github.com/blevesearch/bleve/v2/index/upsidedown/store/goleveldb"
)

// Storage handles log data persistence using Bleve with time-based sharding
type Storage struct {
	baseDir string
	indices map[string]bleve.Index // Map of date -> index
}

// StorageInterface defines the methods implemented by *Storage.
type StorageInterface interface {
	Store(logs []map[string]interface{}, source string) error
	Search(query string, startDate, endDate *time.Time, sources []string) ([]map[string]interface{}, time.Duration, error)
	List() ([]string, error)
	GetSourceNames() ([]string, error)
	Clear() error
	BaseDir() string
	GetDocCount(date string) (uint64, error)
	DeleteByIds(ids []string) (int, error)
}

// NewStorage initializes a new Storage instance
func NewStorage(baseDir string) (*Storage, error) {
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

// getOrCreateIndex returns an index for the given date, creating it if necessary
func (s *Storage) getOrCreateIndex(date string) (bleve.Index, error) {

	index, exists := s.indices[date]
	if exists {
		return index, nil
	}

	indexPath := filepath.Join(s.baseDir, fmt.Sprintf("logs-%s.bleve", date))
	var err error

	// Check if index exists
	_, statErr := os.Stat(indexPath)
	if os.IsNotExist(statErr) {
		mapping := bleve.NewIndexMapping()
		logMapping := bleve.NewDocumentMapping()

		// Map the "timestamp" field as a DateTime type
		dateField := bleve.NewDateTimeFieldMapping()
		dateField.Store = true // We need to retrieve this
		dateField.Index = false
		logMapping.AddFieldMappingsAt("timestamp", dateField)

		// Map the "raw" field as text with efficient settings
		textField := bleve.NewTextFieldMapping()
		textField.Store = true // We need to retrieve the raw content
		textField.Analyzer = "standard"
		// Disable term vectors to save space - they're not needed for basic search
		textField.IncludeTermVectors = false
		textField.IncludeInAll = true
		logMapping.AddFieldMappingsAt("_raw", textField)

		mapping.DefaultMapping = logMapping
		mapping.DefaultAnalyzer = "standard"

		// Enable dynamic indexing but optimize storage
		mapping.IndexDynamic = true

		// Avoid storing duplicates of field values that are already in _raw
		mapping.StoreDynamic = true      // Store dynamic fields separately (already in _raw)
		mapping.DocValuesDynamic = false // Disable doc values for dynamic fields (saves space)

		// Configure LevelDB options for better compression and performance
		kvConfig := map[string]interface{}{
			"create_if_missing": true,
			"error_if_exists":   false,
			// More aggressive compression settings
			"block_size":                32768,    // 32KB blocks for better compression ratio
			"write_buffer_size":         16777216, // 16MB write buffer for better batching
			"lru_cache_capacity":        33554432, // 32MB LRU cache
			"bloom_filter_bits_per_key": 15,       // Bloom filter for performance
			"compression":               "snappy", // Use Snappy compression for better performance/space trade-off

		}

		indexConfig := map[string]interface{}{
			"store": kvConfig,
		}

		index, err = bleve.NewUsing(indexPath, mapping, "scorch", goleveldb.Name, indexConfig)
	} else {
		index, err = bleve.Open(indexPath)
	}

	if err != nil {
		return nil, fmt.Errorf("failed to initialize index for date %s: %w", date, err)
	}

	s.indices[date] = index
	return index, nil
}

// Store saves the parsed log data to appropriate daily indices
func (s *Storage) Store(logs []map[string]interface{}, source string) error {

	// Group logs by date
	logsByDate := make(map[string][]map[string]interface{})
	for _, log := range logs {
		ts := log["timestamp"].(time.Time)
		date := ts.Format("2006-01-02")
		logsByDate[date] = append(logsByDate[date], log)
	}

	// Store logs in appropriate daily indices
	for date, dateLogs := range logsByDate {
		index, err := s.getOrCreateIndex(date)
		if err != nil {
			return fmt.Errorf("failed to get index for date %s: %w", date, err)
		}

		batch := index.NewBatch()
		for i, log := range dateLogs {
			// Create a copy with potential numeric values converted
			logCopy := make(map[string]interface{})

			// First, copy all fields as strings
			for k, v := range log {
				logCopy[k] = v
			}

			// Then try to convert any fields that look like numbers
			for k, v := range log {
				// Skip timestamp field - we want to keep it as a string
				// Skip if key is any of the known smart decoder or fixed field

				if k == "timestamp" || strings.HasPrefix(k, "_") {
					continue
				}

				// Try to convert to int first
				if intVal, err := strconv.ParseInt(v.(string), 10, 64); err == nil {
					logCopy[k] = intVal
					continue
				}

				// If not an int, try float
				if floatVal, err := strconv.ParseFloat(v.(string), 64); err == nil {
					logCopy[k] = floatVal
				}
			}
			// Generate a unique ID for the log entry with Unix timestamp, source and index number
			docID := fmt.Sprintf("%d-%s-%d", log["timestamp"].(time.Time).UnixNano(), source, i)
			if err := batch.Index(docID, logCopy); err != nil {
				return fmt.Errorf("failed to index log entry: %w", err)
			}
		}

		if err := index.Batch(batch); err != nil {
			return fmt.Errorf("failed to commit batch for date %s: %w", date, err)
		}
	}

	return nil
}

// Clear removes all indices
func (s *Storage) Clear() error {

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
	// Track how many logs were deleted
	deletedCount := 0
	
	// Convert ids array to a map for faster lookups
	idMap := make(map[string]bool, len(ids))
	for _, id := range ids {
		idMap[id] = true
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
		
		// Process each ID
		for id := range idMap {
			batch.Delete(id)
		}
		
		// Only execute the batch if there are operations to perform
		if batch.Size() > 0 {
			if err := index.Batch(batch); err != nil {
				return deletedCount, fmt.Errorf("error deleting documents from index %s: %w", date, err)
			}
			// Since we don't know exactly how many documents were deleted from each index,
			// we'll update the deletedCount based on the batch size
			deletedCount += batch.Size()
		}
	}
	
	return deletedCount, nil
}
