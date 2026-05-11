package handlers

import (
	"bytes"
	"encoding/json"
	"logsonic/pkg/types"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"
)

// ---------------------------------------------------------------------------
// Mock Storage
// ---------------------------------------------------------------------------

type mockStorage struct {
	logs        []map[string]interface{}
	sourceNames []string
	storeErr    error
	searchErr   error
	listDates   []string
	clearErr    error
	baseDir     string
	docCounts   map[string]uint64
}

func newMockStorage() *mockStorage {
	return &mockStorage{
		logs:      []map[string]interface{}{},
		docCounts: map[string]uint64{},
		baseDir:   "/tmp/mock-storage",
	}
}

func (m *mockStorage) Store(logs []map[string]interface{}, source string) error {
	if m.storeErr != nil {
		return m.storeErr
	}
	m.logs = append(m.logs, logs...)
	return nil
}

func (m *mockStorage) Search(query string, startDate, endDate *time.Time, sources []string) ([]map[string]interface{}, time.Duration, error) {
	if m.searchErr != nil {
		return nil, 0, m.searchErr
	}
	return m.logs, time.Millisecond, nil
}

func (m *mockStorage) List() ([]string, error) { return m.listDates, nil }

func (m *mockStorage) GetSourceNames() ([]string, error) { return m.sourceNames, nil }

func (m *mockStorage) Clear() error {
	if m.clearErr != nil {
		return m.clearErr
	}
	m.logs = nil
	return nil
}

func (m *mockStorage) BaseDir() string { return m.baseDir }

func (m *mockStorage) GetDocCount(date string) (uint64, error) { return m.docCounts[date], nil }

func (m *mockStorage) DeleteByIds(ids []string) (int, error) { return len(ids), nil }

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// log2grok config is a process-global singleton, so any test that
// touches the library state must hold testConfigMu to avoid races
// between subtests. Each test that calls activateL2GConfig holds it
// for the duration of the test.
var testConfigMu sync.Mutex

// activateL2GConfig points log2grok at a per-test temp dir. Returns
// the dir and a cleanup function (via t.Cleanup) that resets state for
// the next test by removing every entry the test added.
func activateL2GConfig(t *testing.T) string {
	t.Helper()
	testConfigMu.Lock()
	t.Cleanup(testConfigMu.Unlock)

	dir := t.TempDir()
	if err := l2g.LoadConfig(dir, nil); err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	return dir
}

func setupHandler(t *testing.T) (*Services, *mockStorage) {
	t.Helper()
	store := newMockStorage()
	dir := activateL2GConfig(t)
	store.baseDir = dir
	h := NewHandler(store, dir)
	return h, store
}

// ---------------------------------------------------------------------------
// HandlePing
// ---------------------------------------------------------------------------

