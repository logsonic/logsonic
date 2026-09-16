package catalog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/storage"
	"logsonic/pkg/types"
)

func newStorage(t *testing.T) (*storage.Storage, string) {
	t.Helper()
	dir := t.TempDir()
	st, err := storage.NewStorage(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st, dir
}

func rows(source string, start time.Time, n int, step time.Duration) []map[string]interface{} {
	out := make([]map[string]interface{}, n)
	for i := range out {
		out[i] = map[string]interface{}{
			"timestamp": start.Add(time.Duration(i) * step),
			"_raw":      "line",
			"_src":      source,
			"_seq":      int64(i),
		}
	}
	return out
}

// store writes rows to storage and records them, the way a handler does.
func store(t *testing.T, st *storage.Storage, c *Catalog, source string, batch []map[string]interface{}, importID string) {
	t.Helper()
	if err := st.Store(batch, source); err != nil {
		t.Fatal(err)
	}
	s := SummarizeRows(batch, source)[source]
	c.Record(Batch{
		Source:      source,
		Origin:      types.SourceOrigin{Kind: "file", Path: "/tmp/" + source},
		PatternName: "apache",
		Rows:        s.Rows,
		Bytes:       int64(5 * len(batch)),
		FirstTS:     s.FirstTS,
		LastTS:      s.LastTS,
		DayRows:     s.DayRows,
		ImportID:    importID,
		ImportPath:  "/tmp/" + source,
	})
}

func mustGet(t *testing.T, c *Catalog, name string) types.SourceEntry {
	t.Helper()
	e, err := c.Get(name)
	if err != nil {
		t.Fatalf("get %s: %v", name, err)
	}
	return e
}

// C1: two ingests → two entries with exact rows / first / last / days.
func TestC1_RecordTwoSources(t *testing.T) {
	st, dir := newStorage(t)
	c, err := Open(dir, st)
	if err != nil {
		t.Fatal(err)
	}
	day1 := time.Date(2026, 8, 30, 23, 50, 0, 0, time.UTC)
	// 20 rows, one per minute, crossing midnight → 10 on 08-30, 10 on 08-31.
	store(t, st, c, "a.log", rows("a.log", day1, 20, time.Minute), "s1")
	store(t, st, c, "b.log", rows("b.log", day1.Add(48*time.Hour), 5, time.Second), "s2")

	a := mustGet(t, c, "a.log")
	if a.Rows != 20 || a.BytesRaw != 100 {
		t.Errorf("a: rows %d bytes %d", a.Rows, a.BytesRaw)
	}
	if len(a.Days) != 2 || a.Days[0] != "2026-08-30" || a.Days[1] != "2026-08-31" {
		t.Errorf("a days: %v", a.Days)
	}
	if a.DayRows["2026-08-30"] != 10 || a.DayRows["2026-08-31"] != 10 {
		t.Errorf("a day_rows: %v", a.DayRows)
	}
	if !a.FirstTS.Equal(day1) || !a.LastTS.Equal(day1.Add(19*time.Minute)) {
		t.Errorf("a bounds: %v .. %v", a.FirstTS, a.LastTS)
	}
	if a.Origin.Kind != "file" || a.Origin.Path != "/tmp/a.log" || a.PatternName != "apache" {
		t.Errorf("a origin/pattern: %+v %q", a.Origin, a.PatternName)
	}
	if len(a.Imports) != 1 || a.Imports[0].Rows != 20 {
		t.Errorf("a imports: %+v", a.Imports)
	}
	b := mustGet(t, c, "b.log")
	if b.Rows != 5 || len(b.Days) != 1 || b.Days[0] != "2026-09-01" {
		t.Errorf("b: %+v", b)
	}
	if names := c.Names(); len(names) != 2 || names[0] != "a.log" || names[1] != "b.log" {
		t.Errorf("names: %v", names)
	}

	// Two batches of one session collapse into one import row; a new
	// session adds a second.
	store(t, st, c, "b.log", rows("b.log", day1.Add(49*time.Hour), 3, time.Second), "s2")
	store(t, st, c, "b.log", rows("b.log", day1.Add(50*time.Hour), 2, time.Second), "s3")
	b = mustGet(t, c, "b.log")
	if b.Rows != 10 || len(b.Imports) != 2 || b.Imports[0].Rows != 8 || b.Imports[1].Rows != 2 {
		t.Errorf("b after 3 batches: rows %d imports %+v", b.Rows, b.Imports)
	}
}

// C2: restart loads without a rebuild; deleting the file forces a rebuild
// from the indices that yields the same derivable numbers and keeps nothing
// the index can't know (origin becomes "unknown").
func TestC2_RestartAndRebuildMatch(t *testing.T) {
	st, dir := newStorage(t)
	c, err := Open(dir, st)
	if err != nil {
		t.Fatal(err)
	}
	day1 := time.Date(2026, 8, 30, 23, 50, 0, 0, time.UTC)
	store(t, st, c, "a.log", rows("a.log", day1, 20, time.Minute), "s1")
	store(t, st, c, "app.log.1", rows("app.log.1", day1, 7, time.Second), "s2")
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, fileName)); err != nil {
		t.Fatalf("catalog not persisted: %v", err)
	}
	before := c.List()

	// Restart: loads from file, no rebuild.
	c2, err := Open(dir, st)
	if err != nil {
		t.Fatal(err)
	}
	if c2.RebuiltAtOpen() {
		t.Fatal("a valid file must not trigger a rebuild")
	}
	assertSameEntries(t, before, c2.List(), true)

	// Delete the file: rebuilt from indices.
	if err := os.Remove(filepath.Join(dir, fileName)); err != nil {
		t.Fatal(err)
	}
	c3, err := Open(dir, st)
	if err != nil {
		t.Fatal(err)
	}
	if !c3.RebuiltAtOpen() {
		t.Fatal("missing file must trigger a rebuild")
	}
	after := c3.List()
	assertSameEntries(t, before, after, false)
	for _, e := range after {
		if e.Origin.Kind != "unknown" || e.PatternName != "" || len(e.Imports) != 0 {
			t.Errorf("rebuilt entry carries data the index can't know: %+v", e)
		}
	}

	// Idempotent: a second rebuild changes nothing.
	if err := c3.Rebuild(); err != nil {
		t.Fatal(err)
	}
	assertSameEntries(t, after, c3.List(), true)

	// A rebuild over an existing catalog is a merge: origin/pattern survive.
	if err := c2.Rebuild(); err != nil {
		t.Fatal(err)
	}
	merged := mustGet(t, c2, "a.log")
	if merged.Origin.Kind != "file" || merged.PatternName != "apache" || merged.Rows != 20 {
		t.Errorf("merge lost non-derivable fields: %+v", merged)
	}

	// Wrong schema version → rebuild.
	raw, _ := json.Marshal(diskFile{Version: schemaVersion + 1})
	if err := os.WriteFile(filepath.Join(dir, fileName), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	c4, err := Open(dir, st)
	if err != nil {
		t.Fatal(err)
	}
	if !c4.RebuiltAtOpen() || len(c4.List()) != 2 {
		t.Fatal("old schema version must trigger a rebuild")
	}
}

