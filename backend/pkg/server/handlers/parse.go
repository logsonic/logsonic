package handlers

import (
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"logsonic/pkg/tokenizer"
	"logsonic/pkg/types"
)

// @Summary Parse logs or suggest patterns
// @Description Parse logs using existing or temporary Grok patterns without storing them into the database.
// @Description If no grok_pattern is provided, this endpoint will suggest the best matching patterns for the logs.
// @Description When a grok_pattern is provided, it will parse the logs using that pattern.
// @Tags parsing
// @Accept json
// @Produce json
// @Param request body types.ParseRequest true "Log parsing request with optional grok_pattern and custom_patterns"
// @Success 200 {object} types.ParseResponse "Successful parsing with pattern details"
// @Success 200 {object} types.SuggestResponse "Autosuggest results when no pattern provided"
// @Failure 400 {object} types.ErrorResponse "Invalid request or pattern"
// @Failure 500 {object} types.ErrorResponse "Internal server error"
// @Router /parse [post]
func (h *Services) HandleParse(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status: "error",
			Error:  "Method not allowed",
			Code:   "METHOD_NOT_ALLOWED",
		})
		return
	}

	var req types.ParseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Invalid request body",
			Code:    "INVALID_REQUEST",
			Details: err.Error(),
		})
		return
	}

	// If no Grok pattern is provided, treat this as a suggest request
	if req.GrokPattern == "" {
		// Perform autosuggest
		autosuggestResults, err := h.autosuggestPatterns(req.Logs)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(types.ErrorResponse{
				Status:  "error",
				Error:   "Failed to autosuggest patterns",
				Code:    "AUTOSUGGEST_ERROR",
				Details: err.Error(),
			})
			return
		}

		// Return autosuggest results
		json.NewEncoder(w).Encode(types.SuggestResponse{
			Status:  "success",
			Type:    "autosuggest",
			Results: autosuggestResults,
		})
		return
	}

	// If a grok pattern is provided, proceed with parsing (original HandleParse behavior)
	// Temporary tokenizer for this request
	// Create a new tokenizer for each request
	tempTokenizer, err := tokenizer.NewTokenizer()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Failed to create tokenizer",
			Code:    "TOKENIZER_ERROR",
			Details: err.Error(),
		})
		return
	}

	// If a custom Grok pattern is provided, add it temporarily
	if req.GrokPattern != "" {
		// Add custom patterns first if provided
		if len(req.CustomPatterns) > 0 {
			for name, pattern := range req.CustomPatterns {
				if err := tempTokenizer.AddCustomPattern(name, pattern); err != nil {
					w.WriteHeader(http.StatusBadRequest)
					json.NewEncoder(w).Encode(types.ErrorResponse{
						Status:  "error",
						Error:   "Failed to add custom pattern",
						Code:    "PATTERN_ERROR",
						Details: err.Error(),
					})
					tempTokenizer.ClearPatterns()
					return
				}
			}
		}

		// Add the main Grok pattern
		if err := tempTokenizer.AddPattern(req.GrokPattern); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(types.ErrorResponse{
				Status:  "error",
				Error:   "Failed to add Grok pattern",
				Code:    "PATTERN_ERROR",
				Details: err.Error(),
			})
			tempTokenizer.ClearPatterns()
			return
		}
	}

	// Parse logs using the tokenizer (temporary or original)
	parsedLogs, successCount, failedCount, err := tempTokenizer.ParseLogs(req.Logs, req.IngestSessionOptions)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Failed to parse logs",
			Code:    "PARSE_ERROR",
			Details: err.Error(),
		})
		tempTokenizer.ClearPatterns()
		return
	}
	// Remove _raw and _src fields from parsedLogs
	for _, log := range parsedLogs {
		delete(log, "_raw")
	}

	// If a temporary pattern was added, clear it
	if req.GrokPattern != "" {
		tempTokenizer.ClearPatterns()
	}

	json.NewEncoder(w).Encode(types.ParseResponse{
		Status:             "success",
		Processed:          successCount,
		Failed:             failedCount,
		Pattern:            req.GrokPattern,
		PatternDescription: "", // Could potentially add a way to get description
		CustomPatterns:     req.CustomPatterns,
		Logs:               parsedLogs,
	})
	tempTokenizer.ClearPatterns()
}

