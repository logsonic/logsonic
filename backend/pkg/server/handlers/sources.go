package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"

	"logsonic/pkg/catalog"
	"logsonic/pkg/types"

	"github.com/go-chi/chi/v5"
)

// @Summary List sources
// @Description Every source in the catalog (<storage>/sources.json): origin, pattern, rows, bytes, timestamp span, the day-indices holding it, and its import history. Maintained on the ingest write path; see POST /sources/rebuild to reconcile with the indices.
// @Tags sources
// @Produce json
// @Success 200 {object} types.SourcesResponse
// @Failure 503 {object} types.ErrorResponse
// @Router /sources [get]
func (h *Services) HandleListSources(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if h.Catalog == nil {
		writeCatalogUnavailable(w)
		return
	}
	json.NewEncoder(w).Encode(types.SourcesResponse{Sources: h.Catalog.List()})
}

// @Summary Get one source
// @Description One catalog entry by source name (the stored _src value).
// @Tags sources
// @Produce json
// @Param name path string true "Source name"
// @Success 200 {object} types.SourceEntry
// @Failure 404 {object} types.ErrorResponse
// @Failure 503 {object} types.ErrorResponse
// @Router /sources/{name} [get]
func (h *Services) HandleGetSource(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if h.Catalog == nil {
		writeCatalogUnavailable(w)
		return
	}
	name := chi.URLParam(r, "name")
	entry, err := h.Catalog.Get(name)
	if err != nil {
		if errors.Is(err, catalog.ErrNotFound) {
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(types.ErrorResponse{
				Status:  "error",
				Error:   "Source not found",
				Code:    "SOURCE_NOT_FOUND",
				Details: "no catalog entry named " + name + "; GET /api/v1/sources lists what exists",
			})
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Failed to read source", Code: "SOURCE_READ_ERROR", Details: err.Error()})
		return
	}
	json.NewEncoder(w).Encode(entry)
}

// @Summary Rebuild the sources catalog from the indices
// @Description Recomputes rows, days and timestamp bounds for every source from the day-indices (one size-0 facet per day on current indices; a stored-field read on indices created before v1.8's keyword _src mapping). Origin, pattern and import history are kept; sources with no rows left are dropped. Idempotent.
// @Tags sources
// @Produce json
// @Success 200 {object} types.SourcesResponse
// @Failure 500 {object} types.ErrorResponse
// @Failure 503 {object} types.ErrorResponse
// @Router /sources/rebuild [post]
func (h *Services) HandleRebuildSources(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if h.Catalog == nil {
		writeCatalogUnavailable(w)
		return
	}
	if err := h.Catalog.Rebuild(); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Catalog rebuild failed",
			Code:    "CATALOG_REBUILD_ERROR",
			Details: err.Error(),
		})
		return
	}
	if err := h.Catalog.Flush(); err != nil {
		// The in-memory catalog is correct; only persistence failed. Say
		// so rather than pretend, but return the rebuilt list.
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Catalog rebuilt but could not be saved",
			Code:    "CATALOG_SAVE_ERROR",
			Details: err.Error() + " — check that " + h.Catalog.Path() + " is writable",
		})
		return
	}
	h.InvalidateInfoCache()
	json.NewEncoder(w).Encode(types.SourcesResponse{Sources: h.Catalog.List()})
}

func writeCatalogUnavailable(w http.ResponseWriter) {
	w.WriteHeader(http.StatusServiceUnavailable)
	json.NewEncoder(w).Encode(types.ErrorResponse{
		Status:  "error",
		Error:   "Sources catalog unavailable",
		Code:    "CATALOG_UNAVAILABLE",
		Details: "sources.json could not be opened at startup; see the server log",
	})
}

// sourceInUse reports whether a running tail or path-ingest job is storing
// rows under name. An in-flight browser chunk upload (a session with no
// job) is not detected: it has no server-side handle to check, so it can
// race a delete — its next chunk simply stores rows that survive the
// delete. Recorded in ISSUES.md.
func (h *Services) sourceInUse(name string) (bool, string) {
	if h.Live != nil {
		if kind, ok := h.Live.ActiveSourceKinds()[name]; ok {
			if kind == "watch" {
				return true, "a folder watch is following this file; pause or delete the watch first (Settings → Watched folders, or DELETE /api/v1/watches/{id})"
			}
			return true, "a live tail is writing to this source; stop it first (DELETE /api/v1/live/sources/{id})"
		}
	}
	for _, s := range runningIngestSources() {
		if s == name {
			return true, "a path import is still running for this source; wait for it or cancel the job (DELETE /api/v1/ingest/jobs/{id})"
		}
	}
	return false, ""
}

