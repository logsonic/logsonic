package handlers

import (
	"encoding/json"
	"logsonic/pkg/tokenizer"
	"logsonic/pkg/types"
	"net/http"
	"sort"
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
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status: "error",
			Error:  "Method not allowed",
			Code:   "METHOD_NOT_ALLOWED",
		})
		w.WriteHeader(http.StatusMethodNotAllowed)
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
	// Get patterns from the currentPatterns via GetPatternDefinitions method
	patterns := h.GetPatternDefinitions()

	results := []types.AutosuggestResult{}
	if len(patterns) == 0 {
		return results, nil
	}

	// Process each pattern definition
	for _, patternDef := range patterns {
		// Skip empty patterns
		if patternDef.Pattern == "" {
			continue
		}

		// Create a new temporary tokenizer for each pattern
		tempTokenizer, err := tokenizer.NewTokenizer()
		if err != nil {
			continue
		}

		// Add custom patterns first (if any)
		if len(patternDef.CustomPatterns) > 0 {
			// Now add custom patterns
			for name, pattern := range patternDef.CustomPatterns {
				if err := tempTokenizer.AddCustomPattern(name, pattern); err != nil {
					// Continue anyway - we'll try with whatever custom patterns were added
				}
			}
		}

		// Now add the main pattern to the tokenizer
		if err := tempTokenizer.AddPattern(patternDef.Pattern, patternDef.Priority); err != nil {
			continue
		}

		// Try to parse the log lines with this pattern
		defaultIngestSessionOptions := types.IngestSessionOptions{}
		parsedResult, successes, _, err := tempTokenizer.ParseLogs(logs, defaultIngestSessionOptions)
		if err != nil {
			continue
		}

		// If the pattern resulted in a successful parse (successes > 0), add it to results
		if successes > 0 {
			// Parse the result to calculate the score

			// Calculate score based on fields extracted
			totalFields := 0
			for _, fields := range parsedResult {
				totalFields += len(fields)
			}
			score := float64(totalFields) / float64(len(parsedResult))

			// Add to results with pattern information
			results = append(results, types.AutosuggestResult{
				PatternName:        patternDef.Name,
				PatternDescription: patternDef.Description,
				Pattern:            patternDef.Pattern,
				Score:              score,
				ParsedLogs:         parsedResult,
				CustomPatterns:     patternDef.CustomPatterns,
			})
		}
	}

	// Sort results by score (highest first)
	sort.Slice(results, func(i, j int) bool {
		return results[i].Score > results[j].Score
	})

	// Limit results to top 10
	if len(results) > 10 {
		results = results[:10]
	}

	return results, nil
}
