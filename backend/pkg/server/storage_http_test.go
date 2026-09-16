package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/types"
)

// seedDaysAgo stores perDay rows for each of the given ages (in days
// before now) under source, via the chunk route with explicit timestamps.
func seedDaysAgo(t *testing.T, ts *httptest.Server, source string, ages []int, perDay int) {
	t.Helper()
	sid := startTimedSession(t, ts, source)
	var lines []string
	for _, age := range ages {
		day := time.Now().UTC().AddDate(0, 0, -age).Format("2006-01-02")
		lines = append(lines, timedLines([]string{day}, perDay)...)
	}
	postChunk(t, ts, sid, lines)
	endSession(t, ts, sid)
}

// C8: PUT retention 7 on server A; restart as server B with -retention-days
// 30 on the same store → 7 wins (config source), the startup sweep removes
// a 20-day-old day but keeps a 3-day-old one, and the catalog follows.
func TestC8_ConfigRetentionOverridesFlagAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	srvA, tsA := newTestServer(t, Config{Host: "localhost", Port: ":0", StoragePath: dir, RetentionDays: 30})
	seedDaysAgo(t, tsA, "old.log", []int{20, 3}, 5)

	var before types.StorageResponse
	if code := do(t, tsA, http.MethodGet, "/api/v1/storage", nil, &before); code != 200 {
		t.Fatalf("GET /storage: %d", code)
	}
	if before.RetentionDays != 30 || before.RetentionSource != "flag" || before.RetentionDefault != 30 || len(before.Days) != 2 {
		t.Fatalf("before: %+v", before)
	}
	for _, d := range before.Days {
		if d.Rows != 5 || d.Bytes <= 0 {
			t.Errorf("day table row: %+v", d)
		}
	}
	if before.TotalBytes != before.Days[0].Bytes+before.Days[1].Bytes || before.Path != dir {
		t.Errorf("total/path: %+v", before)
	}

	// PUT 7 prunes synchronously: the 20-day-old day goes now.
	seven := 7
	var after types.StorageResponse
	if code := do(t, tsA, http.MethodPut, "/api/v1/storage", types.StorageUpdateRequest{RetentionDays: &seven}, &after); code != 200 {
		t.Fatalf("PUT /storage: %d %+v", code, after)
	}
	if after.RetentionDays != 7 || after.RetentionSource != "config" || after.RetentionDefault != 30 || len(after.Days) != 1 {
		t.Fatalf("after PUT: %+v", after)
	}
	var entry types.SourceEntry
	do(t, tsA, http.MethodGet, "/api/v1/sources/old.log", nil, &entry)
	if entry.Rows != 5 || len(entry.Days) != 1 {
		t.Fatalf("catalog after PUT prune: %+v", entry)
	}
	// Re-seed the old day so server B has something to prune at start.
	seedDaysAgo(t, tsA, "old.log", []int{20}, 5)
	if err := srvA.services.CloseStorage(); err != nil {
		t.Fatal(err)
	}
	tsA.Close()

	// Server B: flag says 30, config.json says 7.
	srvB, tsB := newTestServer(t, Config{Host: "localhost", Port: ":0", StoragePath: dir, RetentionDays: 30})
	// newTestServer never calls Start(); run the startup sweep explicitly.
	srvB.services.Retention.PruneNow()
	var b types.StorageResponse
	do(t, tsB, http.MethodGet, "/api/v1/storage", nil, &b)
	if b.RetentionDays != 7 || b.RetentionSource != "config" || b.RetentionDefault != 30 {
		t.Fatalf("server B must read 7 from config.json over the flag's 30: %+v", b)
	}
	if len(b.Days) != 1 || b.Days[0].Date != time.Now().UTC().AddDate(0, 0, -3).Format("2006-01-02") {
		t.Fatalf("startup sweep with 7 days must leave only the 3-day-old day: %+v", b.Days)
	}
	do(t, tsB, http.MethodGet, "/api/v1/sources/old.log", nil, &entry)
	if entry.Rows != 5 || len(entry.Days) != 1 {
		t.Fatalf("catalog after startup prune: %+v", entry)
	}

	// Clear the override: back to the flag; 0 disables entirely.
	var cleared types.StorageResponse
	if code := do(t, tsB, http.MethodPut, "/api/v1/storage", map[string]any{"retention_days": nil}, &cleared); code != 200 || cleared.RetentionSource != "flag" || cleared.RetentionDays != 30 {
		t.Fatalf("clear override: %d %+v", code, cleared)
	}
	zero := 0
	var off types.StorageResponse
	do(t, tsB, http.MethodPut, "/api/v1/storage", types.StorageUpdateRequest{RetentionDays: &zero}, &off)
	if off.RetentionDays != 0 || off.RetentionSource != "config" {
		t.Fatalf("0 is an explicit override: %+v", off)
	}
	seedDaysAgo(t, tsB, "old.log", []int{40}, 2)
	srvB.services.Retention.PruneNow()
	do(t, tsB, http.MethodGet, "/api/v1/storage", nil, &off)
	if len(off.Days) != 2 {
		t.Fatalf("retention 0 must prune nothing: %+v", off.Days)
	}
	// Persisted with version and only the key we own.
	cfgBytes, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	if string(cfgBytes) == "" || !strings.Contains(string(cfgBytes), `"retention_days": 0`) || !strings.Contains(string(cfgBytes), `"version": 1`) {
		t.Fatalf("config.json: %s", cfgBytes)
	}
}

