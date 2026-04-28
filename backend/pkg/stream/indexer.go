package stream

import (
	"context"
	"log"
	"time"

	"logsonic/pkg/storage"
)

const (
	defaultFlushInterval = 2 * time.Second
	defaultBatchSize     = 500
)

// IndexerConfig configures the async Bleve batch writer.
type IndexerConfig struct {
	FlushInterval time.Duration // 0 = default 2s
	BatchSize     int           // 0 = default 500
}

// BleveIndexer subscribes to a Bus and writes batched events to a Bleve storage
// backend on a configurable flush interval or batch size threshold.
// It runs independently of WebSocket delivery so stream latency is unaffected.
type BleveIndexer struct {
	bus     *Bus
	storage storage.StorageInterface
	cfg     IndexerConfig
	cancel  context.CancelFunc
	done    chan struct{}
}

// NewBleveIndexer creates a BleveIndexer. Call Start to begin indexing.
func NewBleveIndexer(bus *Bus, store storage.StorageInterface, cfg IndexerConfig) *BleveIndexer {
	if cfg.FlushInterval <= 0 {
		cfg.FlushInterval = defaultFlushInterval
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = defaultBatchSize
	}
	return &BleveIndexer{
		bus:     bus,
		storage: store,
		cfg:     cfg,
		done:    make(chan struct{}),
	}
}

// Start subscribes to the bus and launches the background indexing goroutine.
// Subscribe is done synchronously so any Publish after Start returns is captured.
func (idx *BleveIndexer) Start(ctx context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	idx.cancel = cancel
	sub, _ := idx.bus.Subscribe(0) // synchronous — no events missed after return
	go idx.run(ctx, sub)
}

// Stop signals the indexer to stop and waits for in-flight batch to flush.
func (idx *BleveIndexer) Stop() {
	if idx.cancel != nil {
		idx.cancel()
	}
	<-idx.done
}

func (idx *BleveIndexer) run(ctx context.Context, sub *Subscriber) {
	defer close(idx.done)
	defer idx.bus.Unsubscribe(sub)

	ticker := time.NewTicker(idx.cfg.FlushInterval)
	defer ticker.Stop()

	batch := make([]map[string]interface{}, 0, idx.cfg.BatchSize)

	flush := func() {
		if len(batch) == 0 {
			return
		}
		if err := idx.storage.Store(batch, "stream"); err != nil {
			log.Printf("stream/indexer: flush error: %v", err)
		}
		batch = batch[:0]
	}

	for {
		select {
		case <-ctx.Done():
			flush()
			return
		case ev, ok := <-sub.Ch:
			if !ok {
				flush()
				return
			}
			batch = append(batch, ev.Fields)
			if len(batch) >= idx.cfg.BatchSize {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}
