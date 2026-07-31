package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"logsonic/pkg/types"
	"logsonic/pkg/workspaces"

	"github.com/go-chi/chi/v5"
)

func TestWorkspaceHandlersCreateListGetUpdateDuplicateDelete(t *testing.T) {
	h, _ := setupHandler(t)

	createBody, _ := json.Marshal(testHandlerWorkspace("Errors"))
	createReq := httptest.NewRequest(http.MethodPost, "/api/v1/workspaces", bytes.NewReader(createBody))
	createW := httptest.NewRecorder()
	h.HandleCreateWorkspace(createW, createReq)
	if createW.Code != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d body=%s", createW.Code, createW.Body.String())
	}
	var createResp types.WorkspaceResponse
	if err := json.NewDecoder(createW.Body).Decode(&createResp); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if createResp.Workspace.ID == "" {
		t.Fatal("expected id")
	}

	listReq := httptest.NewRequest(http.MethodGet, "/api/v1/workspaces", nil)
	listW := httptest.NewRecorder()
	h.HandleListWorkspaces(listW, listReq)
	if listW.Code != http.StatusOK {
		t.Fatalf("list: expected 200, got %d", listW.Code)
	}
	var listResp types.WorkspaceListResponse
	if err := json.NewDecoder(listW.Body).Decode(&listResp); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(listResp.Workspaces) != 1 || listResp.Workspaces[0].Name != "Errors" {
		t.Fatalf("unexpected list: %+v", listResp.Workspaces)
	}

	getReq := requestWithWorkspaceID(http.MethodGet, "/api/v1/workspaces/"+createResp.Workspace.ID, createResp.Workspace.ID, nil)
	getW := httptest.NewRecorder()
	h.HandleGetWorkspace(getW, getReq)
	if getW.Code != http.StatusOK {
		t.Fatalf("get: expected 200, got %d", getW.Code)
	}

	updated := createResp.Workspace
	updated.Name = "Errors renamed"
	updateBody, _ := json.Marshal(updated)
	updateReq := requestWithWorkspaceID(http.MethodPut, "/api/v1/workspaces/"+updated.ID, updated.ID, bytes.NewReader(updateBody))
	updateW := httptest.NewRecorder()
	h.HandleUpdateWorkspace(updateW, updateReq)
	if updateW.Code != http.StatusOK {
		t.Fatalf("update: expected 200, got %d body=%s", updateW.Code, updateW.Body.String())
	}
	var updateResp types.WorkspaceResponse
	if err := json.NewDecoder(updateW.Body).Decode(&updateResp); err != nil {
		t.Fatalf("decode update: %v", err)
	}
	if updateResp.Workspace.Name != "Errors renamed" {
		t.Fatalf("unexpected update response: %+v", updateResp.Workspace)
	}

	dupeReq := requestWithWorkspaceID(http.MethodPost, "/api/v1/workspaces/"+updated.ID+"/duplicate", updated.ID, nil)
	dupeW := httptest.NewRecorder()
	h.HandleDuplicateWorkspace(dupeW, dupeReq)
	if dupeW.Code != http.StatusCreated {
		t.Fatalf("duplicate: expected 201, got %d body=%s", dupeW.Code, dupeW.Body.String())
	}
	var dupeResp types.WorkspaceResponse
	if err := json.NewDecoder(dupeW.Body).Decode(&dupeResp); err != nil {
		t.Fatalf("decode duplicate: %v", err)
	}
	if dupeResp.Workspace.ID == updated.ID || !strings.Contains(dupeResp.Workspace.Name, "copy") {
		t.Fatalf("unexpected duplicate: %+v", dupeResp.Workspace)
	}

	deleteReq := requestWithWorkspaceID(http.MethodDelete, "/api/v1/workspaces/"+updated.ID, updated.ID, nil)
	deleteW := httptest.NewRecorder()
	h.HandleDeleteWorkspace(deleteW, deleteReq)
	if deleteW.Code != http.StatusNoContent {
		t.Fatalf("delete: expected 204, got %d", deleteW.Code)
	}
}

func TestWorkspaceHandlersValidationAndNotFound(t *testing.T) {
	h, _ := setupHandler(t)

	body, _ := json.Marshal(types.Workspace{Name: ""})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workspaces", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleCreateWorkspace(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	var errResp types.ErrorResponse
	if err := json.NewDecoder(w.Body).Decode(&errResp); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if errResp.Code != "INVALID_WORKSPACE" {
		t.Fatalf("expected INVALID_WORKSPACE, got %q", errResp.Code)
	}

	getReq := requestWithWorkspaceID(http.MethodGet, "/api/v1/workspaces/missing", "missing", nil)
	getW := httptest.NewRecorder()
	h.HandleGetWorkspace(getW, getReq)
	if getW.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", getW.Code)
	}
}

func TestWorkspaceHandlersReturnCorruptStoreError(t *testing.T) {
	h, _ := setupHandler(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "workspaces.json"), []byte("{bad"), 0o644); err != nil {
		t.Fatalf("write corrupt file: %v", err)
	}
	store, err := workspaces.NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	h.Workspaces = store

	req := httptest.NewRequest(http.MethodGet, "/api/v1/workspaces", nil)
	w := httptest.NewRecorder()
	h.HandleListWorkspaces(w, req)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", w.Code)
	}
	var errResp types.ErrorResponse
	if err := json.NewDecoder(w.Body).Decode(&errResp); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if errResp.Code != "WORKSPACES_CORRUPT" {
		t.Fatalf("expected WORKSPACES_CORRUPT, got %q", errResp.Code)
	}
}

func requestWithWorkspaceID(method, target, id string, body *bytes.Reader) *http.Request {
	var reader interface{ Read([]byte) (int, error) }
	if body != nil {
		reader = body
	}
	req := httptest.NewRequest(method, target, reader)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", id)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
}

func testHandlerWorkspace(name string) types.Workspace {
	return types.Workspace{
		Name:    name,
		Query:   "+level:error",
		Sources: []string{"api.log"},
		Time: types.WorkspaceTime{
			Mode:     "relative",
			Relative: "last-7-days",
		},
		SortBy:    "timestamp",
		SortOrder: "desc",
		Columns:   []string{"timestamp", "level", "message"},
		ColumnWidths: map[string]int{
			"message": 420,
		},
		ColorRules: []types.WorkspaceColorRule{
			{Field: "level", Operator: "eq", Value: "ERROR", Color: "bg-red-100", Enabled: true},
		},
		Visualization: types.WorkspaceVisualization{Type: "logs", Bucket: "auto"},
	}
}
