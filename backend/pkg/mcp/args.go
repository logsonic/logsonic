package mcp

import (
	"encoding/json"
	"fmt"
	"maps"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
)

// stringList reads a list argument that clients send in any of three
// shapes: a JSON array, a JSON-array string ("[\"a\",\"b\"]"), or a
// comma-separated string ("a,b"). Missing or empty yields nil.
func stringList(req mcp.CallToolRequest, key string) ([]string, error) {
	raw, ok := req.GetArguments()[key]
	if !ok || raw == nil {
		return nil, nil
	}
	switch v := raw.(type) {
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			s, ok := item.(string)
			if !ok {
				return nil, fmt.Errorf("%s must contain only strings", key)
			}
			if s = strings.TrimSpace(s); s != "" {
				out = append(out, s)
			}
		}
		return out, nil
	case string:
		trimmed := strings.TrimSpace(v)
		if strings.HasPrefix(trimmed, "[") {
			var out []string
			if err := json.Unmarshal([]byte(trimmed), &out); err != nil {
				return nil, fmt.Errorf("%s: invalid JSON array: %w", key, err)
			}
			return out, nil
		}
		return splitCSV(trimmed), nil
	default:
		return nil, fmt.Errorf("%s must be an array of strings or a comma-separated string", key)
	}
}

// stringMap reads an object argument sent as a JSON object or a JSON string.
func stringMap(req mcp.CallToolRequest, key string) (map[string]string, error) {
	raw, ok := req.GetArguments()[key]
	if !ok || raw == nil {
		return nil, nil
	}
	switch v := raw.(type) {
	case map[string]any:
		out := make(map[string]string, len(v))
		for k, item := range v {
			s, ok := item.(string)
			if !ok {
				return nil, fmt.Errorf("%s.%s must be a string", key, k)
			}
			out[k] = s
		}
		return out, nil
	case string:
		if strings.TrimSpace(v) == "" {
			return nil, nil
		}
		var out map[string]string
		if err := json.Unmarshal([]byte(v), &out); err != nil {
			return nil, fmt.Errorf("%s: invalid JSON object: %w", key, err)
		}
		return out, nil
	default:
		return nil, fmt.Errorf("%s must be an object of string values", key)
	}
}

// argsWithout copies the call's arguments minus the named keys, for tools
// that forward most of their arguments to a UI command.
func argsWithout(req mcp.CallToolRequest, drop ...string) map[string]any {
	out := maps.Clone(req.GetArguments())
	if out == nil {
		out = map[string]any{}
	}
	for _, k := range drop {
		delete(out, k)
	}
	return out
}

func requiredString(req mcp.CallToolRequest, key string) (string, error) {
	v := strings.TrimSpace(req.GetString(key, ""))
	if v == "" {
		return "", fmt.Errorf("%s is required", key)
	}
	return v, nil
}
