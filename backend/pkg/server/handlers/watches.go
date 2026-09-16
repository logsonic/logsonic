package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"

	"logsonic/pkg/ingestfile"
	"logsonic/pkg/types"
	"logsonic/pkg/watch"

	"github.com/go-chi/chi/v5"
)

// watchDeps adapts the server's existing pieces to what pkg/watch borrows:
// the live-tail follower (TailManager.StartFileAt), a one-shot import of a
// file's current contents through the same ingestBatch the path-import job
// uses, per-file pattern detection through the same log2grok discovery the
// wizard's /suggest calls, and saved-pattern lookup from the library.
type watchDeps struct{ h *Services }

// StartFileAt / StopSource: the follower, unchanged.
func (d watchDeps) StartFileAt(path string, opts types.IngestSessionOptions, offset, seq int64, obs watch.FollowObserver, kind string) (string, error) {
	return d.h.Live.StartFileAt(path, opts, offset, seq, obs, kind)
}

func (d watchDeps) StopSource(id string) bool { return d.h.Live.StopSource(id) }

// ImportFile reads the file's current contents (gzip/zstd sniffed) in
// bounded batches through ingestBatch — the path-import route's path — and
// reports where it stopped. For a plain file that offset is exact: the
// reader hands back lines only as it consumes bytes, and at EOF everything
// read has been consumed, so a follower starting there sees only what was
// appended afterwards.
func (d watchDeps) ImportFile(ctx context.Context, path string, opts types.IngestSessionOptions) (watch.ImportResult, error) {
	sessionID, startErr := newIngestSession(opts)
	if startErr != nil {
		return watch.ImportResult{}, startErr
	}
	defer d.h.endIngestSession(sessionID)
	sessionMapMutex.Lock()
	if s, ok := sessionMap[sessionID]; ok {
		s.Origin = types.SourceOrigin{Kind: "watch", Path: path}
		sessionMap[sessionID] = s
	}
	sessionMapMutex.Unlock()

	reader, err := ingestfile.Open(ctx, path)
	if err != nil {
		return watch.ImportResult{}, err
	}
	defer reader.Close()
	info := reader.Info()
	var rows int64
	batch := make([]string, 0, ingestFileBatchLines)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		processed, _, err := d.h.ingestBatch(sessionID, batch)
		batch = batch[:0]
		rows += int64(processed)
		return err
	}
	for {
		if err := ctx.Err(); err != nil {
			return watch.ImportResult{}, err
		}
		line, ok, err := reader.Next()
		if err != nil {
			return watch.ImportResult{}, err
		}
		if !ok {
			break
		}
		batch = append(batch, line)
		if len(batch) >= ingestFileBatchLines {
			if err := flush(); err != nil {
				return watch.ImportResult{}, err
			}
		}
	}
	if err := flush(); err != nil {
		return watch.ImportResult{}, err
	}
	sessionMapMutex.RLock()
	var seq int64
	if s, ok := sessionMap[sessionID]; ok && s.Seq != nil {
		seq = s.Seq.Load()
	}
	sessionMapMutex.RUnlock()
	return watch.ImportResult{
		Offset:     reader.BytesRead(),
		Seq:        seq,
		Rows:       rows,
		Compressed: info.Compression != "",
	}, nil
}

// Detect reads the file's first lines and asks log2grok for a pattern —
// the same discovery the import wizard shows as "Pattern found".
func (d watchDeps) Detect(path string, lines int) (types.IngestSessionOptions, error) {
	reader, err := ingestfile.Open(context.Background(), path)
	if err != nil {
		return types.IngestSessionOptions{}, err
	}
	defer reader.Close()
	sample := make([]string, 0, lines)
	for len(sample) < lines {
		line, ok, err := reader.Next()
		if err != nil {
			return types.IngestSessionOptions{}, err
		}
		if !ok {
			break
		}
		if line != "" {
			sample = append(sample, line)
		}
	}
	results, err := d.h.autosuggestPatterns(sample)
	if err != nil {
		return types.IngestSessionOptions{}, err
	}
	if len(results) == 0 {
		return types.IngestSessionOptions{}, errors.New("no pattern detected for the first lines; set a pattern on the watch")
	}
	r := results[0]
	return types.IngestSessionOptions{
		Name:           r.PatternName,
		Pattern:        r.Pattern,
		CustomPatterns: r.CustomPatterns,
	}, nil
}

// patternOptions resolves a saved pattern name to its Grok body (the
// decoder never looks names up) plus its remembered timestamp settings.
func (h *Services) patternOptions(name string) (types.IngestSessionOptions, error) {
	for _, kp := range l2g.ListLibrary() {
		if kp.Name != name {
			continue
		}
		opts := types.IngestSessionOptions{Name: kp.Name, Pattern: kp.Pattern, CustomPatterns: kp.CustomPatterns}
		if h.PatternTimestamps != nil {
			if r, ok := h.PatternTimestamps.Snapshot()[kp.Name]; ok {
				rCopy := r
				opts.TimestampConfig = &rCopy
			}
		}
		return opts, nil
	}
	return types.IngestSessionOptions{}, fmt.Errorf("no saved pattern named %q (GET /api/v1/grok lists them)", name)
}

