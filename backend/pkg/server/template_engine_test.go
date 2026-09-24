package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"logsonic/pkg/storage"
	"logsonic/pkg/types"
)

func TestNewServerReleasesStorageWhenConfigInitializationFails(t *testing.T) {
	storagePath := t.TempDir()
	if err := os.WriteFile(filepath.Join(storagePath, "log2grok"), []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewServer(Config{Host: "localhost", Port: ":0", StoragePath: storagePath, StorageEngine: "template", Timeout: 30 * time.Second}); err == nil {
		t.Fatal("NewServer succeeded despite unusable log2grok path")
	}
	store, err := storage.NewStorageWithEngine(storagePath, "template")
	if err != nil {
		t.Fatalf("storage writer lock remained held after NewServer failure: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close recovered template storage: %v", err)
	}
}

func TestTemplateStorageServerIngestSearchDeleteAndReopen(t *testing.T) {
	storagePath := t.TempDir()
	request := func(srv *Server, method, path string, body, out any) int {
		t.Helper()
		var payload []byte
		if body != nil {
			var err error
			payload, err = json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(payload))
		req.Host = "localhost"
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		if out != nil {
			if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
				t.Fatalf("decode %s response: %v (%s)", path, err, rec.Body.String())
			}
		}
		return rec.Code
	}
	query := func(srv *Server) types.LogResponse {
		t.Helper()
		params := url.Values{
			"_src": {"template.log"}, "limit": {"10"},
			"start_date": {"2026-03-01T00:00:00Z"}, "end_date": {"2026-03-02T00:00:00Z"},
		}
		var out types.LogResponse
		if code := request(srv, http.MethodGet, "/api/v1/logs?"+params.Encode(), nil, &out); code != http.StatusOK {
			t.Fatalf("search status %d", code)
		}
		return out
	}
	open := func() *Server {
		t.Helper()
		srv, err := NewServer(Config{Host: "localhost", Port: ":0", StoragePath: storagePath, StorageEngine: "template", Timeout: 30 * time.Second})
		if err != nil {
			t.Fatalf("NewServer: %v", err)
		}
		return srv
	}
	srv := open()
	closed := false
	closeFirst := func() {
		if closed {
			return
		}
		closed = true
		if err := srv.Close(); err != nil {
			t.Errorf("close first server: %v", err)
		}
	}
	t.Cleanup(closeFirst)
	var started types.IngestResponse
	if code := request(srv, http.MethodPost, "/api/v1/ingest/start", map[string]any{
		"name": "TIMED", "pattern": "%{TIMESTAMP_ISO8601:timestamp} %{WORD:level} %{WORD:service} %{GREEDYDATA:message}",
		"source": "template.log", "meta": map[string]string{"_src": "template.log"},
	}, &started); code != http.StatusOK || started.SessionID == "" {
		t.Fatalf("start ingest: status=%d response=%+v", code, started)
	}
	line := "2026-03-01T10:00:00Z INFO api template-storage-proof"
	if code := request(srv, http.MethodPost, "/api/v1/ingest/logs", map[string]any{"session_id": started.SessionID, "logs": []string{line}}, nil); code != http.StatusOK {
		t.Fatalf("ingest chunk status = %d", code)
	}
	if code := request(srv, http.MethodPost, "/api/v1/ingest/end", map[string]any{"session_id": started.SessionID}, nil); code != http.StatusOK {
		t.Fatalf("end ingest status = %d", code)
	}
	if got := query(srv).TotalCount; got != 1 {
		t.Fatalf("search total before reopen = %d, want 1", got)
	}
	var source types.SourceEntry
	if code := request(srv, http.MethodGet, "/api/v1/sources/template.log", nil, &source); code != http.StatusOK || source.Rows != 1 {
		t.Fatalf("source stats before reopen: status=%d source=%+v", code, source)
	}
	closeFirst()

	// A fresh server must reopen the same engine-specific data and preserve both
	// the query result and the source catalog's rebuilt row count.
	srv2 := open()
	closed2 := false
	t.Cleanup(func() {
		if !closed2 {
			if err := srv2.Close(); err != nil {
				t.Errorf("close reopened server: %v", err)
			}
		}
	})
	if got := query(srv2).TotalCount; got != 1 {
		t.Fatalf("search total after reopen = %d, want 1", got)
	}
	if code := request(srv2, http.MethodGet, "/api/v1/sources/template.log", nil, &source); code != http.StatusOK || source.Rows != 1 {
		t.Fatalf("source stats after reopen: status=%d source=%+v", code, source)
	}
	if code := request(srv2, http.MethodDelete, "/api/v1/sources/template.log", nil, nil); code != http.StatusOK {
		t.Fatalf("delete source status = %d", code)
	}
	if got := query(srv2).TotalCount; got != 0 {
		t.Fatalf("search total after delete = %d, want 0", got)
	}
	closed2 = true
	if err := srv2.Close(); err != nil {
		t.Fatalf("close reopened server: %v", err)
	}
}
