package handlers

import (
	"bytes"
	"encoding/json"
	"logsonic/pkg/types"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
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

func (m *mockStorage) List() ([]string, error) {
	return m.listDates, nil
}

func (m *mockStorage) GetSourceNames() ([]string, error) {
	return m.sourceNames, nil
}

func (m *mockStorage) Clear() error {
	if m.clearErr != nil {
		return m.clearErr
	}
	m.logs = nil
	return nil
}

func (m *mockStorage) BaseDir() string {
	return m.baseDir
}

func (m *mockStorage) GetDocCount(date string) (uint64, error) {
	return m.docCounts[date], nil
}

func (m *mockStorage) DeleteByIds(ids []string) (int, error) {
	return len(ids), nil
}

// ---------------------------------------------------------------------------
// Mock Tokenizer
// ---------------------------------------------------------------------------

type mockTokenizer struct {
	parseErr error
}

func (m *mockTokenizer) ParseLogs(logLines []string, opts types.IngestSessionOptions) ([]map[string]interface{}, int, int, error) {
	if m.parseErr != nil {
		return nil, 0, len(logLines), m.parseErr
	}
	results := make([]map[string]interface{}, len(logLines))
	for i, line := range logLines {
		results[i] = map[string]interface{}{
			"_raw":      line,
			"message":   line,
			"timestamp": time.Now(),
			"_src":      opts.Source,
		}
	}
	return results, len(logLines), 0, nil
}

func (m *mockTokenizer) AddPattern(pattern string, priority ...int) error   { return nil }
func (m *mockTokenizer) AddCustomPattern(name, pattern string) error        { return nil }
func (m *mockTokenizer) AddPersistentPattern(pattern string) error          { return nil }
func (m *mockTokenizer) AddPersistentCustomPattern(name, pattern string) error { return nil }
func (m *mockTokenizer) ClearRequestPatterns()                              {}
func (m *mockTokenizer) GetPersistentPatterns() []string                    { return nil }
func (m *mockTokenizer) GetCustomPatterns() map[string]string               { return nil }
func (m *mockTokenizer) GetPatterns() []string                              { return nil }
func (m *mockTokenizer) ClearPatterns() error                               { return nil }

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

func setupHandler(t *testing.T) (*Services, *mockStorage) {
	t.Helper()
	store := newMockStorage()
	tok := &mockTokenizer{}
	dir := t.TempDir()
	store.baseDir = dir
	h := NewHandler(store, tok, dir)
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

	// Verify session was stored
	sessionMapMutex.RLock()
	_, exists := sessionMap[resp.SessionID]
	sessionMapMutex.RUnlock()
	if !exists {
		t.Error("session not found in sessionMap")
	}

	// Cleanup
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

	// The handler writes body before header for this case, so it's 200
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

	// Create a session first
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

	// Verify session was removed
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

func TestHandleGrokPatterns_GetEmpty(t *testing.T) {
	h, _ := setupHandler(t)

	// Reset global state for test isolation
	patternMutex.Lock()
	currentPatterns = []types.GrokPatternDefinition{}
	patternMutex.Unlock()

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
}

func TestHandleGrokPatterns_CreateAndGet(t *testing.T) {
	h, _ := setupHandler(t)

	// Reset global state
	patternMutex.Lock()
	currentPatterns = []types.GrokPatternDefinition{}
	patternMutex.Unlock()

	// Create a pattern
	body, _ := json.Marshal(types.GrokPatternRequest{
		Name:        "test-pattern",
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

	// Verify it exists via GET
	req = httptest.NewRequest(http.MethodGet, "/api/v1/grok", nil)
	w = httptest.NewRecorder()
	h.HandleGrokPatterns(w, req)

	var resp types.GrokPatternResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if len(resp.Patterns) != 1 {
		t.Errorf("expected 1 pattern, got %d", len(resp.Patterns))
	}
	if resp.Patterns[0].Name != "test-pattern" {
		t.Errorf("expected 'test-pattern', got '%s'", resp.Patterns[0].Name)
	}

	// Cleanup global state
	patternMutex.Lock()
	currentPatterns = []types.GrokPatternDefinition{}
	patternMutex.Unlock()
}

func TestHandleGrokPatterns_CreateDuplicate(t *testing.T) {
	h, _ := setupHandler(t)

	patternMutex.Lock()
	currentPatterns = []types.GrokPatternDefinition{
		{Name: "existing", Pattern: "%{GREEDYDATA:msg}"},
	}
	patternMutex.Unlock()

	body, _ := json.Marshal(types.GrokPatternRequest{
		Name:    "existing",
		Pattern: "%{GREEDYDATA:msg}",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/grok", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleGrokPatterns(w, req)

	if w.Code != http.StatusConflict {
		t.Errorf("expected 409 for duplicate, got %d", w.Code)
	}

	patternMutex.Lock()
	currentPatterns = []types.GrokPatternDefinition{}
	patternMutex.Unlock()
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

	patternMutex.Lock()
	currentPatterns = []types.GrokPatternDefinition{
		{Name: "to-delete", Pattern: "%{GREEDYDATA:msg}"},
	}
	patternMutex.Unlock()

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/grok?name=to-delete", nil)
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

	patternMutex.Lock()
	if len(currentPatterns) != 0 {
		t.Errorf("expected 0 patterns after delete, got %d", len(currentPatterns))
	}
	currentPatterns = []types.GrokPatternDefinition{}
	patternMutex.Unlock()
}

func TestHandleGrokPatterns_DeleteNotFound(t *testing.T) {
	h, _ := setupHandler(t)

	patternMutex.Lock()
	currentPatterns = []types.GrokPatternDefinition{}
	patternMutex.Unlock()

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/grok?name=nonexistent", nil)
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

	// First request populates cache
	req := httptest.NewRequest(http.MethodGet, "/api/v1/info", nil)
	w := httptest.NewRecorder()
	h.HandleInfo(w, req)

	// Verify cache is valid
	h.infoCacheMutex.RLock()
	cached := h.cacheValid
	h.infoCacheMutex.RUnlock()
	if !cached {
		t.Error("expected cache to be valid after first request")
	}

	// Invalidate
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

	// Populate cache
	req := httptest.NewRequest(http.MethodGet, "/api/v1/info", nil)
	w := httptest.NewRecorder()
	h.HandleInfo(w, req)

	// Request with refresh=true
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

	// Ensure no patterns are loaded
	patternMutex.Lock()
	currentPatterns = []types.GrokPatternDefinition{}
	patternMutex.Unlock()

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

// ---------------------------------------------------------------------------
// Grok patterns file persistence
// ---------------------------------------------------------------------------

func TestGrokPatterns_FilePersistence(t *testing.T) {
	h, _ := setupHandler(t)
	dir := h.StoragePath

	// Reset state
	patternMutex.Lock()
	currentPatterns = []types.GrokPatternDefinition{}
	patternMutex.Unlock()

	// Create a pattern (triggers save)
	body, _ := json.Marshal(types.GrokPatternRequest{
		Name:    "persist-test",
		Pattern: "%{IP:client}",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/grok", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleGrokPatterns(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", w.Code)
	}

	// Verify file was created
	filePath := filepath.Join(dir, patternsFile)
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		t.Fatal("patterns file was not created")
	}

	// Cleanup
	patternMutex.Lock()
	currentPatterns = []types.GrokPatternDefinition{}
	patternMutex.Unlock()
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
