package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"logsonic/pkg/ingestfile"
	"logsonic/pkg/types"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	l2g "github.com/logsonic/log2grok/pkg/log2grok"
)

const (
	DefaultPatternName    = "DEFAULT_PATTERN"
	DefaultPattern        = "%{GREEDYDATA:message}"
	SessionTimeout        = 60 * time.Minute
	MaxIngestRequestBytes = 16 * 1024 * 1024
	MaxIngestLines        = 10_000
	// MaxIngestLineBytes is shared with the path-based reader so both ingest
	// routes reject the same input.
	MaxIngestLineBytes = ingestfile.MaxLineBytes
)

// Errors returned by ingestBatch, mapped to HTTP statuses by its callers.
var (
	errInvalidSession = errors.New("invalid or missing session ID")
)

// multilineError wraps a folding failure so callers can return 400 with the
// folder's message rather than a generic 500.
type multilineError struct{ err error }

func (e *multilineError) Error() string { return e.err.Error() }
func (e *multilineError) Unwrap() error { return e.err }

// ingestBatch is the one decode-and-store path for a session: it marks the
// session active, folds multiline records, decodes with the session's
// compiled pattern, stamps `_seq`, and stores. Both the chunk endpoint
// (/ingest/logs) and the path endpoint (/ingest/file) call it, which is what
// keeps their stored documents identical.
func (h *Services) ingestBatch(sessionID string, lines []string) (processed, failed int, err error) {
	// Mark the request as activity while atomically taking the session
	// snapshot. This prevents the cleanup sweep from expiring an active
	// upload between session lookup and decoding/storage.
	sessionMapMutex.Lock()
	session, exists := sessionMap[sessionID]
	if exists {
		session.LastActivity = time.Now()
		sessionMap[sessionID] = session
	}
	sessionOptions := session.Options
	sessionDecoder := session.Decoder
	sessionSeq := session.Seq
	sessionMultiline := session.Multiline
	sessionOrigin := session.Origin
	sessionJobID := session.JobID
	sessionMapMutex.Unlock()

	if !exists || sessionID == "" {
		return 0, 0, errInvalidSession
	}

	logs := lines
	if sessionMultiline != nil {
		folded, foldErr := sessionMultiline.Feed(lines)
		if foldErr != nil {
			return 0, 0, &multilineError{err: foldErr}
		}
		logs = folded
	}
	if len(logs) == 0 {
		// Batch was entirely absorbed into a still-open multiline record;
		// nothing to decode/store yet.
		return 0, 0, nil
	}

	// DecodeConcurrent fans the regex work across NumCPU goroutines for
	// large batches and transparently falls back to serial Decode below
	// its internal threshold (~512 lines). The Decoder is goroutine-safe
	// and output order is preserved, so this is a drop-in replacement
	// for Decode that scales ingest throughput on multi-core boxes.
	results := sessionDecoder.DecodeConcurrent(logs, 0)
	jsonOutput, successCount, failedCount, _ := postProcess(results, sessionOptions, sessionSeq)

	if err := h.storage.Store(jsonOutput, sessionOptions.Source); err != nil {
		return 0, 0, fmt.Errorf("failed to store logs: %w", err)
	}
	h.recordStored(storedBatch{
		Opts: sessionOptions, Origin: sessionOrigin,
		ImportID: sessionID, ImportJobID: sessionJobID,
		Lines: logs, Rows: jsonOutput,
	})
	return successCount, failedCount, nil
}

// IngestSession ties one /ingest/start invocation to its compiled
// log2grok Decoder so subsequent /ingest/logs calls don't recompile the
// pattern per request. Decoders are immutable + goroutine-safe so we
// can hand the same pointer to many concurrent callers.
type IngestSession struct {
	Options      types.IngestSessionOptions
	CreationTime time.Time
	LastActivity time.Time
	Decoder      *l2g.Decoder
	// Seq is a session-wide monotonic line counter shared across every
	// /ingest call for this session (the session is copied by value out
	// of sessionMap, but the pointer is shared, so the count survives
	// across chunks). postProcess stamps each line's `_seq` from it to
	// preserve original order and keep storage docIDs unique.
	Seq *atomic.Int64
	// Multiline folds physical lines into logical records across
	// /ingest/logs chunk boundaries before decoding. Nil when the
	// session didn't opt into multiline folding.
	Multiline *multilineFolder
	// Origin is what the catalog records for rows stored under this
	// session: a browser chunk upload is {file} with no path; a path
	// import (ingest_jobs.go) stamps {file, <canonical path>} and JobID
	// when it starts.
	Origin types.SourceOrigin
	JobID  string
}

