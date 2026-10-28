package agentmcp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/client/transport"
	"github.com/mark3labs/mcp-go/mcp"
)

// Limits. Tool names follow the Messages API rule ^[a-zA-Z0-9_-]{1,64}$.
const (
	// ToolPrefix marks an external tool: mcp__<server>__<tool>.
	ToolPrefix     = "mcp__"
	maxToolName    = 64
	maxToolsPerSrv = 64
	maxDescription = 1024
	connectTimeout = 15 * time.Second
	callTimeout    = 90 * time.Second
	retryAfter     = 30 * time.Second
	stderrTail     = 2048
)

var unsafeToolChars = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// Session is the part of an MCP client the manager uses; tests substitute
// in-process clients through Manager.dial.
type Session interface {
	ListTools(context.Context, mcp.ListToolsRequest) (*mcp.ListToolsResult, error)
	CallTool(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error)
	Close() error
}

type exposedTool struct {
	name     string // mcp__server__tool, unique
	original string
	schema   map[string]any
}

type server struct {
	cfg     ServerConfig
	fp      string
	session Session
	tools   []exposedTool
	err     string
	tried   time.Time
	stderr  *tailBuffer
}

// Manager owns the configured servers. Prepare (re)loads the file and
// connects lazily; Schemas and Call serve the agent loop.
type Manager struct {
	path string
	// dial opens a session; replaced in tests. ctx bounds the handshake;
	// life outlives it and bounds long-lived streams (SSE, HTTP listening).
	dial func(ctx, life context.Context, cfg ServerConfig, stderr *tailBuffer) (Session, error)
	life context.Context
	stop context.CancelFunc

	prepareMu sync.Mutex // serializes Prepare; held across connects
	mu        sync.Mutex // guards the fields below
	stamp     string     // mtime+size of the last loaded file
	fileErr   string
	skipped   []string
	servers   map[string]*server
	byTool    map[string]*server
}

// NewManager reads servers from path (it need not exist yet).
func NewManager(path string) *Manager {
	life, stop := context.WithCancel(context.Background())
	return &Manager{path: path, dial: dialServer, life: life, stop: stop, servers: map[string]*server{}, byTool: map[string]*server{}}
}

// DefaultPath is <storage>/mcp.json, overridden by LOGSONIC_AGENT_MCP_CONFIG.
func DefaultPath(storageDir string) string {
	if v := strings.TrimSpace(os.Getenv("LOGSONIC_AGENT_MCP_CONFIG")); v != "" {
		return v
	}
	return filepath.Join(storageDir, "mcp.json")
}

// Path is the config file location.
func (m *Manager) Path() string { return m.path }

func fileStamp(path string) string {
	fi, err := os.Stat(path)
	if err != nil {
		return "missing"
	}
	return fmt.Sprintf("%d:%d", fi.ModTime().UnixNano(), fi.Size())
}

// Prepare reloads the config when the file changed, stops servers that were
// removed or edited, and connects enabled servers that are not connected
// (a failed server is retried after retryAfter). Failures are recorded for
// Status and never returned: one broken server must not stop a chat.
func (m *Manager) Prepare(ctx context.Context) {
	m.prepareMu.Lock()
	defer m.prepareMu.Unlock()
	m.reload()

	m.mu.Lock()
	pending := []*server{}
	now := time.Now()
	for _, s := range m.servers {
		if s.cfg.Disabled || s.session != nil || (!s.tried.IsZero() && now.Sub(s.tried) < retryAfter) {
			continue
		}
		s.tried = now
		pending = append(pending, s)
	}
	m.mu.Unlock()

	type result struct {
		s       *server
		session Session
		tools   []exposedTool
		err     error
	}
	results := make(chan result, len(pending))
	for _, s := range pending {
		go func(s *server) {
			cctx, cancel := context.WithTimeout(ctx, connectTimeout)
			defer cancel()
			session, tools, err := m.connect(cctx, s)
			results <- result{s, session, tools, err}
		}(s)
	}
	for range pending {
		r := <-results
		m.mu.Lock()
		if current := m.servers[r.s.cfg.Name]; current != r.s {
			// Removed or replaced while connecting.
			m.mu.Unlock()
			if r.session != nil {
				_ = r.session.Close()
			}
			continue
		}
		if r.err != nil {
			r.s.err = r.err.Error()
			if tail := r.s.stderr.String(); tail != "" {
				r.s.err += " (stderr: " + tail + ")"
			}
			log.Printf("agent mcp: %s: %v", r.s.cfg.Name, r.err)
		} else {
			r.s.session, r.s.tools, r.s.err = r.session, r.tools, ""
		}
		m.rebuildIndexLocked()
		m.mu.Unlock()
	}
}

