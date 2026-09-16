package handlers

import (
	"context"
	"encoding/json"
	"net/http"

	"logsonic/pkg/ingestfile"
	"logsonic/pkg/types"
)

// ingestFileBatchLines is how many physical lines are decoded and stored per
// ingestBatch call while reading a file -- the same batch size the browser
// upload path uses, so memory per request stays bounded the same way.
const ingestFileBatchLines = MaxIngestLines

// @Summary Ingest a file by path
// @Description Start ingesting a log file the server can access (absolute path; gzip and zstd are detected by magic bytes) into an existing ingest session, optionally with its rotated siblings. Accepted immediately (202); the read runs in the background. Poll GET /ingest/jobs or listen for "ingest_progress" on GET /live/events for progress and the final state. Call POST /ingest/end only after the job reaches a terminal state (done|cancelled|error) -- ending the session while the job is still running fails its next batch with an invalid-session error.
// @Tags ingest
// @Accept json
// @Produce json
// @Param request body types.IngestFileRequest true "Session and absolute path"
// @Success 202 {object} types.IngestFileResponse
// @Failure 400 {object} types.ErrorResponse
// @Router /ingest/file [post]
func (h *Services) HandleIngestFile(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	var req types.IngestFileRequest
	if !decodeIngestJSON(w, r, &req) {
		return
	}
	path := req.Path
	if path == "" {
		path = req.LogFileName
	}
	if path == "" {
		writeIngestFileError(w, http.StatusBadRequest, "INVALID_PATH", "path is required (absolute path to a readable file)", "")
		return
	}

	// Check the session before touching the filesystem: without this, a
	// request with no valid session could still use this endpoint to probe
	// whether an arbitrary local path exists and how big it is, from the
	// error response alone.
	sessionMapMutex.RLock()
	_, sessionExists := sessionMap[req.SessionID]
	sessionMapMutex.RUnlock()
	if !sessionExists {
		writeIngestFileError(w, http.StatusBadRequest, "INVALID_SESSION", "Invalid or missing session ID", "")
		return
	}

	// Resolve the member list before responding, so a bad path still fails
	// with a synchronous 400 rather than surfacing only as a job error.
	canonical, members, compression, openErr := openFileForImport(r.Context(), path, req.IncludeRotated)
	if openErr != nil {
		// Every Open failure (not absolute, not found, unreadable, a
		// directory) is the caller's path problem, so this is 400 either way.
		writeIngestFileError(w, http.StatusBadRequest, "INVALID_PATH", openErr.message, openErr.details)
		return
	}
	job := h.startIngestFileJob(req.SessionID, canonical, members, compression, false)

	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(types.IngestFileResponse{
		Status:  "accepted",
		JobID:   job.id,
		Path:    canonical,
		Members: members,
	})
}

// openError is openFileForImport's report; both cases are path problems.
type openError struct{ message, details string }

func (e *openError) Error() string { return e.message + ": " + e.details }

// openFileForImport validates a path (absolute, exists, readable, not a
// directory), canonicalizes it, and lists the members to ingest — the
// shared half of POST /ingest/file and the re-import route. Open sniffs
// compression by magic bytes.
func openFileForImport(ctx context.Context, path string, includeRotated bool) (canonical string, members []string, compression string, err *openError) {
	probe, openErr := ingestfile.Open(ctx, path)
	if openErr != nil {
		return "", nil, "", &openError{message: "Cannot open file", details: openErr.Error()}
	}
	info := probe.Info()
	probe.Close()

	members = []string{info.CanonicalPath}
	if includeRotated {
		expanded, expandErr := ingestfile.ExpandRotation(info.CanonicalPath)
		if expandErr != nil {
			return "", nil, "", &openError{message: "Cannot list rotated files", details: expandErr.Error()}
		}
		members = expanded
	}
	return info.CanonicalPath, members, string(info.Compression), nil
}

func writeIngestFileError(w http.ResponseWriter, status int, code, message, details string) {
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(types.ErrorResponse{
		Status:  "error",
		Error:   message,
		Code:    code,
		Details: details,
	})
}
