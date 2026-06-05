package server

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/types"
)

func TestLiveEventsRouteStreamsHello(t *testing.T) {
	srv, err := NewServer(Config{
		Host:        "localhost",
		Port:        ":0",
		StoragePath: t.TempDir(),
		Timeout:     time.Nanosecond,
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	t.Cleanup(func() { _ = srv.services.CloseStorage() })

	httpServer := httptest.NewServer(srv.router)
	defer httpServer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, httpServer.URL+"/api/v1/live/events", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET live events: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("expected text/event-stream, got %q", ct)
	}

	reader := bufio.NewReader(resp.Body)
	eventLine, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read event line: %v", err)
	}
	if strings.TrimSpace(eventLine) != "event: hello" {
		t.Fatalf("expected hello event, got %q", strings.TrimSpace(eventLine))
	}
	dataLine, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read data line: %v", err)
	}
	dataLine = strings.TrimPrefix(strings.TrimSpace(dataLine), "data: ")
	var hello types.LiveHelloEvent
	if err := json.Unmarshal([]byte(dataLine), &hello); err != nil {
		t.Fatalf("decode hello: %v", err)
	}
	if hello.SubscriberID == "" {
		t.Fatal("expected subscriber id")
	}
}

// TestLiveEventsStreamUnblocksOnShutdown proves the held-open SSE handler
// returns when the live manager begins draining, instead of blocking the HTTP
// graceful-shutdown timeout. http.Server.Shutdown does not cancel in-flight
// request contexts, so without the manager Done signal this connection would
// stay open until the drain deadline.
func TestLiveEventsStreamUnblocksOnShutdown(t *testing.T) {
	srv, err := NewServer(Config{
		Host:        "localhost",
		Port:        ":0",
		StoragePath: t.TempDir(),
		Timeout:     time.Minute,
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	t.Cleanup(func() { _ = srv.services.CloseStorage() })

	// Wire the live manager to a cancellable context the way Server.Start does.
	managerCtx, cancelManager := context.WithCancel(context.Background())
	srv.services.StartLive(managerCtx)

	httpServer := httptest.NewServer(srv.router)
	defer httpServer.Close()

	req, err := http.NewRequest(http.MethodGet, httpServer.URL+"/api/v1/live/events", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET live events: %v", err)
	}
	defer resp.Body.Close()

	// Drain the body in the background; it returns EOF once the handler exits.
	done := make(chan error, 1)
	go func() {
		_, err := io.Copy(io.Discard, resp.Body)
		done <- err
	}()

	// Trigger manager shutdown — the SSE handler should unblock promptly.
	cancelManager()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("SSE handler did not return after manager shutdown")
	}
}
