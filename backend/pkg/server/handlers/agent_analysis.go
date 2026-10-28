package handlers

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"logsonic/pkg/storage"
	"logsonic/pkg/types"
)

func agentSchema(properties map[string]any, required ...string) map[string]any {
	schema := map[string]any{"type": "object", "properties": properties}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

var (
	agentStringProp = map[string]any{"type": "string"}
	agentIntProp    = map[string]any{"type": "integer"}
	agentTimeProp   = map[string]any{"type": "string", "description": "RFC3339 timestamp, for example 2026-10-28T10:00:00Z"}
	agentQueryProp  = map[string]any{"type": "string", "description": "Bleve query; empty matches all rows"}
	agentSourceProp = map[string]any{"type": "string", "description": "Source name from list_sources; comma-separate several"}
)

var agentToolSchemas = []map[string]any{
	{"name": "ingest_local", "description": "Import a local absolute log file or a directory of log files (not recursive; hidden files are skipped). At most 16 files, 64 MiB per file. Credential locations such as ~/.ssh, ~/.aws or .env files are refused, and when LOGSONIC_AGENT_INGEST_ROOT is set the path must be inside it. Results are searchable immediately; skipped directory entries are listed with a reason.", "input_schema": agentSchema(map[string]any{"path": agentStringProp}, "path")},
	{"name": "ingest_remote", "description": "Download and import a public HTTPS log file (up to 16 MiB).", "input_schema": agentSchema(map[string]any{"url": agentStringProp}, "url")},
	{"name": "ingest_cloudwatch", "description": "Import up to 1000 CloudWatch log events using an explicitly named AWS CLI profile and region.", "input_schema": agentSchema(map[string]any{"profile": agentStringProp, "region": agentStringProp, "log_group": agentStringProp, "start_time_ms": agentIntProp, "end_time_ms": agentIntProp}, "profile", "region", "log_group")},
	{"name": "list_sources", "description": "List indexed log sources with their time spans and row counts. Start here to orient.", "input_schema": agentSchema(map[string]any{})},
	{"name": "log_histogram", "description": "Exact event counts over time (up to 100 buckets, split by source) for a query and window. Use it to find when errors or activity spike and which sources spike together.", "input_schema": agentSchema(map[string]any{"query": agentQueryProp, "source": agentSourceProp, "start_time": agentTimeProp, "end_time": agentTimeProp})},
	{"name": "facet_logs", "description": "Top values per field (level, service, host, status, _src ...) for the rows matching a query, scanning up to 20,000 newest rows. Use it to see what dominates an error slice before reading rows. Optional fields restricts the output; top sets values per field (max 8).", "input_schema": agentSchema(map[string]any{"query": agentQueryProp, "source": agentSourceProp, "start_time": agentTimeProp, "end_time": agentTimeProp, "fields": map[string]any{"type": "array", "items": agentStringProp}, "top": agentIntProp})},
	{"name": "compare_windows", "description": "Compare an incident window with a baseline window for the same query: exact totals, per-minute rates, and level and source breakdowns with deltas. Each window includes its start and excludes its end, so adjacent windows can share a boundary.", "input_schema": agentSchema(map[string]any{"query": agentQueryProp, "source": agentSourceProp, "baseline_start": agentTimeProp, "baseline_end": agentTimeProp, "incident_start": agentTimeProp, "incident_end": agentTimeProp}, "baseline_start", "baseline_end", "incident_start", "incident_end")},
	{"name": "query_logs", "description": "Search logs with Bleve query syntax, newest first. Quote hyphenated identifiers as exact phrases, for example trace_id:\"order-018\". Returns up to 50 rows plus the exact total_count; narrow the query when total_count exceeds returned rows.", "input_schema": agentSchema(map[string]any{"query": agentQueryProp, "source": agentSourceProp, "limit": agentIntProp, "start_time": agentTimeProp, "end_time": agentTimeProp})},
	{"name": "log_context", "description": "Rows surrounding a moment, oldest first: what happened just before and after an event. Give the event timestamp, optionally a source and query, and seconds before/after (default 60, max 900).", "input_schema": agentSchema(map[string]any{"timestamp": agentTimeProp, "source": agentSourceProp, "query": agentQueryProp, "before_seconds": agentIntProp, "after_seconds": agentIntProp, "limit": agentIntProp}, "timestamp")},
	{"name": "log_patterns", "description": "Full scan for rare and unusual events. Mines every matching row (default 300,000, max_rows up to 1,000,000) into message templates (tokens with digits masked as <*>) with count, first/last seen, sources, levels and an example; also lists rare values of categorical fields and sparse fields present in few rows. sort=rare (default, fewest rows first) finds needles; sort=count shows the bulk; sort=onset shows templates that appeared most recently. Use it early on any open-ended or 'find problems' request: subtle problems often sit in INFO or WARN rows, not ERROR.", "input_schema": agentSchema(map[string]any{"query": agentQueryProp, "source": agentSourceProp, "start_time": agentTimeProp, "end_time": agentTimeProp, "sort": map[string]any{"type": "string", "enum": []string{"rare", "count", "onset"}}, "limit": agentIntProp, "max_rows": agentIntProp})},
	{"name": "save_view", "description": "Save a confirmed finding as a named LogSonic workspace (a view the operator can reopen): query, sources, fixed time window, columns, and optional row highlight. Save one view per confirmed problem after checking that its query returns the evidence rows.", "input_schema": agentSchema(map[string]any{"name": agentStringProp, "description": agentStringProp, "query": agentQueryProp, "source": agentSourceProp, "start_time": agentTimeProp, "end_time": agentTimeProp, "columns": map[string]any{"type": "array", "items": agentStringProp}, "highlight_field": agentStringProp, "highlight_value": agentStringProp}, "name", "query", "start_time", "end_time")},
	{"name": "analyze_logs", "description": "Sampled summary of the newest 200 matching rows by source, severity and minute. Prefer log_histogram and facet_logs, which cover far more rows.", "input_schema": agentSchema(map[string]any{"query": agentQueryProp, "source": agentSourceProp, "start_time": agentTimeProp, "end_time": agentTimeProp})},
}

// agentTimeRange parses an optional RFC3339 window. Missing bounds default
// to the last year through tomorrow, which covers every indexed day.
func agentTimeRange(in map[string]any, startKey, endKey string) (time.Time, time.Time, error) {
	start := time.Now().AddDate(-1, 0, 0)
	end := time.Now().Add(24 * time.Hour)
	for _, pair := range []struct {
		key  string
		dest *time.Time
	}{{startKey, &start}, {endKey, &end}} {
		if s := toolString(in, pair.key); s != "" {
			parsed, err := time.Parse(time.RFC3339Nano, s)
			if err != nil {
				return start, end, fmt.Errorf("%s must be RFC3339", pair.key)
			}
			*pair.dest = parsed
		}
	}
	if end.Before(start) {
		return start, end, fmt.Errorf("%s precedes %s", endKey, startKey)
	}
	return start, end, nil
}

func agentSources(in map[string]any) []string {
	sources := []string{}
	for _, s := range strings.Split(toolString(in, "source"), ",") {
		if s = strings.TrimSpace(s); s != "" {
			sources = append(sources, s)
		}
	}
	return sources
}

func agentQueryText(in map[string]any) (string, error) {
	query := toolString(in, "query")
	if len(query) > 512 {
		return "", errors.New("query too long")
	}
	return query, nil
}

func agentInt(in map[string]any, key string, def, lo, hi int) int {
	v, ok := in[key].(float64)
	if !ok {
		return def
	}
	return min(max(int(v), lo), hi)
}

const agentMaxFieldChars = 2000

// trimAgentRows shortens long string fields (stack traces, payloads) so a
// handful of rows cannot exhaust the tool output budget. Other values keep
// their types.
func trimAgentRows(rows []map[string]interface{}) []map[string]interface{} {
	out := make([]map[string]interface{}, len(rows))
	for i, row := range rows {
		copied := make(map[string]interface{}, len(row))
		for k, v := range row {
			if s, ok := v.(string); ok && len(s) > agentMaxFieldChars {
				cut := agentMaxFieldChars
				for cut > 0 && !utf8.RuneStart(s[cut]) {
					cut--
				}
				v = s[:cut] + fmt.Sprintf("… [%d more bytes]", len(s)-cut)
			}
			copied[k] = v
		}
		out[i] = copied
	}
	return out
}

func (h *Services) agentTotal(ctx context.Context, query string, sources []string, start, end time.Time) (int, error) {
	page, err := h.storage.SearchPage(ctx, storage.SearchOptions{Query: query, StartDate: start, EndDate: end, Sources: sources, Limit: 1, SortBy: "timestamp", SortOrder: "desc", SkipDistribution: true})
	if err != nil {
		return 0, err
	}
	return page.TotalCount, nil
}

type agentFacetValue struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

type agentFacetField struct {
	Field           string            `json:"field"`
	Distinct        int               `json:"distinct"`
	HighCardinality bool              `json:"high_cardinality,omitempty"`
	Top             []agentFacetValue `json:"top,omitempty"`
}

func compactFacets(facets *types.FacetsResponse, only []string, top int) []agentFacetField {
	wanted := map[string]bool{}
	for _, f := range only {
		wanted[f] = true
	}
	out := []agentFacetField{}
	for _, field := range facets.Fields {
		if len(wanted) > 0 && !wanted[field.Name] {
			continue
		}
		item := agentFacetField{Field: field.Name, Distinct: field.Distinct, HighCardinality: field.HighCardinality}
		for i, v := range field.Values {
			if i >= top {
				break
			}
			item.Top = append(item.Top, agentFacetValue{v.Value, v.Count})
		}
		out = append(out, item)
		if len(out) >= 30 {
			break
		}
	}
	return out
}

func (h *Services) agentFacets(ctx context.Context, in map[string]any) (any, error) {
	query, err := agentQueryText(in)
	if err != nil {
		return nil, err
	}
	start, end, err := agentTimeRange(in, "start_time", "end_time")
	if err != nil {
		return nil, err
	}
	sources := agentSources(in)
	var fields []string
	if raw, ok := in["fields"].([]any); ok {
		for _, f := range raw {
			if s, ok := f.(string); ok && strings.TrimSpace(s) != "" {
				fields = append(fields, strings.TrimSpace(s))
			}
		}
	}
	top := agentInt(in, "top", 8, 1, storage.MaxFacetValues)
	facets, err := h.storage.Facets(ctx, storage.SearchOptions{Query: query, StartDate: start, EndDate: end, Sources: sources, SortBy: "timestamp", SortOrder: "desc"})
	if err != nil {
		return nil, err
	}
	total, err := h.agentTotal(ctx, query, sources, start, end)
	if err != nil {
		return nil, err
	}
	note := "Counts are exact over computed_over rows."
	if facets.Sampled {
		note = "Counts cover the newest computed_over rows only; total_count is exact."
	}
	return map[string]any{"total_count": total, "computed_over": facets.ComputedOver, "sampled": facets.Sampled, "fields": compactFacets(facets, fields, top), "note": note}, nil
}

type agentBucket struct {
	Start    string         `json:"start"`
	End      string         `json:"end"`
	Count    int            `json:"count"`
	BySource map[string]int `json:"by_source,omitempty"`
}

func (h *Services) agentHistogram(ctx context.Context, in map[string]any) (any, error) {
	query, err := agentQueryText(in)
	if err != nil {
		return nil, err
	}
	start, end, err := agentTimeRange(in, "start_time", "end_time")
	if err != nil {
		return nil, err
	}
	sources := agentSources(in)
	// Storage splits buckets by source only for an explicit source list, so
	// name every catalogued source when there are few enough to scan.
	if len(sources) == 0 && h.Catalog != nil {
		if list := h.Catalog.List(); len(list) > 1 && len(list) <= 12 {
			for _, s := range list {
				sources = append(sources, s.Name)
			}
		}
	}
	page, err := h.storage.SearchPage(ctx, storage.SearchOptions{Query: query, StartDate: start, EndDate: end, Sources: sources, Limit: 1, SortBy: "timestamp", SortOrder: "desc"})
	if err != nil {
		return nil, err
	}
	buckets := make([]agentBucket, 0, len(page.Distribution))
	var peak *agentBucket
	for _, b := range page.Distribution {
		item := agentBucket{Start: b.StartTime.UTC().Format(time.RFC3339), End: b.EndTime.UTC().Format(time.RFC3339), Count: b.Count}
		if b.Count > 0 && len(b.SourceCounts) > 0 {
			item.BySource = b.SourceCounts
		}
		buckets = append(buckets, item)
		if len(buckets) >= 120 {
			break
		}
	}
	// Leading and trailing empty buckets carry no information; trim them so
	// the default one-year window does not bury the active span.
	for len(buckets) > 0 && buckets[0].Count == 0 {
		buckets = buckets[1:]
	}
	for len(buckets) > 0 && buckets[len(buckets)-1].Count == 0 {
		buckets = buckets[:len(buckets)-1]
	}
	for i := range buckets {
		if peak == nil || buckets[i].Count > peak.Count {
			peak = &buckets[i]
		}
	}
	out := map[string]any{"total_count": page.TotalCount, "buckets": buckets}
	if peak != nil {
		out["peak"] = *peak
	}
	if len(buckets) > 0 {
		width, _ := time.Parse(time.RFC3339, buckets[0].End)
		from, _ := time.Parse(time.RFC3339, buckets[0].Start)
		out["bucket_seconds"] = int(width.Sub(from).Seconds())
	}
	return out, nil
}

func (h *Services) agentContext(ctx context.Context, in map[string]any) (any, error) {
	query, err := agentQueryText(in)
	if err != nil {
		return nil, err
	}
	raw := toolString(in, "timestamp")
	at, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return nil, errors.New("timestamp must be RFC3339")
	}
	before := time.Duration(agentInt(in, "before_seconds", 60, 0, 900)) * time.Second
	after := time.Duration(agentInt(in, "after_seconds", 60, 0, 900)) * time.Second
	limit := agentInt(in, "limit", 30, 1, 60)
	start, end := at.Add(-before), at.Add(after)
	page, err := h.storage.SearchPage(ctx, storage.SearchOptions{Query: query, StartDate: start, EndDate: end, Sources: agentSources(in), Limit: limit, SortBy: "timestamp", SortOrder: "asc", SkipDistribution: true})
	if err != nil {
		return nil, err
	}
	out := map[string]any{"window": map[string]string{"start": start.UTC().Format(time.RFC3339Nano), "end": end.UTC().Format(time.RFC3339Nano)}, "total_count": page.TotalCount, "returned": len(page.Logs), "logs": trimAgentRows(page.Logs)}
	if page.TotalCount > len(page.Logs) {
		out["note"] = "Only the oldest rows of the window are returned; shrink before_seconds or add a query to see rows nearer the event."
	}
	return out, nil
}

