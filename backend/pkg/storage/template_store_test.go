package storage

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func templateTestRows() []map[string]interface{} {
	return []map[string]interface{}{
		{"timestamp": time.Date(2026, 9, 24, 10, 0, 0, 123, time.UTC), "_src": "app.log", "_seq": int64(1), "_raw": "  INFO user=alice duration=0012ms\r\n", "message": "connection timeout", "duration": "12"},
		{"timestamp": time.Date(2026, 9, 24, 10, 0, 1, 456, time.UTC), "_src": "app.log.1", "_seq": int64(2), "_raw": "INFO user=bob duration=18ms", "message": "connected", "duration": "18"},
	}
}

func TestTemplateStoreDurableUpsertsDeletes(t *testing.T) {
	dir := t.TempDir()
	s, err := NewTemplateStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	rows := templateTestRows()
	ids, err := s.StoreWithIDs(rows, "file")
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 {
		t.Fatal(ids)
	}
	if n, _, err := s.DeleteBySource(context.Background(), "app.log", []string{"2026-09-24"}); err != nil || n != 1 {
		t.Fatalf("delete %d %v", n, err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = NewTemplateStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if n, err := s.GetDocCount("2026-09-24"); err != nil || n != 1 {
		t.Fatalf("recovered count %d %v", n, err)
	}
	if _, err = s.StoreWithIDs(rows, "file"); err != nil {
		t.Fatal(err)
	}
	if n, err := s.GetDocCount("2026-09-24"); err != nil || n != 2 {
		t.Fatalf("upsert count %d %v", n, err)
	}
	if n, err := s.DeleteByIds([]string{ids[1], ids[1], "missing"}); err != nil || n != 1 {
		t.Fatalf("delete IDs %d %v", n, err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewStorageWithEngine(dir, "auto")
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	stats, err := reopened.SourceStats("2026-09-24")
	if err != nil || len(stats) != 1 || stats[0].Source != "app.log" {
		t.Fatalf("stats %+v %v", stats, err)
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "logs-*.bleve"))
	if len(matches) != 0 {
		t.Fatalf("persistent Bleve files: %v", matches)
	}
}

func TestTemplateStoreOwnershipAndEngineSelection(t *testing.T) {
	dir := t.TempDir()
	s, err := NewTemplateStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if other, err := NewTemplateStorage(dir); err == nil {
		other.Close()
		t.Fatal("second writer allowed")
	}
	if other, err := NewStorageWithEngine(dir, "bleve"); err == nil {
		other.Close()
		t.Fatal("incompatible engine allowed")
	}
	if other, err := NewStorageWithEngine(t.TempDir(), "typo"); err == nil {
		other.Close()
		t.Fatal("invalid engine allowed")
	}
	oldDir := t.TempDir()
	old, err := NewStorage(oldDir)
	if err != nil {
		t.Fatal(err)
	}
	if err = old.Store(templateTestRows(), "file"); err != nil {
		t.Fatal(err)
	}
	old.Close()
	if other, err := NewTemplateStorage(oldDir); err == nil {
		other.Close()
		t.Fatal("legacy data opened as template")
	}
}

func TestTemplateStoreRecoveryRejectsCorruptionIgnoresTemp(t *testing.T) {
	dir := t.TempDir()
	s, err := NewTemplateStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Store(templateTestRows(), "file"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	var committed string
	err = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.HasSuffix(path, ".tzs") {
			committed = path
		}
		return nil
	})
	if err != nil || committed == "" {
		t.Fatalf("segment missing %v", err)
	}
	if err = os.WriteFile(filepath.Join(filepath.Dir(committed), ".pending.tmp"), []byte("interrupted"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err = NewTemplateStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	data, err := os.ReadFile(committed)
	if err != nil {
		t.Fatal(err)
	}
	data[len(data)/2] ^= 1
	if err = os.WriteFile(committed, data, 0600); err != nil {
		t.Fatal(err)
	}
	if s, err = NewTemplateStorage(dir); err == nil {
		s.Close()
		t.Fatal("corrupt committed data accepted")
	}
}

func TestTemplateStoreClearAndConcurrentWrites(t *testing.T) {
	dir := t.TempDir()
	s, err := NewTemplateStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = os.WriteFile(filepath.Join(dir, "config.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rows := templateTestRows()
			rows[0]["_seq"] = int64(i + 1)
			if err := s.Store(rows[:1], "file"); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if n, err := s.GetDocCount("2026-09-24"); err != nil || n != 8 {
		t.Fatalf("count %d %v", n, err)
	}
	if err = s.RemoveDay("../"); err == nil {
		t.Fatal("invalid date allowed")
	}
	if err = s.Clear(); err != nil {
		t.Fatal(err)
	}
	if dates, err := s.List(); err != nil || len(dates) != 0 {
		t.Fatalf("clear %v %v", dates, err)
	}
	if _, err = os.Stat(filepath.Join(dir, "config.json")); err != nil {
		t.Fatal("clear removed config", err)
	}
	if err = s.Store(templateTestRows(), "file"); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	if err = s.Store(templateTestRows(), "file"); err == nil {
		t.Fatal("write after close allowed")
	}
}

func TestStorageEngineLockPreventsMixedWritersBeforeFirstRow(t *testing.T) {
	dir := t.TempDir()
	legacy, err := NewStorageWithEngine(dir, "bleve")
	if err != nil {
		t.Fatal(err)
	}
	defer legacy.Close()
	if candidate, err := NewTemplateStorage(dir); err == nil {
		candidate.Close()
		t.Fatal("template writer opened beside a live empty Bleve writer")
	}
	legacy.Close()
	candidate, err := NewTemplateStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer candidate.Close()
	if legacy, err := NewStorage(dir); err == nil {
		legacy.Close()
		t.Fatal("legacy constructor ignored template data and ownership")
	}
}

func TestTemplateStoreReopensWithFinderMetadata(t *testing.T) {
	dir := t.TempDir()
	s, err := NewTemplateStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	rows := templateTestRows()
	if _, err = s.StoreWithIDs(rows, "app.log"); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	day := filepath.Join(dir, templateDirectory, "2026-09-24")
	for _, name := range []string{".DS_Store", "._00000000000000000001.tzs"} {
		if err = os.WriteFile(filepath.Join(day, name), []byte("finder"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	s, err = NewTemplateStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	if count, err := s.GetDocCount("2026-09-24"); err != nil || count != uint64(len(rows)) {
		t.Fatalf("count %d %v", count, err)
	}
	dayStart := time.Date(2026, 9, 24, 0, 0, 0, 0, time.UTC)
	page, err := s.SearchPage(context.Background(), SearchOptions{
		Query: "message:connection", Limit: 1,
		StartDate: dayStart, EndDate: dayStart.Add(24 * time.Hour),
		SortBy: "timestamp", SortOrder: "asc",
	})
	if err != nil || page.TotalCount != 1 {
		t.Fatalf("search total %d %v", page.TotalCount, err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}

	if err = os.WriteFile(filepath.Join(day, "notes.txt"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = NewTemplateStorage(dir); err == nil {
		t.Fatal("non-segment file in a day directory was accepted")
	}
}

func TestTemplateStoreRecoveryFinishesDayDeletion(t *testing.T) {
	dir := t.TempDir()
	s, err := NewTemplateStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Store(templateTestRows(), "file"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	removed := filepath.Join(dir, templateDirectory, ".deleted-2026-09-24-123")
	if err = os.Rename(filepath.Join(dir, templateDirectory, "2026-09-24"), removed); err != nil {
		t.Fatal(err)
	}
	s, err = NewTemplateStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if days, err := s.List(); err != nil || len(days) != 0 {
		t.Fatalf("deleted day returned %v %v", days, err)
	}
	if _, err = os.Stat(removed); !os.IsNotExist(err) {
		t.Fatalf("interrupted deletion not reclaimed: %v", err)
	}
}

func TestTemplateStoreFailedMultiDayWriteLeavesNothingBehind(t *testing.T) {
	dir := t.TempDir()
	s, err := NewTemplateStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	// A regular file where the second day's directory must go makes its commit fail
	// after the first day's segment is already durable.
	if err = os.WriteFile(filepath.Join(dir, templateDirectory, "2026-09-25"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	rows := templateTestRows()
	rows = append(rows, map[string]interface{}{"timestamp": time.Date(2026, 9, 25, 1, 0, 0, 0, time.UTC), "_src": "app.log", "_seq": int64(3), "_raw": "next day", "message": "next"})
	if _, err = s.StoreWithIDs(rows, "file"); err == nil {
		t.Fatal("expected the blocked day to fail the write")
	}
	if n, _ := s.GetDocCount("2026-09-24"); n != 0 {
		t.Fatalf("partial write left %d rows behind", n)
	}
	days, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	for _, day := range days {
		if day == "2026-09-25" {
			t.Fatalf("phantom empty day listed: %v", days)
		}
	}
	// The engine stays usable and a retry is clean.
	if _, err = s.StoreWithIDs(templateTestRows(), "file"); err != nil {
		t.Fatalf("store after rolled-back failure: %v", err)
	}
	if n, _ := s.GetDocCount("2026-09-24"); n != 2 {
		t.Fatalf("retry stored %d rows", n)
	}
}

func TestTemplateStoreReplayRemovesCrashedTempSegments(t *testing.T) {
	dir := t.TempDir()
	s, err := NewTemplateStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.StoreWithIDs(templateTestRows(), "file"); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(dir, templateDirectory, "2026-09-24", ".segment-123.tmp")
	if err = os.WriteFile(stale, []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err = NewTemplateStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if _, err = os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("crashed temp segment survived replay: %v", err)
	}
	if n, _ := s.GetDocCount("2026-09-24"); n != 2 {
		t.Fatalf("recovered %d rows", n)
	}
}
