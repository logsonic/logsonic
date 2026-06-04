package server

import (
	"bufio"
	"context"
	"encoding/json"
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
