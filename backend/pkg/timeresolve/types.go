// Package timeresolve composes a wall-clock time.Time from the field
// captures emitted by log2grok. It owns the rules that used to live in
// handlers.updateTimestamp: 2-digit-year expansion, year-less syslog
// promotion, day/year rollover detection, and the Force* overrides.
//
// The package separates two concerns:
//
//   - Inference: read-only metadata derived from a sample of decoded
//     lines (which components are present, year width, default
//     Resolution, preview rows). Surfaced to the UI so the user can see
//     what was deduced.
//   - Resolution: the user-facing config that actually drives per-line
//     resolution. Defaults come from Sniff(); the wizard lets the user
//     override any field before ingest.
package timeresolve

import "time"

// Status classifies the confidence of the inferred resolution as a
// whole. Drives the UI chip color and whether the timestamp panel
// auto-expands in step 3 of the import wizard.
const (
	StatusExact     = "exact"     // year-qualified timestamp captured per line
	StatusInferred  = "inferred"  // year/century/tz inferred from anchor
	StatusAmbiguous = "ambiguous" // multiple plausible interpretations
	StatusMissing   = "missing"   // no time captures at all
)

// Confidence classifies a single resolved row.
const (
	ConfidenceExact     = "exact"     // composed from year-qualified line fields
	ConfidenceInferred  = "inferred"  // composed using sniffed defaults (year, century)
	ConfidenceCarried   = "carried"   // value carried forward from previous row
	ConfidenceSynthetic = "synthetic" // last-resort fallback (anchor or now)
)

// AnchorKind names the source of the absolute date/year used to fill
// missing components. file_mtime is preferred when the ingest path can
// supply it; first_parsed uses the earliest year-qualified timestamp in
// the sample; custom is a user-provided RFC3339; now is the wall clock
// at ingest time (last resort).
const (
	AnchorFileMTime   = "file_mtime"
	AnchorFirstParsed = "first_parsed"
	AnchorCustom      = "custom"
	AnchorNow         = "now"
)

// YearStrategy decides where the year comes from when the line itself
// doesn't have a 4-digit year.
const (
	YearParsed          = "parsed"           // line has 4-digit year — use it
	YearInferredCentury = "inferred_century" // line has 2-digit year — expand vs anchor
	YearForced          = "forced"           // user pinned a specific year
	YearFromAnchor      = "from_anchor"      // line has no year — borrow from anchor
)

// TimezoneKind controls how the timezone is applied. as_parsed uses
// whatever the line carries (tz field or offset in timestamp string),
// falling back to UTC. forced overrides every line.
const (
	TimezoneAsParsed = "as_parsed"
	TimezoneForced   = "forced"
)

// ForceMode controls Force{Year,Month,Day} semantics. fill_missing
// (new default) only sets the component when the line didn't carry it.
// overwrite preserves the legacy behaviour where the override stomps
// any parsed value.
const (
	ForceModeFillMissing = "fill_missing"
	ForceModeOverwrite   = "overwrite"
)

// Anchor is the absolute reference point used to fill missing
// components. Value is always populated when Kind is set; the Kind
// field is informational and surfaces back to the UI.
type Anchor struct {
	Kind  string    `json:"kind"`
	Value time.Time `json:"value"`
}

// TimezoneCfg controls source-side timezone interpretation.
type TimezoneCfg struct {
	Kind  string `json:"kind"`
	Value string `json:"value,omitempty"` // IANA zone name when Kind=forced
}

// Resolution is the full per-session configuration used by Resolver.
// Sniff() returns sensible defaults; the user can override any field
// via the wizard. Carries through to the backend as part of
// IngestSessionOptions.TimestampConfig.
type Resolution struct {
	Anchor       Anchor      `json:"anchor"`
	YearStrategy string      `json:"year_strategy"`
	ForcedYear   *int        `json:"forced_year,omitempty"`
	ForcedMonth  *int        `json:"forced_month,omitempty"`
	ForcedDay    *int        `json:"forced_day,omitempty"`
	Timezone     TimezoneCfg `json:"timezone"`
	Rollover     bool        `json:"rollover"`
	ForceMode    string      `json:"force_mode"`
	// SourceField names a non-canonical capture to use as the line's
	// timestamp string. When set, the resolver reads fields[SourceField]
	// instead of probing the canonical names (timestamp/date/time/...).
	// Empty means "use canonical scan" (the legacy default).
	SourceField string `json:"source_field,omitempty"`
	// SourceFormat hints how to parse SourceField's value. Empty means
	// auto-detect via dateparse + unix-epoch length heuristics. Special
	// values: "unix_seconds" / "unix_millis" / "unix_nanos". Anything
	// else is treated as a Go time layout (e.g. "2006-01-02-15.04.05.000000"
	// for the BGL supercomputer format).
	SourceFormat string `json:"source_format,omitempty"`
}

// FieldCandidate describes one capture that could plausibly serve as
// the timestamp source. Surfaced in Inference so the wizard can offer
// every field as a pick, with a hint about whether it parses cleanly.
type FieldCandidate struct {
	Name   string `json:"name"`             // capture name
	Sample string `json:"sample"`           // first observed value
	Parses bool   `json:"parses"`           // could be parsed as a timestamp
	Parsed string `json:"parsed,omitempty"` // RFC3339 result when Parses
	Format string `json:"format,omitempty"` // detected format hint (auto / unix_seconds / Go layout)
	Score  int    `json:"score,omitempty"`  // ranking used for auto-pick (higher = better)
}

// Layout is the read-only summary of which captures were observed in
// the sample. Surfaced to the UI for the "Detected: yy/MM/dd HH:mm:ss"
// label.
type Layout struct {
	HasTimestampField   bool     `json:"has_timestamp_field"`
	ComponentsPresent   []string `json:"components_present"`
	YearWidth           int      `json:"year_width"` // 0=year-less, 2, or 4
	InferredFormatLabel string   `json:"inferred_format_label"`
}

// PreviewRow shows a single sampled line and how the resolver renders
// it. Frontend renders captured side-by-side with resolved so the user
// can spot misinterpretations.
type PreviewRow struct {
	Raw        string            `json:"raw"`
	Captured   map[string]string `json:"captured"`
	Resolved   string            `json:"resolved"`
	Confidence string            `json:"confidence"`
}

// Inference is the full payload returned by Sniff(). Embedded into
// ParseResponse so the wizard can render the diagnostic chip and the
// preview without an extra round-trip.
type Inference struct {
	Status          string           `json:"status"`
	Layout          Layout           `json:"layout"`
	Resolution      Resolution       `json:"resolution"`
	Preview         []PreviewRow     `json:"preview"`
	Warnings        []string         `json:"warnings,omitempty"`
	FieldCandidates []FieldCandidate `json:"field_candidates,omitempty"`
}