// deleteSourceRows removes a source's rows from every day the catalog lists
// for it, removes day-indices that end up empty, reconciles the catalog for
// the touched days, and drops the entry. Shared by DELETE and re-import.
func (h *Services) deleteSourceRows(ctx context.Context, entry types.SourceEntry) (types.SourceDeleteResponse, error) {
	rows, touched, err := h.storage.DeleteBySource(ctx, entry.Name, entry.Days)
	resp := types.SourceDeleteResponse{Status: "success", Name: entry.Name, RowsDeleted: rows, DaysTouched: touched, DaysRemoved: []string{}}
	if touched == nil {
		resp.DaysTouched = []string{}
	}
	if err != nil {
		// Partial progress is real: reconcile what did change before
		// reporting, so the catalog never overstates what is left. Only
		// the touched days — an empty list would mean a full rebuild.
		if len(touched) > 0 {
			h.rebuildCatalog(touched...)
		}
		h.InvalidateInfoCache()
		return resp, err
	}
	for _, day := range touched {
		n, countErr := h.storage.GetDocCount(day)
		if countErr != nil || n != 0 {
			continue
		}
		if removeErr := h.storage.RemoveDay(day); removeErr != nil {
			log.Printf("sources: remove empty day-index %s: %v", day, removeErr)
			continue
		}
		resp.DaysRemoved = append(resp.DaysRemoved, day)
	}
	// Other sources sharing those days are recounted (the delete touched
	// only this source's rows, but a removed day must leave their entries
	// too); then this entry goes regardless of what the recount found. A
	// stale entry that found nothing to delete skips the recount rather
	// than triggering a full rebuild through the empty variadic.
	if len(touched) > 0 {
		h.rebuildCatalog(touched...)
	}
	if delErr := h.Catalog.Delete(entry.Name); delErr != nil && !errors.Is(delErr, catalog.ErrNotFound) {
		log.Printf("sources: drop catalog entry %s: %v", entry.Name, delErr)
	}
	h.InvalidateInfoCache()
	return resp, nil
}

// @Summary Delete a source
// @Description Delete every row stored under this source (its exact stored _src) from every day-index holding it, remove day-indices that end up empty, and drop the catalog entry. Not undoable. Refused with 409 while a live tail or a path-ingest job is still writing to the source.
// @Tags sources
// @Produce json
// @Param name path string true "Source name (stored _src)"
// @Success 200 {object} types.SourceDeleteResponse
// @Failure 404 {object} types.ErrorResponse
// @Failure 409 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Failure 503 {object} types.ErrorResponse
// @Router /sources/{name} [delete]
func (h *Services) HandleDeleteSource(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if h.Catalog == nil {
		writeCatalogUnavailable(w)
		return
	}
	name := chi.URLParam(r, "name")
	entry, err := h.Catalog.Get(name)
	if err != nil {
		writeSourceNotFound(w, name)
		return
	}
	if busy, why := h.sourceInUse(name); busy {
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Source is in use", Code: "SOURCE_IN_USE", Details: why})
		return
	}
	resp, err := h.deleteSourceRows(r.Context(), entry)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Delete stopped part-way",
			Code:    "SOURCE_DELETE_ERROR",
			Details: fmt.Sprintf("%d row(s) were removed before the error; the catalog was reconciled for the days touched — retry to finish: %v", resp.RowsDeleted, err),
		})
		return
	}
	json.NewEncoder(w).Encode(resp)
}

