package timeresolve

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/araddon/dateparse"
)

// Sniff inspects a sample of decoded captures and returns layout +
// default Resolution. fileMTime is optional; pass nil when the ingest
// path doesn't have a source mtime.
//
// Sniff does not produce preview rows — call Analyze for that, or
// invoke a Resolver against the same sample after Sniff.
func Sniff(samples []map[string]string, fileMTime *time.Time) Inference {
	var inf Inference

	seen := map[string]bool{}
	yearWidth := 0
	var firstFullTS time.Time
	firstFullSet := false

	// nonCanonical accumulates the first observed sample value for
	// every non-canonical capture, so we can score them as potential
	// timestamp sources after the canonical scan.
	nonCanonical := map[string]string{}

	for _, fields := range samples {
		for k, v := range fields {
			v = strings.TrimSpace(v)
			if v == "" {
				continue
			}
			if !isTimeKey(k) {
				if _, ok := nonCanonical[k]; !ok {
					nonCanonical[k] = v
				}
				continue
			}
			seen[k] = true
			switch k {
			case "year":
				if w := len(v); w > yearWidth {
					yearWidth = w
				}
			case "date":
				if w := dateYearWidth(v); w > yearWidth {
					yearWidth = w
				}
			case "timestamp":
				if t, err := dateparse.ParseAny(v); err == nil {
					if t.Year() != 0 {
						if yearWidth < 4 {
							yearWidth = 4
						}
						if !firstFullSet {
							firstFullTS = t
							firstFullSet = true
						}
					}
				}
			}
		}
	}

	// Score every non-canonical capture as a potential timestamp source.
	// The wizard surfaces this list so the user can override auto-pick
	// when, e.g., bgl_timestamp is the right source instead of the unix
	// epoch sitting next to it.
	candidates := buildFieldCandidates(nonCanonical)
	inf.FieldCandidates = candidates

	inf.Layout = Layout{
		HasTimestampField:   seen["timestamp"],
		ComponentsPresent:   sortedKeys(seen),
		YearWidth:           yearWidth,
		InferredFormatLabel: formatLabel(seen, yearWidth),
	}

	res := Resolution{
		ForceMode: ForceModeFillMissing,
		Timezone:  TimezoneCfg{Kind: TimezoneAsParsed},
	}
	switch {
	case fileMTime != nil:
		res.Anchor = Anchor{Kind: AnchorFileMTime, Value: *fileMTime}
	case firstFullSet:
		res.Anchor = Anchor{Kind: AnchorFirstParsed, Value: firstFullTS}
	default:
		res.Anchor = Anchor{Kind: AnchorNow, Value: time.Now()}
	}
	switch {
	case yearWidth >= 4:
		res.YearStrategy = YearParsed
	case yearWidth == 2:
		res.YearStrategy = YearInferredCentury
	default:
		res.YearStrategy = YearFromAnchor
	}
	// Rollover only matters when the year or date is not pinned per
	// line. A 4-digit timestamp on every line never needs rollover.
	res.Rollover = !(yearWidth >= 4 && (seen["timestamp"] || seen["date"]))

	inf.Resolution = res

	hasAnyTime := seen["timestamp"] || seen["time"] || seen["hour"]

	// Auto-pick a SourceField from non-canonical candidates when no
	// canonical capture covers the timestamp. The user can override
	// later via the wizard's source-field dropdown.
	if !hasAnyTime && len(candidates) > 0 && candidates[0].Parses {
		best := candidates[0]
		res.SourceField = best.Name
		// Carry the detected format so the resolver doesn't have to
		// re-detect per line.
		if best.Format != "" && best.Format != "auto" {
			res.SourceFormat = best.Format
		}
		// Promote the layout / anchor as if the source was canonical,
		// so chip + warnings reflect the chosen field's quality.
		if pt, _, ok := parseAsTimestamp(best.Sample, best.Format); ok && pt.Year() != 0 {
			yearWidth = 4
			if !firstFullSet {
				firstFullTS = pt
				firstFullSet = true
				if res.Anchor.Kind == AnchorNow {
					res.Anchor = Anchor{Kind: AnchorFirstParsed, Value: pt}
				}
			}
			res.YearStrategy = YearParsed
		}
		hasAnyTime = true
		// Reflect the picked field in the layout summary.
		inf.Layout.HasTimestampField = true
		inf.Layout.ComponentsPresent = append(inf.Layout.ComponentsPresent, best.Name+"*")
		inf.Layout.InferredFormatLabel = best.Name + " → " + best.Format
		if best.Format == "auto" {
			inf.Layout.InferredFormatLabel = best.Name
		}
	}

	inf.Resolution = res

	switch {
	case !hasAnyTime:
		inf.Status = StatusMissing
		// When there are non-canonical candidates, gently nudge the
		// user toward the picker rather than just declaring "missing".
		if len(candidates) > 0 {
			inf.Warnings = append(inf.Warnings, "No standard timestamp captures detected. Pick a source field below if your log carries the time in a custom field.")
		} else {
			inf.Warnings = append(inf.Warnings, "No timestamp captures detected — every line will be stamped at the import time unless an anchor is set.")
		}
	case res.SourceField != "":
		inf.Status = StatusInferred
		inf.Warnings = append(inf.Warnings, fmt.Sprintf("Auto-picked %q as the timestamp field. Switch to another field below if a different capture better represents the event time.", res.SourceField))
	case yearWidth >= 4:
		inf.Status = StatusExact
	case yearWidth == 2:
		inf.Status = StatusInferred
		inf.Warnings = append(inf.Warnings, fmt.Sprintf("Two-digit year detected — expanding using the %s anchor (%s).", res.Anchor.Kind, res.Anchor.Value.Format("2006-01-02")))
	default:
		inf.Status = StatusInferred
		inf.Warnings = append(inf.Warnings, fmt.Sprintf("Year not captured — borrowing %d from the %s anchor.", res.Anchor.Value.Year(), res.Anchor.Kind))
	}

	return inf
}

