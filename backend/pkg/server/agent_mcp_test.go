package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"logsonic/pkg/agentmcp"
)

func TestAgentChatApproveAllIsRequestLocalAndNotModelVisible(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Stream   bool              `json:"stream"`
			Messages []json.RawMessage `json:"messages"`
		}
		raw, _ := io.ReadAll(r.Body)
		if bytes.Contains(raw, []byte("approve_all")) {
			t.Error("client approval policy leaked to model")
		}
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Error(err)
			return
		}
		if len(body.Messages) == 1 {
			writeAgentProxyTestReply(w, body.Stream, "tool_use", []any{map[string]any{"type": "tool_use", "id": "t1", "name": "mcp__tickets__search", "input": map[string]any{"q": "checkout"}}})
		} else {
			writeAgentProxyTestReply(w, body.Stream, "end_turn", []any{map[string]any{"type": "text", "text": "Ticket checked."}})
		}
	}))
	defer proxy.Close()
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", proxy.URL+"/v1/messages")
	srv, err := NewServer(Config{Host: "localhost", Port: ":0", StoragePath: t.TempDir(), Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.services.CloseStorage()
	fake := &fakeMCP{}
	srv.services.AgentMCP = fake
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	read := func(body string) string {
		resp, err := client.Post(ts.URL+"/api/v1/agent/chat", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("chat status %d", resp.StatusCode)
		}
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			if line := scanner.Text(); strings.HasPrefix(line, "event: ") {
				if strings.Contains(line, "approval_required") {
					return "approval_required"
				}
				if strings.Contains(line, "done") {
					return "done"
				}
			}
		}
		t.Fatalf("stream ended: %v", scanner.Err())
		return ""
	}
	if got := read(`{"stream":true,"approve_all":true,"messages":[{"role":"user","content":"Check ticket"}]}`); got != "done" {
		t.Fatalf("opted-in stream event %s", got)
	}
	if fake.args["q"] != "checkout" {
		t.Fatalf("MCP call missing: %v", fake.args)
	}
	if got := read(`{"stream":true,"messages":[{"role":"user","content":"Check ticket"}]}`); got != "approval_required" {
		t.Fatalf("next request inherited approval: %s", got)
	}
	resp, err := client.Post(ts.URL+"/api/v1/agent/chat", "application/json", strings.NewReader(`{"approve_all":true,"messages":[{"role":"user","content":"Check ticket"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("nonstream approve_all status %d", resp.StatusCode)
	}
}

type fakeMCP struct {
	prepared atomic.Int32
	args     map[string]any
}

func (f *fakeMCP) Prepare(context.Context) { f.prepared.Add(1) }
func (f *fakeMCP) Schemas() []map[string]any {
	return []map[string]any{{"name": "mcp__tickets__search", "description": "[External MCP server \"tickets\"] Search tickets", "input_schema": map[string]any{"type": "object", "properties": map[string]any{"q": map[string]any{"type": "string"}}}}}
}
func (f *fakeMCP) Call(_ context.Context, name string, args map[string]any) (any, error) {
	f.args = args
	return map[string]any{"server": "tickets", "tool": "search", "text": "INC-42: checkout outage, opened 10:19"}, nil
}
func (f *fakeMCP) Status() agentmcp.Status { return agentmcp.Status{} }

// External MCP tools are offered to the model next to LogSonic's own, and a
// call to one is routed to the MCP provider with the model's arguments.
func TestAgentCallsExternalMCPTool(t *testing.T) {
	var turns atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Stream bool `json:"stream"`
			Tools  []struct {
				Name string `json:"name"`
			} `json:"tools"`
			Messages []struct {
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if turns.Add(1) == 1 {
			found := false
			for _, tool := range body.Tools {
				found = found || tool.Name == "mcp__tickets__search"
			}
			if !found {
				t.Error("external tool missing from the tool list")
			}
			writeAgentProxyTestReply(w, body.Stream, "tool_use", []any{map[string]any{"type": "tool_use", "id": "t1", "name": "mcp__tickets__search", "input": map[string]any{"q": "checkout"}}})
			return
		}
		if !bytes.Contains(body.Messages[len(body.Messages)-1].Content, []byte("INC-42")) {
			t.Error("tool result not returned to the model")
		}
		writeAgentProxyTestReply(w, body.Stream, "end_turn", []any{map[string]any{"type": "text", "text": "Ticket INC-42 tracks it."}})
	}))
	defer proxy.Close()
	t.Setenv("LOGSONIC_AGENT_PROXY_URL", proxy.URL+"/v1/messages")
	srv, err := NewServer(Config{Host: "localhost", Port: ":0", StoragePath: t.TempDir(), Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.services.CloseStorage()
	fake := &fakeMCP{}
	srv.services.AgentMCP = fake
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	body, _ := json.Marshal(map[string]any{"messages": []any{map[string]string{"role": "user", "content": "Is there a ticket for the checkout errors?"}}, "stream": true})
	var out struct {
		Answer string `json:"answer"`
		Steps  []struct {
			Tool    string `json:"tool"`
			IsError bool   `json:"is_error"`
		} `json:"steps"`
	}
	if err := json.Unmarshal(postApprovedAgentChat(t, ts.URL, string(body)), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Steps) != 1 || out.Steps[0].Tool != "mcp__tickets__search" || out.Steps[0].IsError {
		t.Fatalf("out=%+v", out)
	}
	if fake.prepared.Load() != 1 || fake.args["q"] != "checkout" {
		t.Fatalf("prepared=%d args=%v", fake.prepared.Load(), fake.args)
	}
}
