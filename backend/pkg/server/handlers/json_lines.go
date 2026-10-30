package handlers

import (
	"bytes"
	"encoding/json"
	"strings"
)

// jsonLineMaxDepth bounds how deep nested objects are flattened into
// parent_child field names; deeper values are kept as compact JSON.
const jsonLineMaxDepth = 3

// jsonLineFields decodes one JSON object line into string fields, keeping
// the producer's key names. Nested objects flatten to parent_child names,
// arrays stay compact JSON, and nulls are dropped. Keys that collide with
// LogSonic's internal fields are prefixed with "json".
func jsonLineFields(line string) (map[string]string, bool) {
	line = strings.TrimSpace(line)
	if len(line) < 2 || line[0] != '{' || line[len(line)-1] != '}' {
		return nil, false
	}
	dec := json.NewDecoder(strings.NewReader(line))
	dec.UseNumber()
	var obj map[string]any
	if err := dec.Decode(&obj); err != nil || dec.More() {
		return nil, false
	}
	fields := make(map[string]string, len(obj))
	flattenJSONLine(fields, "", obj, 0)
	return fields, len(fields) > 0
}

func flattenJSONLine(fields map[string]string, prefix string, obj map[string]any, depth int) {
	for key, value := range obj {
		name := prefix + strings.ReplaceAll(key, ".", "_")
		switch name {
		case "_raw", "_src", "_seq", "_id":
			name = "json" + name
		}
		switch v := value.(type) {
		case nil:
		case string:
			fields[name] = v
		case json.Number:
			fields[name] = v.String()
		case bool:
			if v {
				fields[name] = "true"
			} else {
				fields[name] = "false"
			}
		case map[string]any:
			if depth < jsonLineMaxDepth {
				flattenJSONLine(fields, name+"_", v, depth+1)
				continue
			}
			fields[name] = compactJSON(v)
		default:
			fields[name] = compactJSON(v)
		}
	}
}

func compactJSON(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return ""
	}
	return strings.TrimSuffix(buf.String(), "\n")
}
