package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	storagepkg "logsonic/pkg/storage"
	"logsonic/pkg/types"
)

// countingStorage is real Bleve storage with a counter on the one method a
// catalog rebuild would call. Spec now-10 C6: /info must never scan the
// indices for source names; the catalog is maintained on the write path.
type countingStorage struct {
	*storagepkg.Storage
	sourceStats atomic.Int64
}

func (c *countingStorage) SourceStats(date string) ([]storagepkg.SourceDayStats, error) {
	c.sourceStats.Add(1)
	return c.Storage.SourceStats(date)
}

func TestC6_InfoNeverScansForSourceNames(t *testing.T) {
	dir := activateL2GConfig(t)
	real, err := storagepkg.NewStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { real.Close() })
	store := &countingStorage{Storage: real}
	h := NewHandler(store, dir)
	t.Cleanup(func() { _ = h.Catalog.Close() })

	// Open with no sources.json rebuilds — over zero days, so zero calls.
	if n := store.sourceStats.Load(); n != 0 {
		t.Fatalf("rebuild on an empty store made %d SourceStats calls", n)
	}

	// Three sources, 2,000 rows each, through the real chunk-ingest handlers.
	for _, src := range []string{"a.log", "b.log", "c.log"} {
		body, _ := json.Marshal(types.IngestSessionOptions{
			Name: "C6", Pattern: "%{GREEDYDATA:message}", Source: src,
			Meta: map[string]interface{}{"_src": src},
		})
		w := httptest.NewRecorder()
		h.HandleIngestStart(w, httptest.NewRequest(http.MethodPost, "/api/v1/ingest/start", bytes.NewReader(body)))
		var started types.IngestResponse
		_ = json.NewDecoder(w.Body).Decode(&started)
		if started.SessionID == "" {
			t.Fatalf("start %s: %s", src, w.Body.String())
		}
		lines := make([]string, 2000)
		for i := range lines {
			lines[i] = "line " + strconv.Itoa(i)
		}
		body, _ = json.Marshal(map[string]any{"logs": lines, "session_id": started.SessionID})
		w = httptest.NewRecorder()
		h.HandleIngest(w, httptest.NewRequest(http.MethodPost, "/api/v1/ingest/logs", bytes.NewReader(body)))
		if w.Code != http.StatusOK {
			t.Fatalf("ingest %s: %d %s", src, w.Code, w.Body.String())
		}
		body, _ = json.Marshal(map[string]any{"session_id": started.SessionID})
		h.HandleIngestEnd(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/v1/ingest/end", bytes.NewReader(body)))
	}

	info := func(refresh bool) types.SystemInfoResponse {
		url := "/api/v1/info"
		if refresh {
			url += "?refresh=true"
		}
		w := httptest.NewRecorder()
		h.HandleInfo(w, httptest.NewRequest(http.MethodGet, url, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("/info: %d %s", w.Code, w.Body.String())
		}
		var out types.SystemInfoResponse
		_ = json.NewDecoder(w.Body).Decode(&out)
		return out
	}

	// Ending each session reconciles that source from the index (one
	// SourceStats per day it spans); /info must add nothing to that.
	base := store.sourceStats.Load()

	// A cold call (cache invalidated by the ingests) and a forced refresh
	// both build the storage section without touching SourceStats.
	first := info(false)
	if names := first.StorageInfo.SourceNames; len(names) != 3 || names[0] != "a.log" {
		t.Fatalf("source_names: %v", names)
	}
	if s := first.StorageInfo.Sources; len(s) != 3 || s[0].Rows != 2000 || s[2].Name != "c.log" {
		t.Fatalf("sources: %+v", s)
	}
	info(true)
	if n := store.sourceStats.Load() - base; n != 0 {
		t.Fatalf("/info made %d SourceStats calls; the catalog must answer from memory", n)
	}

	// Warm p95 over 200 calls. The spec's number is for a 1M-row corpus,
	// which this test doesn't build; the point here is that the cost no
	// longer scales with rows at all (nothing here reads the index).
	samples := make([]time.Duration, 0, 200)
	for i := 0; i < 200; i++ {
		start := time.Now()
		info(false)
		samples = append(samples, time.Since(start))
	}
	sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
	p95 := samples[len(samples)*95/100]
	t.Logf("warm /info p50 %s p95 %s (3 sources, 6,000 rows)", samples[len(samples)/2], p95)
	if p95 > 20*time.Millisecond {
		t.Errorf("warm /info p95 %s > 20 ms budget", p95)
	}
	if n := store.sourceStats.Load() - base; n != 0 {
		t.Fatalf("warm loop made %d SourceStats calls", n)
	}
}

// A session that is swept for inactivity (client gone before /ingest/end)
// reconciles its source the same way an ended one does: the same lines
// uploaded twice in that session count once.
func TestExpiredSessionReconcilesCatalog(t *testing.T) {
	dir := activateL2GConfig(t)
	store, err := storagepkg.NewStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	h := NewHandler(store, dir)
	t.Cleanup(func() { _ = h.Catalog.Close() })

	body, _ := json.Marshal(types.IngestSessionOptions{
		Name: "EXP", Pattern: "%{TIMESTAMP_ISO8601:timestamp} %{GREEDYDATA:message}", Source: "exp.log",
		Meta: map[string]interface{}{"_src": "exp.log"},
	})
	w := httptest.NewRecorder()
	h.HandleIngestStart(w, httptest.NewRequest(http.MethodPost, "/api/v1/ingest/start", bytes.NewReader(body)))
	var started types.IngestResponse
	_ = json.NewDecoder(w.Body).Decode(&started)
	lines := make([]string, 500)
	for i := range lines {
		lines[i] = "2026-03-01T10:00:" + strconv.Itoa(i%60) + "Z line " + strconv.Itoa(i)
	}
	for pass := 0; pass < 2; pass++ {
		// Reset the seq so the second pass reproduces the first pass's IDs,
		// as a retried upload of the same chunk would.
		sessionMapMutex.Lock()
		s := sessionMap[started.SessionID]
		s.Seq.Store(0)
		sessionMap[started.SessionID] = s
		sessionMapMutex.Unlock()
		body, _ = json.Marshal(map[string]any{"logs": lines, "session_id": started.SessionID})
		w = httptest.NewRecorder()
		h.HandleIngest(w, httptest.NewRequest(http.MethodPost, "/api/v1/ingest/logs", bytes.NewReader(body)))
		if w.Code != http.StatusOK {
			t.Fatalf("ingest pass %d: %d %s", pass, w.Code, w.Body.String())
		}
	}
	if e, _ := h.Catalog.Get("exp.log"); e.Rows != 1000 {
		t.Fatalf("before expiry the counter is expected to over-count: %d", e.Rows)
	}

	sessionMapMutex.Lock()
	s := sessionMap[started.SessionID]
	s.LastActivity = time.Now().Add(-SessionTimeout - time.Minute)
	sessionMap[started.SessionID] = s
	sessionMapMutex.Unlock()
	expireStaleSessions(time.Now(), h)

	e, err := h.Catalog.Get("exp.log")
	if err != nil || e.Rows != 500 {
		t.Fatalf("after expiry: %+v %v", e, err)
	}
}