// C5: a retention prune removes a day; a scoped rebuild over that day
// shrinks the affected entry and drops an entry that loses all its rows.
func TestC5_PruneShrinksDays(t *testing.T) {
	st, dir := newStorage(t)
	c, err := Open(dir, st)
	if err != nil {
		t.Fatal(err)
	}
	// Whole seconds: rebuilt bounds come back from Bleve at second
	// precision (see storage.SourceDayStats).
	old := time.Now().UTC().Truncate(time.Second).AddDate(0, 0, -40)
	recent := time.Now().UTC().Truncate(time.Second).AddDate(0, 0, -2)
	store(t, st, c, "a.log", rows("a.log", old, 5, time.Second), "s1")
	store(t, st, c, "a.log", rows("a.log", recent, 3, time.Second), "s1")
	store(t, st, c, "old-only.log", rows("old-only.log", old, 4, time.Second), "s2")

	removed, err := st.PruneOlderThan(30 * 24 * time.Hour)
	if err != nil || removed != 1 {
		t.Fatalf("prune: %d %v", removed, err)
	}
	if err := c.Rebuild(old.Format(dayLayout)); err != nil {
		t.Fatal(err)
	}
	a := mustGet(t, c, "a.log")
	if a.Rows != 3 || len(a.Days) != 1 || a.Days[0] != recent.Format(dayLayout) {
		t.Errorf("a after prune: %+v", a)
	}
	if !a.FirstTS.Equal(recent) {
		t.Errorf("a first_ts should move to the surviving day: %v", a.FirstTS)
	}
	if _, err := c.Get("old-only.log"); err != ErrNotFound {
		t.Errorf("source with no rows left should be dropped, got %v", err)
	}
}

