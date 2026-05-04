package timeresolve

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/araddon/dateparse"
)

// Resolver composes per-line wall-clock times from log2grok captures
// according to a Resolution config. One Resolver instance is built per
// ingest session (or per /parse call) and called sequentially. It is
// not safe for concurrent use — the rollover detection holds the
// previous timestamp as state.
type Resolver struct {
	res     Resolution
	prev    time.Time
	prevSet bool
}

// New constructs a Resolver with the given Resolution. When res.Anchor
// is zero, NewWithDefaults should be used instead.
func New(res Resolution) *Resolver {
	if res.ForceMode == "" {
		res.ForceMode = ForceModeFillMissing
	}
	if res.Anchor.Value.IsZero() {
		res.Anchor = Anchor{Kind: AnchorNow, Value: time.Now()}
	}
	return &Resolver{res: res}
}

// Resolution returns the (possibly defaulted) Resolution being used.
// Useful for echoing back what was applied.
func (r *Resolver) Resolution() Resolution {
	return r.res
}

// Resolve renders a single set of captures into a time.Time and a
// confidence label. It updates the resolver's internal "previous
// timestamp" so subsequent rollover detection and carry-forward work.
func (r *Resolver) Resolve(fields map[string]string) (time.Time, string) {
	t, conf := r.compose(fields)
	if r.res.Rollover && r.prevSet && !t.IsZero() {
		t = r.applyRollover(t)
	}
	if !t.IsZero() {
		r.prev = t
		r.prevSet = true
	}
	return t, conf
}

// Carry returns the previous resolved timestamp (or the anchor if
// nothing has been resolved yet). Used for unmatched-line fallback so
// failed lines land near their neighbours rather than at time.Now().
func (r *Resolver) Carry() time.Time {
	if r.prevSet {
		return r.prev
	}
	return r.res.Anchor.Value
}

func (r *Resolver) compose(fields map[string]string) (time.Time, string) {
	parts := extractParts(fields, r.res)

	if !parts.haveTime {
		if r.prevSet {
			return r.prev, ConfidenceCarried
		}
		return r.res.Anchor.Value, ConfidenceSynthetic
	}

	confidence := ConfidenceExact
	yearFromLine := parts.year != 0
	monthFromLine := parts.month != 0
	dayFromLine := parts.day != 0

	// yearInferredFromAnchor records whether the year came from the
	// anchor (or 2-digit expansion against it). When true, we apply a
	// future-clamp at the end so a Dec 10 line ingested in May doesn't
	// land in next December — the anchor is supposed to be an upper
	// bound on log content. Year derived from `prev` skips the clamp:
	// rollover detection owns monotonic progression for that case.
	yearInferredFromAnchor := false

	if !yearFromLine {
		switch {
		case r.res.YearStrategy == YearForced && r.res.ForcedYear != nil:
			parts.year = *r.res.ForcedYear
		case r.prevSet:
			parts.year = r.prev.Year()
		default:
			parts.year = r.anchorYear()
			yearInferredFromAnchor = true
		}
		confidence = ConfidenceInferred
	} else if parts.year < 100 {
		parts.year = r.expandTwoDigitYear(parts.year)
		confidence = ConfidenceInferred
		yearInferredFromAnchor = true
	}

	// Month / day: each filled independently so year-less syslog
	// (which has month + day from the line) keeps its parsed values.
	if !monthFromLine || !dayFromLine {
		fallback := r.res.Anchor.Value
		if r.prevSet {
			fallback = r.prev
		}
		if !monthFromLine {
			parts.month = int(fallback.Month())
		}
		if !dayFromLine {
			parts.day = fallback.Day()
		}
		confidence = ConfidenceInferred
	}

	parts = r.applyForceOverrides(parts, yearFromLine, monthFromLine, dayFromLine)

	loc := r.locationFor(parts)
	t := time.Date(
		parts.year, time.Month(parts.month), parts.day,
		parts.hour, parts.minute, parts.second, parts.nano, loc,
	)

	// Future-clamp: when the year was inferred (year-less syslog or
	// 2-digit year matching the anchor's year) the resolved time can
	// land past the anchor — e.g. ingesting "Dec 10 …" in May yields
	// 2026-12-10 which is implausible for a log file. Subtract a year
	// to put it on the most recent past occurrence. Small slack
	// avoids over-clamping for tz-offset jitter near the boundary.
	if yearInferredFromAnchor {
		const futureSlack = 1 * time.Hour
		if t.After(r.res.Anchor.Value.Add(futureSlack)) {
			t = t.AddDate(-1, 0, 0)
		}
	}
	return t, confidence
}