func (m *Manager) reload() {
	stamp := fileStamp(m.path)
	m.mu.Lock()
	unchanged := stamp == m.stamp
	m.mu.Unlock()
	if unchanged {
		return
	}
	file, err := Load(m.path)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stamp = stamp
	if err != nil {
		// Keep the running servers; report the broken file.
		m.fileErr = err.Error()
		return
	}
	m.fileErr, m.skipped = "", file.Skipped
	for _, msg := range file.Skipped {
		log.Printf("agent mcp: skipped %s", msg)
	}
	next := map[string]*server{}
	for _, cfg := range file.Servers {
		if old, ok := m.servers[cfg.Name]; ok && old.fp == cfg.fingerprint() {
			next[cfg.Name] = old
			continue
		}
		next[cfg.Name] = &server{cfg: cfg, fp: cfg.fingerprint(), stderr: &tailBuffer{}}
	}
	for name, old := range m.servers {
		if next[name] != old && old.session != nil {
			_ = old.session.Close()
		}
	}
	m.servers = next
	m.rebuildIndexLocked()
}

func (m *Manager) connect(ctx context.Context, s *server) (Session, []exposedTool, error) {
	session, err := m.dial(ctx, m.life, s.cfg, s.stderr)
	if err != nil {
		return nil, nil, err
	}
	var listed []mcp.Tool
	var cursor mcp.Cursor
	for range 10 {
		req := mcp.ListToolsRequest{}
		req.Params.Cursor = cursor
		res, err := session.ListTools(ctx, req)
		if err != nil {
			_ = session.Close()
			return nil, nil, fmt.Errorf("list tools: %w", err)
		}
		listed = append(listed, res.Tools...)
		if res.NextCursor == "" {
			break
		}
		cursor = res.NextCursor
	}
	return session, exposeTools(s.cfg, listed), nil
}

// exposeTools namespaces, filters and bounds a server's tool list.
func exposeTools(cfg ServerConfig, listed []mcp.Tool) []exposedTool {
	allowed := map[string]bool{}
	for _, t := range cfg.Tools {
		allowed[t] = true
	}
	sort.Slice(listed, func(i, j int) bool { return listed[i].Name < listed[j].Name })
	out := []exposedTool{}
	used := map[string]bool{}
	for _, tool := range listed {
		if len(allowed) > 0 && !allowed[tool.Name] {
			continue
		}
		if len(out) == maxToolsPerSrv {
			log.Printf("agent mcp: %s offers more than %d tools; list the ones to use in \"tools\"", cfg.Name, maxToolsPerSrv)
			break
		}
		name := ToolName(cfg.Name, tool.Name)
		if used[name] {
			continue
		}
		used[name] = true
		desc := strings.TrimSpace(tool.Description)
		if desc == "" {
			desc = tool.Title
		}
		if len(desc) > maxDescription {
			desc = desc[:maxDescription] + "…"
		}
		out = append(out, exposedTool{
			name:     name,
			original: tool.Name,
			schema: map[string]any{
				"name":         name,
				"description":  fmt.Sprintf("[External MCP server %q, tool %q] %s", cfg.Name, tool.Name, desc),
				"input_schema": inputSchema(tool),
			},
		})
	}
	return out
}

// ToolName builds mcp__<server>__<tool> within the 64-character limit. A
// name that had to be shortened or cleaned gets a short hash suffix so two
// long tool names cannot collide.
func ToolName(serverName, tool string) string {
	clean := unsafeToolChars.ReplaceAllString(tool, "_")
	name := ToolPrefix + serverName + "__" + clean
	if len(name) <= maxToolName && clean == tool {
		return name
	}
	sum := sha256.Sum256([]byte(tool))
	suffix := "_" + hex.EncodeToString(sum[:3])
	room := max(1, maxToolName-len(ToolPrefix)-len(serverName)-2-len(suffix))
	if len(clean) > room {
		clean = clean[:room]
	}
	return ToolPrefix + serverName + "__" + clean + suffix
}

