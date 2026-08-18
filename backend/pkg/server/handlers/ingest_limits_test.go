package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/types"
)

func addTestIngestSession(t *testing.T, id string, lastActivity time.Time) {
	t.Helper()
	sessionMapMutex.Lock()
	sessionMap[id] = IngestSession{
		CreationTime: lastActivity,
		LastActivity: lastActivity,
	}
	sessionMapMutex.Unlock()
	t.Cleanup(func() {
		sessionMapMutex.Lock()
		delete(sessionMap, id)
		sessionMapMutex.Unlock()
	})
}

func TestHandleIngest_RejectsTooManyLines(t *testing.T) {
	h, store := setupHandler(t)
	addTestIngestSession(t, "line-limit", time.Now())

	logs := make([]string, MaxIngestLines+1)
	for i := range logs {
		logs[i] = "line"
	}
	body, err := json.Marshal(types.IngestRequest{SessionID: "line-limit", Logs: logs})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/ingest/logs", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleIngest(w, req)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d: %s", w.Code, w.Body.String())
	}
	if len(store.logs) != 0 {
		t.Fatalf("limit rejection should not store logs, got %d", len(store.logs))
	}
	var response types.ErrorResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Code != "INGEST_LIMIT_EXCEEDED" {
		t.Fatalf("expected INGEST_LIMIT_EXCEEDED, got %q", response.Code)
	}
}

func TestHandleIngest_RejectsOversizedLine(t *testing.T) {
	h, store := setupHandler(t)
	addTestIngestSession(t, "line-size-limit", time.Now())

	body, err := json.Marshal(types.IngestRequest{
		SessionID: "line-size-limit",
		Logs:      []string{strings.Repeat("x", MaxIngestLineBytes+1)},
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/ingest/logs", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleIngest(w, req)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d: %s", w.Code, w.Body.String())
	}
	if len(store.logs) != 0 {
		t.Fatalf("limit rejection should not store logs, got %d", len(store.logs))
	}
}

func TestHandleIngest_RejectsOversizedRequestBody(t *testing.T) {
	h, _ := setupHandler(t)
	addTestIngestSession(t, "body-size-limit", time.Now())

	// The large JSON string exceeds MaxIngestRequestBytes before the decoder
	// can materialize an IngestRequest.
	body := []byte(`{"session_id":"body-size-limit","logs":["`)
	body = append(body, strings.Repeat("x", MaxIngestRequestBytes)...)
	body = append(body, []byte(`"]}`)...)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/ingest/logs", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleIngest(w, req)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d: %s", w.Code, w.Body.String())
	}
	var response types.ErrorResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Code != "INGEST_BODY_TOO_LARGE" {
		t.Fatalf("expected INGEST_BODY_TOO_LARGE, got %q", response.Code)
	}
}

func TestExpireStaleSessions_UsesLastActivity(t *testing.T) {
	h, _ := setupHandler(t)
	id := "active-session"
	creation := time.Now().Add(-SessionTimeout - time.Minute)
	addTestIngestSession(t, id, creation)

	sessionMapMutex.Lock()
	session := sessionMap[id]
	session.LastActivity = time.Now()
	sessionMap[id] = session
	sessionMapMutex.Unlock()

	expireStaleSessions(time.Now(), h)

	sessionMapMutex.RLock()
	_, exists := sessionMap[id]
	sessionMapMutex.RUnlock()
	if !exists {
		t.Fatal("active session was expired based on creation time")
	}

	sessionMapMutex.Lock()
	session = sessionMap[id]
	session.LastActivity = time.Now().Add(-SessionTimeout - time.Minute)
	sessionMap[id] = session
	sessionMapMutex.Unlock()
	expireStaleSessions(time.Now(), h)

	sessionMapMutex.RLock()
	_, exists = sessionMap[id]
	sessionMapMutex.RUnlock()
	if exists {
		t.Fatal("inactive session was not expired")
	}
}
