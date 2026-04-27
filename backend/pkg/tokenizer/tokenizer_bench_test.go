package tokenizer

import (
	"fmt"
	"logsonic/pkg/types"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Log line fixtures
// ---------------------------------------------------------------------------

const (
	apacheLogLine  = `192.168.1.1 - - [23/Jan/2023:14:05:01 +0000] "GET /index.html HTTP/1.1" 200 1234 "http://google.com" "Mozilla/5.0"`
	syslogLine     = `Jan 23 14:05:01 myhost sshd[12345]: Failed password for user admin from 192.168.0.1 port 12345 ssh2`
	iso8601LogLine = `2023-01-23T14:05:01.123Z INFO Application started successfully`
)

// noMatchLine does not match Apache, Syslog, Nginx, or ISO8601 timestamp patterns.
const noMatchLine = `AUDIT req=GET path=/api/v1/pods user=admin src=10.0.0.1 status=200 latency=42ms`

func makeLines(line string, n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = line
	}
	return out
}

// makeNoMatchLines returns lines that won't match any of the specific patterns
// used by newSpecificTokenizer — they have no recognizable timestamps.
func makeNoMatchLines(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("AUDIT req=GET path=/api/v1/pods/%d user=svc-acct src=10.0.%d.1 status=200", i, i%254)
	}
	return out
}

// newSpecificTokenizer builds a tokenizer with numPatterns SPECIFIC (non-GREEDYDATA)
// patterns.  Because go-grok returns the LAST compiled match, we sort lowest
// priority first so that the highest-priority pattern is compiled last (and
// thus wins when multiple patterns could match).
//
// Patterns used: Apache, Syslog, Nginx, ISO8601-level, Java, klog variants.
// None match noMatchLine, making it a genuine no-match scenario.
func newSpecificTokenizer(tb testing.TB, numPatterns int) *Tokenizer {
	tb.Helper()

	specificPatterns := []struct {
		pat string
		pri int
	}{
		// Priority 1 — low: generic ISO8601 + level + message
		{
			`%{TIMESTAMP_ISO8601:timestamp} %{WORD:level} %{GREEDYDATA:message}`,
			1,
		},
		// Priority 5 — Syslog
		{
			`%{SYSLOGTIMESTAMP:timestamp} %{HOSTNAME:hostname} %{PROG:program}(?:\[%{POSINT:pid}\])?: %{GREEDYDATA:message}`,
			5,
		},
		// Priority 8 — Nginx access (similar to Apache)
		{
			`%{IPORHOST:clientip} %{USER:ident} %{USER:auth} \[%{HTTPDATE:timestamp}\] "%{WORD:verb} %{NOTSPACE:request} HTTP/%{NUMBER:httpversion}" %{NUMBER:status} %{NUMBER:bytes} "%{DATA:referrer}" "%{DATA:agent}"`,
			8,
		},
		// Priority 10 — Apache combined (highest priority, compiled last)
		{
			`%{IPORHOST:clientip} %{USER:ident} %{USER:auth} \[%{HTTPDATE:timestamp}\] "%{WORD:verb} %{NOTSPACE:request}(?: HTTP/%{NUMBER:httpversion})?" %{NUMBER:response} (?:%{NUMBER:bytes}|-) "%{DATA:referrer}" "%{DATA:agent}"`,
			10,
		},
		// Priority 3 — Java log
		{
			`%{TIMESTAMP_ISO8601:timestamp} \[%{DATA:thread}\] %{WORD:level} %{DATA:logger} - %{GREEDYDATA:message}`,
			3,
		},
		// Priority 2 — Docker/K8s timestamped
		{
			`%{TIMESTAMP_ISO8601:timestamp} %{WORD:level} %{GREEDYDATA:message}`,
			2,
		},
	}

	if numPatterns > len(specificPatterns) {
		numPatterns = len(specificPatterns)
	}

	tok, err := NewTokenizer()
	if err != nil {
		tb.Fatalf("NewTokenizer: %v", err)
	}
	for i := 0; i < numPatterns; i++ {
		p := specificPatterns[i]
		if err := tok.AddPattern(p.pat, p.pri); err != nil {
			tb.Logf("AddPattern(%d) failed (non-fatal): %v", i, err)
		}
	}
	return tok
}

// ---------------------------------------------------------------------------
// Simulate old O(P) inner loop to measure the before/after directly.
//
// Old code (removed):
//   for range t.preparedPatterns {
//       parsed, err := t.preparedTokenizer.ParseString(logLine)
//       if err == nil && len(parsed) > 0 {
//           ...
//           break  ← exits on first successful match
//       }
//   }
//
// Impact:
//   Matching line:     breaks on first success  → 1 ParseString call   (same as new)
//   Non-matching line: no break, runs P times   → P ParseString calls  (fixed by new code)
//
// The benchmarks below simulate both old and new behaviour so the improvement
// is directly measurable without needing the pre-fix binary.
// ---------------------------------------------------------------------------

