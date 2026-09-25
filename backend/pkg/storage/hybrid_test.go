package storage

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

var hybridDay = time.Date(2024, 3, 10, 0, 0, 0, 0, time.UTC)

func hybridRows(source string, from, n int) []map[string]interface{} {
	rows := make([]map[string]interface{}, 0, n)
	for i := from; i < from+n; i++ {
		rows = append(rows, map[string]interface{}{
			"timestamp": hybridDay.Add(time.Duration(i) * time.Second),
			"_seq":      int64(i),
			"_raw":      fmt.Sprintf("%s level=%s user=%05d request took %dms", source, []string{"info", "warn", "error"}[i%3], i%97, i%500),
			"_src":      source,
			"level":     []string{"info", "warn", "error"}[i%3],
			"user":      fmt.Sprintf("%05d", i%97),
			"latency":   i % 500,
			"tags":      []interface{}{"a", fmt.Sprintf("t%d", i%4)},
		})
	}
	return rows
}

func openCompact(t *testing.T, dir string) *Storage {
	t.Helper()
	s, err := newStorageWithFormat(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func openLegacy(t *testing.T, dir string) *Storage {
	t.Helper()
	s, err := newStorageWithFormat(dir, true)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func dayPage(t *testing.T, s *Storage, query string, limit, offset int) SearchPageResult {
	t.Helper()
	page, err := s.SearchPage(context.Background(), SearchOptions{
		Query: query, StartDate: hybridDay, EndDate: hybridDay.Add(24*time.Hour - time.Nanosecond),
		Limit: limit, Offset: offset, SortBy: "timestamp", SortOrder: "asc",
	})
	if err != nil {
		t.Fatalf("SearchPage(%q): %v", query, err)
	}
	page.QueryTime = 0
	return page
}

func rowFiles(t *testing.T, s *Storage, date string) (sealed []string, wal int64) {
	t.Helper()
	dir := filepath.Join(s.BaseDir(), "logs-"+date+".bleve", rowsDirName)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() == rowWALName {
			info, _ := entry.Info()
			wal = info.Size()
		} else if strings.HasSuffix(entry.Name(), ".zst") {
			sealed = append(sealed, entry.Name())
		}
	}
	sort.Strings(sealed)
	return sealed, wal
}

func TestCompactShardSealsBlocksAndReopens(t *testing.T) {
	dir := t.TempDir()
	s := openCompact(t, dir)
	date := hybridDay.Format("2006-01-02")
	if _, err := s.StoreWithIDs(hybridRows("app.log", 0, rowBlockSize*2+10), "app.log"); err != nil {
		t.Fatal(err)
	}
	if s.ShardFormat(date) != "compact" {
		t.Fatalf("new day format = %q, want compact", s.ShardFormat(date))
	}
	sealed, wal := rowFiles(t, s, date)
	if len(sealed) != 2 || wal == 0 {
		t.Fatalf("after 2 blocks + 10 rows: sealed=%v wal=%d", sealed, wal)
	}
	before := dayPage(t, s, "level:error", 50, 20)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	// Close seals the open block and leaves an empty WAL.
	s = openCompact(t, dir)
	defer s.Close()
	sealed, wal = rowFiles(t, s, date)
	if len(sealed) != 3 || wal != 0 {
		t.Fatalf("after close: sealed=%v wal=%d", sealed, wal)
	}
	if after := dayPage(t, s, "level:error", 50, 20); !reflect.DeepEqual(after, before) {
		t.Fatalf("page changed across reopen:\n%#v\n%#v", after, before)
	}
}

func TestCompactShardReplaysWALAfterCrash(t *testing.T) {
	dir := t.TempDir()
	s := openCompact(t, dir)
	date := hybridDay.Format("2006-01-02")
	if _, err := s.StoreWithIDs(hybridRows("app.log", 0, 300), "app.log"); err != nil {
		t.Fatal(err)
	}
	want := dayPage(t, s, "", 1000, 0)
	crash(t, s)

	// A torn final frame (crash mid-append) is cut off; earlier frames survive.
	wal := filepath.Join(dir, "logs-"+date+".bleve", rowsDirName, rowWALName)
	f, err := os.OpenFile(wal, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte{0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 9, 9, 'x'}); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()

	s = openCompact(t, dir)
	defer s.Close()
	if got := dayPage(t, s, "", 1000, 0); !reflect.DeepEqual(got, want) {
		t.Fatalf("rows after WAL replay differ: %d vs %d", len(got.Logs), len(want.Logs))
	}
	if _, err := s.StoreWithIDs(hybridRows("app.log", 300, 5), "app.log"); err != nil {
		t.Fatalf("append after torn-tail recovery: %v", err)
	}
	if got := dayPage(t, s, "", 1000, 0); got.TotalCount != 305 {
		t.Fatalf("total after append = %d, want 305", got.TotalCount)
	}
}

// crash drops a Storage without sealing or closing its row stores cleanly.
func crash(t *testing.T, s *Storage) {
	t.Helper()
	s.rowsMu.Lock()
	for _, rs := range s.rows {
		rs.discard()
	}
	s.rows = map[string]*rowStore{}
	s.rowsMu.Unlock()
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestCompactShardRepairsDocumentsWhoseRowsWereLost(t *testing.T) {
	dir := t.TempDir()
	s := openCompact(t, dir)
	date := hybridDay.Format("2006-01-02")
	if _, err := s.StoreWithIDs(hybridRows("app.log", 0, rowBlockSize+40), "app.log"); err != nil {
		t.Fatal(err)
	}
	crash(t, s)
	// Power loss: the WAL never reached the disk, the index batch did.
	if err := os.Truncate(filepath.Join(dir, "logs-"+date+".bleve", rowsDirName, rowWALName), 0); err != nil {
		t.Fatal(err)
	}
	s = openCompact(t, dir)
	defer s.Close()
	page := dayPage(t, s, "", 1000, 0)
	if page.TotalCount != rowBlockSize || len(page.Logs) != 1000 {
		t.Fatalf("after repair total=%d page=%d, want the %d sealed rows", page.TotalCount, len(page.Logs), rowBlockSize)
	}
	if count, _ := s.GetDocCount(date); count != rowBlockSize {
		t.Fatalf("doc count %d, want %d", count, rowBlockSize)
	}
}

func TestCompactShardSkipsMissingRowsWithoutHanging(t *testing.T) {
	dir := t.TempDir()
	s := openCompact(t, dir)
	date := hybridDay.Format("2006-01-02")
	if _, err := s.StoreWithIDs(hybridRows("app.log", 0, rowBlockSize+10), "app.log"); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	sealedDir := filepath.Join(dir, "logs-"+date+".bleve", rowsDirName)
	entries, _ := os.ReadDir(sealedDir)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), fmt.Sprintf("%020d-", 2)) {
			_ = os.Remove(filepath.Join(sealedDir, entry.Name()))
		}
	}
	s = openCompact(t, dir)
	defer s.Close()
	done := make(chan SearchPageResult, 1)
	go func() {
		page, _ := s.SearchPage(context.Background(), SearchOptions{
			StartDate: hybridDay, EndDate: hybridDay.Add(24 * time.Hour), Limit: 100,
			SortBy: "timestamp", SortOrder: "desc",
		})
		done <- page
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("search with a missing row block did not return")
	}
}