func writeWatchesUnavailable(w http.ResponseWriter) {
	w.WriteHeader(http.StatusServiceUnavailable)
	json.NewEncoder(w).Encode(types.ErrorResponse{
		Status: "error", Error: "Folder watches unavailable", Code: "WATCHES_UNAVAILABLE",
		Details: "watches.json could not be opened at startup; see the server log",
	})
}

func writeWatchNotFound(w http.ResponseWriter, id string) {
	w.WriteHeader(http.StatusNotFound)
	json.NewEncoder(w).Encode(types.ErrorResponse{
		Status: "error", Error: "Watch not found", Code: "WATCH_NOT_FOUND",
		Details: "no watch with id " + id + "; GET /api/v1/watches lists them",
	})
}

// @Summary List folder watches
// @Description Every folder watch with its live per-file snapshot (state pending | ingesting | following | done | skipped | error, offset, size, source name).
// @Tags watches
// @Produce json
// @Success 200 {object} types.WatchesResponse
// @Failure 503 {object} types.ErrorResponse
// @Router /watches [get]
func (h *Services) HandleListWatches(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if h.Watches == nil {
		writeWatchesUnavailable(w)
		return
	}
	json.NewEncoder(w).Encode(types.WatchesResponse{Watches: h.Watches.List()})
}

// @Summary Create a folder watch
// @Description Watch an absolute, existing directory: every file whose base name matches glob (default *.log) is ingested when it appears and followed as it grows, under the source name watch.<dirname>.<filename>. pattern is "" or "auto" for per-file detection, else a saved Grok pattern name. Persisted in <storage>/watches.json and resumed after a restart.
// @Tags watches
// @Accept json
// @Produce json
// @Param request body types.WatchRequest true "Watch to create"
// @Success 201 {object} types.Watch
// @Failure 400 {object} types.ErrorResponse
// @Failure 409 {object} types.ErrorResponse
// @Failure 503 {object} types.ErrorResponse
// @Router /watches [post]
func (h *Services) HandleCreateWatch(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if h.Watches == nil {
		writeWatchesUnavailable(w)
		return
	}
	var req types.WatchRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Invalid request body", Code: "INVALID_REQUEST", Details: err.Error()})
		return
	}
	created, err := h.Watches.Create(req)
	if err != nil {
		if errors.Is(err, watch.ErrExists) {
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Directory already watched", Code: "WATCH_EXISTS", Details: err.Error()})
			return
		}
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Invalid watch", Code: "INVALID_WATCH", Details: err.Error()})
		return
	}
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(created)
}

// @Summary Delete a folder watch
// @Description Stop following and forget the watch. Rows already indexed stay.
// @Tags watches
// @Produce json
// @Param id path string true "Watch ID"
// @Success 204
// @Failure 404 {object} types.ErrorResponse
// @Failure 503 {object} types.ErrorResponse
// @Router /watches/{id} [delete]
func (h *Services) HandleDeleteWatch(w http.ResponseWriter, r *http.Request) {
	if h.Watches == nil {
		w.Header().Set("Content-Type", "application/json")
		writeWatchesUnavailable(w)
		return
	}
	id := chi.URLParam(r, "id")
	if err := h.Watches.Delete(id); err != nil {
		w.Header().Set("Content-Type", "application/json")
		writeWatchNotFound(w, id)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// @Summary Pause a folder watch
// @Description Stop detection and following; offsets are kept, so resume continues where each file was left.
// @Tags watches
// @Produce json
// @Param id path string true "Watch ID"
// @Success 200 {object} types.Watch
// @Failure 404 {object} types.ErrorResponse
// @Router /watches/{id}/pause [post]
func (h *Services) HandlePauseWatch(w http.ResponseWriter, r *http.Request) {
	h.watchToggle(w, r, true)
}

// @Summary Resume a folder watch
// @Description Sweep the directory now and continue following from the stored offsets.
// @Tags watches
// @Produce json
// @Param id path string true "Watch ID"
// @Success 200 {object} types.Watch
// @Failure 404 {object} types.ErrorResponse
// @Router /watches/{id}/resume [post]
func (h *Services) HandleResumeWatch(w http.ResponseWriter, r *http.Request) {
	h.watchToggle(w, r, false)
}

func (h *Services) watchToggle(w http.ResponseWriter, r *http.Request, pause bool) {
	w.Header().Set("Content-Type", "application/json")
	if h.Watches == nil {
		writeWatchesUnavailable(w)
		return
	}
	id := chi.URLParam(r, "id")
	var (
		out types.Watch
		err error
	)
	if pause {
		out, err = h.Watches.Pause(id)
	} else {
		out, err = h.Watches.Resume(id)
	}
	if err != nil {
		writeWatchNotFound(w, id)
		return
	}
	json.NewEncoder(w).Encode(out)
}