type agentWindowSummary struct {
	Start         string         `json:"start"`
	End           string         `json:"end"`
	TotalCount    int            `json:"total_count"`
	PerMinute     float64        `json:"per_minute"`
	ByLevel       map[string]int `json:"by_level"`
	BySource      map[string]int `json:"by_source"`
	ComputedOver  int            `json:"computed_over"`
	Sampled       bool           `json:"sampled"`
	levelFieldSet bool
}

func (h *Services) agentWindow(ctx context.Context, query string, sources []string, start, end time.Time) (agentWindowSummary, error) {
	summary := agentWindowSummary{Start: start.UTC().Format(time.RFC3339), End: end.UTC().Format(time.RFC3339), ByLevel: map[string]int{}, BySource: map[string]int{}}
	total, err := h.agentTotal(ctx, query, sources, start, end)
	if err != nil {
		return summary, err
	}
	summary.TotalCount = total
	if minutes := end.Sub(start).Minutes(); minutes > 0 {
		summary.PerMinute = float64(int(float64(total)/minutes*100+0.5)) / 100
	}
	facets, err := h.storage.Facets(ctx, storage.SearchOptions{Query: query, StartDate: start, EndDate: end, Sources: sources, SortBy: "timestamp", SortOrder: "desc"})
	if err != nil {
		return summary, err
	}
	summary.ComputedOver, summary.Sampled = facets.ComputedOver, facets.Sampled
	for _, field := range facets.Fields {
		target := map[string]int(nil)
		switch strings.ToLower(field.Name) {
		case "level", "severity", "loglevel", "log_level":
			if summary.levelFieldSet {
				continue
			}
			summary.levelFieldSet = true
			target = summary.ByLevel
		case "_src":
			target = summary.BySource
		default:
			continue
		}
		for _, v := range field.Values {
			target[v.Value] = v.Count
		}
	}
	return summary, nil
}

