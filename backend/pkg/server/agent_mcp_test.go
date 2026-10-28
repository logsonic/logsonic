package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"logsonic/pkg/agentmcp"
)

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
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
			Messages []struct {
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		if turns.Add(1) == 1 {
			found := false
			for _, tool := range body.Tools {
				found = found || tool.Name == "mcp__tickets__search"
			}
			if !found {
				t.Error("external tool missing from the tool list")
			}
			w.Write([]byte(`{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"t1","name":"mcp__tickets__search","input":{"q":"checkout"}}]}`))
			return
		}
		if !bytes.Contains(body.Messages[len(body.Messages)-1].Content, []byte("INC-42")) {
			t.Error("tool result not returned to the model")
		}
		w.Write([]byte(`{"stop_reason":"end_turn","content":[{"type":"text","text":"Ticket INC-42 tracks it."}]}`))
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
	body, _ := json.Marshal(map[string]any{"messages": []any{map[string]string{"role": "user", "content": "Is there a ticket for the checkout errors?"}}})
	resp, err := http.Post(ts.URL+"/api/v1/agent/chat", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Answer string `json:"answer"`
		Steps  []struct {
			Tool    string `json:"tool"`
			IsError bool   `json:"is_error"`
		} `json:"steps"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || len(out.Steps) != 1 || out.Steps[0].Tool != "mcp__tickets__search" || out.Steps[0].IsError {
		t.Fatalf("status=%d out=%+v", resp.StatusCode, out)
	}
	if fake.prepared.Load() != 1 || fake.args["q"] != "checkout" {
		t.Fatalf("prepared=%d args=%v", fake.prepared.Load(), fake.args)
	}
}
