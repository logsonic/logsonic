// Package handlers — grok pattern CRUD.
//
// All persistence + validation lives in log2grok now (patterns.json /
// primitives.json under <cwd>/.log2grok). These handlers are a thin
// translation layer between the HTTP/JSON shape the frontend expects
// (types.GrokPatternRequest) and log2grok's KnownPattern type.
package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"logsonic/pkg/timeresolve"
	"logsonic/pkg/types"
	"net/http"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"
)

// @Summary Manage Grok patterns
// @Description Create, read, update, and delete Grok patterns for log parsing
// @Tags grok
// @Accept json
// @Produce json
// @Param request body types.GrokPatternRequest true "Grok pattern definition"
// @Success 200 {object} types.GrokPatternResponse "Success response with patterns"
// @Success 201 {object} types.GrokPatternResponse "Pattern created successfully"
// @Failure 400 {object} types.ErrorResponse "Invalid request format or missing required fields"
// @Failure 404 {object} types.ErrorResponse "Pattern not found"
// @Failure 405 {object} types.ErrorResponse "Method not allowed"
// @Failure 500 {object} types.ErrorResponse "Internal server error"
// @Router /api/v1/grok [post]
// @Router /api/v1/grok [get]
// @Router /api/v1/grok [delete]
func (h *Services) HandleGrokPatterns(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodPost:
		h.createGrokPattern(w, r)
	case http.MethodDelete:
		h.deleteGrokPattern(w, r)
	case http.MethodGet:
		h.getGrokPatterns(w, r)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status: "error",
			Error:  "Method not allowed",
		})
	}
}

func (h *Services) createGrokPattern(w http.ResponseWriter, r *http.Request) {
	var req types.GrokPatternRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.GrokPatternResponse{
			Status: "error",
			Error:  "Invalid request format: " + err.Error(),
		})
		return
	}

	if req.Name == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.GrokPatternResponse{
			Status: "error",
			Error:  "Pattern name is required",
		})
		return
	}

	// Reject if a pattern with this name already exists. We deliberately
	// don't expose update-via-POST yet — the legacy handler returned 409
	// Conflict and the frontend relies on that semantics for its
	// "rename to overwrite" flow.
	for _, kp := range l2g.ListLibrary() {
		if kp.Name == req.Name {
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(types.GrokPatternResponse{
				Status: "error",
				Error:  fmt.Sprintf("Pattern name '%s' already exists", req.Name),
			})
			return
		}
	}

	kp := l2g.KnownPattern{
		Name:           req.Name,
		Pattern:        req.Pattern,
		Priority:       req.Priority,
		Description:    req.Description,
		CustomPatterns: req.CustomPatterns,
	}
	if _, err := l2g.UpsertLibraryEntry(kp); err != nil {
		// log2grok validates the grok body up front, so a non-nil err
		// here is almost always a 400 (bad regex). Surface it as 400 so
		// the editor can highlight the offending field.
		status := http.StatusBadRequest
		if errors.Is(err, l2g.ErrConfigNotLoaded) {
			status = http.StatusInternalServerError
		}
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(types.GrokPatternResponse{
			Status: "error",
			Error:  fmt.Sprintf("Failed to save pattern: %v", err),
		})
		return
	}

	// Persist the timestamp resolution to the side-file. Failure here
	// is non-fatal — the pattern itself is already saved; the user
	// just won't have their resolution restored next time.
	if req.TimestampConfig != nil && h.PatternTimestamps != nil {
		if err := h.PatternTimestamps.Set(req.Name, *req.TimestampConfig); err != nil {
			// best-effort, don't fail the request
			fmt.Printf("warning: failed to persist timestamp config for %q: %v\n", req.Name, err)
		}
	}

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(types.GrokPatternResponse{
		Status: "success",
		Patterns: []types.GrokPatternRequest{
			{
				Name:            req.Name,
				Priority:        req.Priority,
				CustomPatterns:  req.CustomPatterns,
				Pattern:         req.Pattern,
				Description:     req.Description,
				TimestampConfig: req.TimestampConfig,
			},
		},
	})
}

func (h *Services) deleteGrokPattern(w http.ResponseWriter, r *http.Request) {
	patternName := r.URL.Query().Get("name")
	if patternName == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.GrokPatternResponse{
			Status: "error",
			Error:  "name query param is required",
		})
		return
	}

	removed, err := l2g.RemoveLibraryEntry(patternName)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.GrokPatternResponse{
			Status: "error",
			Error:  fmt.Sprintf("Failed to delete pattern: %v", err),
		})
		return
	}
	if !removed {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(types.GrokPatternResponse{
			Status: "error",
			Error:  fmt.Sprintf("Pattern '%s' not found", patternName),
		})
		return
	}

	// Drop any side-file timestamp config so it doesn't shadow a
	// future pattern reusing the same name. Best-effort.
	if h.PatternTimestamps != nil {
		_ = h.PatternTimestamps.Delete(patternName)
	}

	json.NewEncoder(w).Encode(types.GrokPatternResponse{
		Status: "success",
		Error:  fmt.Sprintf("Pattern '%s' has been deleted", patternName),
	})
}

func (h *Services) getGrokPatterns(w http.ResponseWriter, _ *http.Request) {
	library := l2g.ListLibrary()

	// Look up timestamp configs by name from the side-file. Snapshot
	// is taken once outside the loop so concurrent writes can't race.
	var tsByName map[string]timeresolve.Resolution
	if h.PatternTimestamps != nil {
		tsByName = h.PatternTimestamps.Snapshot()
	}

	convertedPatterns := make([]types.GrokPatternRequest, len(library))
	for i, kp := range library {
		entry := types.GrokPatternRequest{
			Name:           kp.Name,
			Pattern:        kp.Pattern,
			Priority:       kp.Priority,
			Description:    kp.Description,
			CustomPatterns: kp.CustomPatterns,
		}
		if tsByName != nil {
			if r, ok := tsByName[kp.Name]; ok {
				rCopy := r
				entry.TimestampConfig = &rCopy
			}
		}
		convertedPatterns[i] = entry
	}

	json.NewEncoder(w).Encode(types.GrokPatternResponse{
		Status:   "success",
		Patterns: convertedPatterns,
	})
}
