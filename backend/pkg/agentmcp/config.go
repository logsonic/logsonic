// Package agentmcp connects the embedded chat agent to external MCP servers
// so their tools can be used in an investigation next to LogSonic's own.
//
// Servers are declared in a JSON file the user edits by hand, in the same
// shape Claude Desktop and Claude Code use, so existing entries can be
// pasted in:
//
//	{
//	  "mcpServers": {
//	    "github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {"GITHUB_TOKEN": "..."}},
//	    "tickets": {"type": "http", "url": "https://mcp.example.com/mcp", "headers": {"Authorization": "Bearer ..."}, "tools": ["search"]}
//	  }
//	}
//
// The file is the only way to add a server. There is deliberately no HTTP
// endpoint that writes it: a stdio entry runs a command as the LogSonic
// user, and a request body must never be able to define one.
package agentmcp

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
)

// Transport kinds.
const (
	TransportStdio = "stdio"
	TransportHTTP  = "http"
	TransportSSE   = "sse"
)

// ServerConfig is one entry under mcpServers.
type ServerConfig struct {
	Name string `json:"-"`
	// Type is stdio, http (streamable HTTP) or sse. Empty means stdio when
	// Command is set and http when URL is set. "transport" is accepted as
	// an alias, and "streamable-http" / "streamableHttp" as http.
	Type      string            `json:"type,omitempty"`
	Transport string            `json:"transport,omitempty"`
	Command   string            `json:"command,omitempty"`
	Args      []string          `json:"args,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	URL       string            `json:"url,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
	// Tools, when set, limits which of the server's tools the agent sees.
	Tools []string `json:"tools,omitempty"`
	// Disabled keeps the entry in the file without starting it.
	Disabled bool `json:"disabled,omitempty"`
}

// Kind returns the normalized transport.
func (c ServerConfig) Kind() string {
	kind := strings.ToLower(strings.TrimSpace(c.Type))
	if kind == "" {
		kind = strings.ToLower(strings.TrimSpace(c.Transport))
	}
	switch kind {
	case "streamable-http", "streamablehttp", "streamable_http":
		return TransportHTTP
	case "":
		if c.Command != "" {
			return TransportStdio
		}
		return TransportHTTP
	}
	return kind
}

var serverNamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

// Validate checks an entry before anything is started.
func (c ServerConfig) Validate() error {
	if !serverNamePattern.MatchString(c.Name) || strings.Contains(c.Name, "__") {
		return fmt.Errorf("server name %q must be 1-32 letters, digits, '-' or '_' without '__'", c.Name)
	}
	switch c.Kind() {
	case TransportStdio:
		if strings.TrimSpace(c.Command) == "" {
			return errors.New("stdio server needs a command")
		}
	case TransportHTTP, TransportSSE:
		if !strings.HasPrefix(c.URL, "http://") && !strings.HasPrefix(c.URL, "https://") {
			return errors.New("http and sse servers need an http(s) url")
		}
	default:
		return fmt.Errorf("unknown transport %q (use stdio, http or sse)", c.Kind())
	}
	return nil
}

// fingerprint identifies a configuration so an edited entry is restarted.
func (c ServerConfig) fingerprint() string {
	b, _ := json.Marshal(c)
	return c.Name + "\x00" + string(b)
}

// File is the parsed config: valid servers sorted by name, plus one message
// per entry that was skipped.
type File struct {
	Servers []ServerConfig
	Skipped []string
}

// Parse reads the mcpServers map. A malformed entry is skipped with a
// message; a malformed file is an error.
func Parse(data []byte) (File, error) {
	var doc struct {
		MCPServers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return File{}, fmt.Errorf("not valid JSON: %w", err)
	}
	var out File
	names := make([]string, 0, len(doc.MCPServers))
	for name := range doc.MCPServers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		var cfg ServerConfig
		if err := json.Unmarshal(doc.MCPServers[name], &cfg); err != nil {
			out.Skipped = append(out.Skipped, fmt.Sprintf("%s: %v", name, err))
			continue
		}
		cfg.Name = name
		if err := cfg.Validate(); err != nil {
			out.Skipped = append(out.Skipped, fmt.Sprintf("%s: %v", name, err))
			continue
		}
		out.Servers = append(out.Servers, cfg)
	}
	return out, nil
}

// Load reads and parses path. A missing file means no servers.
func Load(path string) (File, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return File{}, nil
	}
	if err != nil {
		return File{}, err
	}
	return Parse(data)
}
