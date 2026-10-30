package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAgentIngestAndQueryViaProxyTools(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.log")
	if err := os.WriteFile(path, []byte("2026-10-28T10:00:00Z ERROR checkout failed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var turns atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(200)
			return
		}
		if r.URL.Path != "/v1/messages" {
			t.Errorf("path %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		if r.Header.Get("anthropic-version") == "" {
			t.Error("missing Anthropic version")
		}
		var body struct {
			Messages []json.RawMessage `json:"messages"`
			Tools    []json.RawMessage `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if len(body.Tools) < 3 {
			t.Errorf("tools: %d", len(body.Tools))
		}
		w.Header().Set("Content-Type", "application/json")
		switch turns.Add(1) {
		case 1:
			json.NewEncoder(w).Encode(map[string]any{"stop_reason": "tool_use", "content": []any{map[string]any{"type": "tool_use", "id": "one", "name": "ingest_local", "input": map[string]any{"path": path}}}})
		case 2:
			if len(body.Messages) < 3 {
				t.Error("tool result missing from messages")
			}
			json.NewEncoder(w).Encode(map[string]any{"stop_reason": "tool_use", "content": []any{map[string]any{"type": "tool_use", "id": "two", "name": "query_logs", "input": map[string]any{"query": "checkout", "limit": 10}}}})
		default:
			json.NewEncoder(w).Encode(map[string]any{"stop_reason": "end_turn", "content": []any{map[string]any{"type": "text", "text": "Found the checkout failure."}}})
		}
	}))
	defer proxy.Close()
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", proxy.URL+"/v1/messages")
	t.Setenv("LOGSONIC_AGENT_PROXY_KEY", "test-key")
	srv, err := NewServer(Config{Host: "localhost", Port: ":0", StoragePath: t.TempDir(), Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.services.CloseStorage()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	body, _ := json.Marshal(map[string]any{"messages": []any{map[string]string{"role": "user", "content": "Import and find checkout errors"}}})
	resp, err := http.Post(ts.URL+"/api/v1/agent/chat", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Answer string `json:"answer"`
		Steps  []struct {
			Tool   string          `json:"tool"`
			Output json.RawMessage `json:"output"`
		} `json:"steps"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || out.Answer == "" || len(out.Steps) != 2 {
		t.Fatalf("status=%d response=%+v", resp.StatusCode, out)
	}
	if out.Steps[0].Tool != "ingest_local" || out.Steps[1].Tool != "query_logs" || !bytes.Contains(out.Steps[1].Output, []byte("checkout failed")) {
		t.Fatalf("steps=%+v", out.Steps)
	}
}

func TestAgentRoutesRejectRemoteAndForeignOrigin(t *testing.T) {
	for _, tc := range []struct{ addr, origin string }{
		{"192.0.2.8:1234", ""},
		{"127.0.0.1:1234", "https://attacker.example"},
	} {
		req := httptest.NewRequest(http.MethodGet, "http://localhost/api/v1/agent/status", nil)
		req.RemoteAddr = tc.addr
		if tc.origin != "" {
			req.Header.Set("Origin", tc.origin)
		}
		w := httptest.NewRecorder()
		agentLoopbackOnly(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })).ServeHTTP(w, req)
		if w.Code != http.StatusForbidden {
			t.Fatalf("%+v: status %d", tc, w.Code)
		}
	}
}

func TestAgentPreservesEmptyToolInputForProxy(t *testing.T) {
	var calls atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(200)
			return
		}
		var body struct {
			Messages []struct {
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		if calls.Add(1) == 1 {
			w.Write([]byte(`{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"list-one","name":"list_sources","input":{}}]}`))
			return
		}
		if !bytes.Contains(body.Messages[1].Content, []byte(`"input":{}`)) {
			t.Errorf("empty input lost: %s", body.Messages[1].Content)
		}
		w.Write([]byte(`{"stop_reason":"end_turn","content":[{"type":"text","text":"No sources."}]}`))
	}))
	defer proxy.Close()
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", proxy.URL+"/v1/messages")
	srv, err := NewServer(Config{Host: "localhost", Port: ":0", StoragePath: t.TempDir(), Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.services.CloseStorage()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Post(ts.URL+"/api/v1/agent/chat", "application/json", bytes.NewBufferString(`{"messages":[{"role":"user","content":"List sources"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestAgentMarksTokenLimitedAnswerIncomplete(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			MaxTokens int    `json:"max_tokens"`
			System    string `json:"system"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		if payload.MaxTokens != 8192 {
			t.Errorf("max_tokens=%d", payload.MaxTokens)
		}
		for _, phrase := range []string{"facet_logs", "log_histogram", "untrusted", "Next:"} {
			if !strings.Contains(payload.System, phrase) {
				t.Errorf("system missing %q", phrase)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"stop_reason":"max_tokens","content":[{"type":"text","text":"Partial finding"}]}`))
	}))
	defer proxy.Close()
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", proxy.URL+"/v1/messages")
	srv, err := NewServer(Config{Host: "localhost", Port: ":0", StoragePath: t.TempDir(), Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.services.CloseStorage()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Post(ts.URL+"/api/v1/agent/chat", "application/json", bytes.NewBufferString(`{"messages":[{"role":"user","content":"Analyze"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Answer string `json:"answer"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || !strings.Contains(out.Answer, "Partial finding") || !strings.Contains(out.Answer, "incomplete") {
		t.Fatalf("status=%d answer=%q", resp.StatusCode, out.Answer)
	}
}

func TestAgentMCPUIActionUsesBridgeAck(t *testing.T) {
	var turns atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Tools []struct {
				Name        string         `json:"name"`
				InputSchema map[string]any `json:"input_schema"`
			} `json:"tools"`
			Messages []struct {
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		found := false
		for _, tool := range body.Tools {
			if tool.Name == "ui_set_query" {
				found = tool.InputSchema["properties"] != nil
			}
			if tool.Name == "delete_source" || tool.Name == "ui_focus" {
				t.Errorf("unexpected advertised tool %s", tool.Name)
			}
		}
		if !found {
			t.Error("MCP ui_set_query schema missing")
		}
		w.Header().Set("Content-Type", "application/json")
		if turns.Add(1) == 1 {
			w.Write([]byte(`{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"ui-one","name":"ui_set_query","input":{"query":"timeout","run":false}}]}`))
			return
		}
		var results []struct {
			Content string `json:"content"`
		}
		if err := json.Unmarshal(body.Messages[len(body.Messages)-1].Content, &results); err != nil || len(results) != 1 || !strings.Contains(results[0].Content, `"status":"applied"`) || !strings.Contains(results[0].Content, `"query":"timeout"`) {
			t.Errorf("UI ack not passed to model: %s (%v)", body.Messages[len(body.Messages)-1].Content, err)
		}
		w.Write([]byte(`{"stop_reason":"end_turn","content":[{"type":"text","text":"The log view query is set to timeout."}]}`))
	}))
	defer proxy.Close()
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", proxy.URL+"/v1/messages")
	srv, err := NewServer(Config{Host: "localhost", Port: ":0", StoragePath: t.TempDir(), Timeout: 30 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.services.CloseStorage()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	srv.mcpBaseURL.Store(ts.URL)
	events, err := http.Get(ts.URL + "/api/v1/live/events?source_id=__ui_bridge__")
	if err != nil {
		t.Fatal(err)
	}
	defer events.Body.Close()
	reader := bufio.NewReader(events.Body)
	if line, err := reader.ReadString('\n'); err != nil || !strings.Contains(line, "hello") {
		t.Fatalf("SSE hello: %q %v", line, err)
	}
	ackDone := make(chan error, 1)
	go func() {
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				ackDone <- err
				return
			}
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var cmd struct {
				ID   string         `json:"id"`
				Type string         `json:"type"`
				Args map[string]any `json:"args"`
			}
			if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data: "))), &cmd) != nil || cmd.Type == "" {
				continue
			}
			if cmd.Type != "set_query" || cmd.Args["query"] != "timeout" {
				ackDone <- fmt.Errorf("command %+v", cmd)
				return
			}
			ack, _ := json.Marshal(map[string]any{"id": cmd.ID, "ok": true, "state": map[string]any{"route": "/agent", "query": "timeout"}})
			resp, err := http.Post(ts.URL+"/api/v1/ui/ack", "application/json", bytes.NewReader(ack))
			if err == nil {
				resp.Body.Close()
				if resp.StatusCode != 204 {
					err = fmt.Errorf("ack status %d", resp.StatusCode)
				}
			}
			ackDone <- err
			return
		}
	}()
	resp, err := http.Post(ts.URL+"/api/v1/agent/chat", "application/json", bytes.NewBufferString(`{"messages":[{"role":"user","content":"Set the log query to timeout"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Answer string `json:"answer"`
		Steps  []struct {
			Tool   string          `json:"tool"`
			Output json.RawMessage `json:"output"`
		} `json:"steps"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || len(out.Steps) != 1 || out.Steps[0].Tool != "ui_set_query" || !bytes.Contains(out.Steps[0].Output, []byte(`"status":"applied"`)) {
		t.Fatalf("status %d output %+v", resp.StatusCode, out)
	}
	if err := <-ackDone; err != nil {
		t.Fatal(err)
	}
}

// sseEvents writes Anthropic stream events to w.
func writeAnthropicStream(w http.ResponseWriter, events ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, ev := range events {
		var probe struct {
			Type string `json:"type"`
		}
		json.Unmarshal([]byte(ev), &probe)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", probe.Type, ev)
	}
}

type agentSSEEvent struct {
	Name string
	Data map[string]any
}

func readAgentSSE(t *testing.T, resp *http.Response) []agentSSEEvent {
	t.Helper()
	var out []agentSSEEvent
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	name := ""
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "event: "):
			name = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			var data map[string]any
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &data); err != nil {
				t.Fatalf("bad event data %q: %v", line, err)
			}
			out = append(out, agentSSEEvent{name, data})
		}
	}
	return out
}

func TestAgentStreamsTextStepsAndPreservesThinking(t *testing.T) {
	var calls atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(200)
			return
		}
		var body struct {
			Stream   bool `json:"stream"`
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if !body.Stream {
			t.Error("proxy request did not ask for a stream")
		}
		switch calls.Add(1) {
		case 1:
			writeAnthropicStream(w,
				`{"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[]}}`,
				`{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`,
				`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Need sources."}}`,
				`{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG-abc"}}`,
				`{"type":"content_block_stop","index":0}`,
				`{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
				`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Checking "}}`,
				`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"sources."}}`,
				`{"type":"content_block_stop","index":1}`,
				`{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tool-1","name":"query_logs","input":{}}}`,
				`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"che"}}`,
				`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"ckout\",\"limit\":5}"}}`,
				`{"type":"content_block_stop","index":2}`,
				`{"type":"ping"}`,
				`{"type":"message_delta","delta":{"stop_reason":"tool_use"}}`,
				`{"type":"message_stop"}`,
			)
		default:
			if len(body.Messages) != 3 {
				t.Errorf("messages=%d", len(body.Messages))
			} else {
				assistant := string(body.Messages[1].Content)
				for _, want := range []string{`"signature":"SIG-abc"`, `"thinking":"Need sources."`, `"input":{"limit":5,"query":"checkout"}`, `"text":"Checking sources."`} {
					if !strings.Contains(assistant, want) {
						t.Errorf("assistant replay missing %s: %s", want, assistant)
					}
				}
				if !strings.Contains(string(body.Messages[2].Content), `"tool_use_id":"tool-1"`) {
					t.Errorf("tool result: %s", body.Messages[2].Content)
				}
			}
			writeAnthropicStream(w,
				`{"type":"message_start","message":{"id":"m2","type":"message","role":"assistant","content":[]}}`,
				`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
				`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"No checkout "}}`,
				`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"errors."}}`,
				`{"type":"content_block_stop","index":0}`,
				`{"type":"message_delta","delta":{"stop_reason":"end_turn"}}`,
				`{"type":"message_stop"}`,
			)
		}
	}))
	defer proxy.Close()
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", proxy.URL+"/v1/messages")
	srv, err := NewServer(Config{Host: "localhost", Port: ":0", StoragePath: t.TempDir(), Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.services.CloseStorage()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Post(ts.URL+"/api/v1/agent/chat", "application/json", bytes.NewBufferString(`{"stream":true,"messages":[{"role":"user","content":"Any checkout errors?"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("status=%d type=%s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	events := readAgentSSE(t, resp)
	var names []string
	var text strings.Builder
	for _, ev := range events {
		names = append(names, ev.Name)
		if ev.Name == "text" {
			text.WriteString(ev.Data["delta"].(string))
		}
	}
	got := strings.Join(names, ",")
	if got != "text,text,step_start,step,text,text,done" {
		t.Fatalf("event order: %s", got)
	}
	if text.String() != "Checking sources.No checkout errors." {
		t.Errorf("text deltas: %q", text.String())
	}
	start, step, done := events[2].Data, events[3].Data, events[6].Data
	if start["id"] != "tool-1" || start["tool"] != "query_logs" || start["input"].(map[string]any)["query"] != "checkout" {
		t.Errorf("step_start: %v", start)
	}
	if step["id"] != "tool-1" || step["is_error"] != false || step["output"].(map[string]any)["total_count"] == nil {
		t.Errorf("step: %v", step)
	}
	if done["answer"] != "No checkout errors." || len(done["steps"].([]any)) != 1 {
		t.Errorf("done: %v", done)
	}
}

func TestAgentStreamReportsProxyFailureAsErrorEvent(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeAnthropicStream(w,
			`{"type":"message_start","message":{"id":"m1"}}`,
			`{"type":"error","error":{"type":"overloaded_error","message":"busy"}}`,
		)
	}))
	defer proxy.Close()
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", proxy.URL+"/v1/messages")
	srv, err := NewServer(Config{Host: "localhost", Port: ":0", StoragePath: t.TempDir(), Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.services.CloseStorage()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Post(ts.URL+"/api/v1/agent/chat", "application/json", bytes.NewBufferString(`{"stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	events := readAgentSSE(t, resp)
	if len(events) != 1 || events[0].Name != "error" || !strings.Contains(events[0].Data["error"].(string), "busy") {
		t.Fatalf("events: %+v", events)
	}
}

func TestAgentStatusRequiresKeyForAnthropicEndpoint(t *testing.T) {
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", "https://api.anthropic.com/v1/messages")
	t.Setenv("LOGSONIC_AGENT_PROXY_KEY", "")
	t.Setenv("ANTHROPIC_API_KEY", "")
	srv, err := NewServer(Config{Host: "localhost", Port: ":0", StoragePath: t.TempDir(), Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.services.CloseStorage()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/v1/agent/status")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var status struct {
		Available bool   `json:"available"`
		Reason    string `json:"reason"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.Available || !strings.Contains(status.Reason, "ANTHROPIC_API_KEY") {
		t.Fatalf("expected unavailable status requiring ANTHROPIC_API_KEY, got %+v", status)
	}
}

func TestAgentStreamPreservesContentBlockStartToolInput(t *testing.T) {
	calls := 0
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			writeAnthropicStream(w,
				`{"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[]}}`,
				`{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-pre","name":"query_logs","input":{"query":"prepopulated","limit":3}}}`,
				`{"type":"content_block_stop","index":0}`,
				`{"type":"message_delta","delta":{"stop_reason":"tool_use"}}`,
				`{"type":"message_stop"}`,
			)
			return
		}
		var body struct {
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode: %v", err)
		} else if !strings.Contains(string(body.Messages[1].Content), `"query":"prepopulated"`) {
			t.Errorf("expected prepopulated tool input in replay, got %s", body.Messages[1].Content)
		}
		writeAnthropicStream(w,
			`{"type":"message_start","message":{"id":"m2","type":"message","role":"assistant","content":[]}}`,
			`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Done."}}`,
			`{"type":"content_block_stop","index":0}`,
			`{"type":"message_delta","delta":{"stop_reason":"end_turn"}}`,
			`{"type":"message_stop"}`,
		)
	}))
	defer proxy.Close()
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", proxy.URL+"/v1/messages")
	srv, err := NewServer(Config{Host: "localhost", Port: ":0", StoragePath: t.TempDir(), Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.services.CloseStorage()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Post(ts.URL+"/api/v1/agent/chat", "application/json", bytes.NewBufferString(`{"stream":true,"messages":[{"role":"user","content":"Check prepopulated"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	events := readAgentSSE(t, resp)
	foundStepStart := false
	for _, ev := range events {
		if ev.Name == "step_start" {
			foundStepStart = true
			if in, _ := ev.Data["input"].(map[string]any); in["query"] != "prepopulated" {
				t.Fatalf("expected prepopulated query in step_start, got %v", ev.Data)
			}
		}
	}
	if !foundStepStart {
		t.Fatalf("missing step_start event in %+v", events)
	}
}

func TestAgentSettingsRouteDrivesStatusAndChat(t *testing.T) {
	for _, k := range []string{"LOGSONIC_AGENT_PROXY_URL", "LOGSONIC_AGENT_MODEL", "LOGSONIC_AGENT_PROXY_KEY", "ANTHROPIC_API_KEY"} {
		t.Setenv(k, "")
	}
	var gotKey, gotModel string
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		gotKey = r.Header.Get("x-api-key")
		var body struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotModel = body.Model
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}`))
	}))
	defer proxy.Close()
	srv, err := NewServer(Config{Host: "localhost", Port: ":0", StoragePath: t.TempDir(), Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.services.CloseStorage()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	put := func(body, contentType, origin string) int {
		req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/agent/settings", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", contentType)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	settings := `{"proxy_url":"` + proxy.URL + `/v1/messages","model":"saved-model","api_key":"sk-saved-5678"}`
	if code := put(settings, "text/plain", ""); code != http.StatusUnsupportedMediaType {
		t.Errorf("text/plain PUT: %d", code)
	}
	if code := put(settings, "application/json", "https://evil.example.com"); code != http.StatusForbidden {
		t.Errorf("foreign-origin PUT: %d", code)
	}
	if code := put(settings, "application/json", ""); code != http.StatusOK {
		t.Fatalf("PUT: %d", code)
	}

	resp, err := http.Get(ts.URL + "/api/v1/agent/status")
	if err != nil {
		t.Fatal(err)
	}
	var status struct {
		Available bool   `json:"available"`
		Model     string `json:"model"`
		ProxyURL  string `json:"proxy_url"`
	}
	json.NewDecoder(resp.Body).Decode(&status)
	resp.Body.Close()
	if !status.Available || status.Model != "saved-model" || status.ProxyURL != proxy.URL+"/v1/messages" {
		t.Fatalf("status %+v", status)
	}

	resp, err = http.Post(ts.URL+"/api/v1/agent/chat", "application/json", bytes.NewBufferString(`{"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || gotKey != "sk-saved-5678" || gotModel != "saved-model" {
		t.Fatalf("chat status %d, key %q, model %q", resp.StatusCode, gotKey, gotModel)
	}

	// Another localhost page gets only the hint; LogSonic's own page (same
	// origin, no Origin header) gets the key so the form can show it.
	getSettings := func(origin string) string {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/agent/settings", nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return string(raw)
	}
	if raw := getSettings("http://localhost:3000"); strings.Contains(raw, "sk-saved") || !strings.Contains(raw, "5678") {
		t.Fatalf("cross-origin settings GET: %s", raw)
	}
	if raw := getSettings(""); !strings.Contains(raw, `"saved_value":"sk-saved-5678"`) {
		t.Fatalf("same-origin settings GET: %s", raw)
	}
}
