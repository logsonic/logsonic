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