func (h *Services) autosuggestPatterns(logs []string) ([]types.AutosuggestResult, error) {
	patterns := h.GetPatternDefinitions()

	results := []types.AutosuggestResult{}
	if len(patterns) == 0 || len(logs) == 0 {
		return results, nil
	}

	// Fix #4: JSON auto-detection — parse NDJSON (Pino/Bunyan/zap/Serilog/etc.) directly
	// rather than matching it with a brittle ordered regex (e.g. Suricata EVE JSON).
	if jsonResult := tryJSONAutodetect(logs); jsonResult != nil {
		results = append(results, *jsonResult)
	}

	// Process each grok pattern definition
	for _, patternDef := range patterns {
		if patternDef.Pattern == "" {
			continue
		}

		// Fix #5: Skip patterns containing literal \n — they require a multi-line pre-join
		// pass that single-line autosuggest does not perform.  These patterns (AWS Lambda
		// REPORT, Snort, OSSEC, Oracle Alert) will never match a single log line and would
		// only waste time and score 0.
		if strings.Contains(patternDef.Pattern, "\\n") {
			continue
		}

		tempTokenizer, err := tokenizer.NewTokenizer()
		if err != nil {
			continue
		}

		for name, pattern := range patternDef.CustomPatterns {
			if err := tempTokenizer.AddCustomPattern(name, pattern); err != nil {
				continue
			}
		}

		if err := tempTokenizer.AddPattern(patternDef.Pattern, patternDef.Priority); err != nil {
			continue
		}

		defaultIngestSessionOptions := types.IngestSessionOptions{}
		parsedResult, successes, _, err := tempTokenizer.ParseLogs(logs, defaultIngestSessionOptions)
		if err != nil || successes == 0 {
			continue
		}

		// Fix #1: Coverage is the primary signal.  A pattern that matches 1 of 100 lines
		// must score far below one that matches 100 of 100, regardless of field count.
		coverage := float64(successes) / float64(len(logs))

		// Count fields extracted by the pattern itself (exclude always-present internal
		// fields _raw and _src which ParseLogs appends to every matched entry).
		totalPatternFields := 0
		for _, fields := range parsedResult {
			if _, hasError := fields["error"]; hasError {
				continue // unmatched entry — skip
			}
			count := len(fields)
			for _, internal := range []string{"_raw", "_src"} {
				if _, ok := fields[internal]; ok {
					count--
				}
			}
			if count > 0 {
				totalPatternFields += count
			}
		}
		avgFields := 0.0
		if successes > 0 {
			avgFields = float64(totalPatternFields) / float64(successes)
		}

		// Fix #2/#8: GREEDYDATA catch-alls consume the rest of the line and guarantee a
		// match; penalise each occurrence so specific patterns win over vague ones.
		greedyCount := strings.Count(patternDef.Pattern, "GREEDYDATA")
		specificity := math.Max(0.4, 1.0-0.2*float64(greedyCount))

		// Fix #3: Field-quality multiplier — validate that fields named after well-known
		// semantic types actually carry values that conform to those types.
		quality := validateFieldQuality(parsedResult)

		// score = coverage² × avgFields × specificity × quality
		// Squaring coverage strongly down-ranks partial matches: 10 % coverage → ×0.01
		// factor, while 90 % → ×0.81.  avgFields rewards more structured extraction.
		score := (coverage * coverage) * avgFields * specificity * quality

		results = append(results, types.AutosuggestResult{
			PatternName:        patternDef.Name,
			PatternDescription: patternDef.Description,
			Pattern:            patternDef.Pattern,
			Score:              score,
			Coverage:           coverage,
			ParsedLogs:         parsedResult,
			CustomPatterns:     patternDef.CustomPatterns,
		})
	}

	// Sort results by score (highest first)
	sort.Slice(results, func(i, j int) bool {
		return results[i].Score > results[j].Score
	})

	// Fix #7: Limit to top 10 so callers can implement fallback chains for heterogeneous
	// streams (e.g. 60% syslog + 40% JSON) rather than relying on a single "best" pick.
	if len(results) > 10 {
		results = results[:10]
	}

	// Fix #10: If nothing matched (or best coverage is weak), mine structural templates
	// from the raw lines so the user has something to work with.
	bestCoverage := 0.0
	if len(results) > 0 {
		bestCoverage = results[0].Coverage
	}
	if bestCoverage < 0.5 {
		templateResults := mineUnknownTemplates(logs)
		results = append(results, templateResults...)
		sort.Slice(results, func(i, j int) bool {
			return results[i].Score > results[j].Score
		})
		if len(results) > 10 {
			results = results[:10]
		}
	}

	return results, nil
}

