package handlers

import (
	"logsonic/pkg/storage"
	"logsonic/pkg/stream"
	"logsonic/pkg/tokenizer"
	"sync"
)

type Services struct {
	storage   storage.StorageInterface
	tokenizer tokenizer.TokenizerInterface

	StoragePath string
	StreamBus   *stream.Bus

	// Cache for system info
	storageInfoCache any // Will store StorageInfoType from info.go
	infoCacheMutex   sync.RWMutex
	cacheValid       bool
}

func NewHandler(store storage.StorageInterface, tok tokenizer.TokenizerInterface, storagePath string, bus *stream.Bus) *Services {
	return &Services{
		storage:          store,
		tokenizer:        tok,
		StoragePath:      storagePath,
		StreamBus:        bus,
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
