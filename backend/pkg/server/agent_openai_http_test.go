package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func clearAgentTestEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{"LOGSONIC_AGENT_PROVIDER", "LOGSONIC_AGENT_PROXY_URL", "LOGSONIC_AGENT_MODEL", "LOGSONIC_AGENT_PROXY_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"} {
		t.Setenv(k, "")
	}
}

func newAgentTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv, err := NewServer(Config{Host: "localhost", Port: ":0", StoragePath: t.TempDir(), Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.services.CloseStorage() })
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

type openAIRequestBody struct {
	Model     string `json:"model"`
	Stream    bool   `json:"stream"`
	MaxTokens int    `json:"max_tokens"`
	Messages  []struct {
		Role       string `json:"role"`
		Content    any    `json:"content"`
		ToolCallID string `json:"tool_call_id"`
		ToolCalls  []struct {
			ID       string `json:"id"`
			Function struct {
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
			} `json:"function"`
		} `json:"tool_calls"`
	} `json:"messages"`
	Tools []struct {
		Type     string `json:"type"`
		Function struct {
			Name       string         `json:"name"`
			Parameters map[string]any `json:"parameters"`
		} `json:"function"`
	} `json:"tools"`
}

// The agent loop runs a tool round trip against a Chat Completions server:
// system prompt first, tools as functions, the tool call replayed as
// tool_calls and its result as a "tool" message, with a bearer token.
func TestAgentOpenAIChatToolRoundTrip(t *testing.T) {
	clearAgentTestEnv(t)
	var calls atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(200)
			return
		}
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-oai" {
			t.Errorf("Authorization %q", got)
		}
		var body openAIRequestBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.Model != "llama3" || body.MaxTokens == 0 || len(body.Tools) < 3 || body.Tools[0].Type != "function" || body.Tools[0].Function.Parameters == nil {
			t.Errorf("request model=%q max_tokens=%d tools=%d", body.Model, body.MaxTokens, len(body.Tools))
		}
		if len(body.Messages) == 0 || body.Messages[0].Role != "system" {
			t.Error("system prompt is not the first message")
		}
		w.Header().Set("Content-Type", "application/json")
		switch calls.Add(1) {
		case 1:
			w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"query_logs","arguments":"{\"query\":\"checkout\",\"limit\":5}"}}]},"finish_reason":"tool_calls"}]}`))
		default:
			if len(body.Messages) != 4 {
				t.Fatalf("messages=%d", len(body.Messages))
			}
			assistant, tool := body.Messages[2], body.Messages[3]
			if assistant.Role != "assistant" || len(assistant.ToolCalls) != 1 || assistant.ToolCalls[0].ID != "call_1" || !strings.Contains(assistant.ToolCalls[0].Function.Arguments, `"checkout"`) {
				t.Errorf("assistant replay: %+v", assistant)
			}
			if tool.Role != "tool" || tool.ToolCallID != "call_1" || !strings.Contains(fmt.Sprint(tool.Content), "total_count") {
				t.Errorf("tool result: %+v", tool)
			}
			w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"No checkout errors."},"finish_reason":"stop"}]}`))
		}
	}))
	defer proxy.Close()
	t.Setenv("LOGSONIC_AGENT_PROVIDER", "openai")
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", proxy.URL+"/v1/chat/completions")
	t.Setenv("LOGSONIC_AGENT_MODEL", "llama3")
	t.Setenv("LOGSONIC_AGENT_PROXY_KEY", "sk-oai")
	ts := newAgentTestServer(t)

	resp, err := http.Post(ts.URL+"/api/v1/agent/chat", "application/json", bytes.NewBufferString(`{"messages":[{"role":"user","content":"Any checkout errors?"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Answer string `json:"answer"`
		Steps  []struct {
			Tool string `json:"tool"`
		} `json:"steps"`
		Error string `json:"error"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != 200 || out.Answer != "No checkout errors." || len(out.Steps) != 1 || out.Steps[0].Tool != "query_logs" {
		t.Fatalf("status=%d out=%+v", resp.StatusCode, out)
	}
}

func writeOpenAIStream(w http.ResponseWriter, chunks ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, c := range chunks {
		fmt.Fprintf(w, "data: %s\n\n", c)
	}
	fmt.Fprint(w, "data: [DONE]\n\n")
}

// Streaming: text deltas reach the browser and tool call fragments keyed by
// index are reassembled into one call.
func TestAgentOpenAIStreamReassemblesToolCalls(t *testing.T) {
	clearAgentTestEnv(t)
	var calls atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body openAIRequestBody
		json.NewDecoder(r.Body).Decode(&body)
		if !body.Stream {
			t.Error("request did not ask for a stream")
		}
		switch calls.Add(1) {
		case 1:
			writeOpenAIStream(w,
				`{"choices":[{"delta":{"role":"assistant","content":"Checking "}}]}`,
				`{"choices":[{"delta":{"content":"sources."}}]}`,
				`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"query_logs","arguments":""}}]}}]}`,
				`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"query\":\"che"}}]}}]}`,
				`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ckout\"}"}}]}}]}`,
				`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
			)
		default:
			assistant := body.Messages[2]
			if len(assistant.ToolCalls) != 1 || assistant.ToolCalls[0].Function.Arguments != `{"query":"checkout"}` || fmt.Sprint(assistant.Content) != "Checking sources." {
				t.Errorf("assistant replay: %+v", assistant)
			}
			writeOpenAIStream(w,
				`{"choices":[{"delta":{"content":"No checkout "}}]}`,
				`{"choices":[{"delta":{"content":"errors."},"finish_reason":"stop"}]}`,
			)
		}
	}))
	defer proxy.Close()
	t.Setenv("LOGSONIC_AGENT_PROVIDER", "openai")
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", proxy.URL+"/v1/chat/completions")
	t.Setenv("LOGSONIC_AGENT_MODEL", "llama3")
	ts := newAgentTestServer(t)

	resp, err := http.Post(ts.URL+"/api/v1/agent/chat", "application/json", bytes.NewBufferString(`{"stream":true,"messages":[{"role":"user","content":"Any checkout errors?"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	events := readAgentSSE(t, resp)
	var names []string
	var text strings.Builder
	for _, ev := range events {
		names = append(names, ev.Name)
		if ev.Name == "text" {
			text.WriteString(ev.Data["delta"].(string))
		}
	}
	if got := strings.Join(names, ","); got != "text,text,step_start,step,text,text,done" {
		t.Fatalf("event order: %s (%v)", got, events)
	}
	if text.String() != "Checking sources.No checkout errors." {
		t.Errorf("text: %q", text.String())
	}
	if done := events[len(events)-1].Data; done["answer"] != "No checkout errors." {
		t.Errorf("done: %v", done)
	}
}

func postAgentTest(t *testing.T, ts *httptest.Server, body string) (int, map[string]any) {
	t.Helper()
	resp, err := http.Post(ts.URL+"/api/v1/agent/test", "application/json", bytes.NewBufferString(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// The Test button checks typed, unsaved fields in either format, with a
// tool declared, and explains failures.
func TestAgentTestRouteChecksTypedFields(t *testing.T) {
	clearAgentTestEnv(t)
	var gotAnthropicKey, gotBearer string
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Tools []json.RawMessage `json:"tools"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if len(body.Tools) != 1 {
			t.Errorf("test request tools=%d, want 1", len(body.Tools))
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/messages":
			gotAnthropicKey = r.Header.Get("x-api-key")
			w.Write([]byte(`{"content":[{"type":"text","text":"OK"}],"stop_reason":"end_turn"}`))
		case "/v1/chat/completions":
			gotBearer = r.Header.Get("Authorization")
			w.Write([]byte(`{"choices":[{"message":{"content":"OK"},"finish_reason":"stop"}]}`))
		case "/bad/v1/chat/completions":
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"error":{"message":"invalid key"}}`))
		case "/moved/v1/messages":
			http.Redirect(w, r, "https://elsewhere.example.com/v1/messages", http.StatusTemporaryRedirect)
		default:
			w.WriteHeader(404)
		}
	}))
	defer proxy.Close()
	ts := newAgentTestServer(t)

	code, out := postAgentTest(t, ts, `{"provider":"anthropic","proxy_url":"`+proxy.URL+`/v1/messages","model":"claude-x","api_key":"sk-a"}`)
	if code != 200 || out["ok"] != true || out["reply"] != "OK" || gotAnthropicKey != "sk-a" {
		t.Fatalf("anthropic: %d %v key=%q", code, out, gotAnthropicKey)
	}
	code, out = postAgentTest(t, ts, `{"provider":"openai","proxy_url":"`+proxy.URL+`/v1/chat/completions","model":"llama3","api_key":"sk-o"}`)
	if code != 200 || out["ok"] != true || out["reply"] != "OK" || gotBearer != "Bearer sk-o" {
		t.Fatalf("openai: %d %v bearer=%q", code, out, gotBearer)
	}
	code, out = postAgentTest(t, ts, `{"provider":"openai","proxy_url":"`+proxy.URL+`/bad/v1/chat/completions","model":"llama3","api_key":"sk-o"}`)
	if code != http.StatusBadGateway || !strings.Contains(fmt.Sprint(out["error"]), "rejected the API key") {
		t.Fatalf("bad key: %d %v", code, out)
	}
	code, out = postAgentTest(t, ts, `{"provider":"anthropic","proxy_url":"`+proxy.URL+`/moved/v1/messages","model":"claude-x","api_key":"sk-a"}`)
	if code != http.StatusBadGateway || !strings.Contains(fmt.Sprint(out["error"]), "redirect") {
		t.Fatalf("redirect: %d %v", code, out)
	}
	code, out = postAgentTest(t, ts, `{"provider":"openai","proxy_url":"`+proxy.URL+`/v1/messages","model":"llama3"}`)
	if code != http.StatusBadRequest || !strings.Contains(fmt.Sprint(out["error"]), "/chat/completions") {
		t.Fatalf("wrong suffix: %d %v", code, out)
	}
}
