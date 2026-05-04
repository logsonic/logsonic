package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"logsonic/pkg/timeresolve"
	"logsonic/pkg/types"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"
)

// TimestampPreviewRequest drives the live re-preview the wizard runs
// when the user changes a knob. Logs is the same sample step 2 used
// for /parse; resolution is the user's effective config (sniffed
// defaults overlaid with their overrides).
type TimestampPreviewRequest struct {
	Logs           []string               `json:"logs"`
	GrokPattern    string                 `json:"grok_pattern,omitempty"`
	CustomPatterns map[string]string      `json:"custom_patterns,omitempty"`
	Resolution     timeresolve.Resolution `json:"resolution"`
	SourceMTime    *time.Time             `json:"source_mtime,omitempty"`
}

type TimestampPreviewResponse struct {
	Status    string                  `json:"status"`
	Inference timeresolve.Inference   `json:"inference"`
}

// @Summary Preview timestamp resolution
// @Description Re-renders the timestamp inference and preview rows for
// @Description a sample of log lines using the supplied Resolution.
// @Description Used by the import wizard's timestamp panel to show a
// @Description live preview as the user changes knobs (anchor, year
// @Description strategy, timezone, force mode, rollover) without
// @Description re-running the full /parse path.
// @Tags parsing
// @Accept json
// @Produce json
// @Param request body TimestampPreviewRequest true "Timestamp preview request"
// @Success 200 {object} TimestampPreviewResponse
// @Failure 400 {object} types.ErrorResponse
// @Router /timestamp/preview [post]
func (h *Services) HandleTimestampPreview(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status: "error", Error: "Method not allowed", Code: "METHOD_NOT_ALLOWED",
		})
		return
	}

	var req TimestampPreviewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status: "error", Error: "Invalid request body", Code: "INVALID_REQUEST", Details: err.Error(),
		})
		return
	}

	pattern := req.GrokPattern
	if pattern == "" {
		pattern = "%{GREEDYDATA:message}"
	}

	dec, err := l2g.NewDecoder(l2g.PatternSpec{
		Grok:           pattern,
		CustomPatterns: req.CustomPatterns,
	}, l2g.DecoderOptions{})
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status: "error", Error: "Failed to compile grok pattern", Code: "PATTERN_ERROR", Details: err.Error(),
		})
		return
	}

	results := dec.Decode(req.Logs)

	samples := make([]map[string]string, 0, len(results))
	for _, lr := range results {
		if lr.Matched {
			samples = append(samples, lr.Fields)
		}
	}

	inf := timeresolve.Sniff(samples, req.SourceMTime)
	inf.Resolution = mergeResolution(inf.Resolution, req.Resolution)
	inf.Preview = buildPreviewFromResults(results, inf.Resolution)

	json.NewEncoder(w).Encode(TimestampPreviewResponse{
		Status:    "success",
		Inference: inf,
	})
}
