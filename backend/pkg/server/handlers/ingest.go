package handlers

import (
	"encoding/json"
	"logsonic/pkg/types"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Define constants for default pattern
const (
	DefaultPatternName = "DEFAULT_PATTERN"
	DefaultPattern     = "%{GREEDYDATA:message}"
	SessionTimeout     = 60 * time.Minute // Sessions expire after 60 minutes
)

var defaultIngestSessionOptions = types.IngestSessionOptions{
	Source:          "",
	SmartDecoder:    false,
	ForceTimezone:   "",
	ForceStartYear:  "",
	ForceStartMonth: "",
	ForceStartDay:   "",
}

// IngestSession tracks an ingest session and its expiration time
type IngestSession struct {
	Options      types.IngestSessionOptions
	CreationTime time.Time
}

// Map to store session options by session ID
var sessionMap = make(map[string]IngestSession)
var sessionMapMutex = &sync.RWMutex{}

// @Summary Ingest log data
// @Description Ingest log data using existing Grok patterns and store them into the index
// @Tags ingest
// @Accept json
// @Produce json
// @Param request body types.IngestRequest true "Log ingest request"
// @Success 200 {object} types.IngestResponse
// @Failure 400 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Router /ingest [post]
func (h *Services) HandleIngest(w http.ResponseWriter, r *http.Request) {
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

	var req types.IngestRequest
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

	// Get session options using the provided session ID
	sessionMapMutex.RLock()
	session, exists := sessionMap[req.SessionID]
	sessionOptions := session.Options
	sessionMapMutex.RUnlock()

	if !exists || req.SessionID == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status: "error",
			Error:  "Invalid or missing session ID",
			Code:   "INVALID_SESSION",
		})
		return
	}

	jsonOutput, successCount, failedCount, err := h.tokenizer.ParseLogs(req.Logs, sessionOptions)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Failed to parse logs",
			Code:    "PARSE_ERROR",
			Details: err.Error(),
		})
		return
	}

	if err := h.storage.Store(jsonOutput); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Failed to store logs",
			Code:    "STORAGE_ERROR",
			Details: err.Error(),
		})
		return
	}

	// Invalidate info cache after successful log ingestion
	h.InvalidateInfoCache()

	json.NewEncoder(w).Encode(types.IngestResponse{
		Status:    "success",
		Processed: successCount,
		Failed:    failedCount,
		SessionID: req.SessionID,
	})
}

// @Summary Start log ingest session
// @Description Start a new log ingest session with specific options and returns a session ID
// @Tags ingest
// @Accept json
// @Produce json
// @Param request body types.IngestSessionOptions true "Log ingest session start request"
// @Success 200 {object} types.IngestResponse
// @Failure 400 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Router /ingest/start [post]
func (h *Services) HandleIngestStart(w http.ResponseWriter, r *http.Request) {
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

	var req types.IngestSessionOptions
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

	// Validate request
	if req.Name == "" && req.Pattern == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status: "error",
			Error:  "Pattern name or pattern is required",
			Code:   "INVALID_PATTERN",
		})
		return
	}

	patternToLoad := types.GrokPatternDefinition{
		Name:           req.Name,
		Pattern:        req.Pattern,
		CustomPatterns: req.CustomPatterns,
		Priority:       req.Priority,
	}

	// Add custom patterns first
	if len(patternToLoad.CustomPatterns) > 0 {
		for name, pattern := range patternToLoad.CustomPatterns {
			if err := h.tokenizer.AddCustomPattern(name, pattern); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				json.NewEncoder(w).Encode(types.ErrorResponse{
					Status:  "error",
					Error:   "Failed to add custom pattern",
					Code:    "CUSTOM_PATTERN_ERROR",
					Details: err.Error(),
				})
				return
			}
		}
	}

	// Add the main pattern and prepare all patterns at once
	// This avoids multiple pattern preparations when adding custom patterns
	if err := h.tokenizer.AddPattern(patternToLoad.Pattern, patternToLoad.Priority); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Failed to add pattern",
			Code:    "PATTERN_ERROR",
			Details: err.Error(),
		})
		return
	}

	// Generate a unique session ID
	sessionID := uuid.New().String()

	// Store the session options
	sessionOptions := types.IngestSessionOptions{
		Source:          req.Source,
		SmartDecoder:    req.SmartDecoder,
		ForceTimezone:   req.ForceTimezone,
		ForceStartYear:  req.ForceStartYear,
		ForceStartMonth: req.ForceStartMonth,
		ForceStartDay:   req.ForceStartDay,
	}

	// Store in the session map
	sessionMapMutex.Lock()
	sessionMap[sessionID] = IngestSession{
		Options:      sessionOptions,
		CreationTime: time.Now(),
	}
	sessionMapMutex.Unlock()

	// Respond with success
	json.NewEncoder(w).Encode(types.IngestResponse{
		Status:    "success",
		SessionID: sessionID,
	})
}

// @Summary End log ingest session
// @Description End the specified log ingest session and cleanup its resources
// @Tags ingest
// @Accept json
// @Produce json
// @Param request body types.IngestRequest true "Session end request with session_id"
// @Success 200 {object} types.IngestResponse
// @Failure 400 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Router /ingest/end [post]
func (h *Services) HandleIngestEnd(w http.ResponseWriter, r *http.Request) {
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

	var req types.IngestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		// If no body is provided, just return success
		json.NewEncoder(w).Encode(types.IngestResponse{
			Status: "success",
		})
		return
	}

	// Remove the session if session ID is provided
	if req.SessionID != "" {
		sessionMapMutex.Lock()
		delete(sessionMap, req.SessionID)
		sessionMapMutex.Unlock()
	}

	json.NewEncoder(w).Encode(types.IngestResponse{
		Status: "success",
	})
}
