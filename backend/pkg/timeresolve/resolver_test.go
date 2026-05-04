package timeresolve

import (
	"testing"
	"time"
)

// anchor2026 returns a Resolution suitable for "we have no fileMTime,
// fall back to a fixed point in 2026" — gives the 2-digit-year
// expansion something deterministic to lean on in tests.
func anchor2026() Resolution {
	return Resolution{
		Anchor:       Anchor{Kind: AnchorNow, Value: time.Date(2026, 5, 4, 12, 0, 0, 0, time.UTC)},
		YearStrategy: YearInferredCentury,
		Timezone:     TimezoneCfg{Kind: TimezoneAsParsed},
		ForceMode:    ForceModeFillMissing,
		Rollover:     true,
	}
}

func TestResolve_Spark(t *testing.T) {
	// 17/06/09 20:10:40 INFO ...
	fields := map[string]string{
		"year":  "17",
		"month": "06",
		"day":   "09",
		"time":  "20:10:40",
	}
	r := New(anchor2026())
	got, conf := r.Resolve(fields)
	want := time.Date(2017, 6, 9, 20, 10, 40, 0, time.UTC)
	if !got.Equal(want) {
		t.Errorf("Spark: got %s, want %s", got, want)
	}
	if conf != ConfidenceInferred {
		t.Errorf("Spark confidence: got %s, want %s (2-digit year was expanded)", conf, ConfidenceInferred)
	}
}

func TestResolve_HealthApp(t *testing.T) {
	// 20171223-22:15:29:606|Step_LSC|...
	fields := map[string]string{
		"date":   "20171223",
		"hour":   "22",
		"minute": "15",
		"second": "29",
		"millis": "606",
	}
	r := New(anchor2026())
	got, conf := r.Resolve(fields)
	want := time.Date(2017, 12, 23, 22, 15, 29, 606*int(time.Millisecond), time.UTC)
	if !got.Equal(want) {
		t.Errorf("HealthApp: got %s, want %s", got, want)
	}
	if conf != ConfidenceExact {
		t.Errorf("HealthApp confidence: got %s, want %s (4-digit year, full date)", conf, ConfidenceExact)
	}
}

func TestResolve_LinuxSyslog_YearLess(t *testing.T) {
	// Jun 14 15:16:01 with anchor=2026-05-04 → June 14 is past the
	// anchor, so it must be from the previous year (2025) rather
	// than 2026. Year-less syslog can never be future-dated relative
	// to the anchor.
	fields := map[string]string{"timestamp": "Jun 14 15:16:01"}
	res := anchor2026()
	res.YearStrategy = YearFromAnchor
	r := New(res)
	got, conf := r.Resolve(fields)
	want := time.Date(2025, 6, 14, 15, 16, 1, 0, time.UTC)
	if got.Year() != want.Year() || got.Month() != want.Month() || got.Day() != want.Day() ||
		got.Hour() != want.Hour() || got.Minute() != want.Minute() || got.Second() != want.Second() {
		t.Errorf("Syslog: got %s, want %s", got, want)
	}
	if conf != ConfidenceInferred {
		t.Errorf("Syslog confidence: got %s, want %s (year borrowed from anchor)", conf, ConfidenceInferred)
	}
}

func TestResolve_OpenSSH_DecemberInPast(t *testing.T) {
	// Regression: openssh.log line "Dec 10 06:55:46 LabSZ ..." was
	// landing in 2026-12-10 (the future) when ingested in May 2026.
	// Anchor is supposed to be an upper bound — Dec 10 must be 2025.
	fields := map[string]string{"timestamp": "Dec 10 06:55:46"}
	res := anchor2026()
	res.YearStrategy = YearFromAnchor
	r := New(res)
	got, _ := r.Resolve(fields)
	if got.Year() != 2025 || got.Month() != 12 || got.Day() != 10 {
		t.Errorf("openssh: got %s, want 2025-12-10", got)
	}
	if got.After(res.Anchor.Value) {
		t.Errorf("openssh: %s is after anchor %s — automatic resolution must not produce future dates", got, res.Anchor.Value)
	}
}

