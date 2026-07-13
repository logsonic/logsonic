package mcp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestClientUsesDynamicBaseURLProvider(t *testing.T) {
	var firstHits atomic.Int32
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		firstHits.Add(1)
		http.Error(w, "old server", http.StatusTeapot)
	}))
	defer first.Close()

	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/ping" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}))
	defer second.Close()

	var baseURL atomic.Value
	baseURL.Store(first.URL)
	c := newClientWithBaseURLProvider(func() string {
		return baseURL.Load().(string)
	})

	baseURL.Store(second.URL)
	data, err := c.get("/ping", nil)
	if err != nil {
		t.Fatalf("get failed: %v", err)
	}
	if string(data) != `{"status":"ok"}`+"\n" {
		t.Fatalf("unexpected response: %s", data)
	}
	if firstHits.Load() != 0 {
		t.Fatalf("expected old server to receive 0 calls, got %d", firstHits.Load())
	}
}

func TestBuildWorkspaceURL(t *testing.T) {
	u := buildWorkspaceURL("http://localhost:8080", map[string]any{
		"query": "+status:>=500",
		"time": map[string]any{
			"mode":  "absolute",
			"start": "2026-01-01T00:00:00Z",
			"end":   "2026-01-02T00:00:00Z",
		},
	})
	if !strings.HasPrefix(u, "http://localhost:8080/?#") {
		t.Fatalf("unexpected base URL: %s", u)
	}
	if !strings.Contains(u, "q=%2Bstatus%3A%3E%3D500") {
		t.Fatalf("query not encoded in URL: %s", u)
	}
	if !strings.Contains(u, "since=1767225600000") || !strings.Contains(u, "to=1767312000000") {
		t.Fatalf("absolute time not encoded in URL: %s", u)
	}

	relative := buildWorkspaceURL("http://localhost:8080", map[string]any{
		"query": "error",
		"time": map[string]any{
			"mode":     "relative",
			"relative": "last-7-days",
		},
	})
	if !strings.Contains(relative, "isRelative=true") || !strings.Contains(relative, "relative=last-7-days") {
		t.Fatalf("relative time not encoded in URL: %s", relative)
	}
}
