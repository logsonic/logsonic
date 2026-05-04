package handlers

import (
	"fmt"
	"strconv"

	"logsonic/pkg/timeresolve"
	"logsonic/pkg/types"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"
)

// postProcess converts log2grok decoder output into the JSON shape
// the rest of logsonic (frontend, storage, search) expects. It owns:
//
//   - timestamp resolution via timeresolve.Resolver, which composes a
//     time.Time from the line captures (year/month/day/time/timestamp)
//     and applies user overrides (ForceStart*, ForceTimezone,
//     TimestampConfig).
//   - merging Meta fields into every record (success and failure alike).
//   - copying smart-decode aux fields straight from LineResult.Smart so
//     the wire shape stays identical to the previous in-house tokenizer
//     ("_ipv4_addr", "_email_addr", "_urls", "_mac_addr", "_uuids").
//   - synthesizing fallback timestamps for unmatched lines so the
//     downstream Bleve store always gets a sortable @timestamp value.
func postProcess(results []l2g.LineResult, opts types.IngestSessionOptions) (parsedLogs []map[string]interface{}, success, failed int, inference timeresolve.Inference) {
	parsedLogs = make([]map[string]interface{}, 0, len(results))

	resolution, inference := buildResolution(results, opts)
	resolver := timeresolve.New(resolution)

	for _, r := range results {
		if r.Matched {
			row := make(map[string]interface{}, len(r.Fields)+len(r.Smart)+5)
			for k, v := range r.Fields {
				row[k] = v
			}
			row["_raw"] = r.Raw
			row["_src"] = opts.Source

			for k, v := range opts.Meta {
				row[k] = v
			}

			ts, _ := resolver.Resolve(r.Fields)
			row["timestamp"] = ts

			for k, v := range r.Smart {
				row[k] = v
			}

			parsedLogs = append(parsedLogs, row)
			success++
			continue
		}

		errorMsg := r.Error
		if errorMsg == "" {
			if opts.Name != "" {
				errorMsg = fmt.Sprintf("Log line did not match the '%s' pattern", opts.Name)
			} else {
				errorMsg = "Log line did not match any configured pattern"
			}
		}
		row := map[string]interface{}{
			"error":     errorMsg,
			"_raw":      r.Raw,
			"message":   r.Raw,
			"timestamp": resolver.Carry(),
		}
		for k, v := range opts.Meta {
			row[k] = v
		}
		parsedLogs = append(parsedLogs, row)
		failed++
	}

	// The inference returned to /parse should preview the actual
	// resolution used, including any overrides. Build a fresh preview
	// that reflects what the wire payload contains.
	inference.Preview = buildPreviewFromResults(results, resolution)
	return parsedLogs, success, failed, inference
}

// buildResolution sniffs the sample to derive defaults, then layers
// user-provided overrides on top: the new TimestampConfig wins,
// otherwise legacy ForceStart* fields are translated to a partial
// override.
func buildResolution(results []l2g.LineResult, opts types.IngestSessionOptions) (timeresolve.Resolution, timeresolve.Inference) {
	samples := make([]map[string]string, 0, len(results))
	for _, r := range results {
		if r.Matched {
			samples = append(samples, r.Fields)
		}
	}
	inf := timeresolve.Sniff(samples, opts.SourceMTime)

	res := inf.Resolution
	if opts.TimestampConfig != nil {
		res = mergeResolution(res, *opts.TimestampConfig)
	} else {
		res = applyLegacyOverrides(res, opts)
	}
	inf.Resolution = res
	return res, inf
}

// applyLegacyOverrides translates the pre-existing ForceStart*
// session options into a Resolution. Legacy semantics were
// "overwrite" (the override stomps any parsed value), so we honour
// that by switching ForceMode.
func applyLegacyOverrides(res timeresolve.Resolution, opts types.IngestSessionOptions) timeresolve.Resolution {
	anyForce := false
	if v := opts.ForceStartYear; v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			res.ForcedYear = &n
			res.YearStrategy = timeresolve.YearForced
			anyForce = true
		}
	}
	if v := opts.ForceStartMonth; v != "" && v != "auto" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 12 {
			res.ForcedMonth = &n
			anyForce = true
		}
	}
	if v := opts.ForceStartDay; v != "" && v != "auto" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 31 {
			res.ForcedDay = &n
			anyForce = true
		}
	}
	if v := opts.ForceTimezone; v != "" && v != "auto" {
		res.Timezone = timeresolve.TimezoneCfg{Kind: timeresolve.TimezoneForced, Value: v}
		anyForce = true
	}
	if anyForce {
		res.ForceMode = timeresolve.ForceModeOverwrite
	}
	return res
}

// mergeResolution overlays a user-provided override onto a base
// (sniffed) Resolution. Empty/zero fields in the override are ignored
// so the wizard can send a partial config.
func mergeResolution(base, over timeresolve.Resolution) timeresolve.Resolution {
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
	// SourceField / SourceFormat: pulled together so an Auto-detect
	// reset (both blank in the override) clears any prior pick.
	if over.SourceField != "" || over.SourceFormat != "" {
		base.SourceField = over.SourceField
		base.SourceFormat = over.SourceFormat
	}
	// Rollover: honour any explicit user choice.
	base.Rollover = over.Rollover
	return base
}

func buildPreviewFromResults(results []l2g.LineResult, res timeresolve.Resolution) []timeresolve.PreviewRow {
	// Match the frontend's preview page size so every visible row in
	// the fused log-preview/timestamp UI has a resolved timestamp.
	const maxRows = 20
	if len(results) == 0 {
		return nil
	}
	r := timeresolve.New(res)
	out := make([]timeresolve.PreviewRow, 0, maxRows)
	for _, lr := range results {
		if !lr.Matched {
			continue
		}
		ts, conf := r.Resolve(lr.Fields)
		captured := map[string]string{}
		for _, k := range []string{"timestamp", "date", "time", "year", "month", "day", "hour", "minute", "second", "millis", "nanos", "tz"} {
			if v, ok := lr.Fields[k]; ok && v != "" {
				captured[k] = v
			}
		}
		out = append(out, timeresolve.PreviewRow{
			Raw:        lr.Raw,
			Captured:   captured,
			Resolved:   ts.Format("2006-01-02T15:04:05.000Z07:00"),
			Confidence: conf,
		})
		if len(out) >= maxRows {
			break
		}
	}
	return out
}