func TestResolve_TwoDigitYear_AlsoClampedToPast(t *testing.T) {
	// 2-digit-year expansion picks the most recent century, but for
	// yy == anchor.Year() the month/day can still push the result
	// past the anchor. The clamp must catch that case too.
	fields := map[string]string{
		"year": "26", "month": "12", "day": "15", "time": "10:00:00",
	}
	r := New(anchor2026()) // anchor 2026-05-04
	got, _ := r.Resolve(fields)
	if got.Year() != 2025 || got.Month() != 12 || got.Day() != 15 {
		t.Errorf("yy=26 Dec 15 with anchor 2026-05-04: got %s, want 2025-12-15", got)
	}
}

func TestResolve_PastInferredYear_NotClamped(t *testing.T) {
	// Year-less line whose date is BEFORE the anchor's date should
	// land in the anchor year (no clamp).
	fields := map[string]string{"timestamp": "Mar 15 12:00:00"}
	res := anchor2026() // 2026-05-04
	res.YearStrategy = YearFromAnchor
	r := New(res)
	got, _ := r.Resolve(fields)
	if got.Year() != 2026 || got.Month() != 3 || got.Day() != 15 {
		t.Errorf("Mar 15 with anchor 2026-05-04: got %s, want 2026-03-15", got)
	}
}

func TestResolve_Hadoop_FullTimestamp(t *testing.T) {
	// 2015-10-18 18:01:47,978 — dateparse handles in one shot.
	fields := map[string]string{"timestamp": "2015-10-18 18:01:47,978"}
	r := New(anchor2026())
	got, conf := r.Resolve(fields)
	if got.Year() != 2015 || got.Month() != 10 || got.Day() != 18 ||
		got.Hour() != 18 || got.Minute() != 1 || got.Second() != 47 {
		t.Errorf("Hadoop: got %s", got)
	}
	if conf != ConfidenceExact {
		t.Errorf("Hadoop confidence: got %s, want %s", conf, ConfidenceExact)
	}
}

func TestResolve_Nginx_HTTPDate(t *testing.T) {
	// nginx access log: [01/Apr/2026:00:00:56 +0000]
	fields := map[string]string{"timestamp": "01/Apr/2026:00:00:56 +0000"}
	r := New(anchor2026())
	got, _ := r.Resolve(fields)
	if got.Year() != 2026 || got.Month() != 4 || got.Day() != 1 ||
		got.Hour() != 0 || got.Minute() != 0 || got.Second() != 56 {
		t.Errorf("Nginx: got %s", got)
	}
}

func TestResolve_TimeOnly_CarriesPriorDate(t *testing.T) {
	// First line carries date; subsequent line only has time.
	r := New(anchor2026())
	r.Resolve(map[string]string{
		"year": "17", "month": "06", "day": "09", "time": "20:10:40",
	})
	got, conf := r.Resolve(map[string]string{"time": "20:10:41"})
	want := time.Date(2017, 6, 9, 20, 10, 41, 0, time.UTC)
	if !got.Equal(want) {
		t.Errorf("Time-only line: got %s, want %s (should carry 2017-06-09 from prev)", got, want)
	}
	if conf != ConfidenceInferred {
		t.Errorf("Time-only confidence: got %s, want %s", conf, ConfidenceInferred)
	}
}

func TestResolve_DayRollover(t *testing.T) {
	// Year-less syslog crossing midnight: Jun 14 23:59 → Jun 15 00:00,
	// then a third line at 00:01 should also be Jun 15. Test the
	// simpler case where the time alone goes backwards (no date in
	// the line) and rollover should advance the day.
	res := anchor2026()
	res.YearStrategy = YearFromAnchor
	r := New(res)
	first, _ := r.Resolve(map[string]string{"timestamp": "Jun 14 23:59:30"})
	if first.Hour() != 23 {
		t.Fatalf("first: got %s", first)
	}
	// Same Jun 14 timestamp, but later wall-clock — should NOT roll
	// over since dates are still present in the line.
	same, _ := r.Resolve(map[string]string{"timestamp": "Jun 14 23:59:45"})
	if !same.After(first) {
		t.Errorf("same-day later time: got %s, want > %s", same, first)
	}
	// True rollover scenario: time-only line going backwards.
	r2 := New(anchor2026())
	r2.Resolve(map[string]string{
		"year": "17", "month": "06", "day": "09", "time": "23:59:50",
	})
	rolled, _ := r2.Resolve(map[string]string{"time": "00:00:05"})
	want := time.Date(2017, 6, 10, 0, 0, 5, 0, time.UTC)
	if !rolled.Equal(want) {
		t.Errorf("rollover: got %s, want %s", rolled, want)
	}
}