// buildFieldCandidates inspects every non-canonical capture and
// returns a list ranked by parseability + name signals. The first
// element is the auto-pick when no canonical timestamp/date/time is
// available. Even non-parsing fields are returned (with Parses=false)
// so the wizard can render them as disabled options or "needs format".
func buildFieldCandidates(nonCanonical map[string]string) []FieldCandidate {
	if len(nonCanonical) == 0 {
		return nil
	}
	out := make([]FieldCandidate, 0, len(nonCanonical))
	for name, sample := range nonCanonical {
		c := FieldCandidate{Name: name, Sample: sample}
		if t, fmtHint, ok := parseAsTimestamp(sample, ""); ok {
			c.Parses = true
			c.Parsed = t.Format(time.RFC3339Nano)
			c.Format = fmtHint
			c.Score = scoreCandidate(name, t, true)
		}
		out = append(out, c)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		// Break ties by name for stable output.
		return out[i].Name < out[j].Name
	})
	return out
}

// Analyze runs Sniff and then builds a small preview by resolving the
// first few sample lines with a fresh Resolver. previewRaws is
// supplied separately because the captures map alone doesn't carry the
// raw line text.
//
// The returned Inference is suitable for direct embedding in a
// ParseResponse.
func Analyze(samples []map[string]string, previewRaws []string, fileMTime *time.Time, override *Resolution) Inference {
	inf := Sniff(samples, fileMTime)
	if override != nil {
		inf.Resolution = mergeResolution(inf.Resolution, *override)
	}
	inf.Preview = buildPreview(samples, previewRaws, inf.Resolution)
	return inf
}

func buildPreview(samples []map[string]string, raws []string, res Resolution) []PreviewRow {
	const maxRows = 20
	if len(samples) == 0 {
		return nil
	}
	r := New(res)
	out := make([]PreviewRow, 0, maxRows)
	for i := 0; i < len(samples) && len(out) < maxRows; i++ {
		t, conf := r.Resolve(samples[i])
		raw := ""
		if i < len(raws) {
			raw = raws[i]
		}
		out = append(out, PreviewRow{
			Raw:        raw,
			Captured:   subsetTimeFields(samples[i]),
			Resolved:   t.Format(time.RFC3339Nano),
			Confidence: conf,
		})
	}
	return out
}