var sessionMap = make(map[string]IngestSession)
var sessionMapMutex = &sync.RWMutex{}

func isRequestBodyTooLarge(err error) bool {
	var maxBytesError *http.MaxBytesError
	return errors.As(err, &maxBytesError)
}

func writeIngestBodyError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	code := "INVALID_REQUEST"
	message := "Invalid request body"
	if isRequestBodyTooLarge(err) {
		status = http.StatusRequestEntityTooLarge
		code = "INGEST_BODY_TOO_LARGE"
		message = "Ingest request body exceeds the configured limit"
	}
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(types.ErrorResponse{
		Status:  "error",
		Error:   message,
		Code:    code,
		Details: err.Error(),
	})
}

func decodeIngestJSON(w http.ResponseWriter, r *http.Request, target interface{}) bool {
	r.Body = http.MaxBytesReader(w, r.Body, MaxIngestRequestBytes)
	if err := json.NewDecoder(r.Body).Decode(target); err != nil {
		writeIngestBodyError(w, err)
		return false
	}
	return true
}

func writeIngestLimitError(w http.ResponseWriter, message string) {
	w.WriteHeader(http.StatusRequestEntityTooLarge)
	json.NewEncoder(w).Encode(types.ErrorResponse{
		Status: "error",
		Error:  message,
		Code:   "INGEST_LIMIT_EXCEEDED",
	})
}

func validateIngestLogs(logs []string) (string, bool) {
	if len(logs) > MaxIngestLines {
		return "Ingest request contains too many log lines", false
	}
	for _, line := range logs {
		if len(line) > MaxIngestLineBytes {
			return "A log line exceeds the configured size limit", false
		}
	}
	return "", true
}

// @Summary Ingest log data
// @Description Ingest log data using existing Grok patterns and store them into the index
// @Tags ingest
// @Accept json
// @Produce json
// @Param request body types.IngestRequest true "Log ingest request"
// @Success 200 {object} types.IngestResponse
// @Failure 400 {object} types.ErrorResponse
// @Failure 413 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Router /ingest/logs [post]
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
	if !decodeIngestJSON(w, r, &req) {
		return
	}

	if message, ok := validateIngestLogs(req.Logs); !ok {
		writeIngestLimitError(w, message)
		return
	}

	processed, failed, err := h.ingestBatch(req.SessionID, req.Logs)
	if err != nil {
		var mlErr *multilineError
		switch {
		case errors.Is(err, errInvalidSession):
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(types.ErrorResponse{
				Status: "error",
				Error:  "Invalid or missing session ID",
				Code:   "INVALID_SESSION",
			})
		case errors.As(err, &mlErr):
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(types.ErrorResponse{
				Status:  "error",
				Error:   "Failed to fold multiline records",
				Code:    "MULTILINE_ERROR",
				Details: mlErr.err.Error(),
			})
		default:
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(types.ErrorResponse{
				Status:  "error",
				Error:   "Failed to store logs",
				Code:    "STORAGE_ERROR",
				Details: err.Error(),
			})
		}
		return
	}

	json.NewEncoder(w).Encode(types.IngestResponse{
		Status:    "success",
		Processed: processed,
		Failed:    failed,
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
// @Failure 413 {object} types.ErrorResponse
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
	if !decodeIngestJSON(w, r, &req) {
		return
	}

	sessionID, startErr := newIngestSession(req)
	if startErr != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   startErr.message,
			Code:    startErr.code,
			Details: startErr.details,
		})
		return
	}

	json.NewEncoder(w).Encode(types.IngestResponse{
		Status:    "success",
		SessionID: sessionID,
	})
}

// sessionStartError is what newIngestSession reports; every case is the
// caller's input, so HandleIngestStart maps all of them to 400.
type sessionStartError struct {
	code, message, details string
}

func (e *sessionStartError) Error() string { return e.message + ": " + e.details }

