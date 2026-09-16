package workspaces

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"logsonic/pkg/types"
)

func TestStoreCreateListUpdateDeletePersists(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	created, err := store.Create(testWorkspace("Production 5xx"))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if created.ID == "" {
		t.Fatal("expected generated id")
	}
	if created.CreatedAt == "" || created.UpdatedAt == "" {
		t.Fatal("expected timestamps")
	}

	reopened, err := NewStore(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got, err := reopened.Get(created.ID)
	if err != nil {
		t.Fatalf("Get after reopen: %v", err)
	}
	if got.Name != "Production 5xx" || got.Columns[1] != "status" {
		t.Fatalf("unexpected reopened workspace: %+v", got)
	}

	got.Name = "Renamed"
	got.Columns = append(got.Columns, "service")
	updated, err := reopened.Update(got.ID, got)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Name != "Renamed" || len(updated.Columns) != 3 {
		t.Fatalf("unexpected updated workspace: %+v", updated)
	}
	if updated.CreatedAt != created.CreatedAt {
		t.Fatalf("expected created_at to be preserved")
	}

	items, err := reopened.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 workspace, got %d", len(items))
	}

	if err := reopened.Delete(created.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	items, err = reopened.List()
	if err != nil {
		t.Fatalf("List after delete: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("expected 0 workspaces, got %d", len(items))
	}
}

func TestStoreDuplicateCreatesIndependentCopy(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	created, err := store.Create(testWorkspace("Errors"))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	dupe, err := store.Duplicate(created.ID)
	if err != nil {
		t.Fatalf("Duplicate: %v", err)
	}
	if dupe.ID == created.ID {
		t.Fatal("duplicate reused id")
	}
	if dupe.Name != "Errors copy" {
		t.Fatalf("unexpected duplicate name: %q", dupe.Name)
	}
	if dupe.Favorite {
		t.Fatal("duplicate should not inherit favorite")
	}
	if dupe.Columns[1] != "status" || dupe.ColumnWidths["status"] != 96 {
		t.Fatalf("duplicate did not preserve view state: %+v", dupe)
	}
}

func TestStoreRejectsInvalidWorkspace(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	_, err = store.Create(types.Workspace{Name: ""})
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("expected validation error, got %v", err)
	}
}

// TestStoreLoadsPreNow03WorkspaceFileWithoutSavedQueries is the spec now-03
// backward-compat requirement: a workspace file written before SavedQueries
// existed has no "saved_queries" key at all, not an empty array -- it must
// still load with a nil (not an error) SavedQueries slice.
func TestStoreLoadsPreNow03WorkspaceFileWithoutSavedQueries(t *testing.T) {
	dir := t.TempDir()
	fixture := `{
		"version": 1,
		"workspaces": [{
			"id": "ws-1",
			"name": "Pre-existing",
			"query": "level:error",
			"time": {"mode": "relative", "relative": "last-24-hours"},
			"sort_by": "timestamp",
			"sort_order": "desc",
			"visualization": {"type": "logs", "bucket": "auto"},
			"favorite": false,
			"created_at": "2026-01-01T00:00:00Z",
			"updated_at": "2026-01-01T00:00:00Z"
		}]
	}`
	if err := os.WriteFile(filepath.Join(dir, fileName), []byte(fixture), 0o644); err != nil {
		t.Fatalf("write pre-now-03 fixture: %v", err)
	}

	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	got, err := store.Get("ws-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Name != "Pre-existing" {
		t.Fatalf("unexpected workspace: %+v", got)
	}
	if got.SavedQueries != nil {
		t.Fatalf("expected nil SavedQueries on a pre-now-03 file, got %+v", got.SavedQueries)
	}

	// The store must also be able to write this workspace back out (e.g. via
	// Update) without SavedQueries becoming a JSON parse hazard for an older
	// build reading the file afterward -- Update round-trips through the
	// same disk format.
	got.Description = "touched"
	if _, err := store.Update("ws-1", got); err != nil {
		t.Fatalf("Update a pre-now-03 workspace: %v", err)
	}
}

// TestStoreSavedQueriesRoundTrip is spec now-03's other backend test case:
// a workspace with 3 saved queries survives create->get->update->get
// unchanged.
func TestStoreSavedQueriesRoundTrip(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	ws := testWorkspace("With saved queries")
	ws.SavedQueries = []types.SavedQuery{
		{ID: "sq-1", Name: "Errors", Query: "level:error", CreatedAt: "2026-01-01T00:00:00Z"},
		{
			ID:      "sq-2",
			Name:    "5xx last hour",
			Query:   "status:>=500",
			Sources: []string{"nginx.log"},
			Time: &types.WorkspaceTime{
				Mode:     "relative",
				Relative: "last-1-hours",
			},
			CreatedAt: "2026-01-01T00:05:00Z",
		},
		{
			ID:    "sq-3",
			Name:  "Fixed window",
			Query: "",
			Time: &types.WorkspaceTime{
				Mode:  "absolute",
				Start: "2026-01-01T00:00:00Z",
				End:   "2026-01-02T00:00:00Z",
			},
			CreatedAt: "2026-01-01T00:10:00Z",
		},
	}

	created, err := store.Create(ws)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if len(created.SavedQueries) != 3 {
		t.Fatalf("expected 3 saved queries after Create, got %d", len(created.SavedQueries))
	}

	got, err := store.Get(created.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(got.SavedQueries) != 3 || got.SavedQueries[1].Time.Relative != "last-1-hours" {
		t.Fatalf("unexpected saved queries after Get: %+v", got.SavedQueries)
	}

	got.Name = "Renamed"
	updated, err := store.Update(created.ID, got)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if len(updated.SavedQueries) != 3 {
		t.Fatalf("expected 3 saved queries after Update, got %d", len(updated.SavedQueries))
	}

	got, err = store.Get(created.ID)
	if err != nil {
		t.Fatalf("Get after Update: %v", err)
	}
	if len(got.SavedQueries) != 3 ||
		got.SavedQueries[0].Name != "Errors" ||
		got.SavedQueries[2].Time.Mode != "absolute" {
		t.Fatalf("saved queries did not survive create->get->update->get: %+v", got.SavedQueries)
	}
}

func TestStoreCorruptFileDoesNotCrashStartup(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, fileName), []byte("{not-json"), 0o644); err != nil {
		t.Fatalf("write corrupt file: %v", err)
	}

	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore should not fail on corrupt JSON: %v", err)
	}
	_, err = store.List()
	if !errors.Is(err, ErrCorrupt) {
		t.Fatalf("expected corrupt error from List, got %v", err)
	}
	_, err = store.Create(testWorkspace("Blocked"))
	if !errors.Is(err, ErrCorrupt) {
		t.Fatalf("expected corrupt error from Create, got %v", err)
	}
}

func testWorkspace(name string) types.Workspace {
	return types.Workspace{
		Name:        name,
		Description: "HTTP failures",
		Query:       "+status:>=500",
		Sources:     []string{"nginx.log"},
		Time: types.WorkspaceTime{
			Mode:     "relative",
			Relative: "last-24-hours",
		},
		SortBy:    "timestamp",
		SortOrder: "desc",
		Columns:   []string{"timestamp", "status"},
		ColumnWidths: map[string]int{
			"status": 96,
		},
		ColorRules: []types.WorkspaceColorRule{
			{Field: "status", Operator: "eq", Value: "500", Color: "bg-red-100", Enabled: true},
		},
		FacetFields: []string{"status"},
		Visualization: types.WorkspaceVisualization{
			Type:   "logs",
			Bucket: "auto",
		},
		Favorite: true,
	}
}