func TestPutStorageValidation(t *testing.T) {
	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	var errResp types.ErrorResponse
	neg := -1
	if code := do(t, ts, http.MethodPut, "/api/v1/storage", types.StorageUpdateRequest{RetentionDays: &neg}, &errResp); code != 400 || errResp.Code != "RETENTION_OUT_OF_RANGE" {
		t.Errorf("negative: %d %+v", code, errResp)
	}
	big := 4000
	if code := do(t, ts, http.MethodPut, "/api/v1/storage", types.StorageUpdateRequest{RetentionDays: &big}, &errResp); code != 400 {
		t.Errorf("too large: %d", code)
	}
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/storage", nil)
	req.Header.Set("Content-Type", "application/json")
	req.Body = http.NoBody
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Errorf("empty body: %d", resp.StatusCode)
	}
}

// Delete-day: removes the directory, the catalog loses the day, 404 for a
// day that doesn't exist, 400 for a malformed date, 409 while a tail is
// writing a source that has rows on that day.
func TestDeleteStorageDay(t *testing.T) {
	srv, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	sid := startTimedSession(t, ts, "a.log")
	postChunk(t, ts, sid, timedLines([]string{"2026-03-01", "2026-03-02"}, 4))
	endSession(t, ts, sid)

	var errResp types.ErrorResponse
	if code := do(t, ts, http.MethodDelete, "/api/v1/storage/days/2026-3-1", nil, &errResp); code != 400 || errResp.Code != "INVALID_DATE" {
		t.Errorf("malformed: %d %+v", code, errResp)
	}
	if code := do(t, ts, http.MethodDelete, "/api/v1/storage/days/1999-01-01", nil, &errResp); code != 404 || errResp.Code != "DAY_NOT_FOUND" {
		t.Errorf("missing: %d %+v", code, errResp)
	}
	var resp types.StorageDayDeleteResponse
	if code := do(t, ts, http.MethodDelete, "/api/v1/storage/days/2026-03-01", nil, &resp); code != 200 || resp.RowsDeleted != 4 {
		t.Fatalf("delete day: %d %+v", code, resp)
	}
	if _, err := os.Stat(filepath.Join(srv.config.StoragePath, "logs-2026-03-01.bleve")); !os.IsNotExist(err) {
		t.Error("day dir still on disk")
	}
	var entry types.SourceEntry
	do(t, ts, http.MethodGet, "/api/v1/sources/a.log", nil, &entry)
	if entry.Rows != 4 || len(entry.Days) != 1 || entry.Days[0] != "2026-03-02" {
		t.Fatalf("catalog after delete-day: %+v", entry)
	}
	var st types.StorageResponse
	do(t, ts, http.MethodGet, "/api/v1/storage", nil, &st)
	if len(st.Days) != 1 {
		t.Fatalf("/storage after delete-day: %+v", st.Days)
	}

	// In use: a tail writing today's shard blocks deleting today.
	path := filepath.Join(t.TempDir(), "tail.log")
	_ = os.WriteFile(path, []byte(""), 0o644)
	var live types.LiveSourceResponse
	do(t, ts, http.MethodPost, "/api/v1/live/files", types.LiveFileRequest{Path: path, Options: types.IngestSessionOptions{
		Name: "TIMED", Pattern: "%{TIMESTAMP_ISO8601:timestamp} %{WORD:level} %{WORD:service} %{GREEDYDATA:message}",
		Source: "tail.log", Meta: map[string]interface{}{"_src": "tail.log"},
	}}, &live)
	today := time.Now().UTC().Format("2006-01-02")
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	fmt.Fprintf(f, "%sT10:00:00Z INFO api one\n", today)
	f.Close()
	// Wait for the row to be catalogued, not just searchable: Store commits
	// before Record runs, and the in-use check reads the catalog's day map.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var e types.SourceEntry
		if do(t, ts, http.MethodGet, "/api/v1/sources/tail.log", nil, &e) == 200 && e.DayRows[today] > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	errResp = types.ErrorResponse{}
	if code := do(t, ts, http.MethodDelete, "/api/v1/storage/days/"+today, nil, &errResp); code != 409 || errResp.Code != "DAY_IN_USE" {
		var srcs types.SourcesResponse
		do(t, ts, http.MethodGet, "/api/v1/sources", nil, &srcs)
		t.Fatalf("delete today's day during a tail: %d %+v\n  live kinds: %v\n  catalog: %+v", code, errResp, srv.services.Live.ActiveSourceKinds(), srcs.Sources)
	}
	do(t, ts, http.MethodDelete, "/api/v1/live/sources/"+live.SourceID, nil, nil)
	if code := do(t, ts, http.MethodDelete, "/api/v1/storage/days/"+today, nil, &resp); code != 200 || resp.RowsDeleted != 1 {
		t.Fatalf("delete today's day after the tail stopped: %d %+v", code, resp)
	}
	if code := do(t, ts, http.MethodGet, "/api/v1/sources/tail.log", nil, nil); code != 404 {
		t.Errorf("a source whose only day was deleted should be gone from the catalog: %d", code)
	}
}
