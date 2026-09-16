package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"

	"logsonic/pkg/types"
)

// A saved pattern's name alone must work for POST /ingest/start and for a
// live source: the decoder needs the Grok body, which only the library has.
func TestSavedPatternNameAloneResolves(t *testing.T) {
	h, _ := setupHandler(t)
	lib := l2g.ListLibrary()
	if len(lib) == 0 {
		t.Skip("no library patterns loaded")
	}
	name := lib[0].Name

	body, _ := json.Marshal(types.IngestSessionOptions{Name: name, Source: "x"})
	w := httptest.NewRecorder()
	h.HandleIngestStart(w, httptest.NewRequest(http.MethodPost, "/api/v1/ingest/start", bytes.NewReader(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("name-only ingest/start: %d %s", w.Code, w.Body.String())
	}
	var resp types.IngestResponse
	_ = json.NewDecoder(w.Body).Decode(&resp)
	sessionMapMutex.RLock()
	s := sessionMap[resp.SessionID]
	sessionMapMutex.RUnlock()
	if s.Options.Pattern == "" || s.Decoder == nil {
		t.Fatalf("session must carry the resolved Grok body: %+v", s.Options)
	}
	sessionMapMutex.Lock()
	delete(sessionMap, resp.SessionID)
	sessionMapMutex.Unlock()

	body, _ = json.Marshal(types.IngestSessionOptions{Name: "no-such-pattern-xyz", Source: "x"})
	w = httptest.NewRecorder()
	h.HandleIngestStart(w, httptest.NewRequest(http.MethodPost, "/api/v1/ingest/start", bytes.NewReader(body)))
	var errResp types.ErrorResponse
	_ = json.NewDecoder(w.Body).Decode(&errResp)
	if w.Code != http.StatusBadRequest || errResp.Code != "PATTERN_NOT_FOUND" {
		t.Fatalf("unknown name: %d %+v", w.Code, errResp)
	}

	// Live source: same resolution.
	if _, err := h.Live.newSource(types.IngestSessionOptions{Name: name, Source: "x"}); err != nil {
		t.Fatalf("newSource with a saved name: %v", err)
	}
	if _, err := h.Live.newSource(types.IngestSessionOptions{Name: "no-such-pattern-xyz"}); err == nil {
		t.Fatal("unknown name must fail newSource")
	}
}