// newIngestSession compiles the pattern and registers a session, the shared
// half of POST /ingest/start and the server-initiated re-import
// (POST /sources/{name}/reimport), which replays a catalog entry's
// recorded options through the same code so the rows land identically.
func newIngestSession(req types.IngestSessionOptions) (string, *sessionStartError) {
	if req.Name == "" && req.Pattern == "" {
		return "", &sessionStartError{code: "INVALID_PATTERN", message: "Pattern name or pattern is required"}
	}
	if err := resolveSavedPattern(&req); err != nil {
		return "", &sessionStartError{code: "PATTERN_NOT_FOUND", message: "Unknown pattern name", details: err.Error()}
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
		return "", &sessionStartError{code: "PATTERN_ERROR", message: "Failed to add pattern", details: err.Error()}
	}

	multilineCfg, err := buildMultilineConfig(req.Multiline)
	if err != nil {
		return "", &sessionStartError{code: "MULTILINE_CONFIG_ERROR", message: "Invalid multiline configuration", details: err.Error()}
	}
	var multiline *multilineFolder
	if multilineCfg != nil {
		multiline = newMultilineFolder(*multilineCfg)
	}

	sessionID := uuid.New().String()
	now := time.Now()

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
		Meta:      req.Meta,
		Multiline: req.Multiline,
	}

	sessionMapMutex.Lock()
	sessionMap[sessionID] = IngestSession{
		Options:      sessionOptions,
		CreationTime: now,
		LastActivity: now,
		Decoder:      dec,
		Seq:          new(atomic.Int64),
		Multiline:    multiline,
		// Browser chunk uploads have no path the server can name; a
		// path import overwrites this when its job starts.
		Origin: types.SourceOrigin{Kind: "file"},
	}
	sessionMapMutex.Unlock()
	return sessionID, nil
}

// endIngestSession is /ingest/end's teardown: drop the session and flush
// its trailing multiline record. Also run by a path-ingest job that was
// started by the server (re-import) rather than a client, which would
// otherwise leave the session to the expiry sweep.
func (h *Services) endIngestSession(sessionID string) {
	sessionMapMutex.Lock()
	session, exists := sessionMap[sessionID]
	delete(sessionMap, sessionID)
	sessionMapMutex.Unlock()
	if exists {
		h.flushSessionMultiline(session, sessionID)
	}
}

// @Summary End log ingest session
// @Description End the specified log ingest session and cleanup its resources
// @Tags ingest
// @Accept json
// @Produce json
// @Param request body types.IngestRequest true "Session end request with session_id"
// @Success 200 {object} types.IngestResponse
// @Failure 400 {object} types.ErrorResponse
// @Failure 413 {object} types.ErrorResponse
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

	r.Body = http.MaxBytesReader(w, r.Body, MaxIngestRequestBytes)
	var req types.IngestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		if isRequestBodyTooLarge(err) {
			writeIngestBodyError(w, err)
			return
		}
		json.NewEncoder(w).Encode(types.IngestResponse{
			Status: "success",
		})
		return
	}

	if req.SessionID != "" {
		h.endIngestSession(req.SessionID)
	}

	json.NewEncoder(w).Encode(types.IngestResponse{
		Status: "success",
	})
}

// flushSessionMultiline decodes and stores any still-open trailing
// multiline record. Used by /ingest/end and by session expiry so the
// last record isn't dropped when nothing arrived to prove it complete.
func (h *Services) flushSessionMultiline(session IngestSession, sessionID string) {
	if session.Multiline == nil {
		return
	}
	final := session.Multiline.Flush()
	if len(final) == 0 {
		return
	}
	results := session.Decoder.DecodeConcurrent(final, 0)
	jsonOutput, _, _, _ := postProcess(results, session.Options, session.Seq)
	if len(jsonOutput) == 0 {
		return
	}
	if err := h.storage.Store(jsonOutput, session.Options.Source); err != nil {
		log.Printf("ingest: failed to store trailing multiline record for session %s: %v", sessionID, err)
		return
	}
	h.recordStored(storedBatch{
		Opts: session.Options, Origin: session.Origin,
		ImportID: sessionID, ImportJobID: session.JobID,
		Lines: final, Rows: jsonOutput,
	})
}

// expireStaleSessions removes sessions older than SessionTimeout and
// flushes any pending multiline records before they are discarded.
func expireStaleSessions(now time.Time, h *Services) {
	type expiredSession struct {
		id      string
		session IngestSession
	}
	var expired []expiredSession
	sessionMapMutex.Lock()
	for id, session := range sessionMap {
		lastActivity := session.LastActivity
		if lastActivity.IsZero() {
			// Preserve cleanup behavior for sessions created by older binaries
			// or tests that do not have LastActivity populated.
			lastActivity = session.CreationTime
		}
		if now.Sub(lastActivity) > SessionTimeout {
			expired = append(expired, expiredSession{id: id, session: session})
			delete(sessionMap, id)
		}
	}
	sessionMapMutex.Unlock()
	for _, e := range expired {
		h.flushSessionMultiline(e.session, e.id)
	}
}

// StartSessionCleanup launches a background goroutine that sweeps
// sessionMap every 5 minutes and removes sessions older than
// SessionTimeout. Runs until ctx is cancelled (i.e. on server shutdown).
func StartSessionCleanup(ctx context.Context, h *Services) {
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				expireStaleSessions(time.Now(), h)
			case <-ctx.Done():
				return
			}
		}
	}()
}