func TestRecordAfterCloseIsNoop(t *testing.T) {
	st, dir := newStorage(t)
	c, _ := Open(dir, st)
	_ = c.Close()
	c.Record(Batch{Source: "late", Rows: 1, DayRows: map[string]int64{"2026-01-01": 1}})
	if _, err := c.Get("late"); err != ErrNotFound {
		t.Fatal("Record after Close must not add entries")
	}
	if _, err := os.Stat(filepath.Join(dir, fileName+".tmp")); err == nil {
		t.Fatal("temp file left behind")
	}
}

func TestDaysForDocIDs(t *testing.T) {
	ts := time.Date(2026, 8, 31, 0, 30, 0, 0, time.UTC)
	id := storage.BuildDocID(map[string]interface{}{"timestamp": ts, "_seq": int64(3)}, "a-b.log", 0)
	days := DaysForDocIDs([]string{id, "garbage"})
	if len(days) != 3 || days[0] != "2026-08-30" || days[1] != "2026-08-31" || days[2] != "2026-09-01" {
		t.Errorf("days: %v", days)
	}
}

func assertSameEntries(t *testing.T, want, got []types.SourceEntry, includeMeta bool) {
	t.Helper()
	if len(want) != len(got) {
		t.Fatalf("entry count %d vs %d", len(want), len(got))
	}
	for i := range want {
		w, g := want[i], got[i]
		if w.Name != g.Name || w.Rows != g.Rows {
			t.Errorf("%s: rows %d vs %d", w.Name, w.Rows, g.Rows)
		}
		if len(w.Days) != len(g.Days) {
			t.Errorf("%s: days %v vs %v", w.Name, w.Days, g.Days)
			continue
		}
		for _, d := range w.Days {
			if w.DayRows[d] != g.DayRows[d] {
				t.Errorf("%s: day %s rows %d vs %d", w.Name, d, w.DayRows[d], g.DayRows[d])
			}
		}
		if (w.FirstTS == nil) != (g.FirstTS == nil) || (w.FirstTS != nil && !w.FirstTS.Equal(*g.FirstTS)) {
			t.Errorf("%s: first_ts %v vs %v", w.Name, w.FirstTS, g.FirstTS)
		}
		if (w.LastTS == nil) != (g.LastTS == nil) || (w.LastTS != nil && !w.LastTS.Equal(*g.LastTS)) {
			t.Errorf("%s: last_ts %v vs %v", w.Name, w.LastTS, g.LastTS)
		}
		if includeMeta {
			if w.Origin != g.Origin || w.PatternName != g.PatternName || w.BytesRaw != g.BytesRaw || len(w.Imports) != len(g.Imports) {
				t.Errorf("%s: meta differs: %+v vs %+v", w.Name, w, g)
			}
		}
	}
}

// A browser upload (no path) followed by a path import of the same source
// must end up with the path — phase 2's re-import is gated on it — while
// an existing path is never replaced.
func TestRecordUpgradesOriginToOneWithPath(t *testing.T) {
	st, dir := newStorage(t)
	c, _ := Open(dir, st)
	day := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	c.Record(Batch{Source: "a.log", Origin: types.SourceOrigin{Kind: "file"}, Rows: 1, DayRows: map[string]int64{"2026-08-30": 1}, FirstTS: day, LastTS: day})
	c.Record(Batch{Source: "a.log", Origin: types.SourceOrigin{Kind: "file", Path: "/x/a.log"}, Rows: 1, DayRows: map[string]int64{"2026-08-30": 1}, FirstTS: day, LastTS: day})
	c.Record(Batch{Source: "a.log", Origin: types.SourceOrigin{Kind: "tail", Path: "/y/a.log"}, Rows: 1, DayRows: map[string]int64{"2026-08-30": 1}, FirstTS: day, LastTS: day})
	e := mustGet(t, c, "a.log")
	if e.Origin.Kind != "file" || e.Origin.Path != "/x/a.log" {
		t.Fatalf("origin: %+v", e.Origin)
	}
}

