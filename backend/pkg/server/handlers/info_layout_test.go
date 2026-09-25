package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	storagepkg "logsonic/pkg/storage"
)

// A background conversion shrinks storage without an import or delete; the
// cached /info size must not keep reporting the old bytes.
func TestInfoSizeFollowsBackgroundConversion(t *testing.T) {
	dir := activateL2GConfig(t)
	t.Setenv(storagepkg.StorageFormatEnv, "legacy")
	legacy, err := storagepkg.NewStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	day := time.Date(2024, 2, 1, 0, 0, 0, 0, time.UTC)
	rows := make([]map[string]interface{}, 0, 3000)
	for i := 0; i < 3000; i++ {
		rows = append(rows, map[string]interface{}{"timestamp": day.Add(time.Duration(i) * time.Second), "_seq": int64(i), "_raw": fmt.Sprintf("GET /orders/%d status=200 user=u%d", i, i%50), "_src": "a.log"})
	}
	if err := legacy.Store(rows, "a.log"); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	t.Setenv(storagepkg.StorageFormatEnv, "")
	t.Setenv(storagepkg.MigrationEnv, "off")
	store, err := storagepkg.NewStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	h := NewHandler(store, dir)
	t.Cleanup(func() { _ = h.Catalog.Close() })

	size := func() int64 {
		rec := httptest.NewRecorder()
		h.HandleInfo(rec, httptest.NewRequest(http.MethodGet, "/api/v1/info", nil))
		var out struct {
			StorageInfo struct {
				StorageSize int64 `json:"storage_size_bytes"`
			} `json:"storage_info"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out.StorageInfo.StorageSize
	}
	before := size()
	if n, err := store.MigrateLegacyDays(context.Background()); err != nil || n != 1 {
		t.Fatalf("migrate: %d %v", n, err)
	}
	if after := size(); after >= before {
		t.Fatalf("/info size %d → %d after conversion; the cached value was served", before, after)
	}
}