func countDeltas(baseline, incident map[string]int) []map[string]any {
	keys := map[string]bool{}
	for k := range baseline {
		keys[k] = true
	}
	for k := range incident {
		keys[k] = true
	}
	out := make([]map[string]any, 0, len(keys))
	for k := range keys {
		out = append(out, map[string]any{"key": k, "baseline": baseline[k], "incident": incident[k], "change": incident[k] - baseline[k]})
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i]["change"].(int), out[j]["change"].(int)
		if a < 0 {
			a = -a
		}
		if b < 0 {
			b = -b
		}
		if a != b {
			return a > b
		}
		return out[i]["key"].(string) < out[j]["key"].(string)
	})
	return out
}

func (h *Services) agentCompareWindows(ctx context.Context, in map[string]any) (any, error) {
	query, err := agentQueryText(in)
	if err != nil {
		return nil, err
	}
	sources := agentSources(in)
	windows := [2]agentWindowSummary{}
	for i, keys := range [][2]string{{"baseline_start", "baseline_end"}, {"incident_start", "incident_end"}} {
		if toolString(in, keys[0]) == "" || toolString(in, keys[1]) == "" {
			return nil, fmt.Errorf("%s and %s are required", keys[0], keys[1])
		}
		start, end, err := agentTimeRange(in, keys[0], keys[1])
		if err != nil {
			return nil, err
		}
		// Storage treats the end bound as inclusive. Windows are half-open so
		// a baseline ending where the incident starts does not count the
		// boundary events twice.
		queryEnd := end
		if end.After(start) {
			queryEnd = end.Add(-time.Nanosecond)
		}
		windows[i], err = h.agentWindow(ctx, query, sources, start, queryEnd)
		if err != nil {
			return nil, err
		}
		windows[i].End = end.UTC().Format(time.RFC3339)
	}
	baseline, incident := windows[0], windows[1]
	rateRatio := any(nil)
	if baseline.PerMinute > 0 {
		rateRatio = float64(int(incident.PerMinute/baseline.PerMinute*100+0.5)) / 100
	}
	note := "Totals and rates are exact."
	if baseline.Sampled || incident.Sampled {
		note += " Level and source counts in a sampled window cover only its newest computed_over rows."
	}
	return map[string]any{
		"baseline":       baseline,
		"incident":       incident,
		"total_change":   incident.TotalCount - baseline.TotalCount,
		"rate_ratio":     rateRatio,
		"level_changes":  countDeltas(baseline.ByLevel, incident.ByLevel),
		"source_changes": countDeltas(baseline.BySource, incident.BySource),
		"note":           note,
	}, nil
}
