package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"logsonic/pkg/storage"
	"logsonic/pkg/types"
)

// Limits for log_patterns. The scan covers far more rows than facet_logs so
// rare events in a large corpus are found; the output stays small because it
// reports groups, not rows.
const (
	agentPatternDefaultRows = 300_000
	agentPatternMaxRows     = 1_000_000
	agentPatternMaxGroups   = 5000
	agentPatternMsgBytes    = 512
	agentPatternFieldValues = 200
	agentPatternOutputBytes = 26 * 1024
)

// rowScanner is implemented by the storage backends that can stream every
// row of a window. Handler tests may use storage fakes without it.
type rowScanner interface {
	ScanRows(ctx context.Context, options storage.SearchOptions, maxRows int, fn func(map[string]interface{})) (storage.ScanResult, error)
}

var (
	patternEmail = regexp.MustCompile(`[\w.+-]+@[\w-]+\.[\w.-]+`)
	// Any token containing a digit: numbers, IDs, IPs, durations, hex, dates.
	// '=' ends a token, so key=value keeps its key.
	patternDigits = regexp.MustCompile(`[A-Za-z0-9_.:/@+#-]*[0-9][A-Za-z0-9_.:/@+#-]*`)
	// Hex identifiers that happen to contain no digit (ord-bfaebefdda).
	patternHex    = regexp.MustCompile(`\b[0-9a-fA-F]{8,}\b`)
	patternSpaces = regexp.MustCompile(`\s+`)
)

// maskMessage turns a log message into a template by replacing variable
// tokens with <*>. Tokens without digits (paths, words, codes such as
// DO_NOT_HONOR) are kept because they usually carry the meaning.
func maskMessage(msg string) string {
	if len(msg) > agentPatternMsgBytes {
		cut := agentPatternMsgBytes
		for cut > 0 && !utf8.RuneStart(msg[cut]) {
			cut--
		}
		msg = msg[:cut]
	}
	msg = patternEmail.ReplaceAllString(msg, "<*>")
	msg = patternDigits.ReplaceAllString(msg, "<*>")
	msg = patternHex.ReplaceAllString(msg, "<*>")
	return strings.TrimSpace(patternSpaces.ReplaceAllString(msg, " "))
}

