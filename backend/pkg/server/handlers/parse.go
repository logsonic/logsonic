package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"logsonic/pkg/types"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"
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

	if req.GrokPattern == "" {
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

		json.NewEncoder(w).Encode(types.SuggestResponse{
			Status:  "success",
			Type:    "autosuggest",
			Results: autosuggestResults,
		})
		return
	}

	// Parse-with-pattern branch: build a one-shot log2grok Decoder.
	// Compilation failures (bad grok body, unknown primitive reference,
	// invalid custom-pattern regex) all surface here and return 400 so
	// the frontend can show the specific error.
	dec, err := l2g.NewDecoder(l2g.PatternSpec{
		Name:           req.IngestSessionOptions.Name,
		Grok:           req.GrokPattern,
		CustomPatterns: req.CustomPatterns,
	}, l2g.DecoderOptions{
		SmartDecode: req.IngestSessionOptions.SmartDecoder,
	})
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Failed to add Grok pattern",
			Code:    "PATTERN_ERROR",
			Details: err.Error(),
		})
		return
	}

	results := dec.Decode(req.Logs)
	parsedLogs, successCount, failedCount, inference := postProcess(results, req.IngestSessionOptions)

	// /parse never persists, so drop _raw before returning to keep the
	// preview payload light. Storage paths keep _raw via ingest.
	for _, log := range parsedLogs {
		delete(log, "_raw")
	}

	json.NewEncoder(w).Encode(types.ParseResponse{
		Status:             "success",
		Processed:          successCount,
		Failed:             failedCount,
		Pattern:            req.GrokPattern,
		PatternDescription: "",
		CustomPatterns:     req.CustomPatterns,
		Logs:               parsedLogs,
		TimestampInference: &inference,
	})
}

// autosuggestPatterns delegates pattern discovery to log2grok. Returns a
// single-element slice (or empty when no pattern is detected) describing
// the source family detected, the Grok expression, custom patterns, the
// coverage observed against the input lines, and — when log2grok could
// infer one — a TimestampField/TimestampLayout pair the frontend can
// use to pre-select the timestamp column in the wizard.
//
// We pass the raw logs through; log2grok normalises blanks internally
// and returns ErrEmptyInput when nothing parseable remains.
func (h *Services) autosuggestPatterns(logs []string) ([]types.AutosuggestResult, error) {
	results := []types.AutosuggestResult{}
	if len(logs) == 0 {
		return results, nil
	}

	dp, err := l2g.Discover(logs, l2g.Options{})
	if err != nil {
		if errors.Is(err, l2g.ErrEmptyInput) {
			return results, nil
		}
		return nil, err
	}
	if dp == nil || dp.Grok == "" {
		return results, nil
	}

	name := dp.Source
	if name == "" {
		name = "Auto-detected"
	}
	description := fmt.Sprintf("Detected by log2grok (source: %s, family: %s)", dp.Source, dp.SourceFamily)
	if dp.SourceFamily == "" {
		description = fmt.Sprintf("Detected by log2grok (source: %s)", dp.Source)
	}

	results = append(results, types.AutosuggestResult{
		PatternName:        name,
		PatternDescription: description,
		Pattern:            dp.Grok,
		Score:              dp.Coverage,
		Coverage:           dp.Coverage,
		ParsedLogs:         []map[string]interface{}{},
		CustomPatterns:     dp.CustomPatterns,
		TimestampField:     dp.TimestampHint.Field,
		TimestampLayout:    dp.TimestampHint.Layout,
		TimestampSource:    dp.TimestampHint.Source,
	})

	return results, nil
}
