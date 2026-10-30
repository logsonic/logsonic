package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// UIAdapter exposes the existing MCP UI tool definitions and handlers to the
// embedded chat agent. It deliberately omits ui_focus and every non-UI tool.
type UIAdapter struct{ tools *server.MCPServer }

func NewUIAdapter(baseURL func() string) *UIAdapter {
	s := server.NewMCPServer("LogSonic embedded UI", "1.0")
	registerUITools(s, newClientWithBaseURLProvider(baseURL))
	return &UIAdapter{tools: s}
}

func allowedEmbeddedUITool(name string) bool {
	return strings.HasPrefix(name, "ui_") && name != "ui_focus"
}

// Schemas returns Anthropic tool definitions directly from the MCP registry.
func (a *UIAdapter) Schemas() []map[string]any {
	registered := a.tools.ListTools()
	names := make([]string, 0, len(registered))
	for name := range registered {
		if allowedEmbeddedUITool(name) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	out := make([]map[string]any, 0, len(names))
	for _, name := range names {
		tool := registered[name].Tool
		out = append(out, map[string]any{"name": tool.Name, "description": tool.Description, "input_schema": tool.InputSchema})
	}
	return out
}

// Call invokes the original MCP UI handler. Its HTTP request inherits ctx,
// so cancellation also stops the pending /ui/command acknowledgement wait.
func (a *UIAdapter) Call(ctx context.Context, name string, args map[string]any) (any, error) {
	if !allowedEmbeddedUITool(name) {
		return nil, fmt.Errorf("unknown UI tool %q", name)
	}
	tool := a.tools.GetTool(name)
	if tool == nil {
		return nil, fmt.Errorf("unknown UI tool %q", name)
	}
	encoded, err := json.Marshal(args)
	if err != nil || len(encoded) > 16*1024 {
		return nil, errors.New("UI tool input exceeds 16 KiB")
	}
	if name == "ui_show_view" {
		if filters, ok := args["filters"].([]any); ok && len(filters) > 8 {
			return nil, errors.New("ui_show_view accepts at most eight filters")
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var req mcp.CallToolRequest
	req.Params.Name = name
	req.Params.Arguments = args
	result, err := tool.Handler(ctx, req)
	if err != nil {
		return nil, err
	}
	if result == nil {
		return nil, errors.New("UI tool returned no result")
	}
	var text []string
	for _, block := range result.Content {
		if item, ok := block.(mcp.TextContent); ok {
			text = append(text, item.Text)
		}
	}
	joined := strings.Join(text, "\n")
	if result.IsError {
		return nil, errors.New(joined)
	}
	var decoded any
	if json.Unmarshal([]byte(joined), &decoded) == nil {
		return decoded, nil
	}
	return joined, nil
}
