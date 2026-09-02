package handlers

import (
	"encoding/json"
	"errors"
	"net/http"

	"logsonic/pkg/ingestfile"
	"logsonic/pkg/types"
)

// ingestFileBatchLines is how many physical lines are decoded and stored per
// ingestBatch call while reading a file -- the same batch size the browser
// upload path uses, so memory per request stays bounded the same way.
const ingestFileBatchLines = MaxIngestLines

// @Summary Ingest a file by path
// @Description Read a log file the server can access (absolute path; gzip and zstd are detected by magic bytes) into an existing ingest session, optionally with its rotated siblings. Synchronous in this release: the response arrives when the file has been stored.
// @Tags ingest
// @Accept json
// @Produce json
// @Param request body types.IngestFileRequest true "Session and absolute path"
// @Success 200 {object} types.IngestFileResponse
// @Failure 400 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
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

	// Resolve the member list first so a bad path fails before any row is
	// stored. Open validates absolute / exists / not-a-directory.
	probe, err := ingestfile.Open(r.Context(), path)
	if err != nil {
		// Every Open failure (not absolute, not found, unreadable, a
		// directory) is the caller's path problem, so this is 400 either way.
		writeIngestFileError(w, http.StatusBadRequest, "INVALID_PATH", "Cannot open file", err.Error())
		return
	}
	info := probe.Info()
	probe.Close()

	members := []string{info.CanonicalPath}
	if req.IncludeRotated {
		expanded, expandErr := ingestfile.ExpandRotation(info.CanonicalPath)
		if expandErr != nil {
			writeIngestFileError(w, http.StatusBadRequest, "INVALID_PATH", "Cannot list rotated files", expandErr.Error())
			return
		}
		members = expanded
	}

	resp := types.IngestFileResponse{
		Status:      "success",
		Path:        info.CanonicalPath,
		Members:     members,
		Compression: string(info.Compression),
		SessionID:   req.SessionID,
	}

	for _, member := range members {
		reader, openErr := ingestfile.Open(r.Context(), member)
		if openErr != nil {
			resp.Status = "error"
			resp.Error = "cannot open " + member + ": " + openErr.Error()
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(resp)
			return
		}
		batch := make([]string, 0, ingestFileBatchLines)
		flush := func() error {
			if len(batch) == 0 {
				return nil
			}
			processed, failed, ingestErr := h.ingestBatch(req.SessionID, batch)
			batch = batch[:0]
			if ingestErr != nil {
				return ingestErr
			}
			resp.Processed += processed
			resp.Failed += failed
			return nil
		}
		var readErr error
		for {
			line, ok, nextErr := reader.Next()
			if nextErr != nil {
				readErr = nextErr
				break
			}
			if !ok {
				break
			}
			batch = append(batch, line)
			if len(batch) == ingestFileBatchLines {
				if ingestErr := flush(); ingestErr != nil {
					readErr = ingestErr
					break
				}
			}
		}
		if readErr == nil {
			readErr = flush()
		}
		resp.Lines += reader.Lines()
		resp.BytesRead += reader.BytesRead()
		reader.Close()
		if readErr != nil {
			resp.Status = "error"
			resp.Error = member + ": " + readErr.Error()
			status := http.StatusInternalServerError
			var tooLong *ingestfile.LineTooLongError
			var mlErr *multilineError
			switch {
			case errors.Is(readErr, errInvalidSession):
				status = http.StatusBadRequest
			case errors.As(readErr, &tooLong), errors.As(readErr, &mlErr):
				status = http.StatusBadRequest
			}
			w.WriteHeader(status)
			json.NewEncoder(w).Encode(resp)
			return
		}
	}

	json.NewEncoder(w).Encode(resp)
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