// @Summary Rename a source (display name)
// @Description Set or clear a display name. The index keeps the stored _src; every display name ever set is kept as an alias, and the _src query parameter on GET /logs resolves aliases to the stored name. The display name must not collide with another source's name, display name or alias.
// @Tags sources
// @Accept json
// @Produce json
// @Param name path string true "Source name (stored _src)"
// @Param request body types.SourceRenameRequest true "New display name; empty clears it"
// @Success 200 {object} types.SourceEntry
// @Failure 400 {object} types.ErrorResponse
// @Failure 404 {object} types.ErrorResponse
// @Failure 409 {object} types.ErrorResponse
// @Failure 503 {object} types.ErrorResponse
// @Router /sources/{name} [patch]
func (h *Services) HandleRenameSource(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if h.Catalog == nil {
		writeCatalogUnavailable(w)
		return
	}
	name := chi.URLParam(r, "name")
	var req types.SourceRenameRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Invalid request body", Code: "INVALID_REQUEST", Details: err.Error()})
		return
	}
	entry, err := h.Catalog.Rename(name, req.DisplayName)
	switch {
	case errors.Is(err, catalog.ErrNotFound):
		writeSourceNotFound(w, name)
		return
	case errors.Is(err, catalog.ErrNameTaken):
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Display name already in use", Code: "SOURCE_NAME_TAKEN", Details: fmt.Sprintf("%q is another source's name, display name or alias; pick a different one", req.DisplayName)})
		return
	case errors.Is(err, catalog.ErrBadName):
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Invalid display name", Code: "SOURCE_NAME_INVALID", Details: "1–120 characters, no leading or trailing whitespace"})
		return
	case err != nil:
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Rename failed", Code: "SOURCE_RENAME_ERROR", Details: err.Error()})
		return
	}
	h.InvalidateInfoCache()
	json.NewEncoder(w).Encode(entry)
}

// @Summary Re-import a source from its origin path
// @Description Requires an origin path that is still readable and the options recorded at its last path import. Validates the path and compiles the pattern first, then deletes the source's rows and starts a path-ingest job (same as POST /ingest/file) that stores them again under the same _src. The catalog entry is kept with zero rows — display name, aliases, origin, pattern and import history survive — and fills as the job runs. 409 while a tail or job is writing to the source; 400 when the path is gone or the source was never path-imported.
// @Tags sources
// @Produce json
// @Param name path string true "Source name (stored _src)"
// @Success 202 {object} types.SourceReimportResponse
// @Failure 400 {object} types.ErrorResponse
// @Failure 404 {object} types.ErrorResponse
// @Failure 409 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Failure 503 {object} types.ErrorResponse
// @Router /sources/{name}/reimport [post]
func (h *Services) HandleReimportSource(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if h.Catalog == nil {
		writeCatalogUnavailable(w)
		return
	}
	name := chi.URLParam(r, "name")
	entry, err := h.Catalog.Get(name)
	if err != nil {
		writeSourceNotFound(w, name)
		return
	}
	if entry.Origin.Path == "" || entry.ImportOptions == nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Source cannot be re-imported",
			Code:    "SOURCE_NOT_REIMPORTABLE",
			Details: "only sources imported by path (Dock drop, Finder Open With, POST /ingest/file) record a path and options to replay; this one was uploaded from the browser or came from a stream",
		})
		return
	}
	if busy, why := h.sourceInUse(name); busy {
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Source is in use", Code: "SOURCE_IN_USE", Details: why})
		return
	}

	// Everything that can fail on input happens before any row is touched:
	// the path must still open and the recorded pattern must still compile.
	canonical, members, compression, openErr := openFileForImport(r.Context(), entry.Origin.Path, false)
	if openErr != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: openErr.message, Code: "INVALID_PATH", Details: entry.Origin.Path + ": " + openErr.details + " — nothing was deleted"})
		return
	}
	sessionID, startErr := newIngestSession(*entry.ImportOptions)
	if startErr != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: startErr.message, Code: startErr.code, Details: startErr.details + " — nothing was deleted"})
		return
	}

	deleted, err := h.deleteSourceRows(r.Context(), entry)
	// Keep the entry (rename, aliases, origin, pattern, history) with zero
	// rows; the job refills it. Done even on a partial delete so what the
	// user named is never silently forgotten.
	h.Catalog.Reinstate(entry)
	h.InvalidateInfoCache()
	if err != nil {
		h.endIngestSession(sessionID)
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Delete stopped part-way; re-import not started",
			Code:    "SOURCE_DELETE_ERROR",
			Details: fmt.Sprintf("%d row(s) were removed before the error; retry the re-import: %v", deleted.RowsDeleted, err),
		})
		return
	}
	job := h.startIngestFileJob(sessionID, canonical, members, compression, true)
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(types.SourceReimportResponse{
		Status:      "accepted",
		JobID:       job.id,
		SessionID:   sessionID,
		Path:        canonical,
		RowsDeleted: deleted.RowsDeleted,
	})
}

func writeSourceNotFound(w http.ResponseWriter, name string) {
	w.WriteHeader(http.StatusNotFound)
	json.NewEncoder(w).Encode(types.ErrorResponse{
		Status:  "error",
		Error:   "Source not found",
		Code:    "SOURCE_NOT_FOUND",
		Details: "no catalog entry named " + name + "; GET /api/v1/sources lists what exists",
	})
}
