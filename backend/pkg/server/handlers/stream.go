package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"logsonic/pkg/stream"

	"github.com/gorilla/websocket"
)

var wsUpgrader = websocket.Upgrader{
	HandshakeTimeout: 10 * time.Second,
	// Restrict to localhost origins only (same policy as CORS middleware).
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		return origin == "" ||
			strings.HasPrefix(origin, "http://localhost") ||
			strings.HasPrefix(origin, "http://127.0.0.1")
	},
}

type wsClientMsg struct {
	Type string `json:"type"` // "pause" | "resume"
}

type wsServerMsg struct {
	Type  string                 `json:"type"`  // "log" | "status" | "error"
	Entry map[string]interface{} `json:"entry,omitempty"`
	State string                 `json:"state,omitempty"`
	Msg   string                 `json:"message,omitempty"`
}

// HandleStreamWS upgrades the connection to WebSocket and streams log events from the bus.
// @Summary WebSocket stream endpoint
// @Description Upgrade to WebSocket and receive live log events from the stream bus
// @Tags stream
// @Router /stream/ws [get]
func (h *Services) HandleStreamWS(w http.ResponseWriter, r *http.Request) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("stream/ws: upgrade error: %v", err)
		return
	}
	defer conn.Close()

	sub, replay := h.StreamBus.Subscribe(512)
	defer h.StreamBus.Unsubscribe(sub)

	// Send connected status.
	if err := writeJSON(conn, wsServerMsg{Type: "status", State: "connected"}); err != nil {
		return
	}

	// Replay buffered events (oldest-first).
	for _, ev := range replay {
		if err := writeJSON(conn, wsServerMsg{Type: "log", Entry: ev.Fields}); err != nil {
			return
		}
	}

	paused := false

	// Read control messages from client in background.
	ctrlCh := make(chan wsClientMsg, 8)
	go func() {
		defer close(ctrlCh)
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var cm wsClientMsg
			if err := json.Unmarshal(msg, &cm); err == nil {
				ctrlCh <- cm
			}
		}
	}()

	for {
		select {
		case cm, ok := <-ctrlCh:
			if !ok {
				return
			}
			switch cm.Type {
			case "pause":
				paused = true
				_ = writeJSON(conn, wsServerMsg{Type: "status", State: "paused"})
			case "resume":
				paused = false
				_ = writeJSON(conn, wsServerMsg{Type: "status", State: "resumed"})
			}
		case ev, ok := <-sub.Ch:
			if !ok {
				return
			}
			if paused {
				continue
			}
			if err := writeJSON(conn, wsServerMsg{Type: "log", Entry: ev.Fields}); err != nil {
				return
			}
		}
	}
}

// StartTestEventGenerator publishes synthetic log entries every 2 seconds until ctx is cancelled.
// Use with --dev-events flag for manual testing of the stream pipeline.
func (h *Services) StartTestEventGenerator(ctx context.Context) {
	levels := []string{"info", "warn", "error", "debug"}
	messages := []string{
		"user login successful",
		"request processed in 42ms",
		"cache miss for key user:session",
		"connection pool at 80% capacity",
		"scheduled job completed",
		"health check passed",
		"config reloaded",
		"new deployment started",
	}
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		i := 0
		for {
			select {
			case <-ctx.Done():
				return
			case t := <-ticker.C:
				h.StreamBus.Publish(&stream.Event{
					Fields: map[string]interface{}{
						"timestamp": t.UTC().Format(time.RFC3339),
						"message":   fmt.Sprintf("[dev] %s #%d", messages[i%len(messages)], i+1),
						"level":     levels[i%len(levels)],
						"_src":      "dev-events",
					},
				})
				i++
			}
		}
	}()
}


func writeJSON(conn *websocket.Conn, v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.TextMessage, data)
}
