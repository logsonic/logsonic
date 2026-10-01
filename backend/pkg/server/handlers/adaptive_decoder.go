package handlers

import (
	"crypto/sha256"
	"maps"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"
)

const (
	adaptiveMaxPatterns   = 16
	adaptiveSampleLines   = 200
	adaptiveSampleBytes   = 64 << 10
	adaptiveMaxSampleLine = 16 << 10
	adaptiveMaxRejected   = 256
	adaptiveRetryAfter    = time.Minute
)

type adaptivePattern struct {
	id      uint64 // monotonic; lets a decode tell which parsers were learned after its snapshot
	spec    l2g.PatternSpec
	decoder *l2g.Decoder
}

// adaptiveDecoder owns discovery and a bounded set of compiled parsers for
// one ingest stream. The mutex protects discovery, cache updates, and reads
// of the primary spec; no process-wide session lock is held during inference.
// Cached parsers are goroutine-safe and are applied outside the mutex, so
// concurrent chunks decode in parallel and only discovery is serialized.
type adaptiveDecoder struct {
	mu            sync.Mutex
	smart         bool
	patterns      []adaptivePattern
	published     atomic.Pointer[[]adaptivePattern] // immutable copy of patterns for lock-free readers
	nextID        uint64
	primary       l2g.PatternSpec
	hasPrimary    bool
	rejected      map[[32]byte]time.Time
	rejectedOrder [][32]byte
	discover      func([]string, l2g.Options) (*l2g.DiscoveredPattern, error)
	discoverMulti func([]string, l2g.Options) (*l2g.MultiPatternResult, error)
}

func newAdaptiveDecoder(smart bool) *adaptiveDecoder {
	return &adaptiveDecoder{smart: smart, rejected: make(map[[32]byte]time.Time), discover: l2g.Discover, discoverMulti: l2g.DiscoverMulti}
}