// ---------------------------------------------------------------------------
// Fix #4 — JSON auto-detection
// ---------------------------------------------------------------------------

// tryJSONAutodetect attempts to parse every log line as a JSON object.  When
// enough lines are valid JSON it returns a synthetic AutosuggestResult so that
// NDJSON formats (Pino, Bunyan, zap, Serilog compact, Suricata EVE, etc.) are
// recognised without brittle key-order-dependent regexes.
func tryJSONAutodetect(logs []string) *types.AutosuggestResult {
	if len(logs) == 0 {
		return nil
	}

	successCount := 0
	totalFields := 0
	parsedLogs := make([]map[string]interface{}, 0, len(logs))

	for _, line := range logs {
		line = strings.TrimSpace(line)
		if line == "" {
			parsedLogs = append(parsedLogs, map[string]interface{}{
				"error":   "empty line",
				"message": line,
			})
			continue
		}
		if !strings.HasPrefix(line, "{") {
			parsedLogs = append(parsedLogs, map[string]interface{}{
				"error":   "not a JSON object",
				"message": line,
			})
			continue
		}
		var obj map[string]interface{}
		if err := json.Unmarshal([]byte(line), &obj); err != nil {
			parsedLogs = append(parsedLogs, map[string]interface{}{
				"error":   "JSON parse error: " + err.Error(),
				"message": line,
			})
			continue
		}
		successCount++
		totalFields += len(obj)
		// Normalise all leaf values to strings for downstream consistency.
		normalised := make(map[string]interface{}, len(obj))
		for k, v := range obj {
			normalised[k] = fmt.Sprintf("%v", v)
		}
		parsedLogs = append(parsedLogs, normalised)
	}

	if successCount == 0 {
		return nil
	}

	coverage := float64(successCount) / float64(len(logs))
	avgFields := float64(totalFields) / float64(successCount)
	// JSON earns a specificity bonus of 1.2 — it is fully structured.
	score := (coverage * coverage) * avgFields * 1.2

	return &types.AutosuggestResult{
		PatternName:        "JSON (auto-detected)",
		PatternDescription: "Newline-delimited JSON — matches Pino, Bunyan, zap, Serilog compact, Suricata EVE, and any other NDJSON producer",
		Pattern:            "",
		Score:              score,
		Coverage:           coverage,
		ParsedLogs:         parsedLogs,
	}
}

// ---------------------------------------------------------------------------
// Fix #3 — Field quality validation
// ---------------------------------------------------------------------------

// knownIPFields is the set of field names whose values should be valid IP addresses.
var knownIPFields = map[string]bool{
	"clientip": true, "src_ip": true, "dest_ip": true, "srcip": true,
	"client_ip": true, "source_ip": true, "forwarded_for": true,
	"backend_ip": true, "target_ip": true, "dstaddr": true, "srcaddr": true,
}

// knownStatusFields is the set of field names whose values should be HTTP status codes.
var knownStatusFields = map[string]bool{
	"response": true, "status": true, "status_code": true,
	"http_status": true, "elb_status_code": true, "backend_status_code": true,
	"target_status_code": true,
}

// knownLevelFields is the set of field names that carry a log severity level.
var knownLevelFields = map[string]bool{
	"level": true, "severity": true, "loglevel": true, "log_level": true,
}

// validLogLevels is the set of recognised log-level strings.
var validLogLevels = map[string]bool{
	"TRACE": true, "DEBUG": true, "INFO": true, "WARN": true,
	"WARNING": true, "ERROR": true, "FATAL": true, "CRITICAL": true,
	"trace": true, "debug": true, "info": true, "warn": true,
	"warning": true, "error": true, "fatal": true, "critical": true,
	// klog single-letter codes
	"I": true, "W": true, "E": true, "F": true, "D": true,
	// syslog levels
	"emerg": true, "alert": true, "crit": true, "err": true, "notice": true,
}