func TestResolve_NoTime_FallsBackToAnchor(t *testing.T) {
	// Line has neither timestamp nor any time component.
	r := New(anchor2026())
	got, conf := r.Resolve(map[string]string{"message": "hello"})
	if !got.Equal(anchor2026().Anchor.Value) {
		t.Errorf("no-time line: got %s, want anchor %s", got, anchor2026().Anchor.Value)
	}
	if conf != ConfidenceSynthetic {
		t.Errorf("no-time confidence: got %s, want %s", conf, ConfidenceSynthetic)
	}
}

func TestResolve_NoTime_CarriesForward(t *testing.T) {
	// First line resolves to a real time; second line is time-less.
	r := New(anchor2026())
	first, _ := r.Resolve(map[string]string{
		"year": "17", "month": "06", "day": "09", "time": "20:10:40",
	})
	got, conf := r.Resolve(map[string]string{"message": "continuation"})
	if !got.Equal(first) {
		t.Errorf("carry: got %s, want %s", got, first)
	}
	if conf != ConfidenceCarried {
		t.Errorf("carry confidence: got %s, want %s", conf, ConfidenceCarried)
	}
}

func TestResolve_ForcedYear_FillMissing(t *testing.T) {
	res := anchor2026()
	year2017 := 2017
	res.ForcedYear = &year2017
	res.YearStrategy = YearForced
	r := New(res)
	// Year-less syslog — forced year fills the gap.
	got, _ := r.Resolve(map[string]string{"timestamp": "Jun 14 15:16:01"})
	if got.Year() != 2017 {
		t.Errorf("forced fill: got year %d, want 2017", got.Year())
	}
	// Line that already has 2026 — fill_missing should NOT stomp.
	got, _ = r.Resolve(map[string]string{"timestamp": "2026-04-01 00:00:00"})
	if got.Year() != 2026 {
		t.Errorf("fill_missing must not stomp parsed year: got %d, want 2026", got.Year())
	}
}

func TestResolve_ForcedYear_Overwrite_LegacySemantics(t *testing.T) {
	res := anchor2026()
	year2017 := 2017
	res.ForcedYear = &year2017
	res.YearStrategy = YearForced
	res.ForceMode = ForceModeOverwrite
	r := New(res)
	got, _ := r.Resolve(map[string]string{"timestamp": "2026-04-01 00:00:00"})
	if got.Year() != 2017 {
		t.Errorf("overwrite must stomp parsed year: got %d, want 2017", got.Year())
	}
}

func TestSniff_Spark(t *testing.T) {
	samples := []map[string]string{
		{"year": "17", "month": "06", "day": "09", "time": "20:10:40"},
		{"year": "17", "month": "06", "day": "09", "time": "20:10:41"},
	}
	inf := Sniff(samples, nil)
	if inf.Status != StatusInferred {
		t.Errorf("Spark status: got %s, want %s", inf.Status, StatusInferred)
	}
	if inf.Layout.YearWidth != 2 {
		t.Errorf("Spark year width: got %d, want 2", inf.Layout.YearWidth)
	}
	if inf.Resolution.YearStrategy != YearInferredCentury {
		t.Errorf("Spark year strategy: got %s, want %s", inf.Resolution.YearStrategy, YearInferredCentury)
	}
	if len(inf.Warnings) == 0 {
		t.Error("Spark: expected a warning about 2-digit year")
	}
}

