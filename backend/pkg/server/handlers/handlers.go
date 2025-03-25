package handlers

import (
	"logsonic/pkg/storage"
	"logsonic/pkg/tokenizer"
	"sync"
)

type Services struct {
	storage   storage.StorageInterface
	tokenizer tokenizer.TokenizerInterface

	StoragePath string

	// Cache for system info
	storageInfoCache any // Will store StorageInfoType from info.go
	infoCacheMutex   sync.RWMutex
	cacheValid       bool
}

func NewHandler(storage storage.StorageInterface, tokenizer tokenizer.TokenizerInterface, storagePath string) *Services {
	return &Services{
		storage:          storage,
		tokenizer:        tokenizer,
		StoragePath:      storagePath,
		storageInfoCache: nil,
		cacheValid:       false,
	}
}
