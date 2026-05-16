package handlers

import (
	"context"
	"encoding/json"
	"logsonic/pkg/types"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	l2g "github.com/logsonic/log2grok/pkg/log2grok"
)

const (
	DefaultPatternName = "DEFAULT_PATTERN"
	DefaultPattern     = "%{GREEDYDATA:message}"
	SessionTimeout     = 60 * time.Minute
)

var defaultIngestSessionOptions = types.IngestSessionOptions{
	Source:          "",
	SmartDecoder:    false,
	ForceTimezone:   "",
	ForceStartYear:  "",
	ForceStartMonth: "",
	ForceStartDay:   "",
	Meta:            nil,
}

// IngestSession ties one /ingest/start invocation to its compiled
// log2grok Decoder so subsequent /ingest/logs calls don't recompile the
// pattern per request. Decoders are immutable + goroutine-safe so we
// can hand the same pointer to many concurrent callers.
type IngestSession struct {
	Options      types.IngestSessionOptions
	CreationTime time.Time
	Decoder      *l2g.Decoder
}

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
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Invalid request body",
			Code:    "INVALID_REQUEST",
			Details: err.Error(),
		})
		return
	}

	sessionMapMutex.RLock()
	session, exists := sessionMap[req.SessionID]
	sessionOptions := session.Options
	sessionDecoder := session.Decoder
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

	// DecodeConcurrent fans the regex work across NumCPU goroutines for
	// large batches and transparently falls back to serial Decode below
	// its internal threshold (~512 lines). The Decoder is goroutine-safe
	// and output order is preserved, so this is a drop-in replacement
	// for Decode that scales ingest throughput on multi-core boxes.
	results := sessionDecoder.DecodeConcurrent(req.Logs, 0)
	jsonOutput, successCount, failedCount, _ := postProcess(results, sessionOptions)

	if err := h.storage.Store(jsonOutput, sessionOptions.Source); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Failed to store logs",
			Code:    "STORAGE_ERROR",
			Details: err.Error(),
		})
		return
	}

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

	if req.Name == "" && req.Pattern == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status: "error",
			Error:  "Pattern name or pattern is required",
			Code:   "INVALID_PATTERN",
		})
		return
	}

	dec, err := l2g.NewDecoder(l2g.PatternSpec{
		Name:           req.Name,
		Grok:           req.Pattern,
		CustomPatterns: req.CustomPatterns,
		Priority:       req.Priority,
	}, l2g.DecoderOptions{
		SmartDecode: req.SmartDecoder,
	})
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Failed to add pattern",
			Code:    "PATTERN_ERROR",
			Details: err.Error(),
		})
		return
	}

	sessionID := uuid.New().String()

	sessionOptions := types.IngestSessionOptions{
		Name:            req.Name,
		Pattern:         req.Pattern,
		Source:          req.Source,
		SmartDecoder:    req.SmartDecoder,
		ForceTimezone:   req.ForceTimezone,
		ForceStartYear:  req.ForceStartYear,
		ForceStartMonth: req.ForceStartMonth,
		ForceStartDay:   req.ForceStartDay,
		SourceMTime:     req.SourceMTime,
		TimestampConfig: req.TimestampConfig,
		// Meta is freely passed through so callers can stamp every
		// record with additional fields.
		Meta: req.Meta,
	}

	sessionMapMutex.Lock()
	sessionMap[sessionID] = IngestSession{
		Options:      sessionOptions,
		CreationTime: time.Now(),
		Decoder:      dec,
	}
	sessionMapMutex.Unlock()

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
		json.NewEncoder(w).Encode(types.IngestResponse{
			Status: "success",
		})
		return
	}

	if req.SessionID != "" {
		sessionMapMutex.Lock()
		delete(sessionMap, req.SessionID)
		sessionMapMutex.Unlock()
	}

	json.NewEncoder(w).Encode(types.IngestResponse{
		Status: "success",
	})
}

// StartSessionCleanup launches a background goroutine that sweeps
// sessionMap every 5 minutes and removes sessions older than
// SessionTimeout. Runs until ctx is cancelled (i.e. on server shutdown).
func StartSessionCleanup(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				now := time.Now()
				sessionMapMutex.Lock()
				for id, session := range sessionMap {
					if now.Sub(session.CreationTime) > SessionTimeout {
						delete(sessionMap, id)
					}
				}
				sessionMapMutex.Unlock()
			case <-ctx.Done():
				return
			}
		}
	}()
}
