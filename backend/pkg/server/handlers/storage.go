package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"

	"logsonic/pkg/types"

	"github.com/go-chi/chi/v5"
)

func writeRetentionUnavailable(w http.ResponseWriter) {
	w.WriteHeader(http.StatusServiceUnavailable)
	json.NewEncoder(w).Encode(types.ErrorResponse{
		Status:  "error",
		Error:   "Storage settings unavailable",
		Code:    "STORAGE_SETTINGS_UNAVAILABLE",
		Details: "config.json could not be opened at startup; see the server log",
	})
}

// storageResponse builds the GET/PUT /storage body: retention in effect and
// the per-day table (rows from the index, bytes from its directory).
func (h *Services) storageResponse() (types.StorageResponse, error) {
	days, source := h.Retention.Effective()
	resp := types.StorageResponse{
		Status:           "success",
		RetentionDays:    days,
		RetentionSource:  source,
		RetentionDefault: h.Retention.Default(),
		Days:             []types.StorageDay{},
		Path:             h.storage.BaseDir(),
	}
	if h.Retention.cfg != nil {
		resp.ConfigPath = h.Retention.cfg.Path()
	}
	dates, err := h.storage.List()
	if err != nil {
		return resp, err
	}
	sort.Strings(dates)
	for _, date := range dates {
		rows, err := h.storage.GetDocCount(date)
		if err != nil {
			return resp, fmt.Errorf("%s: %w", date, err)
		}
		bytes, err := h.storage.IndexDirSize(date)
		if err != nil {
			return resp, fmt.Errorf("%s: %w", date, err)
		}
		resp.Days = append(resp.Days, types.StorageDay{Date: date, Rows: int64(rows), Bytes: bytes})
		resp.TotalBytes += bytes
	}
	return resp, nil
}

// @Summary Storage overview and retention setting
// @Description Retention in effect (with its source: config.json, the CLI flag/env, or none) and a per-day table of row counts and on-disk bytes. total_bytes sums the day-index directories only; /info's storage_size_bytes walks the whole storage dir.
// @Tags storage
// @Produce json
// @Success 200 {object} types.StorageResponse
// @Failure 500 {object} types.ErrorResponse
// @Failure 503 {object} types.ErrorResponse
// @Router /storage [get]
func (h *Services) HandleGetStorage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if h.Retention == nil {
		writeRetentionUnavailable(w)
		return
	}
	resp, err := h.storageResponse()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Failed to read storage", Code: "STORAGE_READ_ERROR", Details: err.Error()})
		return
	}
	json.NewEncoder(w).Encode(resp)
}

// @Summary Set the retention override
// @Description Writes retention_days to <storage>/config.json, which takes precedence over -retention-days / RETENTION_DAYS; null clears the override (the flag/env default applies again); 0 keeps everything. The prune runs synchronously before the response, so the first PUT on a long-lived store may take a moment while old day-indices are removed.
// @Tags storage
// @Accept json
// @Produce json
// @Param request body types.StorageUpdateRequest true "retention_days: 0–3650, or null to clear"
// @Success 200 {object} types.StorageResponse
// @Failure 400 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Failure 503 {object} types.ErrorResponse
// @Router /storage [put]
func (h *Services) HandlePutStorage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if h.Retention == nil {
		writeRetentionUnavailable(w)
		return
	}
	var req types.StorageUpdateRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Invalid request body", Code: "INVALID_REQUEST", Details: err.Error()})
		return
	}
	if req.RetentionDays != nil && (*req.RetentionDays < 0 || *req.RetentionDays > maxRetentionDays) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status:  "error",
			Error:   "Invalid retention_days",
			Code:    "RETENTION_OUT_OF_RANGE",
			Details: fmt.Sprintf("retention_days must be between 0 (keep everything) and %d, or null to clear the override; got %d", maxRetentionDays, *req.RetentionDays),
		})
		return
	}
	if err := h.Retention.Set(req.RetentionDays); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Failed to save retention", Code: "STORAGE_SAVE_ERROR", Details: err.Error() + " — check that " + h.Retention.cfg.Path() + " is writable"})
		return
	}
	resp, err := h.storageResponse()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Retention saved but storage could not be read back", Code: "STORAGE_READ_ERROR", Details: err.Error()})
		return
	}
	json.NewEncoder(w).Encode(resp)
}

// @Summary Delete one day of logs
// @Description Remove the day-index for a date (every source's rows for that day) from disk and reconcile the catalog. Not undoable. 409 while a live tail or a running path-ingest job is storing rows for a source that has rows on that day.
// @Tags storage
// @Produce json
// @Param date path string true "Day, YYYY-MM-DD"
// @Success 200 {object} types.StorageDayDeleteResponse
// @Failure 400 {object} types.ErrorResponse
// @Failure 404 {object} types.ErrorResponse
// @Failure 409 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Router /storage/days/{date} [delete]
func (h *Services) HandleDeleteStorageDay(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	date := chi.URLParam(r, "date")
	if _, err := time.Parse("2006-01-02", date); err != nil || len(date) != 10 {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Invalid date", Code: "INVALID_DATE", Details: "expected YYYY-MM-DD, got " + date})
		return
	}
	if _, err := os.Stat(filepath.Join(h.storage.BaseDir(), "logs-"+date+".bleve")); errors.Is(err, os.ErrNotExist) {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "No logs for that day", Code: "DAY_NOT_FOUND", Details: "no day-index for " + date + "; GET /api/v1/storage lists the days that exist"})
		return
	}
	// Same rule as DELETE /sources/{name}: never pull a shard out from
	// under a writer. Any source with rows on this day that a tail or job
	// is still storing makes it busy.
	if h.Catalog != nil {
		for _, e := range h.Catalog.List() {
			if e.DayRows[date] == 0 {
				continue
			}
			if busy, why := h.sourceInUse(e.Name); busy {
				w.WriteHeader(http.StatusConflict)
				json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Day is in use", Code: "DAY_IN_USE", Details: e.Name + ": " + why})
				return
			}
		}
	}
	rows, _ := h.storage.GetDocCount(date)
	if err := h.storage.RemoveDay(date); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(types.ErrorResponse{Status: "error", Error: "Failed to remove day", Code: "DAY_DELETE_ERROR", Details: err.Error()})
		return
	}
	h.rebuildCatalog(date)
	h.InvalidateInfoCache()
	json.NewEncoder(w).Encode(types.StorageDayDeleteResponse{Status: "success", Date: date, RowsDeleted: int64(rows)})
}
