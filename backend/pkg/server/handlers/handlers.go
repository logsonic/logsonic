package handlers

import (
	"context"
	"log"
	"logsonic/pkg/catalog"
	"logsonic/pkg/storage"
	"logsonic/pkg/timeresolve"
	"logsonic/pkg/watch"
	"logsonic/pkg/workspaces"
	"sync"
)

// BuildInfo identifies the running binary; set by the server from its
// Config after NewHandler. Zero values render as "dev" / "unknown".
type BuildInfo struct {
	Version   string
	Commit    string
	BuildDate string
}

type Services struct {
	storage storage.StorageInterface
	Live    *TailManager

	StoragePath string
	Build       BuildInfo

	// PatternTimestamps persists per-pattern Resolution alongside the
	// log2grok library. Saved patterns thus restore their last-used
	// anchor / year strategy / timezone on next import.
	PatternTimestamps *timeresolve.LibraryStore
	Workspaces        *workspaces.Store
	// Catalog is the sources catalog (<storage>/sources.json, spec now-10).
	// Every write path reports its batch here via recordStored; /info and
	// the /sources routes read it instead of scanning the indices.
	Catalog *catalog.Catalog
	// Retention is set by the server (it needs the CLI default); nil in
	// handler unit tests, which the storage routes treat as unavailable.
	Retention *RetentionManager
	// Watches is the folder-watch manager (spec now-04), started by the
	// server beside the live tail and closed before storage.
	Watches *watch.Manager

	storageInfoCache any
	infoCacheMutex   sync.RWMutex
	cacheValid       bool

	// ingestJobsCtx is the parent context for every path-ingest job's
	// per-job timeout (see StartIngestJobs). It defaults to
	// context.Background() so handler tests that never call Start()/
	// StartIngestJobs still work; the real server replaces it with the
	// same cleanupCtx that StartLive gets, so a shutdown cancels running
	// jobs the same way it cancels tail sources.
	ingestJobsCtx context.Context

	// catalogSync keeps a catalog rebuild from observing a batch that is
	// already in the index but not yet recorded: every write path holds
	// the read side across Store + recordStored, rebuildCatalog takes the
	// write side. Without it a reconcile that lands in that gap counts
	// the batch twice (once from the index, once from Record).
	catalogSync sync.RWMutex
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
	workspaceStore, err := workspaces.NewStore(storagePath)
	if err != nil {
		log.Printf("workspaces: failed to open workspaces.json: %v", err)
	}
	sources, err := catalog.Open(storagePath, storage)
	if err != nil {
		// Unlike the two side files above this one has readers (/info)
		// that need a non-nil catalog; Open only fails if the storage dir
		// itself can't be created, which storage has already done, so
		// this is defensive rather than expected.
		log.Printf("catalog: failed to open sources.json: %v", err)
	}
	svc := &Services{
		storage:           storage,
		StoragePath:       storagePath,
		PatternTimestamps: store,
		Workspaces:        workspaceStore,
		Catalog:           sources,
		storageInfoCache:  nil,
		cacheValid:        false,
		ingestJobsCtx:     context.Background(),
	}
	svc.Live = NewTailManager(storage, svc.recordStored)
	svc.Live.storeGuard = &svc.catalogSync
	watches, err := watch.Open(storagePath, watch.Deps{
		Follower:       watchDeps{svc},
		Importer:       watchDeps{svc},
		Detector:       watchDeps{svc},
		PatternOptions: svc.patternOptions,
	})
	if err != nil {
		log.Printf("watch: failed to open watches.json: %v", err)
	}
	svc.Watches = watches
	return svc
}

// StartIngestJobs wires the server's shutdown context into path-ingest jobs
// started after this call: each job's own context is derived from ctx (see
// ingest_jobs.go), so cancelling ctx (server shutdown) cancels every running
// job the same way it cancels tail sources -- cooperatively, on the job's
// next read, not awaited here. That mirrors TailManager.Start, which has the
// same not-awaited-before-storage-close property; see ISSUES.md.
func (s *Services) StartIngestJobs(ctx context.Context) {
	s.ingestJobsCtx = ctx
}

// CloseStorage flushes the sources catalog, then cleanly shuts down all open
// Bleve indices. The catalog goes first so its final write happens while a
// late Record from a not-yet-stopped tail/job is still meaningful; after
// Close those become no-ops.
func (s *Services) CloseStorage() error {
	type closer interface {
		Close() error
	}
	// Watches first: they own followers and a state file, and their
	// Finished callbacks must land before the catalog's final flush.
	if s.Watches != nil {
		if err := s.Watches.Close(); err != nil {
			log.Printf("watch: flush on shutdown: %v", err)
		}
	}
	if s.Catalog != nil {
		if err := s.Catalog.Close(); err != nil {
			log.Printf("catalog: flush on shutdown: %v", err)
		}
	}
	if c, ok := s.storage.(closer); ok {
		return c.Close()
	}
	return nil
}