func (r *Resolver) anchorYear() int {
	if r.res.YearStrategy == YearForced && r.res.ForcedYear != nil {
		return *r.res.ForcedYear
	}
	return r.res.Anchor.Value.Year()
}

// expandTwoDigitYear maps yy → yyyy using the anchor as the upper
// reference point: the chosen century is the one whose result is ≤
// anchor.Year(). E.g., anchor=2026, yy=17 → 2017; yy=99 → 1999.
func (r *Resolver) expandTwoDigitYear(yy int) int {
	if r.res.YearStrategy == YearForced && r.res.ForcedYear != nil {
		return *r.res.ForcedYear
	}
	anchorYear := r.res.Anchor.Value.Year()
	century := (anchorYear / 100) * 100
	candidate := century + yy
	if candidate > anchorYear {
		candidate -= 100
	}
	return candidate
}

func (r *Resolver) applyForceOverrides(p parsedParts, yearFromLine, monthFromLine, dayFromLine bool) parsedParts {
	mode := r.res.ForceMode
	if mode == "" {
		mode = ForceModeFillMissing
	}
	apply := func(force *int, current int, fromLine bool) int {
		if force == nil {
			return current
		}
		if mode == ForceModeOverwrite || !fromLine {
			return *force
		}
		return current
	}
	p.year = apply(r.res.ForcedYear, p.year, yearFromLine)
	p.month = apply(r.res.ForcedMonth, p.month, monthFromLine)
	p.day = apply(r.res.ForcedDay, p.day, dayFromLine)
	return p
}

// locationFor picks the time zone for a composed timestamp. forced
// always wins; otherwise a tz captured from the line wins, then the
// anchor's location, then UTC.
func (r *Resolver) locationFor(p parsedParts) *time.Location {
	if r.res.Timezone.Kind == TimezoneForced && r.res.Timezone.Value != "" {
		if loc, err := time.LoadLocation(r.res.Timezone.Value); err == nil {
			return loc
		}
	}
	if p.location != nil {
		return p.location
	}
	if anc := r.res.Anchor.Value.Location(); anc != nil {
		return anc
	}
	return time.UTC
}

// applyRollover advances the date forward when the composed time goes
// backwards by more than 12 hours relative to the previous line. This
// handles year-less or date-less files that span a day or year
// boundary (Dec 31 → Jan 1, 23:59 → 00:00).
func (r *Resolver) applyRollover(t time.Time) time.Time {
	if t.After(r.prev) || t.Equal(r.prev) {
		return t
	}
	gap := r.prev.Sub(t)
	switch {
	case gap > 6*30*24*time.Hour:
		// Year-scale jump backwards — promote year by 1.
		return time.Date(t.Year()+1, t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), t.Location())
	case gap > 12*time.Hour:
		// Day-scale jump backwards — promote day by 1.
		return t.AddDate(0, 0, 1)
	}
	return t
}

// parsedParts holds the decomposed timestamp components extracted from
// a single line's captures. Zero-valued numeric fields mean "not
// present"; haveTime is the only state flag because the date side is
// recovered by checking which of year/month/day are non-zero.
type parsedParts struct {
	year, month, day           int
	hour, minute, second, nano int
	haveTime                   bool
	location                   *time.Location
}

