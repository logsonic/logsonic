package timeresolve

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func makeRes(year int, tz string) Resolution {
	yr := year
	return Resolution{
		Anchor:       Anchor{Kind: AnchorFileMTime, Value: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
		YearStrategy: YearForced,
		ForcedYear:   &yr,
		Timezone:     TimezoneCfg{Kind: TimezoneForced, Value: tz},
		Rollover:     true,
		ForceMode:    ForceModeFillMissing,
	}
}

func TestLibraryStore_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := NewLibraryStore(dir)
	if err != nil {
		t.Fatalf("NewLibraryStore: %v", err)
	}
	if _, ok := s.Get("Spark"); ok {
		t.Error("expected empty store, got entry")
	}

	if err := s.Set("Spark", makeRes(2017, "UTC")); err != nil {
		t.Fatalf("Set: %v", err)
	}
	got, ok := s.Get("Spark")
	if !ok {
		t.Fatal("Get: expected entry, got none")
	}
	if got.ForcedYear == nil || *got.ForcedYear != 2017 {
		t.Errorf("forced year: got %v, want 2017", got.ForcedYear)
	}

	// Reopen — values must persist.
	s2, err := NewLibraryStore(dir)
	if err != nil {
		t.Fatalf("re-open: %v", err)
	}
	got2, ok := s2.Get("Spark")
	if !ok {
		t.Fatal("Get after reopen: expected entry, got none")
	}
	if got2.ForcedYear == nil || *got2.ForcedYear != 2017 {
		t.Errorf("after reopen: forced year %v, want 2017", got2.ForcedYear)
	}
	if got2.Timezone.Value != "UTC" {
		t.Errorf("after reopen: tz %q, want UTC", got2.Timezone.Value)
	}
}

func TestLibraryStore_DeleteRemovesEntry(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewLibraryStore(dir)
	_ = s.Set("Apache", makeRes(2024, "America/New_York"))
	if err := s.Delete("Apache"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, ok := s.Get("Apache"); ok {
		t.Error("entry still present after Delete")
	}
}

func TestLibraryStore_NilReceiverNoOp(t *testing.T) {
	// The handler tolerates a nil store when the side-file couldn't
	// be opened. Calling Set / Delete on nil must not panic.
	var s *LibraryStore
	if err := s.Set("X", makeRes(2020, "UTC")); err != nil {
		t.Errorf("nil Set: got %v, want nil", err)
	}
	if err := s.Delete("X"); err != nil {
		t.Errorf("nil Delete: got %v, want nil", err)
	}
}

func TestLibraryStore_CorruptFileTreatedAsEmpty(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "pattern_timestamps.json"), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := NewLibraryStore(dir)
	if err != nil {
		t.Fatalf("NewLibraryStore on corrupt file: %v", err)
	}
	if _, ok := s.Get("anything"); ok {
		t.Error("expected empty store for corrupt file")
	}
	// First Set should rewrite the file cleanly.
	if err := s.Set("Spark", makeRes(2017, "UTC")); err != nil {
		t.Fatalf("Set after corrupt: %v", err)
	}
	s2, _ := NewLibraryStore(dir)
	if _, ok := s2.Get("Spark"); !ok {
		t.Error("Spark not persisted after corrupt-file recovery")
	}
}

func TestLibraryStore_Snapshot(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewLibraryStore(dir)
	_ = s.Set("A", makeRes(2017, "UTC"))
	_ = s.Set("B", makeRes(2024, "Asia/Kolkata"))
	snap := s.Snapshot()
	if len(snap) != 2 {
		t.Errorf("snapshot size: got %d, want 2", len(snap))
	}
	// Mutating the snapshot must not affect the store.
	delete(snap, "A")
	if _, ok := s.Get("A"); !ok {
		t.Error("Snapshot is not a copy — mutation leaked back to store")
	}
}
