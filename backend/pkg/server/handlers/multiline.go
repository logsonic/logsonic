package handlers

import (
	"fmt"
	"regexp"
	"strings"
	"sync"

	"logsonic/pkg/types"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"
)

// buildMultilineConfig converts logsonic's JSON-serializable multiline
// options into log2grok's MultilineConfig. Returns nil, nil when cfg is
// absent or disabled.
func buildMultilineConfig(cfg *types.MultilineConfig) (*l2g.MultilineConfig, error) {
	if cfg == nil || !cfg.Enabled {
		return nil, nil
	}

	out := l2g.MultilineConfig{
		MaxLines: cfg.MaxLines,
		MaxBytes: cfg.MaxBytes,
	}

	switch cfg.Mode {
	case "", "header":
		if cfg.HeaderPattern == "" {
			return nil, fmt.Errorf("header_pattern is required for multiline mode %q", "header")
		}
		header, err := regexp.Compile(cfg.HeaderPattern)
		if err != nil {
			return nil, fmt.Errorf("invalid multiline header_pattern: %w", err)
		}
		out.Mode = l2g.MultilineHeader
		out.Header = header
	case "indent":
		out.Mode = l2g.MultilineIndent
	default:
		return nil, fmt.Errorf("unknown multiline mode %q", cfg.Mode)
	}

	return &out, nil
}

type multilineCandidate struct {
	wire types.MultilineConfig
	cfg  l2g.MultilineConfig
}

func commonMultilineCandidates() []multilineCandidate {
	common := l2g.CommonMultilineConfigs()
	out := make([]multilineCandidate, 0, 3)
	if cfg, ok := common["syslog"]; ok {
		out = append(out, multilineCandidate{
			wire: types.MultilineConfig{Enabled: true, Mode: "header", HeaderPattern: cfg.Header.String()},
			cfg:  cfg,
		})
	}
	if cfg, ok := common["iso8601"]; ok {
		out = append(out, multilineCandidate{
			wire: types.MultilineConfig{Enabled: true, Mode: "header", HeaderPattern: cfg.Header.String()},
			cfg:  cfg,
		})
	}
	out = append(out, multilineCandidate{
		wire: types.MultilineConfig{Enabled: true, Mode: "indent"},
		cfg:  l2g.MultilineConfig{Mode: l2g.MultilineIndent},
	})
	return out
}

func discoverScore(lines []string) (coverage float64, library bool) {
	dp, err := l2g.Discover(lines, l2g.Options{})
	if err != nil || dp == nil {
		return 0, false
	}
	return dp.Coverage, strings.HasPrefix(dp.Source, "library:")
}

// javaContinuationRE matches stack-trace body lines that must be folded
// into the preceding timestamped record. Indent-only folding misses these
// because exception class names and "Caused by:" are not indented.
var javaContinuationRE = regexp.MustCompile(`(?i)^(?:[\t ]|at |Caused by:|\.\.\. \d+ more|(?:[a-zA-Z_$][\w$]*\.)+[A-Za-z_$][\w$]*(?:Exception|Error|Throwable)\b)`)

func looksLikeJavaContinuation(line string) bool {
	return javaContinuationRE.MatchString(line)
}

func hasUnindentedJavaContinuation(lines []string) bool {
	for _, line := range lines {
		if line == "" {
			continue
		}
		if line[0] == ' ' || line[0] == '\t' {
			continue
		}
		if looksLikeJavaContinuation(line) {
			return true
		}
	}
	return false
}

func orphanJavaRecords(folded []string) int {
	n := 0
	for _, rec := range folded {
		if looksLikeJavaContinuation(rec) {
			n++
		}
	}
	return n
}

// detectMultilineConfig picks a common continuation style when folding
// the sample yields fewer logical records than physical lines. Header
// modes (ISO 8601, syslog) are preferred over indent when the sample
// contains unindented Java stack frames — indent would emit
// `java.lang.FooException` as its own record.
func detectMultilineConfig(lines []string) *types.MultilineConfig {
	if len(lines) < 3 {
		return nil
	}

	skipIndent := hasUnindentedJavaContinuation(lines)
	var best *types.MultilineConfig
	bestScore := 0.0

	for _, cand := range commonMultilineCandidates() {
		if skipIndent && cand.wire.Mode == "indent" {
			continue
		}
		folded, err := l2g.JoinMultilineStrings(lines, cand.cfg)
		if err != nil || len(folded) < 2 || len(folded) >= len(lines) {
			continue
		}
		joined := float64(len(lines) - len(folded))
		score := joined - 8*float64(orphanJavaRecords(folded))
		if _, lib := discoverScore(folded); lib {
			score += 2
		}
		if score > bestScore {
			bestScore = score
			cfg := cand.wire
			best = &cfg
		}
	}
	return best
}

// multilineFolder makes log2grok's batch-oriented JoinMultilineStrings safe
// to call repeatedly across chunked or streamed input without splitting a
// logical record across a chunk boundary. JoinMultilineStrings always
// treats its first input line as the start of an open record and always
// flushes that record (even if still "open") once it runs out of lines; so
// each Feed call holds back the last folded record as `pending` and
// prepends it as line 0 of the next batch, letting continuation detection
// resume across the boundary. This mirrors the pending-bytes trick
// splitCompleteLines already uses for partial physical lines, one level up
// (record-level instead of byte-level).
type multilineFolder struct {
	mu         sync.Mutex
	cfg        l2g.MultilineConfig
	pending    string
	hasPending bool
}

func newMultilineFolder(cfg l2g.MultilineConfig) *multilineFolder {
	return &multilineFolder{cfg: cfg}
}

// Feed folds lines into complete records, returning every record that is
// now known to be closed. The last record is held back as pending, since
// the next Feed call's lines might still be continuations of it.
func (f *multilineFolder) Feed(lines []string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	input := lines
	if f.hasPending {
		input = make([]string, 0, len(lines)+1)
		input = append(input, f.pending)
		input = append(input, lines...)
	}
	if len(input) == 0 {
		return nil, nil
	}

	joined, err := l2g.JoinMultilineStrings(input, f.cfg)
	if err != nil {
		return nil, err
	}
	if len(joined) == 0 {
		f.hasPending = false
		f.pending = ""
		return nil, nil
	}

	f.pending = joined[len(joined)-1]
	f.hasPending = true
	return joined[:len(joined)-1], nil
}

// Flush returns any still-open trailing record (as a single-element slice)
// and clears it. Call this once, at end of stream, to avoid dropping the
// last record.
func (f *multilineFolder) Flush() []string {
	f.mu.Lock()
	defer f.mu.Unlock()

	if !f.hasPending {
		return nil
	}
	out := []string{f.pending}
	f.pending = ""
	f.hasPending = false
	return out
}