func TestCompactDeleteReclaimsRowBlocks(t *testing.T) {
	dir := t.TempDir()
	s := openCompact(t, dir)
	defer s.Close()
	date := hybridDay.Format("2006-01-02")
	if _, err := s.StoreWithIDs(hybridRows("big.log", 0, rowBlockSize*3), "big.log"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.StoreWithIDs(hybridRows("small.log", 100000, 50), "small.log"); err != nil {
		t.Fatal(err)
	}
	withBoth, _ := s.IndexDirSize(date)

	// Re-import big.log the way the sources API does: delete, then store.
	for cycle := 0; cycle < 3; cycle++ {
		if _, _, err := s.DeleteBySource(context.Background(), "big.log", []string{date}); err != nil {
			t.Fatal(err)
		}
		if _, err := s.StoreWithIDs(hybridRows("big.log", 0, rowBlockSize*3), "big.log"); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.rowStoreFor(date).seal(); err != nil {
		t.Fatal(err)
	}
	sealed, _ := rowFiles(t, s, date)
	if len(sealed) > 5 {
		t.Fatalf("re-imports left %d row blocks: %v", len(sealed), sealed)
	}
	if size, _ := s.IndexDirSize(date); size > withBoth*2 {
		t.Fatalf("re-import grew the day from %d to %d bytes", withBoth, size)
	}

	rows, _, err := s.DeleteBySource(context.Background(), "big.log", []string{date})
	if err != nil || rows != rowBlockSize*3 {
		t.Fatalf("delete big.log = %d, %v", rows, err)
	}
	page, err := s.SearchPage(context.Background(), SearchOptions{
		StartDate: hybridDay, EndDate: hybridDay.Add(48 * time.Hour), Sources: []string{"small.log"},
		Limit: 100, SortBy: "timestamp", SortOrder: "asc",
	})
	if err != nil || page.TotalCount != 50 || len(page.Logs) != 50 || page.Logs[0]["_src"] != "small.log" {
		t.Fatalf("small.log after deleting big.log: total=%d rows=%d err=%v", page.TotalCount, len(page.Logs), err)
	}
	sealed, _ = rowFiles(t, s, date)
	if len(sealed) > 1 {
		t.Fatalf("blocks holding only deleted rows were kept: %v", sealed)
	}
}

func TestCompactReclaimRewritesMostlyDeadBlocks(t *testing.T) {
	dir := t.TempDir()
	s := openCompact(t, dir)
	defer s.Close()
	date := hybridDay.Format("2006-01-02")
	// One block where three of every four rows belong to noisy.log.
	rows := hybridRows("noisy.log", 0, rowBlockSize)
	for i := range rows {
		if i%4 == 0 {
			rows[i]["_src"] = "keep.log"
		}
	}
	ids, err := s.StoreWithIDs(rows, "mixed")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.rowStoreFor(date).seal(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.DeleteBySource(context.Background(), "noisy.log", []string{date}); err != nil {
		t.Fatal(err)
	}
	if err := s.rowStoreFor(date).seal(); err != nil {
		t.Fatal(err)
	}
	sealed, _ := rowFiles(t, s, date)
	if len(sealed) != 1 || !strings.HasSuffix(sealed[0], fmt.Sprintf("-%d.zst", rowBlockSize/4)) {
		t.Fatalf("mostly-dead block not rewritten: %v", sealed)
	}
	page := dayPage(t, s, "", 1000, 0)
	if page.TotalCount != rowBlockSize/4 {
		t.Fatalf("kept rows = %d", page.TotalCount)
	}
	if page.Logs[0]["_id"] != ids[0] || page.Logs[0]["_src"] != "keep.log" {
		t.Fatalf("rewritten row lost its identity: %#v", page.Logs[0])
	}
}

func TestMigrateDayConvertsLegacyShardWithoutChangingResults(t *testing.T) {
	dir := t.TempDir()
	legacy := openLegacy(t, dir)
	date := hybridDay.Format("2006-01-02")
	rows := hybridRows("app.log", 0, rowBlockSize*2+300)
	rows[0]["context"] = map[string]interface{}{"code": 503, "region": "eu"}
	rows[1]["when"] = "2024-03-10T08:00:00Z"
	ids, err := legacy.StoreWithIDs(rows, "app.log")
	if err != nil {
		t.Fatal(err)
	}
	queries := []string{"", "level:error", `"request took"`, "latency:[100 TO 200]", "user:00042", "tags:t3", "context.code:503", "warn"}
	want := map[string]SearchPageResult{}
	for _, q := range queries {
		want[q] = dayPage(t, legacy, q, 200, 150)
	}
	wantFacets, _ := legacy.Facets(context.Background(), SearchOptions{StartDate: hybridDay, EndDate: hybridDay.Add(24 * time.Hour)})
	wantStats, _ := legacy.SourceStats(date)
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	s := openCompact(t, dir)
	if s.ShardFormat(date) != "legacy" {
		t.Fatalf("format before migration = %q", s.ShardFormat(date))
	}
	before, after, err := s.MigrateDay(context.Background(), date)
	if err != nil {
		t.Fatal(err)
	}
	if s.ShardFormat(date) != "compact" || after >= before {
		t.Fatalf("format=%q size %d → %d", s.ShardFormat(date), before, after)
	}
	check := func(s *Storage) {
		t.Helper()
		for _, q := range queries {
			if got := dayPage(t, s, q, 200, 150); !reflect.DeepEqual(got, want[q]) {
				t.Fatalf("query %q changed by migration:\n got=%#v\nwant=%#v", q, got, want[q])
			}
		}
		gotFacets, _ := s.Facets(context.Background(), SearchOptions{StartDate: hybridDay, EndDate: hybridDay.Add(24 * time.Hour)})
		if !reflect.DeepEqual(gotFacets, wantFacets) {
			t.Fatalf("facets changed by migration")
		}
		gotStats, _ := s.SourceStats(date)
		if !reflect.DeepEqual(gotStats, wantStats) {
			t.Fatalf("source stats changed: %+v vs %+v", gotStats, wantStats)
		}
	}
	check(s)
	// Document IDs survive, so ID-based deletes and upserts keep working.
	if n, err := s.DeleteByIds([]string{ids[5]}); err != nil || n != 1 {
		t.Fatalf("delete migrated ID: %d %v", n, err)
	}
	if _, err := s.StoreWithIDs(rows[5:6], "app.log"); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = openCompact(t, dir)
	defer s.Close()
	check(s)
	if matches, _ := filepath.Glob(filepath.Join(dir, "logs-*.bleve.*")); len(matches) != 0 {
		t.Fatalf("migration left %v", matches)
	}
}

func TestMigrateDayRetriesWhenTheDayChanges(t *testing.T) {
	dir := t.TempDir()
	legacy := openLegacy(t, dir)
	date := hybridDay.Format("2006-01-02")
	if _, err := legacy.StoreWithIDs(hybridRows("app.log", 0, 100), "app.log"); err != nil {
		t.Fatal(err)
	}
	_ = legacy.Close()
	s := openCompact(t, dir)
	defer s.Close()
	migrationAfterCopyHook = func(string) {
		if _, err := s.StoreWithIDs(hybridRows("late.log", 500, 3), "late.log"); err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(func() { migrationAfterCopyHook = nil })
	if _, _, err := s.MigrateDay(context.Background(), date); !errors.Is(err, errMigrationRetry) {
		t.Fatalf("MigrateDay = %v, want retry", err)
	}
	if s.ShardFormat(date) != "legacy" {
		t.Fatalf("day converted despite a concurrent write")
	}
	if matches, _ := filepath.Glob(filepath.Join(dir, "logs-*.bleve.new")); len(matches) != 0 {
		t.Fatalf("partial copy left behind: %v", matches)
	}
	migrationAfterCopyHook = nil
	if _, _, err := s.MigrateDay(context.Background(), date); err != nil {
		t.Fatal(err)
	}
	if page := dayPage(t, s, "", 200, 0); page.TotalCount != 103 {
		t.Fatalf("rows after retry = %d, want 103", page.TotalCount)
	}
}

func TestRecoverMigrationsAfterCrash(t *testing.T) {
	dir := t.TempDir()
	legacy := openLegacy(t, dir)
	dates := []string{"2024-03-10", "2024-03-11"}
	for i, date := range dates {
		day, _ := time.Parse("2006-01-02", date)
		rows := hybridRows(fmt.Sprintf("s%d.log", i), 0, 20)
		for _, row := range rows {
			row["timestamp"] = day.Add(row["timestamp"].(time.Time).Sub(hybridDay))
		}
		if _, err := legacy.StoreWithIDs(rows, "x"); err != nil {
			t.Fatal(err)
		}
	}
	_ = legacy.Close()

	// Day 1: crash while copying (partial .new beside the intact shard).
	partial := filepath.Join(dir, "logs-2024-03-10.bleve.new")
	if err := os.MkdirAll(filepath.Join(partial, "store"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Day 2: crash between the two renames (complete copy, old moved aside).
	s := openCompact(t, dir)
	finalPath := filepath.Join(dir, "logs-2024-03-11.bleve")
	if _, err := s.buildCompactCopy(context.Background(), s.indices["2024-03-11"], "2024-03-11", finalPath+".new"); err != nil {
		t.Fatal(err)
	}
	_ = s.Close()
	if err := os.Rename(finalPath, finalPath+".old"); err != nil {
		t.Fatal(err)
	}

	s = openCompact(t, dir)
	defer s.Close()
	if got := s.ShardFormat("2024-03-10"); got != "legacy" {
		t.Fatalf("day 1 format %q, want legacy", got)
	}
	if got := s.ShardFormat("2024-03-11"); got != "compact" {
		t.Fatalf("day 2 format %q, want compact", got)
	}
	for _, date := range dates {
		if count, _ := s.GetDocCount(date); count != 20 {
			t.Fatalf("%s count %d", date, count)
		}
	}
	if matches, _ := filepath.Glob(filepath.Join(dir, "logs-*.bleve.*")); len(matches) != 0 {
		t.Fatalf("leftovers: %v", matches)
	}
}

func TestMigrateLegacyDaysSkipsToday(t *testing.T) {
	dir := t.TempDir()
	legacy := openLegacy(t, dir)
	now := time.Now()
	if _, err := legacy.StoreWithIDs([]map[string]interface{}{
		{"timestamp": now, "_raw": "today", "_src": "a"},
		{"timestamp": now.AddDate(0, 0, -3), "_raw": "old", "_src": "a"},
	}, "a"); err != nil {
		t.Fatal(err)
	}
	_ = legacy.Close()
	s := openCompact(t, dir)
	defer s.Close()
	n, err := s.MigrateLegacyDays(context.Background())
	if err != nil || n != 1 {
		t.Fatalf("migrated %d, %v; want 1", n, err)
	}
	if got := s.ShardFormat(now.Format("2006-01-02")); got != "legacy" {
		t.Fatalf("today's shard format %q, want legacy", got)
	}
	status := s.MigrationStatus()
	if status.LegacyDays != 1 || status.CompactDays != 1 {
		t.Fatalf("status %+v", status)
	}
}

func TestCompactConcurrentWritesSearchesAndMigration(t *testing.T) {
	dir := t.TempDir()
	legacy := openLegacy(t, dir)
	oldDay := hybridDay.AddDate(0, 0, -1)
	rows := hybridRows("old.log", 0, 1500)
	for _, row := range rows {
		row["timestamp"] = row["timestamp"].(time.Time).AddDate(0, 0, -1)
	}
	if _, err := legacy.StoreWithIDs(rows, "old.log"); err != nil {
		t.Fatal(err)
	}
	_ = legacy.Close()

	s := openCompact(t, dir)
	defer s.Close()
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	wg.Add(3)
	go func() {
		defer wg.Done()
		for i := 0; i < 20; i++ {
			if _, err := s.StoreWithIDs(hybridRows("live.log", i*60, 60), "live.log"); err != nil {
				errs <- err
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 30; i++ {
			for _, q := range []string{"", `"request took"`, "level:warn"} {
				if _, err := s.SearchPage(context.Background(), SearchOptions{
					Query: q, StartDate: oldDay, EndDate: hybridDay.Add(24 * time.Hour), Limit: 50,
					SortBy: "timestamp", SortOrder: "desc",
				}); err != nil {
					errs <- err
					return
				}
			}
		}
	}()
	go func() {
		defer wg.Done()
		if _, err := s.MigrateLegacyDays(context.Background()); err != nil {
			errs <- err
		}
		for i := 0; i < 5; i++ {
			if _, _, err := s.DeleteBySource(context.Background(), "live.log", []string{hybridDay.Format("2006-01-02")}); err != nil {
				errs <- err
				return
			}
		}
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if count, _ := s.GetDocCount(oldDay.Format("2006-01-02")); count != 1500 {
		t.Fatalf("old day has %d rows after concurrent migration", count)
	}
}

func TestCompactShardRebuildsBlocksLostBeforeCheckpoint(t *testing.T) {
	dir := t.TempDir()
	s := openCompact(t, dir)
	date := hybridDay.Format("2006-01-02")
	if _, err := s.StoreWithIDs(hybridRows("app.log", 0, rowBlockSize*2+10), "app.log"); err != nil {
		t.Fatal(err)
	}
	want := dayPage(t, s, "level:warn", 500, 0)
	crash(t, s)
	// Power loss after sealing but before a checkpoint: block files vanish,
	// the WAL still has their frames.
	sealed, _ := filepath.Glob(filepath.Join(dir, "logs-"+date+".bleve", rowsDirName, "*.zst"))
	if len(sealed) != 2 {
		t.Fatalf("sealed blocks before crash: %v", sealed)
	}
	for _, path := range sealed {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
	}
	s = openCompact(t, dir)
	defer s.Close()
	if got := dayPage(t, s, "level:warn", 500, 0); !reflect.DeepEqual(got, want) {
		t.Fatalf("rows not rebuilt from the WAL: total %d vs %d", got.TotalCount, want.TotalCount)
	}
	if count, _ := s.GetDocCount(date); count != rowBlockSize*2+10 {
		t.Fatalf("doc count %d", count)
	}
}

func TestCompactShardDropsDocumentsOfUnrecoverableBlocks(t *testing.T) {
	dir := t.TempDir()
	s := openCompact(t, dir)
	date := hybridDay.Format("2006-01-02")
	if _, err := s.StoreWithIDs(hybridRows("app.log", 0, rowBlockSize+10), "app.log"); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil { // checkpoint: the WAL no longer covers block 1
		t.Fatal(err)
	}
	sealed, _ := filepath.Glob(filepath.Join(dir, "logs-"+date+".bleve", rowsDirName, fmt.Sprintf("%020d-*.zst", 1)))
	if len(sealed) != 1 {
		t.Fatalf("block 1: %v", sealed)
	}
	_ = os.Remove(sealed[0])
	s = openCompact(t, dir)
	defer s.Close()
	page := dayPage(t, s, "", 100, 0)
	if page.TotalCount != 10 || len(page.Logs) != 10 {
		t.Fatalf("after losing block 1: total=%d rows=%d, want the 10 rows of block 2", page.TotalCount, len(page.Logs))
	}
}

// Retention and day removal close a day's index; they must wait for a write
// to that day instead of failing it with "index is closed".
func TestRemovalWaitsForInFlightWrites(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		s, err := newStorageWithFormat(t.TempDir(), legacy)
		if err != nil {
			t.Fatal(err)
		}
		old := time.Now().UTC().AddDate(0, 0, -20)
		stop := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				if _, err := s.PruneOlderThan(7 * 24 * time.Hour); err != nil {
					t.Error(err)
					return
				}
				_ = s.RemoveDay(old.Format("2006-01-02"))
			}
		}()
		for i := 0; i < 50; i++ {
			rows := []map[string]interface{}{{"timestamp": old, "_seq": int64(i), "_raw": "x", "_src": "a"}}
			if _, err := s.StoreWithIDs(rows, "a"); err != nil {
				t.Errorf("legacy=%v write %d: %v", legacy, i, err)
				break
			}
		}
		close(stop)
		wg.Wait()
		if err := s.Close(); err != nil {
			t.Fatal(err)
		}
	}
}
