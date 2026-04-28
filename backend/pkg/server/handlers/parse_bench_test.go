package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"logsonic/pkg/stream"
	"net/http"
	"net/http/httptest"
	"testing"
)

// initBenchPatterns populates the global currentPatterns with the full
// DefaultGrokPatterns set.  Must be called before any autosuggest benchmark.
func initBenchPatterns() {
	patternMutex.Lock()
	defer patternMutex.Unlock()
	if len(currentPatterns) == 0 {
		currentPatterns = DefaultGrokPatterns()
	}
}

// benchLogs returns n representative log lines of the requested kind.
func benchLogs(kind string, n int) []string {
	switch kind {
	case "apache":
		line := `192.168.1.1 - - [23/Jan/2023:14:05:01 +0000] "GET /index.html HTTP/1.1" 200 1234 "http://google.com" "Mozilla/5.0"`
		out := make([]string, n)
		for i := range out {
			out[i] = line
		}
		return out
	case "syslog":
		line := `Jan 23 14:05:01 myhost sshd[12345]: Failed password for invalid user username from 192.168.0.1 port 12345 ssh2`
		out := make([]string, n)
		for i := range out {
			out[i] = line
		}
		return out
	case "json":
		out := make([]string, n)
		for i := range out {
			out[i] = fmt.Sprintf(`{"timestamp":"2023-01-23T14:05:01.123Z","level":"info","message":"req %d","status":200}`, i)
		}
		return out
	case "unknown":
		out := make([]string, n)
		for i := range out {
			out[i] = fmt.Sprintf("XYZ#%d DEADBEEF ALPHA-BETA-GAMMA-%d delta echo", i, i*13)
		}
		return out
	default:
		panic("unknown log kind: " + kind)
	}
}

func newBenchHandler(b *testing.B) *Services {
	b.Helper()
	store := newMockStorage()
	tok := &mockTokenizer{}
	h := NewHandler(store, tok, b.TempDir(), stream.NewBus())
	return h
}

// ---------------------------------------------------------------------------
// Autosuggest benchmarks
//
// autosuggestPatterns creates one temporary tokenizer per pattern definition
// (~60+ patterns in DefaultGrokPatterns) and runs each against the sample
// lines.  Key improvements measured:
//
//   Fix #4  — JSON auto-detect runs before the grok loop (fast path for NDJSON)
//   Fix #5  — skip multiline patterns (saves N tokenizer compilations)
//   Fix #1  — coverage² scoring changes ranking but not raw throughput
//   Fix #10 — template mining only fires when bestCoverage < 0.5
// ---------------------------------------------------------------------------

// BenchmarkAutosuggest_Apache — known format, high coverage; tests normal path.
func BenchmarkAutosuggest_Apache_10Lines(b *testing.B) {
	initBenchPatterns()
	h := newBenchHandler(b)
	logs := benchLogs("apache", 10)
	b.ResetTimer()
	for b.Loop() {
		_, _ = h.autosuggestPatterns(logs)
	}
}

func BenchmarkAutosuggest_Apache_50Lines(b *testing.B) {
	initBenchPatterns()
	h := newBenchHandler(b)
	logs := benchLogs("apache", 50)
	b.ResetTimer()
	for b.Loop() {
		_, _ = h.autosuggestPatterns(logs)
	}
}

// BenchmarkAutosuggest_Syslog — syslog lines; multiple SYSLOG patterns compete.
func BenchmarkAutosuggest_Syslog_10Lines(b *testing.B) {
	initBenchPatterns()
	h := newBenchHandler(b)
	logs := benchLogs("syslog", 10)
	b.ResetTimer()
	for b.Loop() {
		_, _ = h.autosuggestPatterns(logs)
	}
}

// BenchmarkAutosuggest_JSON — Fix #4: JSON auto-detect fires first, skipping
// the grok loop entirely for lines that are valid JSON objects.
func BenchmarkAutosuggest_JSON_10Lines(b *testing.B) {
	initBenchPatterns()
	h := newBenchHandler(b)
	logs := benchLogs("json", 10)
	b.ResetTimer()
	for b.Loop() {
		_, _ = h.autosuggestPatterns(logs)
	}
}

func BenchmarkAutosuggest_JSON_50Lines(b *testing.B) {
	initBenchPatterns()
	h := newBenchHandler(b)
	logs := benchLogs("json", 50)
	b.ResetTimer()
	for b.Loop() {
		_, _ = h.autosuggestPatterns(logs)
	}
}

// BenchmarkAutosuggest_Unknown — Fix #10: template mining fallback fires when
// bestCoverage < 0.5.  This is the slowest path.
func BenchmarkAutosuggest_Unknown_10Lines(b *testing.B) {
	initBenchPatterns()
	h := newBenchHandler(b)
	logs := benchLogs("unknown", 10)
	b.ResetTimer()
	for b.Loop() {
		_, _ = h.autosuggestPatterns(logs)
	}
}

// ---------------------------------------------------------------------------
// HandleParse HTTP-level benchmarks (autosuggest branch, no grok_pattern)
// ---------------------------------------------------------------------------

func BenchmarkHandleParse_Autosuggest_Apache(b *testing.B) {
	initBenchPatterns()
	h := newBenchHandler(b)
	body, _ := json.Marshal(map[string]any{
		"logs": benchLogs("apache", 10),
	})
	b.ResetTimer()
	for b.Loop() {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/parse", bytes.NewReader(body))
		w := httptest.NewRecorder()
		h.HandleParse(w, req)
		if w.Code != http.StatusOK {
			b.Fatalf("unexpected status %d", w.Code)
		}
	}
}

func BenchmarkHandleParse_Autosuggest_JSON(b *testing.B) {
	initBenchPatterns()
	h := newBenchHandler(b)
	body, _ := json.Marshal(map[string]any{
		"logs": benchLogs("json", 10),
	})
	b.ResetTimer()
	for b.Loop() {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/parse", bytes.NewReader(body))
		w := httptest.NewRecorder()
		h.HandleParse(w, req)
		if w.Code != http.StatusOK {
			b.Fatalf("unexpected status %d", w.Code)
		}
	}
}

func BenchmarkHandleParse_Autosuggest_Unknown(b *testing.B) {
	initBenchPatterns()
	h := newBenchHandler(b)
	body, _ := json.Marshal(map[string]any{
		"logs": benchLogs("unknown", 10),
	})
	b.ResetTimer()
	for b.Loop() {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/parse", bytes.NewReader(body))
		w := httptest.NewRecorder()
		h.HandleParse(w, req)
		if w.Code != http.StatusOK {
			b.Fatalf("unexpected status %d", w.Code)
		}
	}
}
