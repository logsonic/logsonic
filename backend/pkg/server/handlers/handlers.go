package handlers

import (
	"logsonic/pkg/storage"
	"sync"
)

type Services struct {
	storage storage.StorageInterface

	StoragePath string

	storageInfoCache any
	infoCacheMutex   sync.RWMutex
	cacheValid       bool
}

// NewHandler wires up the HTTP service surface. Pattern + decode logic
// is fully owned by log2grok now, so no tokenizer dependency is needed.
func NewHandler(storage storage.StorageInterface, storagePath string) *Services {
	return &Services{
		storage:          storage,
		StoragePath:      storagePath,
		storageInfoCache: nil,
		cacheValid:       false,
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