// extractParts pulls timestamp components out of a captures map. It
// applies the canonical field-name contract documented in the package
// comment: timestamp / date / time / year / month / day / hour /
// minute / second / millis / nanos / tz.
//
// resolution may carry a SourceField/SourceFormat override that lets
// the caller name a non-canonical capture (e.g. "bgl_timestamp") as
// the timestamp source; this takes precedence over the canonical
// cascade.
func extractParts(fields map[string]string, resolution Resolution) parsedParts {
	var p parsedParts

	// Path 0: explicit SourceField override — use the named capture's
	// value, parsed via SourceFormat (or auto-detect when blank).
	if name := strings.TrimSpace(resolution.SourceField); name != "" {
		if raw := strings.TrimSpace(fields[name]); raw != "" {
			if t, _, ok := parseAsTimestamp(raw, resolution.SourceFormat); ok {
				p.year = t.Year()
				p.month = int(t.Month())
				p.day = t.Day()
				p.hour = t.Hour()
				p.minute = t.Minute()
				p.second = t.Second()
				p.nano = t.Nanosecond()
				p.location = t.Location()
				p.haveTime = true
				return p
			}
		}
	}

	// Path 1: full `timestamp` capture — let dateparse do the work,
	// then decompose so the caller can still apply Force* overrides.
	if ts := strings.TrimSpace(fields["timestamp"]); ts != "" {
		if t, err := dateparse.ParseAny(ts); err == nil {
			p.year = t.Year()
			p.month = int(t.Month())
			p.day = t.Day()
			p.hour = t.Hour()
			p.minute = t.Minute()
			p.second = t.Second()
			p.nano = t.Nanosecond()
			p.location = t.Location()
			p.haveTime = true
			return p
		}
	}

	// Path 2: composed components.
	if y, ok := atoiField(fields, "year"); ok {
		p.year = y
	}
	if m, ok := atoiField(fields, "month"); ok {
		p.month = m
	}
	if d, ok := atoiField(fields, "day"); ok {
		p.day = d
	}
	if dateStr := strings.TrimSpace(fields["date"]); dateStr != "" {
		if y, m, d, ok := parseDateField(dateStr); ok {
			if p.year == 0 {
				p.year = y
			}
			if p.month == 0 {
				p.month = m
			}
			if p.day == 0 {
				p.day = d
			}
		}
	}
	if timeStr := strings.TrimSpace(fields["time"]); timeStr != "" {
		if h, mi, s, ns, loc, ok := parseTimeField(timeStr); ok {
			p.hour = h
			p.minute = mi
			p.second = s
			p.nano = ns
			if loc != nil {
				p.location = loc
			}
			p.haveTime = true
		}
	} else {
		h, hOk := atoiField(fields, "hour")
		mi, miOk := atoiField(fields, "minute")
		s, sOk := atoiField(fields, "second")
		if hOk && miOk && sOk {
			p.hour = h
			p.minute = mi
			p.second = s
			p.haveTime = true
		}
		if ms, ok := atoiField(fields, "millis"); ok {
			p.nano = ms * int(time.Millisecond)
		}
		if ns, ok := atoiField(fields, "nanos"); ok {
			p.nano = ns
		}
	}

	if tz := strings.TrimSpace(fields["tz"]); tz != "" {
		if loc, err := parseTimezone(tz); err == nil {
			p.location = loc
		}
	}

	return p
}

func atoiField(fields map[string]string, key string) (int, bool) {
	v := strings.TrimSpace(fields[key])
	if v == "" {
		return 0, false
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, false
	}
	return n, true
}