// Decode returns exactly one result for each input line. Inference failures
// leave lines as explicit misses, so later batches can discover new formats.
func (a *adaptiveDecoder) Decode(lines []string) []l2g.LineResult {
	results := make([]l2g.LineResult, len(lines))
	pending := make([]int, len(lines))
	for i, line := range lines {
		results[i] = l2g.LineResult{Raw: line, Error: "log line did not match any discovered pattern"}
		pending[i] = i
	}
	// Apply the cached parsers from the published snapshot. It is read without
	// the mutex, which a chunk in discovery may hold for a long time.
	var snapshot []adaptivePattern
	if p := a.published.Load(); p != nil {
		snapshot = *p
	}
	var seen uint64
	for _, pattern := range snapshot {
		seen = max(seen, pattern.id)
		pending, _ = adaptiveApply(pattern.decoder, lines, pending, results)
		if len(pending) == 0 {
			return results
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	// A concurrent chunk may have learned parsers since the snapshot; try them
	// before discovering, or both chunks would infer the same family.
	for _, pattern := range a.patterns {
		if pattern.id <= seen {
			continue
		}
		pending, _ = adaptiveApply(pattern.decoder, lines, pending, results)
		if len(pending) == 0 {
			return results
		}
	}
	// One single-pattern discovery preserves the established dominant format
	// choice. A second multi-pattern attempt addresses any remaining families.
	now := time.Now()
	considered := make(map[[32]byte]struct{})
	defer func() {
		// Only cache lines actually sampled and still unresolved. Samples
		// skipped by the work budget must remain eligible next time.
		for _, index := range pending {
			if results[index].Matched || len(lines[index]) > adaptiveMaxSampleLine {
				continue
			}
			key := sha256.Sum256([]byte(lines[index]))
			if _, tried := considered[key]; tried {
				a.rememberRejected(key, now.Add(adaptiveRetryAfter))
			}
		}
	}()
	sample := a.sample(lines, pending, now)
	for _, line := range sample {
		considered[sha256.Sum256([]byte(line))] = struct{}{}
	}
	if len(sample) == 0 {
		return results
	}
	if a.discover != nil {
		if found, err := a.discover(sample, l2g.Options{MaxLines: adaptiveSampleLines}); err == nil && found != nil {
			pending = a.addDiscovered(found, lines, pending, results)
		}
	}
	if len(pending) == 0 {
		return results
	}
	sample = a.sample(lines, pending, now)
	for _, line := range sample {
		considered[sha256.Sum256([]byte(line))] = struct{}{}
	}
	if len(sample) == 0 {
		return results
	}
	if a.discoverMulti != nil {
		if found, err := a.discoverMulti(sample, l2g.Options{MaxLines: adaptiveSampleLines, TargetCoverage: 1}); err == nil && found != nil {
			// Reserve one candidate attempt for the single-pattern call.
			for _, candidate := range found.Patterns[:min(len(found.Patterns), adaptiveMaxPatterns-1)] {
				if candidate == nil || len(pending) == 0 {
					continue
				}
				pending = a.addDiscovered(candidate, lines, pending, results)
			}
		}
	}
	return results
}

func (a *adaptiveDecoder) PrimaryPattern() (l2g.PatternSpec, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.hasPrimary {
		return l2g.PatternSpec{}, false
	}
	spec := a.primary
	spec.CustomPatterns = maps.Clone(spec.CustomPatterns)
	return spec, true
}

func adaptiveSample(lines []string, pending []int) []string {
	sample := make([]string, 0, min(len(pending), adaptiveSampleLines))
	bytesUsed := 0
	for _, index := range pending {
		line := lines[index]
		if strings.TrimSpace(line) == "" || len(line) > adaptiveMaxSampleLine {
			continue
		}
		if len(sample) >= adaptiveSampleLines {
			break
		}
		if bytesUsed+len(line) > adaptiveSampleBytes {
			continue
		}
		sample = append(sample, line)
		bytesUsed += len(line)
	}
	return sample
}

func adaptiveApply(decoder *l2g.Decoder, lines []string, pending []int, results []l2g.LineResult) ([]int, int) {
	if len(pending) == 0 {
		return pending, 0
	}
	batch := make([]string, len(pending))
	for i, index := range pending {
		batch[i] = lines[index]
	}
	// Falls back to serial decoding below the library's batch threshold.
	decoded := decoder.DecodeConcurrent(batch, 0)
	remaining := make([]int, 0, len(pending))
	matched := 0
	for i, result := range decoded {
		if result.Matched && adaptiveMeaningful(result.Fields) {
			results[pending[i]] = result
			matched++
		} else {
			// Keep valid timestamp-only captures provisionally, but leave
			// the line eligible for a more informative parser this batch.
			// These broad rules are not added to the reusable parser cache.
			if result.Matched && !results[pending[i]].Matched {
				if _, err := decoder.Timestamp(result); err == nil {
					results[pending[i]] = result
				}
			}
			remaining = append(remaining, pending[i])
		}
	}
	return remaining, matched
}

func adaptiveMeaningful(fields map[string]string) bool {
	for name, value := range fields {
		if value == "" {
			continue
		}
		name = strings.ToLower(name)
		if adaptiveTemporalOrMessageField(name) || adaptiveGenericField(name) {
			continue
		}
		return true
	}
	return false
}

func adaptiveGenericField(name string) bool {
	if !strings.HasPrefix(name, "field") {
		return false
	}
	suffix := strings.TrimPrefix(name, "field")
	suffix = strings.TrimPrefix(suffix, "_")
	if suffix == "" {
		return false
	}
	for _, r := range suffix {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func (a *adaptiveDecoder) addDiscovered(found *l2g.DiscoveredPattern, lines []string, pending []int, results []l2g.LineResult) []int {
	if found.Grok == "" {
		return pending
	}
	spec := l2g.PatternSpec{Name: found.Source, Grok: found.Grok, CustomPatterns: maps.Clone(found.CustomPatterns)}
	for _, existing := range a.patterns {
		if existing.spec.Grok == spec.Grok && maps.Equal(existing.spec.CustomPatterns, spec.CustomPatterns) {
			return pending
		}
	}
	decoder, err := l2g.NewDecoder(spec, l2g.DecoderOptions{SmartDecode: a.smart})
	if err != nil {
		return pending
	}
	remaining, matched := adaptiveApply(decoder, lines, pending, results)
	if matched == 0 {
		return pending
	}
	if !a.hasPrimary {
		a.primary, a.hasPrimary = spec, true
	}
	if len(a.patterns) == adaptiveMaxPatterns {
		a.patterns = a.patterns[1:]
	}
	a.nextID++
	a.patterns = append(a.patterns, adaptivePattern{id: a.nextID, spec: spec, decoder: decoder})
	published := slices.Clone(a.patterns)
	a.published.Store(&published)
	return remaining
}

func adaptiveTemporalOrMessageField(name string) bool {
	switch name {
	case "message", "msg", "timestamp", "ts", "date", "time", "year", "month", "day", "hour", "minute", "second", "millis", "nanos", "tz":
		return true
	}
	return false
}

// Repeated identical noise consumes one inference attempt per retry window.
// Distinct unseen lines remain eligible, and cached parsers are always tried
// first so a newly learned rule can explain a previously rejected line.
func (a *adaptiveDecoder) sample(lines []string, pending []int, now time.Time) []string {
	eligible := make([]int, 0, min(len(pending), adaptiveSampleLines))
	seen := make(map[[32]byte]struct{})
	bytesUsed := 0
	for _, i := range pending {
		line := lines[i]
		if strings.TrimSpace(line) == "" || len(line) > adaptiveMaxSampleLine {
			continue
		}
		key := sha256.Sum256([]byte(line))
		if until, known := a.rejected[key]; known && now.Before(until) {
			continue
		}
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		if bytesUsed+len(line) > adaptiveSampleBytes {
			continue
		}
		seen[key] = struct{}{}
		eligible = append(eligible, i)
		bytesUsed += len(line)
		if len(eligible) == adaptiveSampleLines {
			break
		}
	}
	return adaptiveSample(lines, eligible)
}

func (a *adaptiveDecoder) rememberRejected(key [32]byte, until time.Time) {
	if _, exists := a.rejected[key]; !exists {
		if len(a.rejectedOrder) == adaptiveMaxRejected {
			delete(a.rejected, a.rejectedOrder[0])
			a.rejectedOrder = a.rejectedOrder[1:]
		}
		a.rejectedOrder = append(a.rejectedOrder, key)
	}
	a.rejected[key] = until
}
