package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

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

	sub := h.StreamBus.Subscribe(500)
	defer h.StreamBus.Unsubscribe(sub)

	// Send connected status.
	if err := writeJSON(conn, wsServerMsg{Type: "status", State: "connected"}); err != nil {
		return
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

func writeJSON(conn *websocket.Conn, v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.TextMessage, data)
}