func inputSchema(tool mcp.Tool) map[string]any {
	schema := map[string]any{}
	if len(tool.RawInputSchema) > 0 {
		_ = json.Unmarshal(tool.RawInputSchema, &schema)
	} else if b, err := json.Marshal(tool.InputSchema); err == nil {
		_ = json.Unmarshal(b, &schema)
	}
	if schema["type"] != "object" {
		schema["type"] = "object"
	}
	if _, ok := schema["properties"]; !ok {
		schema["properties"] = map[string]any{}
	}
	return schema
}

func (m *Manager) rebuildIndexLocked() {
	m.byTool = map[string]*server{}
	for _, s := range m.servers {
		if s.session == nil {
			continue
		}
		for _, t := range s.tools {
			m.byTool[t.name] = s
		}
	}
}

// Schemas returns Messages API tool definitions for every connected server,
// sorted by name so the tool list (and the prompt cache) stays stable.
func (m *Manager) Schemas() []map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	names := make([]string, 0, len(m.servers))
	for name := range m.servers {
		names = append(names, name)
	}
	sort.Strings(names)
	out := []map[string]any{}
	for _, name := range names {
		s := m.servers[name]
		if s.session == nil {
			continue
		}
		for _, t := range s.tools {
			out = append(out, t.schema)
		}
	}
	return out
}

// Call runs one external tool. A transport failure drops the session so the
// next Prepare reconnects; a tool that reports isError becomes an error.
func (m *Manager) Call(ctx context.Context, name string, args map[string]any) (any, error) {
	m.mu.Lock()
	s := m.byTool[name]
	var session Session
	var original string
	if s != nil {
		session = s.session
		for _, t := range s.tools {
			if t.name == name {
				original = t.original
			}
		}
	}
	m.mu.Unlock()
	if session == nil || original == "" {
		return nil, fmt.Errorf("external tool %q is not connected", name)
	}
	cctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	req := mcp.CallToolRequest{}
	req.Params.Name = original
	req.Params.Arguments = args
	res, err := session.CallTool(cctx, req)
	if err != nil {
		if ctx.Err() == nil {
			m.mu.Lock()
			if s.session == session {
				_ = session.Close()
				s.session, s.err, s.tried = nil, "disconnected after a failed call: "+err.Error(), time.Time{}
				m.rebuildIndexLocked()
			}
			m.mu.Unlock()
		}
		return nil, fmt.Errorf("%s: %w", s.cfg.Name, err)
	}
	text, structured := renderResult(res)
	if res.IsError {
		if text == "" {
			text = "the tool reported an error"
		}
		return nil, errors.New(text)
	}
	out := map[string]any{"server": s.cfg.Name, "tool": original, "text": text}
	if structured != nil && text == "" {
		out["structured"] = structured
	}
	return out, nil
}

// renderResult flattens MCP content blocks into text. Binary blocks become a
// one-line placeholder: base64 would only use up the tool output budget.
func renderResult(res *mcp.CallToolResult) (string, any) {
	parts := []string{}
	for _, content := range res.Content {
		raw, err := json.Marshal(content)
		if err != nil {
			continue
		}
		var block map[string]any
		if json.Unmarshal(raw, &block) != nil {
			continue
		}
		str := func(m map[string]any, k string) string { v, _ := m[k].(string); return v }
		switch str(block, "type") {
		case "text":
			parts = append(parts, str(block, "text"))
		case "image", "audio":
			parts = append(parts, fmt.Sprintf("[%s %s omitted, %d base64 characters]", str(block, "type"), str(block, "mimeType"), len(str(block, "data"))))
		case "resource":
			resource, _ := block["resource"].(map[string]any)
			if text := str(resource, "text"); text != "" {
				parts = append(parts, text)
			} else {
				parts = append(parts, fmt.Sprintf("[binary resource %s omitted]", str(resource, "uri")))
			}
		case "resource_link":
			parts = append(parts, fmt.Sprintf("[resource %s: %s]", str(block, "name"), str(block, "uri")))
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n")), res.StructuredContent
}

// ServerStatus is what the status endpoint shows. It never includes env
// values, headers, arguments or URL paths and queries, which may hold tokens.
type ServerStatus struct {
	Name      string   `json:"name"`
	Transport string   `json:"transport"`
	Target    string   `json:"target"`
	Disabled  bool     `json:"disabled,omitempty"`
	Connected bool     `json:"connected"`
	Tools     []string `json:"tools"`
	Error     string   `json:"error,omitempty"`
}

// Status describes the config file and each server.
type Status struct {
	Config     string         `json:"config"`
	ConfigErr  string         `json:"config_error,omitempty"`
	Skipped    []string       `json:"skipped,omitempty"`
	Servers    []ServerStatus `json:"servers"`
	Connected  int            `json:"connected"`
	ToolCount  int            `json:"tool_count"`
	ConfigSeen bool           `json:"config_exists"`
}

func target(cfg ServerConfig) string {
	if cfg.Kind() == TransportStdio {
		return filepath.Base(cfg.Command)
	}
	if u, err := url.Parse(cfg.URL); err == nil {
		return u.Scheme + "://" + u.Host
	}
	return ""
}

// Status reports the last known state without connecting anything.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := Status{Config: m.path, ConfigErr: m.fileErr, Skipped: m.skipped, Servers: []ServerStatus{}}
	_, statErr := os.Stat(m.path)
	out.ConfigSeen = statErr == nil
	names := make([]string, 0, len(m.servers))
	for name := range m.servers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		s := m.servers[name]
		st := ServerStatus{Name: name, Transport: s.cfg.Kind(), Target: target(s.cfg), Disabled: s.cfg.Disabled, Connected: s.session != nil, Tools: []string{}, Error: s.err}
		if s.session != nil {
			out.Connected++
			for _, t := range s.tools {
				st.Tools = append(st.Tools, t.name)
			}
			out.ToolCount += len(s.tools)
		}
		out.Servers = append(out.Servers, st)
	}
	return out
}

