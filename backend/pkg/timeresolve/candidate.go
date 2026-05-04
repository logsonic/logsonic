package timeresolve

import (
	"strconv"
	"strings"
	"time"

	"github.com/araddon/dateparse"
)

// commonLayouts are non-RFC3339 layouts the resolver can fall back to
// after dateparse.ParseAny fails. Order matters — the first match
// wins. Add new shapes here when a real-world log format trips up the
// auto-detect.
var commonLayouts = []string{
	"2006-01-02-15.04.05.000000",   // BGL supercomputer
	"2006-01-02-15.04.05",          // BGL truncated
	"2006/01/02 15:04:05.000000",
	"2006/01/02 15:04:05",
	"2006.01.02 15:04:05",
	"01/02/2006 15:04:05",
	"02/Jan/2006:15:04:05 -0700",   // HTTPDATE without surrounding brackets
}

// parseAsTimestamp attempts to interpret a captured value as a
// timestamp. Returns the parsed time, the format hint that worked
// ("auto" for dateparse, "unix_seconds" / "unix_millis" / "unix_nanos"
// for epoch ints, or the Go layout that matched), and ok=true on
// success.
//
// hint, when non-empty, forces the parsing path: special values for
// unix epochs or any Go layout. Empty hint runs the auto cascade.
func parseAsTimestamp(value, hint string) (time.Time, string, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, "", false
	}

	switch hint {
	case "":
		// auto cascade — fall through
	case "unix_seconds", "unix_millis", "unix_nanos":
		t, ok := parseUnix(value, hint)
		return t, hint, ok
	default:
		// Treat as a Go layout.
		if t, err := time.Parse(hint, value); err == nil {
			return t, hint, true
		}
		return time.Time{}, "", false
	}

	// Auto cascade: dateparse → unix-by-length → common layouts.
	if t, err := dateparse.ParseAny(value); err == nil {
		// dateparse returns Year()=0 for year-less syslog timestamps.
		// Treat that as a successful parse but mark it via the "auto"
		// hint; the caller still benefits from extracting month/day/time.
		return t, "auto", true
	}

	if hint, ok := unixHintForDigitsOnly(value); ok {
		if t, ok := parseUnix(value, hint); ok {
			return t, hint, true
		}
	}

	for _, layout := range commonLayouts {
		if t, err := time.Parse(layout, value); err == nil {
			return t, layout, true
		}
	}

	return time.Time{}, "", false
}

// unixHintForDigitsOnly returns the appropriate epoch-precision hint
// for an all-digits string, based on length:
//
//	10 digits → seconds       (range 2001-09 … 2286-11)
//	13 digits → milliseconds
//	16 digits → microseconds  (treated as nanoseconds for parsing)
//	19 digits → nanoseconds
//
// Anything else is rejected — log files don't carry 4-digit "epochs".
func unixHintForDigitsOnly(s string) (string, bool) {
	for _, r := range s {
		if r < '0' || r > '9' {
			return "", false
		}
	}
	switch len(s) {
	case 10:
		return "unix_seconds", true
	case 13:
		return "unix_millis", true
	case 16, 19:
		return "unix_nanos", true
	}
	return "", false
}

func parseUnix(value, kind string) (time.Time, bool) {
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return time.Time{}, false
	}
	switch kind {
	case "unix_seconds":
		return time.Unix(n, 0).UTC(), true
	case "unix_millis":
		return time.UnixMilli(n).UTC(), true
	case "unix_nanos":
		// 16-digit values are microseconds; pad to nanoseconds.
		if len(value) == 16 {
			n *= 1000
		}
		return time.Unix(0, n).UTC(), true
	}
	return time.Time{}, false
}

// scoreCandidate ranks a capture's likelihood of being the timestamp
// source. Higher is better. Used by Sniff to pick a default
// SourceField when no canonical capture is present.
//
// Heuristics:
//   - Name signals: "timestamp", "_at", "_ts", "time", "date" → big boost.
//   - Parses-with-year: parsed time has a non-zero year (rules out
//     year-less syslog matches that decode to 0001-01-...).
//   - Has fractional seconds: tie-breaker preferring high-precision.
//
// scoreCandidate intentionally does NOT prefer canonical-named fields;
// the canonical scan handles those before we ever score candidates.
func scoreCandidate(name string, parsed time.Time, parses bool) int {
	if !parses {
		return 0
	}
	score := 1
	lower := strings.ToLower(name)
	switch {
	case strings.Contains(lower, "timestamp"), strings.HasSuffix(lower, "_ts"), strings.HasSuffix(lower, "_at"):
		score += 10
	case lower == "time", lower == "date", strings.HasSuffix(lower, "_time"), strings.HasSuffix(lower, "_date"):
		score += 5
	}
	if parsed.Year() != 0 {
		score += 5
	}
	if parsed.Nanosecond() != 0 {
		score++
	}
	return score
}