// validateFieldQuality returns a quality multiplier in [0.8, 1.0].
// It checks known semantic field types and rewards patterns whose extracted
// values actually conform to those types (e.g. an "src_ip" field that holds
// a real IP address, not an arbitrary string).
func validateFieldQuality(parsedLogs []map[string]interface{}) float64 {
	checks, passed := 0, 0

	for _, logEntry := range parsedLogs {
		if _, hasError := logEntry["error"]; hasError {
			continue
		}
		for field, val := range logEntry {
			strVal, ok := val.(string)
			if !ok {
				continue
			}
			switch {
			case knownIPFields[field]:
				checks++
				// Strip optional port suffix before validating.
				host := strVal
				if idx := strings.LastIndex(strVal, ":"); idx > 0 {
					if candidate := strVal[:idx]; net.ParseIP(candidate) != nil {
						host = candidate
					}
				}
				if net.ParseIP(host) != nil {
					passed++
				}
			case knownStatusFields[field]:
				checks++
				if code, err := strconv.Atoi(strVal); err == nil && code >= 100 && code <= 599 {
					passed++
				}
			case knownLevelFields[field]:
				checks++
				if validLogLevels[strVal] {
					passed++
				}
			}
		}
	}

	if checks == 0 {
		return 1.0 // No checkable fields — no penalty
	}
	// Blend: 0.8 baseline + up to 0.2 quality bonus so the multiplier is always positive.
	return 0.8 + 0.2*float64(passed)/float64(checks)
}

// ---------------------------------------------------------------------------
// Fix #10 — Template mining fallback
// ---------------------------------------------------------------------------

var uuidTokenRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var hexTokenRe = regexp.MustCompile(`^[0-9a-fA-F]{6,}$`)

// mineUnknownTemplates performs a lightweight Drain-style grouping of log lines
// by their token structure, returning up to 3 template sketches so the user can
// give names to otherwise unrecognised formats.
func mineUnknownTemplates(logs []string) []types.AutosuggestResult {
	if len(logs) == 0 {
		return nil
	}

	sigCounts := make(map[string]int)
	sigTemplates := make(map[string]string)

	for _, line := range logs {
		sig, tpl := lineSignature(line)
		sigCounts[sig]++
		if sigTemplates[sig] == "" {
			sigTemplates[sig] = tpl
		}
	}

	type entry struct {
		sig   string
		count int
		tpl   string
	}
	entries := make([]entry, 0, len(sigCounts))
	for sig, count := range sigCounts {
		entries = append(entries, entry{sig, count, sigTemplates[sig]})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].count > entries[j].count })
	if len(entries) > 3 {
		entries = entries[:3]
	}

	results := make([]types.AutosuggestResult, 0, len(entries))
	for i, e := range entries {
		coverage := float64(e.count) / float64(len(logs))
		results = append(results, types.AutosuggestResult{
			PatternName:        fmt.Sprintf("Unknown Format %d", i+1),
			PatternDescription: fmt.Sprintf("Mined template covering %.0f%% of lines — example: %s", coverage*100, e.tpl),
			Pattern:            e.tpl,
			Score:              coverage * 0.3, // Low score; user needs to refine
			Coverage:           coverage,
			ParsedLogs:         []map[string]interface{}{},
		})
	}
	return results
}

// lineSignature returns a structural signature and a human-readable template for
// a single log line.  Variable token types (numbers, IPs, UUIDs, hex strings)
// are replaced with typed placeholders so that structurally similar lines hash
// to the same signature.
func lineSignature(line string) (sig, tpl string) {
	tokens := strings.Fields(line)
	sigParts := make([]string, len(tokens))
	tplParts := make([]string, len(tokens))

	for i, tok := range tokens {
		switch {
		case isUUIDToken(tok):
			sigParts[i] = "<UUID>"
			tplParts[i] = "%{UUID}"
		case isIPToken(tok):
			sigParts[i] = "<IP>"
			tplParts[i] = "%{IP}"
		case isNumericToken(tok):
			sigParts[i] = "<NUM>"
			tplParts[i] = "%{NUMBER}"
		case isHexToken(tok):
			sigParts[i] = "<HEX>"
			tplParts[i] = "%{DATA}"
		default:
			sigParts[i] = tok
			tplParts[i] = tok
		}
	}
	return strings.Join(sigParts, " "), strings.Join(tplParts, " ")
}

func isUUIDToken(s string) bool {
	return uuidTokenRe.MatchString(s)
}

func isIPToken(s string) bool {
	host := s
	if idx := strings.LastIndex(s, ":"); idx > 0 {
		host = s[:idx]
	}
	return net.ParseIP(strings.Trim(host, "[]")) != nil
}

func isNumericToken(s string) bool {
	_, err := strconv.ParseFloat(strings.TrimRight(s, ",;"), 64)
	return err == nil
}

func isHexToken(s string) bool {
	return hexTokenRe.MatchString(s)
}