// rowMessage returns the free-text part of a row.
func rowMessage(row map[string]interface{}) string {
	for _, key := range []string{"message", "msg", "log", "event", "error", "_raw"} {
		if s, ok := row[key].(string); ok && strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

func rowLevel(row map[string]interface{}) string {
	for _, key := range []string{"level", "severity", "loglevel", "log_level"} {
		if v, ok := row[key]; ok && v != nil {
			return strings.ToUpper(fmt.Sprint(v))
		}
	}
	return ""
}

func scalarString(raw interface{}) (string, bool) {
	switch v := raw.(type) {
	case string:
		return v, true
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64), true
	case bool:
		return strconv.FormatBool(v), true
	case int:
		return strconv.Itoa(v), true
	case int64:
		return strconv.FormatInt(v, 10), true
	default:
		return "", false
	}
}

func shorten(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

type patternGroup struct {
	Template string         `json:"template"`
	Count    int            `json:"count"`
	First    time.Time      `json:"first_seen"`
	Last     time.Time      `json:"last_seen"`
	Sources  map[string]int `json:"sources"`
	Levels   map[string]int `json:"levels,omitempty"`
	Example  string         `json:"example"`
	ExSource string         `json:"example_source"`
	ExTime   time.Time      `json:"example_time"`
}

type valueStat struct {
	count       int
	first, last time.Time
	sources     map[string]int
}

type fieldStat struct {
	rows   int
	values map[string]*valueStat // nil once the field has too many values
	first  time.Time
	last   time.Time
}

type patternMiner struct {
	rows         int
	groups       map[string]*patternGroup
	overflow     int
	fields       map[string]*fieldStat
	first, last  time.Time
	withoutTimes int
}

func newPatternMiner() *patternMiner {
	return &patternMiner{groups: map[string]*patternGroup{}, fields: map[string]*fieldStat{}}
}

func widen(first, last *time.Time, at time.Time) {
	if first.IsZero() || at.Before(*first) {
		*first = at
	}
	if last.IsZero() || at.After(*last) {
		*last = at
	}
}

// Add folds one row into the message templates and field value counts.
func (m *patternMiner) Add(row map[string]interface{}) {
	m.rows++
	at, _ := row["timestamp"].(time.Time)
	if at.IsZero() {
		m.withoutTimes++
	} else {
		widen(&m.first, &m.last, at)
	}
	source := fmt.Sprint(row["_src"])
	if msg := rowMessage(row); msg != "" {
		m.addMessage(msg, source, rowLevel(row), at)
	}
	for field, raw := range row {
		switch field {
		case "timestamp", "message", "msg", "_raw":
			continue
		}
		if strings.HasPrefix(field, "_") && field != "_src" {
			continue
		}
		value, ok := scalarString(raw)
		if !ok {
			continue
		}
		fs := m.fields[field]
		if fs == nil {
			fs = &fieldStat{values: map[string]*valueStat{}}
			m.fields[field] = fs
		}
		fs.rows++
		widen(&fs.first, &fs.last, at)
		if fs.values == nil {
			continue
		}
		vs := fs.values[value]
		if vs == nil {
			if len(fs.values) >= agentPatternFieldValues {
				fs.values = nil // identifiers, amounts: not useful as categories
				continue
			}
			vs = &valueStat{sources: map[string]int{}}
			fs.values[value] = vs
		}
		vs.count++
		widen(&vs.first, &vs.last, at)
		vs.sources[source]++
	}
}

func (m *patternMiner) addMessage(msg, source, level string, at time.Time) {
	key := maskMessage(msg)
	g := m.groups[key]
	if g == nil {
		if len(m.groups) >= agentPatternMaxGroups {
			m.overflow++
			return
		}
		g = &patternGroup{Template: key, Sources: map[string]int{}, Levels: map[string]int{}, Example: shorten(msg, 300), ExSource: source, ExTime: at}
		m.groups[key] = g
	}
	g.Count++
	widen(&g.First, &g.Last, at)
	g.Sources[source]++
	if level != "" {
		g.Levels[level]++
	}
}

func topKeys(m map[string]int, n int) map[string]int {
	if len(m) <= n {
		return m
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if m[keys[i]] != m[keys[j]] {
			return m[keys[i]] > m[keys[j]]
		}
		return keys[i] < keys[j]
	})
	out := map[string]int{}
	for _, k := range keys[:n] {
		out[k] = m[k]
	}
	return out
}

type rareValue struct {
	Value   string         `json:"value"`
	Count   int            `json:"count"`
	First   time.Time      `json:"first_seen"`
	Last    time.Time      `json:"last_seen"`
	Sources map[string]int `json:"sources"`
}

type rareField struct {
	Field     string      `json:"field"`
	PresentIn int         `json:"present_in"`
	Distinct  int         `json:"distinct"`
	Rare      []rareValue `json:"rare_values"`
}

type sparseField struct {
	Field     string    `json:"field"`
	PresentIn int       `json:"present_in"`
	First     time.Time `json:"first_seen"`
	Last      time.Time `json:"last_seen"`
}

// result renders the mined groups. sortBy is "rare" (fewest rows first),
// "count" (most rows first) or "onset" (latest first appearance first).
func (m *patternMiner) result(sortBy string, limit, valuesPerField int) map[string]any {
	groups := make([]*patternGroup, 0, len(m.groups))
	for _, g := range m.groups {
		groups = append(groups, g)
	}
	sort.Slice(groups, func(i, j int) bool {
		a, b := groups[i], groups[j]
		switch sortBy {
		case "count":
			if a.Count != b.Count {
				return a.Count > b.Count
			}
		case "onset":
			if !a.First.Equal(b.First) {
				return a.First.After(b.First)
			}
		default:
			if a.Count != b.Count {
				return a.Count < b.Count
			}
		}
		return a.Template < b.Template
	})
	if len(groups) > limit {
		groups = groups[:limit]
	}
	for _, g := range groups {
		g.Template = shorten(g.Template, 200)
		g.Sources = topKeys(g.Sources, 3)
		g.Levels = topKeys(g.Levels, 3)
	}

	// Rare values: categorical fields (at most agentPatternFieldValues
	// distinct values) whose least common values make up at most 2% of the
	// rows carrying the field.
	rare := []rareField{}
	sparse := []sparseField{}
	names := make([]string, 0, len(m.fields))
	for name := range m.fields {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fs := m.fields[name]
		if m.rows >= 50 && float64(fs.rows) <= 0.02*float64(m.rows) {
			sparse = append(sparse, sparseField{name, fs.rows, fs.first, fs.last})
		}
		if len(fs.values) < 2 {
			continue
		}
		threshold := max(1, int(0.02*float64(fs.rows)))
		item := rareField{Field: name, PresentIn: fs.rows, Distinct: len(fs.values)}
		for value, vs := range fs.values {
			if vs.count <= threshold {
				item.Rare = append(item.Rare, rareValue{shorten(value, 120), vs.count, vs.first, vs.last, topKeys(vs.sources, 3)})
			}
		}
		if len(item.Rare) == 0 {
			continue
		}
		sort.Slice(item.Rare, func(i, j int) bool {
			if item.Rare[i].Count != item.Rare[j].Count {
				return item.Rare[i].Count < item.Rare[j].Count
			}
			return item.Rare[i].Value < item.Rare[j].Value
		})
		if len(item.Rare) > valuesPerField {
			item.Rare = item.Rare[:valuesPerField]
		}
		rare = append(rare, item)
	}
	sort.SliceStable(rare, func(i, j int) bool { return rare[i].Rare[0].Count < rare[j].Rare[0].Count })
	if len(rare) > 25 {
		rare = rare[:25]
	}
	sort.Slice(sparse, func(i, j int) bool { return sparse[i].PresentIn < sparse[j].PresentIn })
	if len(sparse) > 20 {
		sparse = sparse[:20]
	}
	out := map[string]any{
		"distinct_patterns": len(m.groups),
		"patterns":          groups,
		"rare_values":       rare,
		"sparse_fields":     sparse,
	}
	if !m.first.IsZero() {
		out["span"] = map[string]any{"first": m.first, "last": m.last}
	}
	if m.overflow > 0 {
		out["rows_in_uncounted_patterns"] = m.overflow
	}
	return out
}

func (h *Services) agentPatterns(ctx context.Context, in map[string]any) (any, error) {
	scanner, ok := h.storage.(rowScanner)
	if !ok {
		return nil, errors.New("storage backend cannot scan rows")
	}
	query, err := agentQueryText(in)
	if err != nil {
		return nil, err
	}
	start, end, err := agentTimeRange(in, "start_time", "end_time")
	if err != nil {
		return nil, err
	}
	sortBy := toolString(in, "sort")
	if sortBy != "count" && sortBy != "onset" {
		sortBy = "rare"
	}
	limit := agentInt(in, "limit", 40, 1, 80)
	maxRows := agentInt(in, "max_rows", agentPatternDefaultRows, 1000, agentPatternMaxRows)
	miner := newPatternMiner()
	scan, err := scanner.ScanRows(ctx, storage.SearchOptions{Query: query, StartDate: start, EndDate: end, Sources: agentSources(in), SortBy: "timestamp", SortOrder: "desc"}, maxRows, miner.Add)
	if err != nil {
		return nil, err
	}
	// Shrink the lists until the result fits the tool output budget.
	values := 4
	for {
		out := miner.result(sortBy, limit, values)
		out["total_count"] = scan.Total
		out["scanned"] = scan.Rows
		out["truncated"] = scan.Truncated
		out["sort"] = sortBy
		note := "Counts are exact over every scanned row."
		if scan.Truncated {
			note = "Only the newest scanned rows were mined; raise max_rows or narrow the window for full coverage."
		}
		out["note"] = note + " Templates mask tokens containing digits as <*>; query a constant phrase from the template or example to see its rows."
		encoded, _ := json.Marshal(out)
		if len(encoded) <= agentPatternOutputBytes || (limit <= 5 && values <= 1) {
			return out, nil
		}
		limit = max(5, limit*2/3)
		values = max(1, values-1)
	}
}

// agentSaveView stores a finding as a workspace with a fixed time window, so
// the operator can reopen exactly the evidence the agent confirmed.
func (h *Services) agentSaveView(ctx context.Context, in map[string]any) (any, error) {
	if h.Workspaces == nil {
		return nil, errors.New("workspace store unavailable")
	}
	start, end, err := agentTimeRange(in, "start_time", "end_time")
	if err != nil {
		return nil, err
	}
	if toolString(in, "start_time") == "" || toolString(in, "end_time") == "" {
		return nil, errors.New("start_time and end_time are required")
	}
	query, err := agentQueryText(in)
	if err != nil {
		return nil, err
	}
	columns := []string{}
	if raw, ok := in["columns"].([]any); ok {
		for _, c := range raw {
			if s, ok := c.(string); ok && strings.TrimSpace(s) != "" {
				columns = append(columns, strings.TrimSpace(s))
			}
		}
	}
	ws := types.Workspace{
		Name:          toolString(in, "name"),
		Description:   toolString(in, "description"),
		Query:         query,
		Sources:       agentSources(in),
		Time:          types.WorkspaceTime{Mode: "absolute", Start: start.UTC().Format(time.RFC3339), End: end.UTC().Format(time.RFC3339)},
		SortBy:        "timestamp",
		SortOrder:     "asc",
		Columns:       columns,
		Visualization: types.WorkspaceVisualization{Type: "logs", Bucket: "auto"},
	}
	if field, value := toolString(in, "highlight_field"), toolString(in, "highlight_value"); field != "" && value != "" {
		ws.ColorRules = []types.WorkspaceColorRule{{Field: field, Operator: "contains", Value: value, Color: "bg-red-100", Enabled: true}}
	}
	saved, err := h.Workspaces.Create(ws)
	if err != nil {
		return nil, err
	}
	total, err := h.agentTotal(ctx, query, ws.Sources, start, end)
	if err != nil {
		return nil, err
	}
	out := map[string]any{"id": saved.ID, "name": saved.Name, "matching_rows": total}
	if total == 0 {
		out["warning"] = "The saved view matches no rows; check the query, sources and window."
	}
	return out, nil
}
