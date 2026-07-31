package handlers

import (
	"encoding/json"
	"errors"
	"net/http"

	"logsonic/pkg/types"
	"logsonic/pkg/workspaces"

	"github.com/go-chi/chi/v5"
)

// @Summary List saved investigation workspaces
// @Tags workspaces
// @Produce json
// @Success 200 {object} types.WorkspaceListResponse
// @Failure 500 {object} types.ErrorResponse
// @Router /workspaces [get]
func (h *Services) HandleListWorkspaces(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet {
		writeWorkspaceError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Method not allowed", "")
		return
	}
	items, err := h.workspaceStore().List()
	if err != nil {
		writeWorkspaceStoreError(w, err)
		return
	}
	_ = json.NewEncoder(w).Encode(types.WorkspaceListResponse{Status: "success", Workspaces: items})
}

// @Summary Create a saved investigation workspace
// @Tags workspaces
// @Accept json
// @Produce json
// @Param request body types.Workspace true "Workspace"
// @Success 201 {object} types.WorkspaceResponse
// @Failure 400 {object} types.ErrorResponse
// @Failure 409 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Router /workspaces [post]
func (h *Services) HandleCreateWorkspace(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		writeWorkspaceError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Method not allowed", "")
		return
	}

	var req types.Workspace
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeWorkspaceError(w, http.StatusBadRequest, "INVALID_REQUEST", "Invalid request body", err.Error())
		return
	}
	ws, err := h.workspaceStore().Create(req)
	if err != nil {
		writeWorkspaceStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(types.WorkspaceResponse{Status: "success", Workspace: ws})
}

// @Summary Get a saved investigation workspace
// @Tags workspaces
// @Produce json
// @Param id path string true "Workspace ID"
// @Success 200 {object} types.WorkspaceResponse
// @Failure 404 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Router /workspaces/{id} [get]
func (h *Services) HandleGetWorkspace(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet {
		writeWorkspaceError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Method not allowed", "")
		return
	}
	ws, err := h.workspaceStore().Get(chi.URLParam(r, "id"))
	if err != nil {
		writeWorkspaceStoreError(w, err)
		return
	}
	_ = json.NewEncoder(w).Encode(types.WorkspaceResponse{Status: "success", Workspace: ws})
}

// @Summary Update a saved investigation workspace
// @Tags workspaces
// @Accept json
// @Produce json
// @Param id path string true "Workspace ID"
// @Param request body types.Workspace true "Workspace"
// @Success 200 {object} types.WorkspaceResponse
// @Failure 400 {object} types.ErrorResponse
// @Failure 404 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Router /workspaces/{id} [put]
func (h *Services) HandleUpdateWorkspace(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPut {
		writeWorkspaceError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Method not allowed", "")
		return
	}

	var req types.Workspace
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeWorkspaceError(w, http.StatusBadRequest, "INVALID_REQUEST", "Invalid request body", err.Error())
		return
	}
	ws, err := h.workspaceStore().Update(chi.URLParam(r, "id"), req)
	if err != nil {
		writeWorkspaceStoreError(w, err)
		return
	}
	_ = json.NewEncoder(w).Encode(types.WorkspaceResponse{Status: "success", Workspace: ws})
}

// @Summary Delete a saved investigation workspace
// @Tags workspaces
// @Param id path string true "Workspace ID"
// @Success 204
// @Failure 404 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Router /workspaces/{id} [delete]
func (h *Services) HandleDeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodDelete {
		writeWorkspaceError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Method not allowed", "")
		return
	}
	if err := h.workspaceStore().Delete(chi.URLParam(r, "id")); err != nil {
		writeWorkspaceStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// @Summary Duplicate a saved investigation workspace
// @Tags workspaces
// @Produce json
// @Param id path string true "Workspace ID"
// @Success 201 {object} types.WorkspaceResponse
// @Failure 404 {object} types.ErrorResponse
// @Failure 500 {object} types.ErrorResponse
// @Router /workspaces/{id}/duplicate [post]
func (h *Services) HandleDuplicateWorkspace(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		writeWorkspaceError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Method not allowed", "")
		return
	}
	ws, err := h.workspaceStore().Duplicate(chi.URLParam(r, "id"))
	if err != nil {
		writeWorkspaceStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(types.WorkspaceResponse{Status: "success", Workspace: ws})
}

func (h *Services) workspaceStore() *workspaces.Store {
	return h.Workspaces
}

func writeWorkspaceStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, workspaces.ErrNotFound):
		writeWorkspaceError(w, http.StatusNotFound, "WORKSPACE_NOT_FOUND", "Workspace not found", err.Error())
	case errors.Is(err, workspaces.ErrExists):
		writeWorkspaceError(w, http.StatusConflict, "WORKSPACE_EXISTS", "Workspace already exists", err.Error())
	case errors.Is(err, workspaces.ErrValidation):
		writeWorkspaceError(w, http.StatusBadRequest, "INVALID_WORKSPACE", "Invalid workspace", err.Error())
	case errors.Is(err, workspaces.ErrCorrupt):
		writeWorkspaceError(w, http.StatusInternalServerError, "WORKSPACES_CORRUPT", "Saved workspaces file is corrupt", err.Error())
	default:
		writeWorkspaceError(w, http.StatusInternalServerError, "WORKSPACE_STORE_ERROR", "Workspace store error", err.Error())
	}
}

func writeWorkspaceError(w http.ResponseWriter, status int, code, message, details string) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(types.ErrorResponse{
		Status:  "error",
		Error:   message,
		Code:    code,
		Details: details,
	})
}
