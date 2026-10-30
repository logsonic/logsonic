package agentmcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"
)

func testServer() *mcpserver.MCPServer {
	s := mcpserver.NewMCPServer("test", "1.0")
	s.AddTool(mcp.NewTool("echo", mcp.WithDescription("Echo text back"), mcp.WithString("text", mcp.Required())),
		func(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			return mcp.NewToolResultText("echo: " + req.GetString("text", "")), nil
		})
	s.AddTool(mcp.NewTool("fail", mcp.WithDescription("Always fails")),
		func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			return mcp.NewToolResultError("ticket system is down"), nil
		})
	s.AddTool(mcp.NewTool("picture", mcp.WithDescription("Returns an image")),
		func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			return mcp.NewToolResultImage("chart attached", strings.Repeat("A", 4000), "image/png"), nil
		})
	return s
}

func inProcessDial(servers map[string]*mcpserver.MCPServer) func(context.Context, context.Context, ServerConfig, *tailBuffer) (Session, error) {
	return func(ctx, _ context.Context, cfg ServerConfig, _ *tailBuffer) (Session, error) {
		srv, ok := servers[cfg.Name]
		if !ok {
			return nil, errors.New("connection refused")
		}
		c, err := client.NewInProcessClient(srv)
		if err != nil {
			return nil, err
		}
		if err := c.Start(ctx); err != nil {
			return nil, err
		}
		init := mcp.InitializeRequest{}
		init.Params.ProtocolVersion = mcp.LATEST_PROTOCOL_VERSION
		init.Params.ClientInfo = mcp.Implementation{Name: "test", Version: "1"}
		if _, err := c.Initialize(ctx, init); err != nil {
			return nil, err
		}
		return c, nil
	}
}

func writeConfig(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	// The manager reloads on mtime+size; make every write look new.
	future := time.Now().Add(time.Duration(len(body)) * time.Second)
	_ = os.Chtimes(path, future, future)
}