func TestHandlePing(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/ping", nil)
	w := httptest.NewRecorder()

	h.HandlePing(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var resp PingResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.Status != "pong" {
		t.Errorf("expected status 'pong', got '%s'", resp.Status)
	}
}

// ---------------------------------------------------------------------------
// HandleIngestStart
// ---------------------------------------------------------------------------

func TestHandleIngestStart_Success(t *testing.T) {
	h, _ := setupHandler(t)

	body, _ := json.Marshal(types.IngestSessionOptions{
		Name:    "test-pattern",
		Pattern: "%{GREEDYDATA:message}",
		Source:  "test.log",
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/ingest/start", bytes.NewReader(body))
	w := httptest.NewRecorder()

	h.HandleIngestStart(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var resp types.IngestResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if resp.Status != "success" {
		t.Errorf("expected 'success', got '%s'", resp.Status)
	}
	if resp.SessionID == "" {
		t.Error("expected non-empty session ID")
	}

	sessionMapMutex.RLock()
	_, exists := sessionMap[resp.SessionID]
	sessionMapMutex.RUnlock()
	if !exists {
		t.Error("session not found in sessionMap")
	}

	sessionMapMutex.Lock()
	delete(sessionMap, resp.SessionID)
	sessionMapMutex.Unlock()
}

func TestHandleIngestStart_MethodNotAllowed(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/ingest/start", nil)
	w := httptest.NewRecorder()

	h.HandleIngestStart(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestHandleIngestStart_MissingPatternAndName(t *testing.T) {
	h, _ := setupHandler(t)

	body, _ := json.Marshal(types.IngestSessionOptions{
		Source: "test.log",
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/ingest/start", bytes.NewReader(body))
	w := httptest.NewRecorder()

	h.HandleIngestStart(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestHandleIngestStart_InvalidBody(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ingest/start", bytes.NewReader([]byte("not json")))
	w := httptest.NewRecorder()

	h.HandleIngestStart(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

// ---------------------------------------------------------------------------
// HandleIngest
// ---------------------------------------------------------------------------

func TestHandleIngest_InvalidSession(t *testing.T) {
	h, _ := setupHandler(t)

	body, _ := json.Marshal(types.IngestRequest{
		SessionID: "nonexistent-session",
		Logs:      []string{"test log"},
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/ingest", bytes.NewReader(body))
	w := httptest.NewRecorder()

	h.HandleIngest(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestHandleIngest_MethodNotAllowed(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/ingest", nil)
	w := httptest.NewRecorder()

	h.HandleIngest(w, req)

	var resp types.ErrorResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Code != "METHOD_NOT_ALLOWED" {
		t.Errorf("expected METHOD_NOT_ALLOWED code, got '%s'", resp.Code)
	}
}

func TestHandleIngest_InvalidBody(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ingest", bytes.NewReader([]byte("{bad")))
	w := httptest.NewRecorder()

	h.HandleIngest(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

// ---------------------------------------------------------------------------
// HandleIngestEnd
// ---------------------------------------------------------------------------

func TestHandleIngestEnd_Success(t *testing.T) {
	h, _ := setupHandler(t)

	sessionMapMutex.Lock()
	sessionMap["test-session-end"] = IngestSession{
		Options:      types.IngestSessionOptions{Source: "test.log"},
		CreationTime: time.Now(),
	}
	sessionMapMutex.Unlock()

	body, _ := json.Marshal(types.IngestRequest{SessionID: "test-session-end"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ingest/end", bytes.NewReader(body))
	w := httptest.NewRecorder()

	h.HandleIngestEnd(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	sessionMapMutex.RLock()
	_, exists := sessionMap["test-session-end"]
	sessionMapMutex.RUnlock()
	if exists {
		t.Error("session should have been removed")
	}
}

func TestHandleIngestEnd_MethodNotAllowed(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/ingest/end", nil)
	w := httptest.NewRecorder()

	h.HandleIngestEnd(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestHandleIngestEnd_EmptyBody(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ingest/end", bytes.NewReader([]byte("")))
	w := httptest.NewRecorder()

	h.HandleIngestEnd(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 even with empty body, got %d", w.Code)
	}
}

// ---------------------------------------------------------------------------
// HandleGrokPatterns
// ---------------------------------------------------------------------------

func TestHandleGrokPatterns_GetReturnsLibrary(t *testing.T) {
	h, _ := setupHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/grok", nil)
	w := httptest.NewRecorder()

	h.HandleGrokPatterns(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var resp types.GrokPatternResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Status != "success" {
		t.Errorf("expected 'success', got '%s'", resp.Status)
	}
	// Embedded library has many entries, but the test must not assume
	// a specific count — just that ListLibrary surfaced something.
	if len(resp.Patterns) == 0 {
		t.Error("expected non-empty embedded library via GET")
	}
}

func TestHandleGrokPatterns_CreateAndGet(t *testing.T) {
	h, _ := setupHandler(t)

	body, _ := json.Marshal(types.GrokPatternRequest{
		Name:        "ls-handler-test-pattern",
		Pattern:     "%{GREEDYDATA:message}",
		Description: "Test pattern",
		Priority:    1,
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/grok", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleGrokPatterns(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d", w.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/grok", nil)
	w = httptest.NewRecorder()
	h.HandleGrokPatterns(w, req)

	var resp types.GrokPatternResponse
	json.NewDecoder(w.Body).Decode(&resp)

	found := false
	for _, p := range resp.Patterns {
		if p.Name == "ls-handler-test-pattern" {
			found = true
			break
		}
	}
	if !found {
		t.Error("created pattern not visible via GET")
	}
}

func TestHandleGrokPatterns_CreateDuplicate(t *testing.T) {
	h, _ := setupHandler(t)

	if _, err := l2g.UpsertLibraryEntry(l2g.KnownPattern{
		Name:    "ls-handler-existing",
		Pattern: "%{GREEDYDATA:msg}",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	body, _ := json.Marshal(types.GrokPatternRequest{
		Name:    "ls-handler-existing",
		Pattern: "%{GREEDYDATA:msg}",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/grok", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleGrokPatterns(w, req)

	if w.Code != http.StatusConflict {
		t.Errorf("expected 409 for duplicate, got %d", w.Code)
	}
}

func TestHandleGrokPatterns_CreateMissingName(t *testing.T) {
	h, _ := setupHandler(t)

	body, _ := json.Marshal(types.GrokPatternRequest{
		Pattern: "%{GREEDYDATA:msg}",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/grok", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleGrokPatterns(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestHandleGrokPatterns_Delete(t *testing.T) {
	h, _ := setupHandler(t)

	if _, err := l2g.UpsertLibraryEntry(l2g.KnownPattern{
		Name:    "ls-handler-delete-me",
		Pattern: "%{GREEDYDATA:msg}",
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/grok?name=ls-handler-delete-me", nil)
	w := httptest.NewRecorder()
	h.HandleGrokPatterns(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var resp types.GrokPatternResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Status != "success" {
		t.Errorf("expected 'success', got '%s'", resp.Status)
	}

	for _, kp := range l2g.ListLibrary() {
		if kp.Name == "ls-handler-delete-me" {
			t.Fatal("entry still present after delete")
		}
	}
}

func TestHandleGrokPatterns_DeleteNotFound(t *testing.T) {
	h, _ := setupHandler(t)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/grok?name=ls-handler-nonexistent-name-xyz", nil)
	w := httptest.NewRecorder()
	h.HandleGrokPatterns(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestHandleGrokPatterns_UnsupportedMethod(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/grok", nil)
	w := httptest.NewRecorder()
	h.HandleGrokPatterns(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

// ---------------------------------------------------------------------------
// HandleInfo
// ---------------------------------------------------------------------------

func TestHandleInfo_Success(t *testing.T) {
	h, store := setupHandler(t)
	store.listDates = []string{"2024-01-15"}
	store.sourceNames = []string{"app.log"}
	store.docCounts = map[string]uint64{"2024-01-15": 42}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/info", nil)
	w := httptest.NewRecorder()

	h.HandleInfo(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var resp types.SystemInfoResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Status != "success" {
		t.Errorf("expected 'success', got '%s'", resp.Status)
	}
}

func TestHandleInfo_MethodNotAllowed(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/info", nil)
	w := httptest.NewRecorder()

	h.HandleInfo(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestHandleInfo_CacheInvalidation(t *testing.T) {
	h, store := setupHandler(t)
	store.listDates = []string{"2024-01-15"}
	store.sourceNames = []string{"app.log"}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/info", nil)
	w := httptest.NewRecorder()
	h.HandleInfo(w, req)

	h.infoCacheMutex.RLock()
	cached := h.cacheValid
	h.infoCacheMutex.RUnlock()
	if !cached {
		t.Error("expected cache to be valid after first request")
	}

	h.InvalidateInfoCache()

	h.infoCacheMutex.RLock()
	cached = h.cacheValid
	h.infoCacheMutex.RUnlock()
	if cached {
		t.Error("expected cache to be invalid after InvalidateInfoCache")
	}
}

func TestHandleInfo_RefreshParam(t *testing.T) {
	h, store := setupHandler(t)
	store.listDates = []string{}
	store.sourceNames = []string{}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/info", nil)
	w := httptest.NewRecorder()
	h.HandleInfo(w, req)

	req = httptest.NewRequest(http.MethodGet, "/api/v1/info?refresh=true", nil)
	w = httptest.NewRecorder()
	h.HandleInfo(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

// ---------------------------------------------------------------------------
// HandleParse
// ---------------------------------------------------------------------------

func TestHandleParse_MethodNotAllowed(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/parse", nil)
	w := httptest.NewRecorder()

	h.HandleParse(w, req)

	var resp types.ErrorResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Code != "METHOD_NOT_ALLOWED" {
		t.Errorf("expected METHOD_NOT_ALLOWED, got '%s'", resp.Code)
	}
}

func TestHandleParse_InvalidBody(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/parse", bytes.NewReader([]byte("bad")))
	w := httptest.NewRecorder()

	h.HandleParse(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestHandleParse_WithPattern(t *testing.T) {
	h, _ := setupHandler(t)

	body, _ := json.Marshal(types.ParseRequest{
		Logs:        []string{"hello world", "foo bar"},
		GrokPattern: "%{GREEDYDATA:message}",
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/parse", bytes.NewReader(body))
	w := httptest.NewRecorder()

	h.HandleParse(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var resp types.ParseResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Status != "success" {
		t.Errorf("expected 'success', got '%s'", resp.Status)
	}
	if resp.Processed != 2 {
		t.Errorf("expected 2 processed, got %d", resp.Processed)
	}
}

func TestHandleParse_AutosuggestNoPatterns(t *testing.T) {
	h, _ := setupHandler(t)

	body, _ := json.Marshal(types.ParseRequest{
		Logs: []string{"Jan 15 10:30:00 myhost test message"},
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/parse", bytes.NewReader(body))
	w := httptest.NewRecorder()

	h.HandleParse(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var resp types.SuggestResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Status != "success" {
		t.Errorf("expected 'success', got '%s'", resp.Status)
	}
	if resp.Type != "autosuggest" {
		t.Errorf("expected type 'autosuggest', got '%s'", resp.Type)
	}
}

// TestHandleParse_AutosuggestSurfacesTimestampHint covers the new
// log2grok TimestampHint path: when Discover identifies a pattern with
// a recognised timestamp primitive (HTTPDATE in this case), /parse's
// autosuggest result should carry the inferred field name + Go layout
// so the wizard can pre-select the timestamp column.
func TestHandleParse_AutosuggestSurfacesTimestampHint(t *testing.T) {
	h, _ := setupHandler(t)

	body, _ := json.Marshal(types.ParseRequest{
		Logs: []string{
			`192.168.1.1 - - [23/Jan/2026:14:05:01 +0000] "GET / HTTP/1.1" 200 1 "-" "ua"`,
			`10.0.0.1 - - [23/Jan/2026:14:05:02 +0000] "GET /a HTTP/1.1" 200 2 "-" "ua"`,
			`10.0.0.2 - - [23/Jan/2026:14:05:03 +0000] "GET /b HTTP/1.1" 200 3 "-" "ua"`,
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/parse", bytes.NewReader(body))
	w := httptest.NewRecorder()

	h.HandleParse(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp types.SuggestResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Results) == 0 {
		t.Fatal("expected at least one autosuggest result")
	}
	r := resp.Results[0]
	if r.TimestampField == "" {
		t.Errorf("TimestampField empty; result=%+v", r)
	}
	if r.TimestampLayout == "" {
		t.Errorf("TimestampLayout empty; result=%+v", r)
	}
}

// TestHandleParse_AutosuggestAcceptsBlankInputLines verifies the
// pre-filter we used to do in handlers can be safely dropped: log2grok
// normalises blanks internally and either returns a pattern or
// ErrEmptyInput (which we translate to an empty results slice).
func TestHandleParse_AutosuggestAcceptsBlankInputLines(t *testing.T) {
	h, _ := setupHandler(t)

	body, _ := json.Marshal(types.ParseRequest{
		Logs: []string{
			"",
			`192.168.1.1 - - [23/Jan/2026:14:05:01 +0000] "GET / HTTP/1.1" 200 1 "-" "ua"`,
			"",
			`10.0.0.1 - - [23/Jan/2026:14:05:02 +0000] "GET /a HTTP/1.1" 200 2 "-" "ua"`,
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/parse", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleParse(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp types.SuggestResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Results) == 0 {
		t.Error("expected at least one suggestion despite blank input lines")
	}
}

// ---------------------------------------------------------------------------
// Grok pattern persistence — verify writes hit log2grok's patterns.json
// ---------------------------------------------------------------------------

func TestGrokPatterns_FilePersistence(t *testing.T) {
	h, _ := setupHandler(t)
	dir := l2g.ConfigDir()
	if dir == "" {
		t.Fatal("log2grok ConfigDir empty after setupHandler")
	}

	body, _ := json.Marshal(types.GrokPatternRequest{
		Name:    "ls-persist-test",
		Pattern: "%{IP:client}",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/grok", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleGrokPatterns(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", w.Code)
	}

	patternsFile := filepath.Join(dir, "patterns.json")
	if _, err := os.Stat(patternsFile); os.IsNotExist(err) {
		t.Fatal("log2grok patterns.json was not created")
	}
	data, err := os.ReadFile(patternsFile)
	if err != nil {
		t.Fatalf("read patterns.json: %v", err)
	}
	if !bytes.Contains(data, []byte("ls-persist-test")) {
		t.Error("patterns.json missing the upserted entry")
	}
}

// ---------------------------------------------------------------------------
// HandleReadAll (logs)
// ---------------------------------------------------------------------------

func TestHandleReadAll_MethodNotAllowed(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/logs", nil)
	w := httptest.NewRecorder()

	h.HandleReadAll(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestHandleReadAll_EmptyStore(t *testing.T) {
	h, _ := setupHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/logs?start_date=2024-01-01T00:00:00Z&end_date=2024-12-31T23:59:59Z", nil)
	w := httptest.NewRecorder()

	h.HandleReadAll(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var resp types.LogResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Status != "success" {
		t.Errorf("expected 'success', got '%s'", resp.Status)
	}
	if resp.TotalCount != 0 {
		t.Errorf("expected 0 total, got %d", resp.TotalCount)
	}
}
