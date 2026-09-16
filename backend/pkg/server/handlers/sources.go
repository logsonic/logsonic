package handlers

import (
	"encoding/json"
	"errors"
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