func TestSniff_HealthApp(t *testing.T) {
	samples := []map[string]string{
		{"date": "20171223", "hour": "22", "minute": "15", "second": "29", "millis": "606"},
	}
	inf := Sniff(samples, nil)
	if inf.Status != StatusExact {
		t.Errorf("HealthApp status: got %s, want %s", inf.Status, StatusExact)
	}
	if inf.Layout.YearWidth != 4 {
		t.Errorf("HealthApp year width: got %d, want 4", inf.Layout.YearWidth)
	}
}

func TestSniff_FileMTimeAnchor(t *testing.T) {
	mtime := time.Date(2017, 7, 15, 12, 0, 0, 0, time.UTC)
	samples := []map[string]string{{"year": "17", "month": "06", "day": "09", "time": "20:10:40"}}
	inf := Sniff(samples, &mtime)
	if inf.Resolution.Anchor.Kind != AnchorFileMTime {
		t.Errorf("anchor kind: got %s, want %s", inf.Resolution.Anchor.Kind, AnchorFileMTime)
	}
	if !inf.Resolution.Anchor.Value.Equal(mtime) {
		t.Errorf("anchor value: got %s, want %s", inf.Resolution.Anchor.Value, mtime)
	}
}

func TestSniff_NoTime(t *testing.T) {
	samples := []map[string]string{{"message": "hello"}}
	inf := Sniff(samples, nil)
	if inf.Status != StatusMissing {
		t.Errorf("no-time status: got %s, want %s", inf.Status, StatusMissing)
	}
}

func TestParseDateField(t *testing.T) {
	cases := []struct {
		in            string
		y, m, d       int
		wantOK        bool
	}{
		{"20171223", 2017, 12, 23, true},
		{"2017-06-09", 2017, 6, 9, true},
		{"2017/06/09", 2017, 6, 9, true},
		{"2017.06.09", 2017, 6, 9, true},
		{"", 0, 0, 0, false},
		{"not-a-date", 0, 0, 0, false},
	}
	for _, c := range cases {
		y, m, d, ok := parseDateField(c.in)
		if ok != c.wantOK {
			t.Errorf("parseDateField(%q) ok=%v, want %v", c.in, ok, c.wantOK)
			continue
		}
		if !ok {
			continue
		}
		if y != c.y || m != c.m || d != c.d {
			t.Errorf("parseDateField(%q): got %d-%d-%d, want %d-%d-%d", c.in, y, m, d, c.y, c.m, c.d)
		}
	}
}

func TestParseTimeField(t *testing.T) {
	cases := []struct {
		in                          string
		h, m, s, nano               int
		wantTZName                  string
		wantOK                      bool
	}{
		{"20:10:40", 20, 10, 40, 0, "", true},
		{"20:10:40.123", 20, 10, 40, 123000000, "", true},
		{"20:10:40,500", 20, 10, 40, 500000000, "", true},
		{"20:10:40Z", 20, 10, 40, 0, "UTC", true},
		{"20:10", 20, 10, 0, 0, "", true},
	}
	for _, c := range cases {
		h, m, s, ns, loc, ok := parseTimeField(c.in)
		if ok != c.wantOK {
			t.Errorf("parseTimeField(%q) ok=%v, want %v", c.in, ok, c.wantOK)
			continue
		}
		if h != c.h || m != c.m || s != c.s || ns != c.nano {
			t.Errorf("parseTimeField(%q): got %d:%d:%d.%d, want %d:%d:%d.%d", c.in, h, m, s, ns, c.h, c.m, c.s, c.nano)
		}
		if c.wantTZName != "" && (loc == nil || loc.String() != c.wantTZName) {
			t.Errorf("parseTimeField(%q) loc: got %v, want %s", c.in, loc, c.wantTZName)
		}
	}
}

