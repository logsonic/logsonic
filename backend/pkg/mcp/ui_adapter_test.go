package mcp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestEmbeddedUIAdapterAllowlistAndCancellation(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/ui/command" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		started <- struct{}{}
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer func() { close(release); srv.Close() }()
	a := NewUIAdapter(func() string { return srv.URL })
	found := false
	for _, schema := range a.Schemas() {
		name := schema["name"].(string)
		if name == "ui_get_state" {
			found = schema["input_schema"] != nil
		}
		if name == "ui_focus" || name == "delete_source" {
			t.Errorf("advertised %s", name)
		}
	}
	if !found {
		t.Fatal("MCP UI schema missing")
	}
	for _, name := range []string{"delete_source", "ui_focus", "ui_unknown"} {
		if _, err := a.Call(context.Background(), name, nil); err == nil {
			t.Errorf("accepted %s", name)
		}
	}
	filters := make([]any, 9)
	for i := range filters {
		filters[i] = map[string]any{"field": "level", "value": "ERROR"}
	}
	if _, err := a.Call(context.Background(), "ui_show_view", map[string]any{"filters": filters}); err == nil {
		t.Error("accepted unbounded ui_show_view")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := a.Call(ctx, "ui_get_state", nil); done <- err }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("UI command not sent")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Error("cancellation not propagated")
		}
	case <-time.After(time.Second):
		t.Fatal("UI call did not cancel")
	}
}
