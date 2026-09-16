package handlers

import (
	"context"
	"testing"
	"time"

	"logsonic/pkg/appconfig"
	storagepkg "logsonic/pkg/storage"
)

// The daily ticker calls the same PruneNow the startup sweep and PUT use;
// this only proves the scheduling fires.
func TestRetentionTickerPrunes(t *testing.T) {
	old := retentionInterval
	retentionInterval = 50 * time.Millisecond
	t.Cleanup(func() { retentionInterval = old })

	dir := activateL2GConfig(t)
	store, err := storagepkg.NewStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	h := NewHandler(store, dir)
	t.Cleanup(func() { _ = h.Catalog.Close() })
	cfg, _ := appconfig.Open(dir)
	m := NewRetentionManager(h, cfg, 7)

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m.Start(ctx) // startup sweep on an empty store, then the ticker

	oldDay := time.Now().UTC().AddDate(0, 0, -20)
	if err := store.Store([]map[string]interface{}{{"timestamp": oldDay, "_raw": "x", "_src": "a"}}, "a"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if dates, _ := store.List(); len(dates) == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	dates, _ := store.List()
	t.Fatalf("ticker did not prune the 20-day-old day within 3 s: %v", dates)
}