func TestParseSkipsBadEntries(t *testing.T) {
	file, err := Parse([]byte(`{"mcpServers": {
		"ok": {"command": "npx", "args": ["x"]},
		"web": {"type": "streamable-http", "url": "https://mcp.example.com/mcp"},
		"bad name": {"command": "x"},
		"noCmd": {"type": "stdio"},
		"ftp": {"url": "ftp://x"},
		"weird": {"type": "carrier-pigeon", "url": "https://x"}
	}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(file.Servers) != 2 || file.Servers[0].Name != "ok" || file.Servers[1].Kind() != TransportHTTP {
		t.Fatalf("servers = %+v", file.Servers)
	}
	if len(file.Skipped) != 4 {
		t.Fatalf("skipped = %v", file.Skipped)
	}
	if _, err := Parse([]byte("{nope")); err == nil {
		t.Fatal("malformed file must be an error")
	}
}

func TestToolNameFitsAPIRule(t *testing.T) {
	rule := regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
	if got := ToolName("github", "search_issues"); got != "mcp__github__search_issues" {
		t.Fatalf("plain name = %q", got)
	}
	long1 := ToolName("a-very-long-server-name-here", strings.Repeat("x", 60)+"one")
	long2 := ToolName("a-very-long-server-name-here", strings.Repeat("x", 60)+"two")
	dotted := ToolName("fs", "read.file")
	for _, name := range []string{long1, long2, dotted} {
		if !rule.MatchString(name) {
			t.Errorf("%q breaks the tool name rule", name)
		}
	}
	if long1 == long2 {
		t.Errorf("long names collided: %q", long1)
	}
	if dotted == "mcp__fs__read_file" {
		t.Errorf("a cleaned name must not collide with a real read_file tool")
	}
}

func TestManagerServesToolsAndIsolatesFailures(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp.json")
	writeConfig(t, path, `{"mcpServers": {
		"tickets": {"command": "tickets-mcp", "env": {"TICKETS_TOKEN": "s3cret-token"}},
		"limited": {"type": "http", "url": "https://mcp.example.com/mcp?key=hidden", "headers": {"Authorization": "Bearer hidden-bearer"}, "tools": ["echo"]},
		"down": {"command": "missing-mcp"},
		"off": {"command": "off-mcp", "disabled": true}
	}}`)
	m := NewManager(path)
	m.dial = inProcessDial(map[string]*mcpserver.MCPServer{"tickets": testServer(), "limited": testServer(), "off": testServer()})
	defer m.Close()
	ctx := context.Background()
	m.Prepare(ctx)

	names := []string{}
	for _, s := range m.Schemas() {
		names = append(names, s["name"].(string))
		schema := s["input_schema"].(map[string]any)
		if schema["type"] != "object" {
			t.Errorf("%s schema type = %v", s["name"], schema["type"])
		}
	}
	want := []string{"mcp__limited__echo", "mcp__tickets__echo", "mcp__tickets__fail", "mcp__tickets__picture"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("tools = %v, want %v", names, want)
	}

	out, err := m.Call(ctx, "mcp__tickets__echo", map[string]any{"text": "INC-42"})
	if err != nil || out.(map[string]any)["text"] != "echo: INC-42" {
		t.Fatalf("echo = %v, %v", out, err)
	}
	if _, err := m.Call(ctx, "mcp__tickets__fail", nil); err == nil || !strings.Contains(err.Error(), "ticket system is down") {
		t.Fatalf("isError must become an error, got %v", err)
	}
	pic, err := m.Call(ctx, "mcp__tickets__picture", nil)
	if err != nil {
		t.Fatal(err)
	}
	text := pic.(map[string]any)["text"].(string)
	if !strings.Contains(text, "chart attached") || !strings.Contains(text, "[image image/png omitted, 4000 base64 characters]") || strings.Contains(text, "AAAA") {
		t.Fatalf("image result = %q", text)
	}
	if _, err := m.Call(ctx, "mcp__limited__fail", nil); err == nil {
		t.Fatal("a tool outside the allowlist must not be callable")
	}

	st := m.Status()
	if st.Connected != 2 || st.ToolCount != 4 || len(st.Servers) != 4 {
		t.Fatalf("status = %+v", st)
	}
	for _, s := range st.Servers {
		switch s.Name {
		case "down":
			if s.Connected || !strings.Contains(s.Error, "connection refused") {
				t.Errorf("down = %+v", s)
			}
		case "off":
			if s.Connected || !s.Disabled {
				t.Errorf("off = %+v", s)
			}
		case "limited":
			if s.Target != "https://mcp.example.com" {
				t.Errorf("target = %q", s.Target)
			}
		}
	}
	encoded, _ := json.Marshal(st)
	for _, secret := range []string{"s3cret-token", "hidden-bearer", "key=hidden"} {
		if strings.Contains(string(encoded), secret) {
			t.Errorf("status leaks %q: %s", secret, encoded)
		}
	}

	// Editing the file drops removed servers and their tools.
	writeConfig(t, path, `{"mcpServers": {"limited": {"type": "http", "url": "https://mcp.example.com/mcp?key=hidden", "headers": {"Authorization": "Bearer hidden-bearer"}, "tools": ["echo"]}}}`)
	m.Prepare(ctx)
	if got := m.Schemas(); len(got) != 1 || got[0]["name"] != "mcp__limited__echo" {
		t.Fatalf("after edit = %v", got)
	}
	if _, err := m.Call(ctx, "mcp__tickets__echo", map[string]any{"text": "x"}); err == nil {
		t.Fatal("a removed server's tool must not be callable")
	}
}

func TestChildEnvDropsAgentCredentials(t *testing.T) {
	t.Setenv("LOGSONIC_AGENT_PROXY_KEY", "proxy-secret")
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-secret")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "oauth-secret")
	t.Setenv("OPENAI_API_KEY", "sk-openai-secret")
	t.Setenv("PATH_FOR_TEST", "kept")
	t.Setenv("OVERRIDDEN_VAR", "ambient")
	entries := childEnv(map[string]string{"GITHUB_TOKEN": "gh", "OVERRIDDEN_VAR": "custom"})
	env := strings.Join(entries, "\n")
	if strings.Contains(env, "proxy-secret") || strings.Contains(env, "sk-ant-secret") || strings.Contains(env, "oauth-secret") || strings.Contains(env, "sk-openai-secret") {
		t.Fatal("agent credentials must not reach MCP child processes")
	}
	if !strings.Contains(env, "PATH_FOR_TEST=kept") || !strings.Contains(env, "GITHUB_TOKEN=gh") || !strings.Contains(env, "OVERRIDDEN_VAR=custom") {
		t.Fatalf("env = %s", env)
	}
	if strings.Contains(env, "OVERRIDDEN_VAR=ambient") {
		t.Fatalf("expected OVERRIDDEN_VAR=ambient to be replaced, got:\n%s", env)
	}
}

// Windows environment names ignore case: a key set as Openai_Api_Key is the
// same variable and must be dropped, and an entry override must replace it.
func TestChildEnvFoldsCaseOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("environment names are case-sensitive here")
	}
	t.Setenv("Openai_Api_Key", "sk-openai-secret")
	t.Setenv("My_Var", "ambient")
	env := strings.Join(childEnv(map[string]string{"MY_VAR": "custom"}), "\n")
	if strings.Contains(env, "sk-openai-secret") || strings.Contains(env, "ambient") || !strings.Contains(env, "MY_VAR=custom") {
		t.Fatalf("env = %s", env)
	}
}

// The handshake context ends when Prepare's connect timeout does; an SSE or
// HTTP session must keep working after that.
func TestRemoteSessionsOutliveHandshakeContext(t *testing.T) {
	for _, kind := range []string{TransportSSE, TransportHTTP} {
		t.Run(kind, func(t *testing.T) {
			var handler http.Handler
			if kind == TransportSSE {
				handler = mcpserver.NewSSEServer(testServer())
			} else {
				handler = mcpserver.NewStreamableHTTPServer(testServer())
			}
			ts := httptest.NewServer(handler)
			defer ts.Close()
			url := ts.URL + "/mcp"
			if kind == TransportSSE {
				url = ts.URL + "/sse"
			}
			life, stop := context.WithCancel(context.Background())
			defer stop()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			session, err := dialServer(ctx, life, ServerConfig{Name: "remote", Type: kind, URL: url}, &tailBuffer{})
			cancel()
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			time.Sleep(100 * time.Millisecond)
			req := mcp.CallToolRequest{}
			req.Params.Name = "echo"
			req.Params.Arguments = map[string]any{"text": "still here"}
			res, err := session.CallTool(context.Background(), req)
			if err != nil {
				t.Fatalf("call after the handshake context ended: %v", err)
			}
			if text, _ := renderResult(res); text != "echo: still here" {
				t.Fatalf("result = %q", text)
			}
		})
	}
}
