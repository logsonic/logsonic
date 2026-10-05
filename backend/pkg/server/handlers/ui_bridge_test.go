package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"logsonic/pkg/types"
)

func postUICommand(t *testing.T, h *Services, body string) (*httptest.ResponseRecorder, types.UICommandResponse) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ui/command", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.HandleUICommand(rec, req)
	var resp types.UICommandResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response %q: %v", rec.Body.String(), err)
	}
	return rec, resp
}

func TestUICommandRejectsUnknownType(t *testing.T) {
	h, _ := setupHandler(t)
	rec, resp := postUICommand(t, h, `{"type":"explode"}`)
	if rec.Code != http.StatusBadRequest || resp.Status != "error" {
		t.Fatalf("got %d %+v, want 400 error", rec.Code, resp)
	}
}

func TestUICommandNoUIConnected(t *testing.T) {
	h, _ := setupHandler(t)
	// A non-bridge subscriber (e.g. the ingest progress listener) must not
	// count as a connected UI.
	other := h.Live.Subscribe("__ingest_jobs_only__")
	defer h.Live.Unsubscribe(other.id)

	start := time.Now()
	rec, resp := postUICommand(t, h, `{"type":"get_state"}`)
	if rec.Code != http.StatusConflict || resp.Status != "no_ui_connected" {
		t.Fatalf("got %d %+v, want 409 no_ui_connected", rec.Code, resp)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("no-UI path should not wait for an ack")
	}
}

func TestUICommandAckRoundTrip(t *testing.T) {
	h, _ := setupHandler(t)
	sub := h.Live.Subscribe(types.UIBridgeSourceFilter)
	defer h.Live.Unsubscribe(sub.id)

	// Play the UI: read the broadcast, then ack it.
	go func() {
		ev := <-sub.ch
		cmd := ev.data.(types.UICommandEvent)
		if ev.name != "ui_command" || cmd.Type != "set_columns" || string(cmd.Args) != `{"columns":["level"]}` {
			t.Errorf("unexpected event %s %+v", ev.name, cmd)
		}
		ack, _ := json.Marshal(types.UIAckRequest{ID: cmd.ID, OK: true, Warnings: []string{"w"}, State: json.RawMessage(`{"route":"/"}`)})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/ui/ack", bytes.NewReader(ack))
		rec := httptest.NewRecorder()
		h.HandleUIAck(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Errorf("ack status %d", rec.Code)
		}
	}()

	rec, resp := postUICommand(t, h, `{"type":"set_columns","args":{"columns":["level"]}}`)
	if rec.Code != http.StatusOK || resp.Status != "applied" {
		t.Fatalf("got %d %+v, want 200 applied", rec.Code, resp)
	}
	if string(resp.State) != `{"route":"/"}` || len(resp.Warnings) != 1 {
		t.Fatalf("state/warnings not passed through: %+v", resp)
	}
}

func TestUICommandUIError(t *testing.T) {
	h, _ := setupHandler(t)
	sub := h.Live.Subscribe(types.UIBridgeSourceFilter)
	defer h.Live.Unsubscribe(sub.id)
	go func() {
		ev := <-sub.ch
		cmd := ev.data.(types.UICommandEvent)
		h.bridge().deliver(types.UIAckRequest{ID: cmd.ID, OK: false, Error: "unknown column"})
	}()
	rec, resp := postUICommand(t, h, `{"type":"set_columns"}`)
	if rec.Code != http.StatusUnprocessableEntity || resp.Error != "unknown column" {
		t.Fatalf("got %d %+v", rec.Code, resp)
	}
}

func TestUICommandTimeout(t *testing.T) {
	h, _ := setupHandler(t)
	sub := h.Live.Subscribe(types.UIBridgeSourceFilter)
	defer h.Live.Unsubscribe(sub.id)
	rec, resp := postUICommand(t, h, `{"type":"get_state","timeout_ms":50}`)
	if rec.Code != http.StatusGatewayTimeout || resp.Status != "timeout" {
		t.Fatalf("got %d %+v, want 504 timeout", rec.Code, resp)
	}
	// The late ack finds nothing pending.
	ack := `{"id":"` + resp.ID + `","ok":true}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ui/ack", bytes.NewBufferString(ack))
	ackRec := httptest.NewRecorder()
	h.HandleUIAck(ackRec, req)
	if ackRec.Code != http.StatusNotFound {
		t.Fatalf("late ack status %d, want 404", ackRec.Code)
	}
}
