package handlers

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"

	"logsonic/pkg/types"
)

const (
	uiCommandDefaultTimeout = 5 * time.Second
	// uiCommandMaxTimeout stays well under the MCP client's 30s HTTP
	// timeout and the API group's request timeout.
	uiCommandMaxTimeout = 15 * time.Second
	uiAckMaxBytes       = 1 << 20
)

// UICommandTypes lists every command the web UI's agent bridge applies.
// The server rejects anything else up front so a typo fails fast instead
// of waiting out the ack timeout.
var UICommandTypes = map[string]bool{
	"get_state":         true,
	"navigate":          true,
	"set_query":         true,
	"set_time":          true,
	"set_sources":       true,
	"set_columns":       true,
	"show_columns":      true,
	"hide_columns":      true,
	"add_filter":        true,
	"remove_filter":     true,
	"clear_filters":     true,
	"set_sort":          true,
	"set_page":          true,
	"set_fields_panel":  true,
	"open_workspace":    true,
	"run_search":        true,
	"set_column_widths": true,
}

// uiBridge pairs each broadcast ui_command with the UI's POST /ui/ack.
type uiBridge struct {
	mu      sync.Mutex
	pending map[string]chan types.UIAckRequest
}

func newUIBridge() *uiBridge {
	return &uiBridge{pending: make(map[string]chan types.UIAckRequest)}
}

func (b *uiBridge) register(id string) chan types.UIAckRequest {
	ch := make(chan types.UIAckRequest, 1)
	b.mu.Lock()
	b.pending[id] = ch
	b.mu.Unlock()
	return ch
}

func (b *uiBridge) forget(id string) {
	b.mu.Lock()
	delete(b.pending, id)
	b.mu.Unlock()
}

// deliver hands an ack to its waiting command. Only the first ack wins
// (several UI tabs may all answer); later ones are reported as unknown.
func (b *uiBridge) deliver(ack types.UIAckRequest) bool {
	b.mu.Lock()
	ch, ok := b.pending[ack.ID]
	if ok {
		delete(b.pending, ack.ID)
	}
	b.mu.Unlock()
	if ok {
		ch <- ack
	}
	return ok
}

// countSubscribers returns how many /live/events subscribers use
// sourceFilter.
func (m *TailManager) countSubscribers(sourceFilter string) int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	n := 0
	for _, sub := range m.subscribers {
		if sub.sourceFilter == sourceFilter {
			n++
		}
	}
	return n
}

func writeUICommandResponse(w http.ResponseWriter, code int, resp types.UICommandResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(resp)
}

// @Summary Send a command to the connected web UI
// @Description Broadcasts a "ui_command" event on /live/events to the web UI's agent bridge and waits for its acknowledgement, which carries the UI state after the command. Lets an agent drive what the user sees: columns, filters, query, time range, sort, page, route. Returns 409 no_ui_connected when no UI is open, 504 timeout when no UI answered in time, 422 error when the UI rejected the command.
// @Tags ui
// @Accept json
// @Produce json
// @Param request body types.UICommandRequest true "Command type and arguments"
// @Success 200 {object} types.UICommandResponse
// @Failure 400 {object} types.UICommandResponse
// @Failure 409 {object} types.UICommandResponse
// @Failure 422 {object} types.UICommandResponse
// @Failure 504 {object} types.UICommandResponse
// @Router /ui/command [post]
func (h *Services) HandleUICommand(w http.ResponseWriter, r *http.Request) {
	var req types.UICommandRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, uiAckMaxBytes)).Decode(&req); err != nil {
		writeUICommandResponse(w, http.StatusBadRequest, types.UICommandResponse{Status: "error", Error: "invalid JSON body: " + err.Error()})
		return
	}
	if !UICommandTypes[req.Type] {
		writeUICommandResponse(w, http.StatusBadRequest, types.UICommandResponse{Status: "error", Type: req.Type, Error: "unknown ui command type"})
		return
	}
	if h.Live == nil || h.Live.countSubscribers(types.UIBridgeSourceFilter) == 0 {
		writeUICommandResponse(w, http.StatusConflict, types.UICommandResponse{
			Status: "no_ui_connected",
			Type:   req.Type,
			Error:  "no LogSonic web UI is connected; open the UI (ui_focus or a browser at the server URL) and retry",
		})
		return
	}

	timeout := uiCommandDefaultTimeout
	if req.TimeoutMS > 0 {
		timeout = time.Duration(req.TimeoutMS) * time.Millisecond
	}
	if timeout > uiCommandMaxTimeout {
		timeout = uiCommandMaxTimeout
	}

	id := uuid.New().String()
	ch := h.bridge().register(id)
	defer h.bridge().forget(id)
	h.Live.publishBroadcast("ui_command", types.UICommandEvent{ID: id, Type: req.Type, Args: req.Args})

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case ack := <-ch:
		resp := types.UICommandResponse{ID: id, Type: req.Type, Warnings: ack.Warnings, State: ack.State}
		if !ack.OK {
			resp.Status = "error"
			resp.Error = ack.Error
			writeUICommandResponse(w, http.StatusUnprocessableEntity, resp)
			return
		}
		resp.Status = "applied"
		writeUICommandResponse(w, http.StatusOK, resp)
	case <-timer.C:
		writeUICommandResponse(w, http.StatusGatewayTimeout, types.UICommandResponse{
			Status: "timeout", ID: id, Type: req.Type,
			Error: "the web UI did not acknowledge the command in time",
		})
	case <-r.Context().Done():
	}
}

// @Summary Acknowledge a UI command
// @Description Called by the web UI's agent bridge after it applied (or rejected) a ui_command.
// @Tags ui
// @Accept json
// @Produce json
// @Param request body types.UIAckRequest true "Command id, result and state snapshot"
// @Success 204
// @Failure 404 {object} types.ErrorResponse
// @Router /ui/ack [post]
func (h *Services) HandleUIAck(w http.ResponseWriter, r *http.Request) {
	var ack types.UIAckRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, uiAckMaxBytes)).Decode(&ack); err != nil || ack.ID == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "invalid ack body"})
		return
	}
	if !h.bridge().deliver(ack) {
		// Late (after timeout) or a second tab answering: not an error for
		// the UI, nothing waits for it any more.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "no pending command with this id"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Services) bridge() *uiBridge {
	h.uiBridgeOnce.Do(func() { h.uiBridgeState = newUIBridge() })
	return h.uiBridgeState
}