// mergeResolution overlays user-provided overrides on top of the
// sniffed defaults. Zero/empty fields in the override are ignored so
// the wizard can send a partial Resolution.
func mergeResolution(base, over Resolution) Resolution {
	if over.Anchor.Kind != "" {
		base.Anchor = over.Anchor
	}
	if over.YearStrategy != "" {
		base.YearStrategy = over.YearStrategy
	}
	if over.ForcedYear != nil {
		base.ForcedYear = over.ForcedYear
	}
	if over.ForcedMonth != nil {
		base.ForcedMonth = over.ForcedMonth
	}
	if over.ForcedDay != nil {
		base.ForcedDay = over.ForcedDay
	}
	if over.Timezone.Kind != "" {
		base.Timezone = over.Timezone
	}
	if over.ForceMode != "" {
		base.ForceMode = over.ForceMode
	}
	// SourceField / SourceFormat: an explicit empty override means
	// "unset" (the user re-selected Auto-detect after picking a
	// non-canonical field). Honour empty as authoritative when the
	// override carries any source_field intent in the same patch —
	// otherwise leave the base alone.
	if over.SourceField != "" || over.SourceFormat != "" {
		base.SourceField = over.SourceField
		base.SourceFormat = over.SourceFormat
	}
	// Rollover: zero value (false) is meaningful — only override when
	// the user explicitly asked. We can't distinguish "unset false"
	// from "explicit false" with a bool, so the wizard sends a
	// separate marker; for now treat the override field as
	// authoritative when its other fields indicate intent.
	base.Rollover = over.Rollover || base.Rollover
	return base
}

func subsetTimeFields(fields map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range fields {
		if isTimeKey(k) {
			out[k] = v
		}
	}
	return out
}

func isTimeKey(k string) bool {
	switch k {
	case "timestamp", "date", "time", "year", "month", "day",
		"hour", "minute", "second", "millis", "nanos", "tz":
		return true
	}
	return false
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// dateYearWidth returns 4 if the date capture has a 4-digit year (the
// common case), 2 if it's 2-digit, 0 if undeterminable. Mirrors
// parseDateField but only inspects the year portion.
func dateYearWidth(s string) int {
	s = strings.TrimSpace(s)
	if len(s) == 8 && allDigits(s) {
		return 4
	}
	for _, sep := range []string{"-", "/", "."} {
		parts := strings.Split(s, sep)
		if len(parts) == 3 && allDigits(parts[0]) {
			return len(parts[0])
		}
	}
	return 0
}

// formatLabel renders a human-readable description of the layout for
// the UI ("yy/MM/dd HH:mm:ss", "yyyymmdd HH:mm:ss.SSS", etc).
func formatLabel(seen map[string]bool, yearWidth int) string {
	if seen["timestamp"] {
		return "full timestamp string"
	}
	parts := []string{}
	switch yearWidth {
	case 4:
		parts = append(parts, "yyyy")
	case 2:
		parts = append(parts, "yy")
	default:
		if seen["year"] {
			parts = append(parts, "yy?")
		}
	}
	if seen["month"] {
		parts = append(parts, "MM")
	}
	if seen["day"] {
		parts = append(parts, "dd")
	}
	if seen["date"] {
		parts = []string{"date"}
	}
	if seen["time"] {
		parts = append(parts, "HH:mm:ss")
	} else if seen["hour"] {
		parts = append(parts, "HH:mm:ss")
	}
	if seen["millis"] {
		parts[len(parts)-1] = parts[len(parts)-1] + ".SSS"
	}
	if seen["tz"] {
		parts = append(parts, "Z")
	}
	if len(parts) == 0 {
		return "(no timestamp captures)"
	}
	return strings.Join(parts, " ")
}