// oldParseLoop replicates the removed O(P) for-range loop.
// Must be called while t.mutex is NOT held (it acquires RLock internally).
func oldParseLoop(t *Tokenizer, logLines []string) (int, int) {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	success, failed := 0, 0
	for _, line := range logLines {
		matched := false
		for range t.preparedPatterns { // THE OLD LOOP — P ParseString calls on no-match
			parsed, err := t.preparedTokenizer.ParseString(line)
			if err == nil && len(parsed) > 0 {
				matched = true
				success++
				break
			}
		}
		if !matched {
			failed++
		}
	}
	return success, failed
}

// newParseCore replicates the new single-call parse (same logic as ParseLogs
// but without timestamp/metadata handling for a fair apples-to-apples comparison).
func newParseCore(t *Tokenizer, logLines []string) (int, int) {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	success, failed := 0, 0
	for _, line := range logLines {
		parsed, err := t.preparedTokenizer.ParseString(line)
		if err == nil && len(parsed) > 0 {
			success++
		} else {
			failed++
		}
	}
	return success, failed
}

// ---------------------------------------------------------------------------
// Direct before/after benchmarks for the O(N) loop fix
// ---------------------------------------------------------------------------

// BenchmarkParseCore_Old_1Pattern_NoMatch — old loop, 1 pattern, 100 non-matching lines.
// Expected: 1 ParseString call per line (loop has 1 iteration).
func BenchmarkParseCore_Old_1Pattern_NoMatch(b *testing.B) {
	tok := newSpecificTokenizer(b, 1)
	lines := makeNoMatchLines(100)
	b.ResetTimer()
	for b.Loop() {
		oldParseLoop(tok, lines)
	}
}

// BenchmarkParseCore_New_1Pattern_NoMatch — new single call, 1 pattern.
// Expected: same cost as old (both make 1 ParseString call).
func BenchmarkParseCore_New_1Pattern_NoMatch(b *testing.B) {
	tok := newSpecificTokenizer(b, 1)
	lines := makeNoMatchLines(100)
	b.ResetTimer()
	for b.Loop() {
		newParseCore(tok, lines)
	}
}

// BenchmarkParseCore_Old_4Patterns_NoMatch — old loop, 4 patterns, 100 non-matching lines.
// Expected: 4 ParseString calls per line = 400 total calls.
func BenchmarkParseCore_Old_4Patterns_NoMatch(b *testing.B) {
	tok := newSpecificTokenizer(b, 4)
	lines := makeNoMatchLines(100)
	b.ResetTimer()
	for b.Loop() {
		oldParseLoop(tok, lines)
	}
}

// BenchmarkParseCore_New_4Patterns_NoMatch — new single call, 4 patterns.
// Expected: 1 ParseString call per line = 100 total calls.  ~4× faster than old.
func BenchmarkParseCore_New_4Patterns_NoMatch(b *testing.B) {
	tok := newSpecificTokenizer(b, 4)
	lines := makeNoMatchLines(100)
	b.ResetTimer()
	for b.Loop() {
		newParseCore(tok, lines)
	}
}

// BenchmarkParseCore_Old_6Patterns_NoMatch — old loop, 6 patterns (capped at 6).
// Expected: 6 ParseString calls per line.
func BenchmarkParseCore_Old_6Patterns_NoMatch(b *testing.B) {
	tok := newSpecificTokenizer(b, 6)
	lines := makeNoMatchLines(100)
	b.ResetTimer()
	for b.Loop() {
		oldParseLoop(tok, lines)
	}
}

// BenchmarkParseCore_New_6Patterns_NoMatch — new single call, 6 patterns.
// Expected: 1 ParseString call per line.  ~6× faster than old.
func BenchmarkParseCore_New_6Patterns_NoMatch(b *testing.B) {
	tok := newSpecificTokenizer(b, 6)
	lines := makeNoMatchLines(100)
	b.ResetTimer()
	for b.Loop() {
		newParseCore(tok, lines)
	}
}

// BenchmarkParseCore_Old_4Patterns_Match — matching lines, 4 patterns.
// Old loop breaks after first match → 1 ParseString call.  Same as new.
func BenchmarkParseCore_Old_4Patterns_Match(b *testing.B) {
	tok := newSpecificTokenizer(b, 4)
	lines := makeLines(syslogLine, 100) // matches syslog pattern (priority 5)
	b.ResetTimer()
	for b.Loop() {
		oldParseLoop(tok, lines)
	}
}