// Close stops every server; stdio children exit with their pipes.
func (m *Manager) Close() error {
	m.prepareMu.Lock()
	defer m.prepareMu.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.servers {
		if s.session != nil {
			_ = s.session.Close()
			s.session = nil
		}
	}
	m.byTool = map[string]*server{}
	m.stop()
	return nil
}

// childEnv is the stdio server environment: LogSonic's own, minus model
// credentials (LOGSONIC_AGENT_*, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN),
// plus the entry's env. A server that needs one of those lists it in env.
func childEnv(extra map[string]string) []string {
	env := []string{}
	for _, kv := range os.Environ() {
		key, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(key, "LOGSONIC_AGENT_") || key == "ANTHROPIC_API_KEY" || key == "ANTHROPIC_AUTH_TOKEN" {
			continue
		}
		if _, overridden := extra[key]; overridden {
			continue
		}
		env = append(env, kv)
	}
	keys := make([]string, 0, len(extra))
	for k := range extra {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		env = append(env, k+"="+extra[k])
	}
	return env
}

func dialServer(ctx, life context.Context, cfg ServerConfig, stderr *tailBuffer) (Session, error) {
	var c *client.Client
	var err error
	switch cfg.Kind() {
	case TransportStdio:
		c, err = client.NewStdioMCPClientWithOptions(cfg.Command, nil, cfg.Args, transport.WithCommandFunc(func(_ context.Context, command string, _ []string, args []string) (*exec.Cmd, error) {
			// Not bound to a request context: the server outlives the chat
			// that started it and stops in Close.
			cmd := exec.Command(command, args...)
			cmd.Env = childEnv(cfg.Env)
			return cmd, nil
		}))
		if err == nil {
			if r, ok := client.GetStderr(c); ok {
				go func() { _, _ = io.Copy(stderr, r) }()
			}
		}
	case TransportSSE:
		// Start opens the event stream, which must outlive the handshake.
		c, err = client.NewSSEMCPClient(cfg.URL, client.WithHeaders(cfg.Headers))
		if err == nil {
			err = c.Start(life)
		}
	default:
		c, err = client.NewStreamableHttpClient(cfg.URL, transport.WithHTTPHeaders(cfg.Headers))
		if err == nil {
			err = c.Start(life)
		}
	}
	if err != nil {
		if c != nil {
			_ = c.Close()
		}
		return nil, err
	}
	init := mcp.InitializeRequest{}
	init.Params.ProtocolVersion = mcp.LATEST_PROTOCOL_VERSION
	init.Params.ClientInfo = mcp.Implementation{Name: "logsonic-agent", Version: "1.0"}
	if _, err := c.Initialize(ctx, init); err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("initialize: %w", err)
	}
	return c, nil
}

// tailBuffer keeps the last stderrTail bytes a stdio server wrote, for
// error messages.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > stderrTail {
		t.buf = t.buf[len(t.buf)-stderrTail:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	if t == nil {
		return ""
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	lines := bytes.Split(bytes.TrimSpace(t.buf), []byte("\n"))
	if len(lines) > 3 {
		lines = lines[len(lines)-3:]
	}
	return string(bytes.Join(lines, []byte(" | ")))
}