// parseDateField handles the canonical shapes a `date` capture can
// take: yyyymmdd (HealthApp), yyyy-mm-dd, yyyy/mm/dd, yy/mm/dd. The
// caller is responsible for 2-digit-year expansion via the resolver.
func parseDateField(s string) (year, month, day int, ok bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return
	}

	if len(s) == 8 && allDigits(s) {
		y, _ := strconv.Atoi(s[:4])
		m, _ := strconv.Atoi(s[4:6])
		d, _ := strconv.Atoi(s[6:8])
		if y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31 {
			return y, m, d, true
		}
	}

	for _, sep := range []string{"-", "/", "."} {
		parts := strings.Split(s, sep)
		if len(parts) != 3 {
			continue
		}
		a, errA := strconv.Atoi(parts[0])
		b, errB := strconv.Atoi(parts[1])
		c, errC := strconv.Atoi(parts[2])
		if errA != nil || errB != nil || errC != nil {
			continue
		}
		// First part decides ordering: 4-digit or >= 1900 → year-first
		// (yyyy-mm-dd / yy-mm-dd). Otherwise assume year-first anyway
		// for log dates, which are overwhelmingly ISO-ordered.
		return a, b, c, true
	}

	if t, err := dateparse.ParseAny(s); err == nil {
		return t.Year(), int(t.Month()), t.Day(), true
	}
	return 0, 0, 0, false
}

// parseTimeField parses a HH:MM[:SS[.fff]] string, optionally
// suffixed with a timezone (Z or ±HHMM / ±HH:MM). Returns nano in
// nanoseconds, location when the string carries a tz suffix.
func parseTimeField(s string) (h, m, sec, nano int, loc *time.Location, ok bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return
	}

	// Strip trailing tz suffix.
	tzIdx := -1
	for i := len(s) - 1; i >= 0; i-- {
		c := s[i]
		if c == 'Z' || c == 'z' {
			tzIdx = i
			break
		}
		if (c == '+' || c == '-') && i > 0 {
			tzIdx = i
			break
		}
		if c == ':' || c == '.' || c == ',' || (c >= '0' && c <= '9') {
			continue
		}
		break
	}
	if tzIdx >= 0 {
		tzStr := s[tzIdx:]
		if l, err := parseTimezone(tzStr); err == nil {
			loc = l
			s = s[:tzIdx]
		}
	}

	fracStr := ""
	if idx := strings.IndexAny(s, ".,"); idx >= 0 {
		fracStr = s[idx+1:]
		s = s[:idx]
	}

	parts := strings.Split(s, ":")
	if len(parts) < 2 {
		return
	}
	var err error
	h, err = strconv.Atoi(parts[0])
	if err != nil {
		return
	}
	m, err = strconv.Atoi(parts[1])
	if err != nil {
		return
	}
	if len(parts) >= 3 {
		sec, err = strconv.Atoi(parts[2])
		if err != nil {
			return
		}
	}
	if fracStr != "" {
		digits := fracStr
		if len(digits) > 9 {
			digits = digits[:9]
		}
		for len(digits) < 9 {
			digits += "0"
		}
		n, err := strconv.Atoi(digits)
		if err == nil {
			nano = n
		}
	}
	ok = true
	return
}

func parseTimezone(tz string) (*time.Location, error) {
	tz = strings.TrimSpace(tz)
	if tz == "" || tz == "Z" || tz == "z" {
		return time.UTC, nil
	}
	if loc, err := time.LoadLocation(tz); err == nil {
		return loc, nil
	}
	sign := 1
	s := tz
	switch s[0] {
	case '-':
		sign = -1
		s = s[1:]
	case '+':
		s = s[1:]
	}
	s = strings.ReplaceAll(s, ":", "")
	switch len(s) {
	case 4:
		h, errH := strconv.Atoi(s[:2])
		m, errM := strconv.Atoi(s[2:4])
		if errH == nil && errM == nil {
			return time.FixedZone(tz, sign*(h*3600+m*60)), nil
		}
	case 2:
		h, errH := strconv.Atoi(s)
		if errH == nil {
			return time.FixedZone(tz, sign*h*3600), nil
		}
	}
	return nil, fmt.Errorf("unrecognized timezone %q", tz)
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