// An entry with no imports (a rebuilt one) must serialize its slices as
// [] — the TS type is SourceImport[], not SourceImport[] | null.
func TestEmptySlicesSerializeAsArrays(t *testing.T) {
	st, dir := newStorage(t)
	c, _ := Open(dir, st)
	day := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	if err := st.Store(rows("a.log", day, 2, time.Second), "a.log"); err != nil {
		t.Fatal(err)
	}
	if err := c.Rebuild(); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(c.List()[0])
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"imports":[]`, `"days":["2026-08-30"]`} {
		if !strings.Contains(string(b), key) {
			t.Errorf("want %s in %s", key, b)
		}
	}
	if strings.Contains(string(b), "null") {
		t.Errorf("null on the wire: %s", b)
	}
}

// A scoped rebuild over a day nowhere near the bounds keeps them without
// re-querying; one over the first day recomputes them.
func TestScopedRebuildRecomputesBoundsOnlyWhenAffected(t *testing.T) {
	st, dir := newStorage(t)
	c, _ := Open(dir, st)
	d1 := time.Date(2026, 8, 1, 10, 0, 0, 0, time.UTC)
	d2 := time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC)
	d3 := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	for _, d := range []time.Time{d1, d2, d3} {
		store(t, st, c, "a.log", rows("a.log", d, 3, time.Second), "s")
	}
	// Delete the middle day's rows behind the catalog's back.
	ids := []string{}
	for i := 0; i < 3; i++ {
		ids = append(ids, storage.BuildDocID(map[string]interface{}{"timestamp": d2.Add(time.Duration(i) * time.Second), "_seq": int64(i)}, "a.log", i))
	}
	if n, err := st.DeleteByIds(ids); err != nil || n != 3 {
		t.Fatalf("delete: %d %v", n, err)
	}
	if err := c.Rebuild(DaysForDocIDs(ids)...); err != nil {
		t.Fatal(err)
	}
	e := mustGet(t, c, "a.log")
	if e.Rows != 6 || len(e.Days) != 2 || !e.FirstTS.Equal(d1) || !e.LastTS.Equal(d3.Add(2*time.Second)) {
		t.Fatalf("after middle-day delete: %+v", e)
	}
	// Now the first day: bounds must move.
	ids = ids[:0]
	for i := 0; i < 3; i++ {
		ids = append(ids, storage.BuildDocID(map[string]interface{}{"timestamp": d1.Add(time.Duration(i) * time.Second), "_seq": int64(i)}, "a.log", i))
	}
	if n, err := st.DeleteByIds(ids); err != nil || n != 3 {
		t.Fatalf("delete first day: %d %v", n, err)
	}
	if err := c.Rebuild(DaysForDocIDs(ids)...); err != nil {
		t.Fatal(err)
	}
	e = mustGet(t, c, "a.log")
	if e.Rows != 3 || !e.FirstTS.Equal(d3) {
		t.Fatalf("after first-day delete: %+v", e)
	}
}

func TestRenameAliasesAndResolve(t *testing.T) {
	st, dir := newStorage(t)
	c, _ := Open(dir, st)
	day := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	store(t, st, c, "file.app.log", rows("file.app.log", day, 2, time.Second), "s1")
	store(t, st, c, "file.db.log", rows("file.db.log", day, 2, time.Second), "s2")

	e, err := c.Rename("file.app.log", "prod-app")
	if err != nil || e.DisplayName != "prod-app" || len(e.Aliases) != 1 || e.Aliases[0] != "prod-app" {
		t.Fatalf("rename: %v %+v", err, e)
	}
	e, _ = c.Rename("file.app.log", "prod-app-2")
	if e.DisplayName != "prod-app-2" || len(e.Aliases) != 2 {
		t.Fatalf("second rename keeps the first alias: %+v", e)
	}
	// Collisions: another entry's name, its display name, its alias.
	if _, err := c.Rename("file.db.log", "file.app.log"); err != ErrNameTaken {
		t.Errorf("stored name of another entry: %v", err)
	}
	if _, err := c.Rename("file.db.log", "prod-app"); err != ErrNameTaken {
		t.Errorf("alias of another entry: %v", err)
	}
	if _, err := c.Rename("file.db.log", " x"); err != ErrBadName {
		t.Errorf("untrimmed: %v", err)
	}
	if _, err := c.Rename("nope", "x"); err != ErrNotFound {
		t.Errorf("missing: %v", err)
	}
	// Resolution: stored names pass, display name and old alias map back,
	// unknown names pass through, duplicates collapse.
	got := c.ResolveSources([]string{"prod-app-2", "prod-app", "file.app.log", "file.db.log", "unknown.log"})
	want := []string{"file.app.log", "file.db.log", "unknown.log"}
	if len(got) != len(want) {
		t.Fatalf("resolve: %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("resolve: %v want %v", got, want)
		}
	}
	// Clearing keeps aliases so old links still resolve.
	e, _ = c.Rename("file.app.log", "")
	if e.DisplayName != "" || len(e.Aliases) != 2 {
		t.Fatalf("clear: %+v", e)
	}

	// Persist round-trip keeps display name + aliases.
	_ = c.Close()
	c2, _ := Open(dir, st)
	e2 := mustGet(t, c2, "file.app.log")
	if len(e2.Aliases) != 2 {
		t.Fatalf("aliases lost on reload: %+v", e2)
	}

	top, distinct := c2.TopSources(1)
	if distinct != 2 || len(top) != 1 || top[0].Rows != 2 {
		t.Fatalf("top: %v %d", top, distinct)
	}
	if err := c2.Delete("file.app.log"); err != nil {
		t.Fatal(err)
	}
	if _, err := c2.Get("file.app.log"); err != ErrNotFound {
		t.Fatal("deleted entry still present")
	}
	if err := c2.Delete("file.app.log"); err != ErrNotFound {
		t.Fatal("double delete must be ErrNotFound")
	}
}

func TestImportOptionsRecordedOnlyWhenGiven(t *testing.T) {
	st, dir := newStorage(t)
	c, _ := Open(dir, st)
	day := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	dr := map[string]int64{"2026-08-30": 1}
	c.Record(Batch{Source: "a", Rows: 1, DayRows: dr, FirstTS: day, LastTS: day, ImportOptions: &types.IngestSessionOptions{Name: "P1", Source: "a"}})
	c.Record(Batch{Source: "a", Rows: 1, DayRows: dr, FirstTS: day, LastTS: day})
	e := mustGet(t, c, "a")
	if e.ImportOptions == nil || e.ImportOptions.Name != "P1" {
		t.Fatalf("a batch without options must not clear them: %+v", e.ImportOptions)
	}
	c.Record(Batch{Source: "a", Rows: 1, DayRows: dr, FirstTS: day, LastTS: day, ImportOptions: &types.IngestSessionOptions{Name: "P2", Source: "a"}})
	if e := mustGet(t, c, "a"); e.ImportOptions.Name != "P2" {
		t.Fatalf("last path-backed import wins: %+v", e.ImportOptions)
	}
}

// An unclean exit (the marker is still there at Open) forces a rebuild
// even though sources.json is valid; a clean Close removes the marker.
func TestUncleanExitMarkerForcesRebuild(t *testing.T) {
	st, dir := newStorage(t)
	c, _ := Open(dir, st)
	marker := filepath.Join(dir, fileName+markerSuffix)
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("marker must exist while open: %v", err)
	}
	day := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	store(t, st, c, "a.log", rows("a.log", day, 5, time.Second), "s1")
	if err := c.Flush(); err != nil {
		t.Fatal(err)
	}
	// Simulate a crash: more rows land in the index after the last flush,
	// and the process dies without Close (marker stays).
	if err := st.Store(rows("a.log", day.Add(time.Hour), 5, time.Second), "a.log"); err != nil {
		t.Fatal(err)
	}
	c2, _ := Open(dir, st)
	if !c2.RebuiltAtOpen() {
		t.Fatal("marker present → rebuild expected")
	}
	if e := mustGet(t, c2, "a.log"); e.Rows != 10 {
		t.Fatalf("rebuild must see the unrecorded rows: %d", e.Rows)
	}
	// The rebuild result is persisted immediately, not left to the ticker.
	b, _ := os.ReadFile(filepath.Join(dir, fileName))
	if !strings.Contains(string(b), `"rows": 10`) {
		t.Fatalf("rebuilt catalog not saved at Open: %s", b)
	}
	if err := c2.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("clean Close must remove the marker")
	}
	c3, _ := Open(dir, st)
	if c3.RebuiltAtOpen() {
		t.Fatal("after a clean Close no rebuild should run")
	}
	_ = c3.Close()
}
