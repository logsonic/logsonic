package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type bridgeCommand struct {
	ID   string         `json:"id"`
	Type string         `json:"type"`
	Args map[string]any `json:"args"`
}

// connectTestBridge plays the web UI's agent bridge: it acks every UI
// command with a non-empty result and records the commands in order.
func connectTestBridge(t *testing.T, ts *httptest.Server) func() []bridgeCommand {
	t.Helper()
	events, err := http.Get(ts.URL + "/api/v1/live/events?source_id=__ui_bridge__")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { events.Body.Close() })
	reader := bufio.NewReader(events.Body)
	if line, err := reader.ReadString('\n'); err != nil || !strings.Contains(line, "hello") {
		t.Fatalf("SSE hello: %q %v", line, err)
	}
	var mu sync.Mutex
	var seen []bridgeCommand
	go func() {
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				return
			}
			var cmd bridgeCommand
			if !strings.HasPrefix(line, "data: ") || json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data: "))), &cmd) != nil || cmd.Type == "" {
				continue
			}
			mu.Lock()
			seen = append(seen, cmd)
			mu.Unlock()
			ack, _ := json.Marshal(map[string]any{"id": cmd.ID, "ok": true, "state": map[string]any{"route": "/agent", "result_count": 1}})
			if resp, err := http.Post(ts.URL+"/api/v1/ui/ack", "application/json", bytes.NewReader(ack)); err == nil {
				resp.Body.Close()
			}
		}
	}()
	return func() []bridgeCommand {
		mu.Lock()
		defer mu.Unlock()
		return append([]bridgeCommand(nil), seen...)
	}
}

// After an agent turn that imported old logs and queried them without a
// window, the tools search the data's own span, and the log view is set to
// the imported source and that span even though the model never called
// ui_show_view.
func TestAgentTurnEndsWithViewOfEvidence(t *testing.T) {
	clearAgentTestEnv(t)
	path := filepath.Join(t.TempDir(), "old.log")
	if err := os.WriteFile(path, []byte("2005-06-03T10:00:00Z ERROR disk failed\n2005-06-04T11:00:00Z INFO recovered\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var turns atomic.Int32
	var queryInput map[string]any
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Stream   bool `json:"stream"`
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		switch turns.Add(1) {
		case 1:
			writeAgentProxyTestReply(w, body.Stream, "tool_use", []any{map[string]any{"type": "tool_use", "id": "one", "name": "ingest_local", "input": map[string]any{"path": path}}})
		case 2:
			writeAgentProxyTestReply(w, body.Stream, "tool_use", []any{map[string]any{"type": "tool_use", "id": "two", "name": "query_logs", "input": map[string]any{"query": "failed", "source": "old.log"}}})
		default:
			// The model's own tool_use input is replayed unchanged.
			if assistant := string(body.Messages[3].Content); strings.Contains(assistant, "start_time") {
				t.Errorf("replayed tool input was rewritten: %s", assistant)
			}
			if result := string(body.Messages[4].Content); !strings.Contains(result, "disk failed") {
				t.Errorf("query without a window missed the 2005 rows: %s", result)
			}
			writeAgentProxyTestReply(w, body.Stream, "end_turn", []any{map[string]any{"type": "text", "text": "The disk failed on 3 June 2005."}})
		}
	}))
	defer proxy.Close()
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", proxy.URL+"/v1/messages")
	srv, err := NewServer(Config{Host: "localhost", Port: ":0", StoragePath: t.TempDir(), Timeout: 30 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.services.CloseStorage() })
	ts := httptest.NewServer(srv.Handler())
	// Cleanups run last-first, so the bridge's SSE stream closes before the
	// server waits for its connections.
	t.Cleanup(ts.Close)
	srv.mcpBaseURL.Store(ts.URL)
	commands := connectTestBridge(t, ts)

	result := postApprovedAgentChat(t, ts.URL, `{"messages":[{"role":"user","content":"Import old.log and find problems"}],"stream":true}`)
	var out struct {
		Answer string `json:"answer"`
		Steps  []struct {
			ID      string         `json:"id"`
			Tool    string         `json:"tool"`
			Input   map[string]any `json:"input"`
			IsError bool           `json:"is_error"`
		} `json:"steps"`
		Error string `json:"error"`
	}
	json.Unmarshal(result, &out)
	if len(out.Steps) != 3 {
		t.Fatalf("out=%+v", out)
	}
	queryInput = out.Steps[1].Input
	if !strings.HasPrefix(toString(queryInput["start_time"]), "2005-06-03") || !strings.HasPrefix(toString(queryInput["end_time"]), "2005-06-04") {
		t.Errorf("query_logs window not filled from the data: %v", queryInput)
	}
	view := out.Steps[2]
	if !strings.HasPrefix(view.ID, "view-auto-") || view.Tool != "ui_show_view" || view.IsError {
		t.Fatalf("auto view step: %+v", view)
	}

	byType := map[string]bridgeCommand{}
	var order []string
	for _, c := range commands() {
		byType[c.Type] = c
		order = append(order, c.Type)
	}
	if got := strings.Join(order, ","); got != "set_query,set_time,set_sources,run_search" {
		t.Fatalf("UI commands: %s", got)
	}
	if q := byType["set_query"].Args["query"]; q != "failed" {
		t.Errorf("query = %v", q)
	}
	if s := byType["set_sources"].Args["sources"]; toString(s) != "[old.log]" {
		t.Errorf("sources = %v", s)
	}
	tm := byType["set_time"].Args
	if !strings.HasPrefix(toString(tm["start"]), "2005-06-03T10:00:00") || !strings.HasPrefix(toString(tm["end"]), "2005-06-04T11:00:01") {
		t.Errorf("time = %v", tm)
	}
}

func toString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []any:
		parts := make([]string, len(x))
		for i, p := range x {
			parts[i] = toString(p)
		}
		return "[" + strings.Join(parts, " ") + "]"
	}
	b, _ := json.Marshal(v)
	return string(b)
}