func TestResolve_SourceField_BGL(t *testing.T) {
	// BGL supercomputer log: bgl_timestamp captures the event time
	// in a non-canonical format, alongside a unix epoch in
	// unix_timestamp. Picking bgl_timestamp via SourceField with
	// the matching Go layout must yield 2005-06-03 15:42:50.
	fields := map[string]string{
		"alert":          "-",
		"unix_timestamp": "1117838570",
		"date":           "2005.06.03",
		"bgl_timestamp":  "2005-06-03-15.42.50.675872",
		"component":      "RAS",
		"level":          "INFO",
		"message":        "instruction cache parity error corrected",
	}
	res := anchor2026()
	res.SourceField = "bgl_timestamp"
	res.YearStrategy = YearParsed
	r := New(res)
	got, conf := r.Resolve(fields)
	if got.Year() != 2005 || got.Month() != 6 || got.Day() != 3 ||
		got.Hour() != 15 || got.Minute() != 42 || got.Second() != 50 {
		t.Errorf("BGL bgl_timestamp: got %s, want 2005-06-03 15:42:50.x", got)
	}
	if conf != ConfidenceExact {
		t.Errorf("BGL bgl_timestamp confidence: got %s, want %s", conf, ConfidenceExact)
	}
}

func TestResolve_SourceField_UnixSeconds(t *testing.T) {
	// 10-digit epoch via unix_seconds hint — 1117838570 → 2005-06-03 17:22:50 UTC.
	fields := map[string]string{"unix_timestamp": "1117838570"}
	res := anchor2026()
	res.SourceField = "unix_timestamp"
	res.SourceFormat = "unix_seconds"
	res.YearStrategy = YearParsed
	r := New(res)
	got, conf := r.Resolve(fields)
	want := time.Unix(1117838570, 0).UTC()
	if !got.Equal(want) {
		t.Errorf("unix_seconds: got %s, want %s", got, want)
	}
	if conf != ConfidenceExact {
		t.Errorf("unix_seconds confidence: got %s, want %s", conf, ConfidenceExact)
	}
}

func TestSniff_BGL_AutoPicksField(t *testing.T) {
	// A whole sample of BGL lines — Sniff has no canonical
	// timestamp/time/hour; bgl_timestamp and unix_timestamp are
	// non-canonical candidates. With "timestamp" in both names, the
	// scorer's tie-breakers should still pick something parseable
	// and surface BOTH in the candidates list for the wizard.
	samples := []map[string]string{
		{
			"alert":          "-",
			"unix_timestamp": "1117838570",
			"date":           "2005.06.03",
			"bgl_timestamp":  "2005-06-03-15.42.50.675872",
		},
		{
			"alert":          "-",
			"unix_timestamp": "1117838573",
			"date":           "2005.06.03",
			"bgl_timestamp":  "2005-06-03-15.42.53.276129",
		},
	}
	inf := Sniff(samples, nil)

	if len(inf.FieldCandidates) < 2 {
		t.Fatalf("expected ≥2 candidates, got %d: %+v", len(inf.FieldCandidates), inf.FieldCandidates)
	}
	names := map[string]bool{}
	for _, c := range inf.FieldCandidates {
		names[c.Name] = true
	}
	if !names["bgl_timestamp"] || !names["unix_timestamp"] {
		t.Errorf("both bgl_timestamp and unix_timestamp must be candidates, got %v", names)
	}
	if inf.Resolution.SourceField == "" {
		t.Error("Sniff should auto-pick a SourceField when no canonical timestamp present")
	}
	if inf.Status == StatusMissing {
		t.Errorf("status: got %s, want non-missing once a candidate was picked", inf.Status)
	}
}

func TestExpandTwoDigitYear(t *testing.T) {
	// Anchor 2026 → yy=17 should be 2017, yy=99 should be 1999.
	r := New(anchor2026())
	if got := r.expandTwoDigitYear(17); got != 2017 {
		t.Errorf("yy=17: got %d, want 2017", got)
	}
	if got := r.expandTwoDigitYear(99); got != 1999 {
		t.Errorf("yy=99: got %d, want 1999 (anchor 2026 means future-century is implausible)", got)
	}
	if got := r.expandTwoDigitYear(26); got != 2026 {
		t.Errorf("yy=26: got %d, want 2026", got)
	}
}