// BenchmarkParseCore_New_4Patterns_Match — matching lines, new code.
// Same cost expected — confirming the fix doesn't regress the match path.
func BenchmarkParseCore_New_4Patterns_Match(b *testing.B) {
	tok := newSpecificTokenizer(b, 4)
	lines := makeLines(syslogLine, 100)
	b.ResetTimer()
	for b.Loop() {
		newParseCore(tok, lines)
	}
}

// ---------------------------------------------------------------------------
// Full ParseLogs benchmarks (includes timestamp parsing and metadata)
// ---------------------------------------------------------------------------

func BenchmarkParseLogs_ApacheMatch_4Patterns(b *testing.B) {
	tok := newSpecificTokenizer(b, 4)
	logs := makeLines(apacheLogLine, 100)
	opts := types.IngestSessionOptions{Source: "bench"}
	b.ResetTimer()
	for b.Loop() {
		_, _, _, _ = tok.ParseLogs(logs, opts)
	}
}

func BenchmarkParseLogs_NoMatch_4Patterns(b *testing.B) {
	tok := newSpecificTokenizer(b, 4)
	logs := makeNoMatchLines(100)
	opts := types.IngestSessionOptions{Source: "bench"}
	b.ResetTimer()
	for b.Loop() {
		_, _, _, _ = tok.ParseLogs(logs, opts)
	}
}

func BenchmarkParseLogs_NoMatch_4Patterns_1000Lines(b *testing.B) {
	tok := newSpecificTokenizer(b, 4)
	logs := makeNoMatchLines(1000)
	opts := types.IngestSessionOptions{Source: "bench"}
	b.ResetTimer()
	for b.Loop() {
		_, _, _, _ = tok.ParseLogs(logs, opts)
	}
}

// ---------------------------------------------------------------------------
// SmartDecoder overhead
// ---------------------------------------------------------------------------

func BenchmarkParseLogs_SmartDecoder_On(b *testing.B) {
	tok := newSpecificTokenizer(b, 2)
	logs := make([]string, 100)
	for i := range logs {
		logs[i] = fmt.Sprintf(`192.168.%d.%d - - [23/Jan/2023:14:05:01 +0000] "GET /path HTTP/1.1" 200 1234 "https://ref.example.com" "Mozilla/5.0"`, i%255, i%255)
	}
	opts := types.IngestSessionOptions{Source: "bench", SmartDecoder: true}
	b.ResetTimer()
	for b.Loop() {
		_, _, _, _ = tok.ParseLogs(logs, opts)
	}
}

func BenchmarkParseLogs_SmartDecoder_Off(b *testing.B) {
	tok := newSpecificTokenizer(b, 2)
	logs := make([]string, 100)
	for i := range logs {
		logs[i] = fmt.Sprintf(`192.168.%d.%d - - [23/Jan/2023:14:05:01 +0000] "GET /path HTTP/1.1" 200 1234 "https://ref.example.com" "Mozilla/5.0"`, i%255, i%255)
	}
	opts := types.IngestSessionOptions{Source: "bench", SmartDecoder: false}
	b.ResetTimer()
	for b.Loop() {
		_, _, _, _ = tok.ParseLogs(logs, opts)
	}
}

// ---------------------------------------------------------------------------
// SmartDecodeLog micro-benchmarks
// ---------------------------------------------------------------------------

func BenchmarkSmartDecodeLog_AllPatterns(b *testing.B) {
	line := `Connection from 192.168.1.100 user@example.com UUID: 550e8400-e29b-41d4-a716-446655440000 https://api.example.com MAC: 00:1A:2B:3C:4D:5E`
	b.ResetTimer()
	for b.Loop() {
		SmartDecodeLog(line)
	}
}

func BenchmarkSmartDecodeLog_NoMatches(b *testing.B) {
	line := strings.Repeat("just plain text with no patterns to extract ", 5)
	b.ResetTimer()
	for b.Loop() {
		SmartDecodeLog(line)
	}
}

// ---------------------------------------------------------------------------
// Allocation profiles
// ---------------------------------------------------------------------------

func BenchmarkParseLogs_Allocs_Match(b *testing.B) {
	tok := newSpecificTokenizer(b, 2)
	logs := makeLines(iso8601LogLine, 10)
	opts := types.IngestSessionOptions{Source: "bench"}
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		_, _, _, _ = tok.ParseLogs(logs, opts)
	}
}

func BenchmarkParseLogs_Allocs_NoMatch(b *testing.B) {
	tok := newSpecificTokenizer(b, 2)
	logs := makeNoMatchLines(10)
	opts := types.IngestSessionOptions{Source: "bench"}
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		_, _, _, _ = tok.ParseLogs(logs, opts)
	}
}
