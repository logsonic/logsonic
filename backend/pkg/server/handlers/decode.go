package handlers

import (
	"fmt"
	"strconv"
	"time"

	"logsonic/pkg/types"

	"github.com/araddon/dateparse"
	l2g "github.com/logsonic/log2grok/pkg/log2grok"
)

// postProcess converts log2grok decoder output into the JSON shape that
// the rest of logsonic (frontend, storage, search) expects. It owns:
//
//   - timestamp parsing via dateparse plus the ForceTimezone /
//     ForceStartYear/Month/Day overrides expressed in
//     IngestSessionOptions.
//   - merging Meta fields into every record (success and failure alike).
//   - copying smart-decode aux fields straight from LineResult.Smart so
//     the wire shape stays identical to the previous in-house tokenizer
//     ("_ipv4_addr", "_email_addr", "_urls", "_mac_addr", "_uuids").
//   - synthesizing fallback timestamps for unmatched lines so the
//     downstream Bleve store always gets a sortable @timestamp value.
//
// It deliberately keeps the on-the-wire field set byte-identical to
// what tokenizer.ParseLogs produced so the React frontend and Playwright
// e2e suite need no changes.
func postProcess(results []l2g.LineResult, opts types.IngestSessionOptions) (parsedLogs []map[string]interface{}, success, failed int) {
	parsedLogs = make([]map[string]interface{}, 0, len(results))
	lastTimestamp := time.Now()
	lastTimeDelta := 0

	for _, r := range results {
		if r.Matched {
			row := make(map[string]interface{}, len(r.Fields)+len(r.Smart)+4)
			for k, v := range r.Fields {
				row[k] = v
			}
			row["_raw"] = r.Raw
			row["_src"] = opts.Source

			for k, v := range opts.Meta {
				row[k] = v
			}

			// Timestamp: prefer the named "timestamp" capture; fall back
			// to time.Now() so storage indexing always has a value.
			if tsStr, ok := r.Fields["timestamp"]; ok && tsStr != "" {
				ts := updateTimestamp(tsStr, opts)
				row["timestamp"] = ts
				lastTimeDelta = int(ts.Sub(lastTimestamp).Milliseconds())
				lastTimestamp = ts
			} else {
				row["timestamp"] = time.Now()
			}

			for k, v := range r.Smart {
				row[k] = v
			}

			parsedLogs = append(parsedLogs, row)
			success++
			continue
		}

		// Failure path mirrors the legacy tokenizer: keep _raw + message
		// + a synthesized timestamp so search & sort still work.
		errorMsg := r.Error
		if errorMsg == "" {
			if opts.Name != "" {
				errorMsg = fmt.Sprintf("Log line did not match the '%s' pattern", opts.Name)
			} else {
				errorMsg = "Log line did not match any configured pattern"
			}
		}
		approx := lastTimestamp.Add(time.Duration(lastTimeDelta) * time.Millisecond)
		row := map[string]interface{}{
			"error":     errorMsg,
			"_raw":      r.Raw,
			"message":   r.Raw,
			"timestamp": approx,
		}
		lastTimestamp = approx
		for k, v := range opts.Meta {
			row[k] = v
		}
		parsedLogs = append(parsedLogs, row)
		failed++
	}

	return parsedLogs, success, failed
}

// updateTimestamp resolves a timestamp captured from the log line into
// a wall-clock time.Time. It applies the optional Force* overrides from
// IngestSessionOptions (year/month/day/timezone) so users can backfill
// logs that lack a year or that arrived in the wrong tz. Falls back to
// time.Now() if every parser path fails — the caller always receives a
// usable time. Logic is copied verbatim from the previous in-tree
// tokenizer to preserve byte-identical behaviour.
func updateTimestamp(timestamp string, options types.IngestSessionOptions) time.Time {
	if timestamp == "" {
		return time.Now()
	}

	parsedTime, err := dateparse.ParseAny(timestamp)
	if err != nil {
		// dateparse can't handle Android logcat timestamps like
		// "03-17 16:16:08.538"; try that explicit layout next and
		// stamp on the current year, since the format omits it.
		androidLayout := "01-02 15:04:05.000"
		androidTime, androidErr := time.Parse(androidLayout, timestamp)
		if androidErr == nil {
			parsedTime = time.Date(
				time.Now().Year(),
				androidTime.Month(),
				androidTime.Day(),
				androidTime.Hour(),
				androidTime.Minute(),
				androidTime.Second(),
				androidTime.Nanosecond(),
				androidTime.Location(),
			)
		} else {
			return time.Now()
		}
	}

	// dateparse leaves Year() = 0 for formats that omit the year
	// (e.g. syslog "Jan 02 15:04:05"). Promote to current year, then
	// rewind one if the result is in the future.
	if parsedTime.Year() == 0 {
		parsedTime = parsedTime.AddDate(time.Now().Year(), 0, 0)
		if parsedTime.After(time.Now()) {
			parsedTime = parsedTime.AddDate(-1, 0, 0)
		}
	}

	if options.ForceStartYear != "" {
		if year, err := strconv.Atoi(options.ForceStartYear); err == nil {
			parsedTime = time.Date(year, parsedTime.Month(), parsedTime.Day(),
				parsedTime.Hour(), parsedTime.Minute(), parsedTime.Second(),
				parsedTime.Nanosecond(), parsedTime.Location())
		}
	}
	if options.ForceStartMonth != "" {
		if month, err := strconv.Atoi(options.ForceStartMonth); err == nil && month >= 1 && month <= 12 {
			parsedTime = time.Date(parsedTime.Year(), time.Month(month), parsedTime.Day(),
				parsedTime.Hour(), parsedTime.Minute(), parsedTime.Second(),
				parsedTime.Nanosecond(), parsedTime.Location())
		}
	}
	if options.ForceStartDay != "" {
		if day, err := strconv.Atoi(options.ForceStartDay); err == nil && day >= 1 && day <= 31 {
			parsedTime = time.Date(parsedTime.Year(), parsedTime.Month(), day,
				parsedTime.Hour(), parsedTime.Minute(), parsedTime.Second(),
				parsedTime.Nanosecond(), parsedTime.Location())
		}
	}
	if options.ForceTimezone != "" {
		if loc, err := time.LoadLocation(options.ForceTimezone); err == nil {
			parsedTime = parsedTime.In(loc)
		}
	}

	return parsedTime
}
