package handlers

import (
	"log"
	"logsonic/pkg/storage"
	"logsonic/pkg/timeresolve"
	"sync"
)

type Services struct {
	storage storage.StorageInterface

	StoragePath string

	// PatternTimestamps persists per-pattern Resolution alongside the
	// log2grok library. Saved patterns thus restore their last-used
	// anchor / year strategy / timezone on next import.
	PatternTimestamps *timeresolve.LibraryStore

	storageInfoCache any
	infoCacheMutex   sync.RWMutex
	cacheValid       bool
}

// NewHandler wires up the HTTP service surface. Pattern + decode logic
// is fully owned by log2grok now, so no tokenizer dependency is needed.
func NewHandler(storage storage.StorageInterface, storagePath string) *Services {
	store, err := timeresolve.NewLibraryStore(storagePath)
	if err != nil {
		// A failed side-file open shouldn't block ingest. Log and
		// leave PatternTimestamps nil; the grok handler treats nil
		// as "no persistence" and falls through cleanly.
		log.Printf("timeresolve: failed to open pattern_timestamps.json: %v", err)
	}
	return &Services{
		storage:           storage,
		StoragePath:       storagePath,
		PatternTimestamps: store,
		storageInfoCache:  nil,
		cacheValid:        false,
	}
}

// CloseStorage cleanly shuts down all open Bleve indices.
func (s *Services) CloseStorage() error {
	type closer interface {
		Close() error
	}
	if c, ok := s.storage.(closer); ok {
		return c.Close()
	}
	return nil
}
