package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"

	"logsonic/pkg/ingestfile"
	"logsonic/pkg/samples"
	"logsonic/pkg/types"

	"github.com/go-chi/chi/v5"
)

// @Summary List bundled sample logs
// @Description The sample files embedded in the binary for a first run, with the source name and pattern each imports under.
// @Tags samples
// @Produce json
// @Success 200 {object} types.SamplesResponse
// @Router /samples [get]
func (h *Services) HandleListSamples(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	out := types.SamplesResponse{Samples: []types.SampleInfo{}}
	for _, s := range samples.List() {
		out.Samples = append(out.Samples, types.SampleInfo{
			Name: s.Name, Description: s.Description, Lines: s.Lines, Bytes: s.Bytes,
			License: s.License, Source: s.Source, PatternName: s.PatternName,
		})
	}
	json.NewEncoder(w).Encode(out)
}

// @Summary Import a bundled sample
// @Description Ingest a bundled sample straight from the binary into the index (nothing is written to disk) under its fixed source name with its pinned pattern. Runs as a path-ingest job: 202 with the job id, progress as "ingest_progress" on /live/events, the session ends itself. Importing the same sample twice upserts the same rows.
// @Tags samples
// @Produce json
// @Param name path string true "Sample name (GET /samples)"
// @Success 202 {object} types.IngestFileResponse
// @Failure 404 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Router /samples/{name}/import [post]
func (h *Services) HandleImportSample(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	name := chi.URLParam(r, "name")
	sample, data, ok := samples.Get(name)
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "No such sample", Code: "SAMPLE_NOT_FOUND", Details: "GET /api/v1/samples lists the bundled samples"})
		return
	}
	sessionID, startErr := newIngestSession(types.IngestSessionOptions{
		Name:    sample.PatternName,
		Pattern: sample.Pattern,
		Source:  sample.Source,
		Meta:    map[string]interface{}{"_src": sample.Source},
	})
	if startErr != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: startErr.message, Code: startErr.code, Details: startErr.details})
		return
	}
	member := "sample:" + sample.Name
	job, ctx := h.newIngestFileJob(sessionID, member, []string{member}, "", true, "sample")
	job.bytesTotal = int64(len(data))
	job.openMember = func(ctx context.Context, _ string) (*ingestfile.Reader, error) {
		return ingestfile.OpenReader(ctx, bytes.NewReader(data), member, int64(len(data)))
	}
	go h.runIngestFileJob(ctx, job)
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(types.IngestFileResponse{Status: "accepted", JobID: job.id, Path: member, Members: []string{member}})
}

// @Summary Bring the app window to the front
// @Description Broadcasts a "ui_focus" event on /live/events; the macOS shell raises its window and, when a route is given, navigates to it. In browser mode nothing listens — the CLI prints the URL instead.
// @Tags ui
// @Accept json
// @Produce json
// @Param request body types.UIFocusRequest false "Optional route (a #/... hash)"
// @Success 204
// @Router /ui/focus [post]
func (h *Services) HandleUIFocus(w http.ResponseWriter, r *http.Request) {
	var req types.UIFocusRequest
	if r.Body != nil {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req)
	}
	if h.Live != nil {
		h.Live.publishBroadcast("ui_focus", types.UIFocusEvent(req))
	}
	w.WriteHeader(http.StatusNoContent)
}
