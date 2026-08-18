package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"logsonic/pkg/types"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"
)

// ---------------------------------------------------------------------------
// buildMultilineConfig
// ---------------------------------------------------------------------------

func TestBuildMultilineConfig_DisabledOrNil(t *testing.T) {
	cfg, err := buildMultilineConfig(nil)
	if err != nil || cfg != nil {
		t.Fatalf("nil config: expected nil, nil, got %v, %v", cfg, err)
	}

	cfg, err = buildMultilineConfig(&types.MultilineConfig{Enabled: false, Mode: "header", HeaderPattern: `^\d`})
	if err != nil || cfg != nil {
		t.Fatalf("disabled config: expected nil, nil, got %v, %v", cfg, err)
	}
}

func TestBuildMultilineConfig_HeaderRequiresPattern(t *testing.T) {
	_, err := buildMultilineConfig(&types.MultilineConfig{Enabled: true, Mode: "header"})
	if err == nil {
		t.Fatal("expected error for header mode without header_pattern")
	}
}

func TestBuildMultilineConfig_InvalidRegex(t *testing.T) {
	_, err := buildMultilineConfig(&types.MultilineConfig{Enabled: true, Mode: "header", HeaderPattern: `(`})
	if err == nil {
		t.Fatal("expected error for invalid header_pattern regex")
	}
}

func TestBuildMultilineConfig_UnknownMode(t *testing.T) {
	_, err := buildMultilineConfig(&types.MultilineConfig{Enabled: true, Mode: "bogus"})
	if err == nil {
		t.Fatal("expected error for unknown multiline mode")
	}
}

func TestBuildMultilineConfig_Indent(t *testing.T) {
	cfg, err := buildMultilineConfig(&types.MultilineConfig{Enabled: true, Mode: "indent"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg == nil || cfg.Mode != l2g.MultilineIndent {
		t.Fatalf("expected indent mode, got %#v", cfg)
	}
}

// ---------------------------------------------------------------------------
// multilineFolder
// ---------------------------------------------------------------------------

func headerFolder(t *testing.T) *multilineFolder {
	t.Helper()
	return newMultilineFolder(l2g.MultilineConfig{
		Mode:   l2g.MultilineHeader,
		Header: regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`),
	})
}

func TestMultilineFolder_SingleBatch(t *testing.T) {
	f := headerFolder(t)

	out, err := f.Feed([]string{
		"2024-01-01 first line",
		"  continuation 1",
		"  continuation 2",
		"2024-01-02 second record",
	})
	if err != nil {
		t.Fatalf("Feed: %v", err)
	}
	// The header of "2024-01-02" is itself only known to be complete once
	// something proves it (or Flush is called), so only the first record
	// is returned here.
	if len(out) != 1 {
		t.Fatalf("expected 1 completed record, got %d: %#v", len(out), out)
	}
	want := "2024-01-01 first line   continuation 1   continuation 2"
	if out[0] != want {
		t.Fatalf("expected %q, got %q", want, out[0])
	}

	final := f.Flush()
	if len(final) != 1 || final[0] != "2024-01-02 second record" {
		t.Fatalf("expected flushed second record, got %#v", final)
	}
}

func TestMultilineFolder_SplitAcrossFeedCalls(t *testing.T) {
	f := headerFolder(t)

	// First chunk ends mid-record (continuation lines still coming).
	out1, err := f.Feed([]string{
		"2024-01-01 first line",
		"  continuation 1",
	})
	if err != nil {
		t.Fatalf("Feed 1: %v", err)
	}
	if len(out1) != 0 {
		t.Fatalf("expected no completed records yet, got %#v", out1)
	}

	// Second chunk continues the same record, then starts a new one.
	out2, err := f.Feed([]string{
		"  continuation 2",
		"2024-01-02 second record",
	})
	if err != nil {
		t.Fatalf("Feed 2: %v", err)
	}
	if len(out2) != 1 {
		t.Fatalf("expected 1 completed record, got %d: %#v", len(out2), out2)
	}
	want := "2024-01-01 first line   continuation 1   continuation 2"
	if out2[0] != want {
		t.Fatalf("expected record folded across the chunk boundary, got %q", out2[0])
	}

	final := f.Flush()
	if len(final) != 1 || final[0] != "2024-01-02 second record" {
		t.Fatalf("expected flushed trailing record, got %#v", final)
	}
}

func TestMultilineFolder_FlushNoPending(t *testing.T) {
	f := headerFolder(t)
	if out := f.Flush(); len(out) != 0 {
		t.Fatalf("expected no pending record, got %#v", out)
	}
}

func TestMultilineFolder_EmptyFeed(t *testing.T) {
	f := headerFolder(t)
	out, err := f.Feed(nil)
	if err != nil || len(out) != 0 {
		t.Fatalf("expected no output for empty feed, got %#v, %v", out, err)
	}
}

// ---------------------------------------------------------------------------
// /ingest multiline round trip: a record split across two /ingest/logs
// chunks must land as a single stored document.
// ---------------------------------------------------------------------------

func TestIngestMultiline_RecordSplitAcrossChunks(t *testing.T) {
	h, store := setupHandler(t)

	startBody, _ := json.Marshal(types.IngestSessionOptions{
		Name:    "multiline-test",
		Pattern: "%{GREEDYDATA:message}",
		Source:  "app.log",
		Multiline: &types.MultilineConfig{
			Enabled:       true,
			Mode:          "header",
			HeaderPattern: `^\d{4}-\d{2}-\d{2}`,
		},
	})
	startReq := httptest.NewRequest(http.MethodPost, "/api/v1/ingest/start", bytes.NewReader(startBody))
	startW := httptest.NewRecorder()
	h.HandleIngestStart(startW, startReq)
	if startW.Code != http.StatusOK {
		t.Fatalf("ingest/start: expected 200, got %d: %s", startW.Code, startW.Body.String())
	}
	var startResp types.IngestResponse
	if err := json.NewDecoder(startW.Body).Decode(&startResp); err != nil {
		t.Fatalf("decode start response: %v", err)
	}
	sessionID := startResp.SessionID
	t.Cleanup(func() {
		sessionMapMutex.Lock()
		delete(sessionMap, sessionID)
		sessionMapMutex.Unlock()
	})

	// Chunk 1: a header line plus a continuation line whose record isn't
	// provably complete yet.
	chunk1, _ := json.Marshal(types.IngestRequest{
		SessionID: sessionID,
		Logs: []string{
			"2024-01-01 12:00:00 ERROR something broke",
			"  at com.example.Foo.bar(Foo.java:42)",
		},
	})
	req1 := httptest.NewRequest(http.MethodPost, "/api/v1/ingest", bytes.NewReader(chunk1))
	w1 := httptest.NewRecorder()
	h.HandleIngest(w1, req1)
	if w1.Code != http.StatusOK {
		t.Fatalf("ingest chunk 1: expected 200, got %d: %s", w1.Code, w1.Body.String())
	}
	var resp1 types.IngestResponse
	json.NewDecoder(w1.Body).Decode(&resp1)
	if resp1.Processed != 0 {
		t.Fatalf("expected 0 processed for chunk 1 (record still open), got %d", resp1.Processed)
	}
	if len(store.logs) != 0 {
		t.Fatalf("expected nothing stored yet, got %d docs", len(store.logs))
	}

	// Chunk 2: another continuation line, then a new header proving the
	// first record complete.
	chunk2, _ := json.Marshal(types.IngestRequest{
		SessionID: sessionID,
		Logs: []string{
			"  ... 3 more",
			"2024-01-01 12:00:05 INFO recovered",
		},
	})
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/ingest", bytes.NewReader(chunk2))
	w2 := httptest.NewRecorder()
	h.HandleIngest(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("ingest chunk 2: expected 200, got %d: %s", w2.Code, w2.Body.String())
	}
	var resp2 types.IngestResponse
	json.NewDecoder(w2.Body).Decode(&resp2)
	if resp2.Processed != 1 {
		t.Fatalf("expected 1 processed for chunk 2, got %d", resp2.Processed)
	}
	if len(store.logs) != 1 {
		t.Fatalf("expected 1 stored doc after chunk 2, got %d", len(store.logs))
	}
	msg, _ := store.logs[0]["message"].(string)
	want := "2024-01-01 12:00:00 ERROR something broke   at com.example.Foo.bar(Foo.java:42)   ... 3 more"
	if msg != want {
		t.Fatalf("expected joined message %q, got %q", want, msg)
	}

	// End the session: the still-open trailing record ("INFO recovered")
	// must be flushed and stored, not dropped.
	endBody, _ := json.Marshal(types.IngestRequest{SessionID: sessionID})
	endReq := httptest.NewRequest(http.MethodPost, "/api/v1/ingest/end", bytes.NewReader(endBody))
	endW := httptest.NewRecorder()
	h.HandleIngestEnd(endW, endReq)
	if endW.Code != http.StatusOK {
		t.Fatalf("ingest/end: expected 200, got %d", endW.Code)
	}
	if len(store.logs) != 2 {
		t.Fatalf("expected trailing record flushed on session end, got %d docs", len(store.logs))
	}
	msg2, _ := store.logs[1]["message"].(string)
	want2 := "2024-01-01 12:00:05 INFO recovered"
	if msg2 != want2 {
		t.Fatalf("expected flushed trailing message %q, got %q", want2, msg2)
	}
}

// ---------------------------------------------------------------------------
// Live tail multiline: a record spanning two processLines batches must
// still be published as a single row.
// ---------------------------------------------------------------------------

func TestLiveTailMultiline_RecordSpansBatches(t *testing.T) {
	h, store := setupHandler(t)

	source, err := h.Live.newSource(types.IngestSessionOptions{
		Name:    DefaultPatternName,
		Pattern: DefaultPattern,
		Source:  "live.log",
		Multiline: &types.MultilineConfig{
			Enabled: true,
			Mode:    "indent",
		},
	})
	if err != nil {
		t.Fatalf("newSource: %v", err)
	}
	if err := h.Live.addSource(source); err != nil {
		t.Fatalf("addSource: %v", err)
	}
	defer h.Live.removeSource(source.id)

	sub := h.Live.Subscribe("")
	defer h.Live.Unsubscribe(sub.id)

	// Batch 1: a header line and an indented continuation, still open.
	if err := source.processLines([]string{"first line", "  continued"}); err != nil {
		t.Fatalf("process batch 1: %v", err)
	}
	if len(store.logs) != 0 {
		t.Fatalf("expected nothing stored after batch 1 (record still open), got %d", len(store.logs))
	}

	// Batch 2: a new (non-indented) line proves the first record complete.
	if err := source.processLines([]string{"second line"}); err != nil {
		t.Fatalf("process batch 2: %v", err)
	}
	event := waitLiveEvent(t, sub)
	rows := event.data.(types.LiveRowsEvent).Rows
	if len(rows) != 1 {
		t.Fatalf("expected 1 published row, got %d", len(rows))
	}
	msg, _ := rows[0]["message"].(string)
	if want := "first line   continued"; msg != want {
		t.Fatalf("expected joined message %q, got %q", want, msg)
	}

	// Flushing the source must emit the still-open trailing record.
	source.flushMultiline()
	if len(store.logs) != 2 {
		t.Fatalf("expected trailing record flushed, got %d stored docs", len(store.logs))
	}
	msg2, _ := store.logs[1]["message"].(string)
	if want := "second line"; msg2 != want {
		t.Fatalf("expected flushed trailing message %q, got %q", want, msg2)
	}
}

// ---------------------------------------------------------------------------
// /parse folds before both pattern matching and autosuggest.
// ---------------------------------------------------------------------------

func TestParseMultiline_FoldsBeforePatternMatch(t *testing.T) {
	h, _ := setupHandler(t)

	body, _ := json.Marshal(types.ParseRequest{
		Logs: []string{
			"2024-01-01 12:00:00 ERROR something broke",
			"  at com.example.Foo.bar(Foo.java:42)",
			"2024-01-01 12:00:05 INFO recovered",
		},
		GrokPattern: "%{GREEDYDATA:message}",
		IngestSessionOptions: types.IngestSessionOptions{
			Multiline: &types.MultilineConfig{
				Enabled:       true,
				Mode:          "header",
				HeaderPattern: `^\d{4}-\d{2}-\d{2}`,
			},
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/parse", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleParse(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("parse: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp types.ParseResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Processed != 2 {
		t.Fatalf("expected 2 folded records, got processed=%d failed=%d logs=%d", resp.Processed, resp.Failed, len(resp.Logs))
	}
	msg, _ := resp.Logs[0]["message"].(string)
	want := "2024-01-01 12:00:00 ERROR something broke   at com.example.Foo.bar(Foo.java:42)"
	if msg != want {
		t.Fatalf("expected joined message %q, got %q", want, msg)
	}
}

func TestParseMultiline_FoldsBeforeAutosuggest(t *testing.T) {
	h, _ := setupHandler(t)

	body, _ := json.Marshal(types.ParseRequest{
		Logs: []string{
			"2024-01-01T12:00:00Z ERROR something broke",
			"  at com.example.Foo.bar(Foo.java:42)",
			"2024-01-01T12:00:05Z INFO recovered",
		},
		IngestSessionOptions: types.IngestSessionOptions{
			Multiline: &types.MultilineConfig{
				Enabled:       true,
				Mode:          "header",
				HeaderPattern: `^\d{4}-\d{2}-\d{2}`,
			},
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/parse", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleParse(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("parse autosuggest: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp types.SuggestResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Status != "success" || resp.Type != "autosuggest" {
		t.Fatalf("expected autosuggest success, got status=%q type=%q", resp.Status, resp.Type)
	}
	if len(resp.Results) == 0 {
		t.Fatal("expected at least one autosuggest result after folding")
	}
}

func TestExpireStaleSessions_FlushesPendingMultiline(t *testing.T) {
	h, store := setupHandler(t)

	startBody, _ := json.Marshal(types.IngestSessionOptions{
		Name:    "multiline-expire",
		Pattern: "%{GREEDYDATA:message}",
		Source:  "app.log",
		Multiline: &types.MultilineConfig{
			Enabled:       true,
			Mode:          "header",
			HeaderPattern: `^\d{4}-\d{2}-\d{2}`,
		},
	})
	startReq := httptest.NewRequest(http.MethodPost, "/api/v1/ingest/start", bytes.NewReader(startBody))
	startW := httptest.NewRecorder()
	h.HandleIngestStart(startW, startReq)
	if startW.Code != http.StatusOK {
		t.Fatalf("ingest/start: expected 200, got %d: %s", startW.Code, startW.Body.String())
	}
	var startResp types.IngestResponse
	if err := json.NewDecoder(startW.Body).Decode(&startResp); err != nil {
		t.Fatalf("decode start response: %v", err)
	}
	sessionID := startResp.SessionID

	chunk, _ := json.Marshal(types.IngestRequest{
		SessionID: sessionID,
		Logs:      []string{"2024-01-01 12:00:00 ERROR still open"},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ingest", bytes.NewReader(chunk))
	w := httptest.NewRecorder()
	h.HandleIngest(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("ingest: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if len(store.logs) != 0 {
		t.Fatalf("expected pending record not stored yet, got %d docs", len(store.logs))
	}

	sessionMapMutex.Lock()
	session, exists := sessionMap[sessionID]
	if !exists {
		sessionMapMutex.Unlock()
		t.Fatal("session missing after ingest")
	}
	session.CreationTime = time.Now().Add(-SessionTimeout - time.Minute)
	session.LastActivity = session.CreationTime
	sessionMap[sessionID] = session
	sessionMapMutex.Unlock()

	expireStaleSessions(time.Now(), h)

	sessionMapMutex.RLock()
	_, stillThere := sessionMap[sessionID]
	sessionMapMutex.RUnlock()
	if stillThere {
		t.Fatal("expected expired session to be removed")
	}
	if len(store.logs) != 1 {
		t.Fatalf("expected pending multiline record flushed on expiry, got %d docs", len(store.logs))
	}
	msg, _ := store.logs[0]["message"].(string)
	if msg != "2024-01-01 12:00:00 ERROR still open" {
		t.Fatalf("unexpected flushed message %q", msg)
	}
}

func TestDetectMultilineConfig_SyslogHeader(t *testing.T) {
	lines := []string{
		"Apr  1 09:14:22 logsonic-host logsonic[1420]: ingest session started",
		"Apr  1 09:15:01 logsonic-host kernel: Out of memory: Killed process 8841 (logsonic)",
		"    pid: 8841 uid: 1000 tgid: 8841 total_vm: 2148124kB",
		"    rss: 1812044kB pgtables: 4208kB",
		"Apr  1 09:15:02 logsonic-host systemd[1]: logsonic.service: Main process exited",
		"Apr  1 09:16:18 logsonic-host python[9102]: Traceback (most recent call last):",
		"  File \"/opt/logsonic/scripts/export.py\", line 88, in <module>",
		"    main()",
		"Apr  1 09:16:19 logsonic-host python[9102]: export aborted",
	}
	got := detectMultilineConfig(lines)
	if got == nil || !got.Enabled || got.Mode != "header" {
		t.Fatalf("expected syslog header mode, got %#v", got)
	}
	if got.HeaderPattern == "" {
		t.Fatal("expected a header_pattern")
	}
}

func TestDetectMultilineConfig_SingleLineNoFold(t *testing.T) {
	lines := []string{
		"192.168.1.10 - - [01/Apr/2026:00:00:00 +0000] \"GET /api HTTP/1.1\" 200 1234",
		"192.168.1.11 - - [01/Apr/2026:00:00:01 +0000] \"GET /health HTTP/1.1\" 200 12",
		"192.168.1.12 - - [01/Apr/2026:00:00:02 +0000] \"GET /logs HTTP/1.1\" 200 88",
	}
	if got := detectMultilineConfig(lines); got != nil {
		t.Fatalf("expected no multiline detection for single-line access logs, got %#v", got)
	}
}

func TestParseAutosuggest_DetectsSyslogMultilineAndLibraryPattern(t *testing.T) {
	h, _ := setupHandler(t)

	body, _ := json.Marshal(types.ParseRequest{
		Logs: []string{
			"Apr  1 09:14:22 logsonic-host logsonic[1420]: ingest session started",
			"Apr  1 09:15:01 logsonic-host kernel: Out of memory: Killed process 8841 (logsonic)",
			"    pid: 8841 uid: 1000 tgid: 8841 total_vm: 2148124kB",
			"    rss: 1812044kB pgtables: 4208kB",
			"Apr  1 09:15:02 logsonic-host systemd[1]: logsonic.service: Main process exited",
			"Apr  1 09:16:18 logsonic-host python[9102]: Traceback (most recent call last):",
			"  File \"/opt/logsonic/scripts/export.py\", line 88, in <module>",
			"    main()",
			"Apr  1 09:16:19 logsonic-host python[9102]: export aborted",
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/parse", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleParse(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("parse: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp types.SuggestResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Multiline == nil || !resp.Multiline.Enabled || resp.Multiline.Mode != "header" {
		t.Fatalf("expected auto-detected syslog header multiline, got %#v", resp.Multiline)
	}
	if len(resp.Results) == 0 {
		t.Fatal("expected an autosuggest result")
	}
	if !strings.Contains(strings.ToLower(resp.Results[0].PatternName), "syslog") {
		t.Fatalf("expected Syslog RFC3164 (or similar) after folding, got %q %q", resp.Results[0].PatternName, resp.Results[0].Pattern)
	}
}

func testdataLines(t *testing.T, name string) []string {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read testdata/%s: %v", name, err)
	}
	raw := strings.ReplaceAll(string(body), "\r\n", "\n")
	raw = strings.TrimSuffix(raw, "\n")
	return strings.Split(raw, "\n")
}

func countISO8601Headers(lines []string) int {
	re := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}`)
	n := 0
	for _, line := range lines {
		if re.MatchString(line) {
			n++
		}
	}
	return n
}

func TestLooksLikeJavaContinuation_ExceptionAndCausedBy(t *testing.T) {
	want := []string{
		"java.lang.IllegalStateException: index writer is closed",
		"com.logsonic.parse.PatternException: unknown grok primitive",
		"\tat com.logsonic.storage.BleveStore.store(BleveStore.java:214)",
		"Caused by: java.io.IOException: No space left on device",
		"    at org.springframework.web.servlet.DispatcherServlet.doDispatch",
		"... 6 more",
	}
	for _, line := range want {
		if !looksLikeJavaContinuation(line) {
			t.Errorf("expected continuation: %q", line)
		}
	}
	not := []string{
		"2026-04-01 09:15:01 ERROR [http-nio-8080-exec-7] c.l.storage.BleveStore - failed",
		"2026-04-01T09:16:18 ERROR [parser-pool-2] c.l.parse.GrokDecoder - pattern match failed",
		"Apr  1 09:15:01 logsonic-host kernel: Out of memory",
	}
	for _, line := range not {
		if looksLikeJavaContinuation(line) {
			t.Errorf("did not expect continuation: %q", line)
		}
	}
}

func TestDetectMultilineConfig_JavaStackUsesISO8601NotIndent(t *testing.T) {
	lines := testdataLines(t, "java-stacktrace.log")
	got := detectMultilineConfig(lines)
	if got == nil || !got.Enabled || got.Mode != "header" {
		t.Fatalf("expected ISO-8601 header mode, got %#v", got)
	}
	if !strings.Contains(got.HeaderPattern, `\d{4}-\d{2}-\d{2}`) {
		t.Fatalf("expected ISO-8601 header_pattern, got %q", got.HeaderPattern)
	}

	cfg, err := buildMultilineConfig(got)
	if err != nil {
		t.Fatal(err)
	}
	folded, err := l2g.JoinMultilineStrings(lines, *cfg)
	if err != nil {
		t.Fatal(err)
	}
	wantRecords := countISO8601Headers(lines)
	if len(folded) != wantRecords {
		t.Fatalf("expected %d folded records (one per timestamp), got %d", wantRecords, len(folded))
	}
	if orphanJavaRecords(folded) != 0 {
		t.Fatalf("exception class / Caused by leaked as their own records: %#v", folded)
	}

	var errorWithStack string
	for _, rec := range folded {
		if strings.Contains(rec, "failed to store log batch") {
			errorWithStack = rec
			break
		}
	}
	if errorWithStack == "" {
		t.Fatal("missing ERROR record for failed store")
	}
	for _, needle := range []string{
		"java.lang.IllegalStateException",
		"at com.logsonic.storage.BleveStore.store",
		"Caused by: java.io.IOException",
	} {
		if !strings.Contains(errorWithStack, needle) {
			t.Errorf("folded ERROR record missing %q\nrecord: %s", needle, errorWithStack)
		}
	}
}

func TestIndentModeSplitsJavaExceptionClass(t *testing.T) {
	lines := testdataLines(t, "java-stacktrace.log")
	folded, err := l2g.JoinMultilineStrings(lines, l2g.MultilineConfig{Mode: l2g.MultilineIndent})
	if err != nil {
		t.Fatal(err)
	}
	if orphanJavaRecords(folded) == 0 {
		t.Fatal("expected indent mode to emit unindented exception class lines as separate records (this is why detection must not pick indent)")
	}
}

func TestParseAutosuggest_JavaStackFoldsIntoLog4jRecords(t *testing.T) {
	h, _ := setupHandler(t)
	lines := testdataLines(t, "java-stacktrace.log")

	body, _ := json.Marshal(types.ParseRequest{Logs: lines})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/parse", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleParse(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("autosuggest: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var suggest types.SuggestResponse
	if err := json.NewDecoder(w.Body).Decode(&suggest); err != nil {
		t.Fatal(err)
	}
	if suggest.Multiline == nil || suggest.Multiline.Mode != "header" || !strings.Contains(suggest.Multiline.HeaderPattern, `\d{4}-\d{2}-\d{2}`) {
		t.Fatalf("expected auto-detected ISO-8601 multiline, got %#v", suggest.Multiline)
	}
	if len(suggest.Results) == 0 {
		t.Fatal("expected autosuggest result")
	}

	parseBody, _ := json.Marshal(types.ParseRequest{
		Logs:                 lines,
		GrokPattern:          suggest.Results[0].Pattern,
		CustomPatterns:       suggest.Results[0].CustomPatterns,
		IngestSessionOptions: types.IngestSessionOptions{Multiline: suggest.Multiline},
	})
	parseReq := httptest.NewRequest(http.MethodPost, "/api/v1/parse", bytes.NewReader(parseBody))
	parseW := httptest.NewRecorder()
	h.HandleParse(parseW, parseReq)
	if parseW.Code != http.StatusOK {
		t.Fatalf("parse: expected 200, got %d: %s", parseW.Code, parseW.Body.String())
	}
	var parsed types.ParseResponse
	if err := json.NewDecoder(parseW.Body).Decode(&parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Processed != countISO8601Headers(lines) {
		t.Fatalf("expected %d processed logical records, got %d (physical lines=%d)", countISO8601Headers(lines), parsed.Processed, len(lines))
	}

	var storeErr map[string]interface{}
	for _, log := range parsed.Logs {
		msg, _ := log["message"].(string)
		raw, _ := log["_raw"].(string)
		if strings.Contains(msg, "IllegalStateException") || strings.Contains(raw, "IllegalStateException") {
			storeErr = log
			break
		}
	}
	if storeErr == nil {
		t.Fatal("expected a parsed record whose message/_raw contains the IllegalStateException stack")
	}
	raw, _ := storeErr["_raw"].(string)
	msg, _ := storeErr["message"].(string)
	blob := raw + " " + msg
	for _, needle := range []string{"IllegalStateException", "BleveStore.store", "Caused by"} {
		if !strings.Contains(blob, needle) {
			t.Errorf("stack not under the ERROR record, missing %q\nraw=%q\nmessage=%q", needle, raw, msg)
		}
	}
}

func TestIngestJavaStack_OneDocumentPerTimestampedRecord(t *testing.T) {
	h, store := setupHandler(t)
	lines := testdataLines(t, "java-stacktrace.log")
	detected := detectMultilineConfig(lines)
	if detected == nil {
		t.Fatal("expected multiline detection")
	}

	startBody, _ := json.Marshal(types.IngestSessionOptions{
		Name:      "java-stack-test",
		Pattern:   "%{GREEDYDATA:message}",
		Source:    "java-stacktrace.log",
		Multiline: detected,
	})
	startReq := httptest.NewRequest(http.MethodPost, "/api/v1/ingest/start", bytes.NewReader(startBody))
	startW := httptest.NewRecorder()
	h.HandleIngestStart(startW, startReq)
	if startW.Code != http.StatusOK {
		t.Fatalf("start: %d %s", startW.Code, startW.Body.String())
	}
	var startResp types.IngestResponse
	json.NewDecoder(startW.Body).Decode(&startResp)

	mid := len(lines) / 2
	for _, chunk := range [][]string{lines[:mid], lines[mid:]} {
		body, _ := json.Marshal(types.IngestRequest{SessionID: startResp.SessionID, Logs: chunk})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/ingest/logs", bytes.NewReader(body))
		w := httptest.NewRecorder()
		h.HandleIngest(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("ingest: %d %s", w.Code, w.Body.String())
		}
	}
	endBody, _ := json.Marshal(types.IngestRequest{SessionID: startResp.SessionID})
	endReq := httptest.NewRequest(http.MethodPost, "/api/v1/ingest/end", bytes.NewReader(endBody))
	endW := httptest.NewRecorder()
	h.HandleIngestEnd(endW, endReq)
	if endW.Code != http.StatusOK {
		t.Fatalf("end: %d", endW.Code)
	}

	want := countISO8601Headers(lines)
	if len(store.logs) != want {
		t.Fatalf("stored %d docs, want %d logical records (not %d physical lines)", len(store.logs), want, len(lines))
	}
	foundStack := false
	for _, doc := range store.logs {
		msg, _ := doc["message"].(string)
		if strings.Contains(msg, "IllegalStateException") && strings.Contains(msg, "Caused by") && strings.Contains(msg, "BleveStore.store") {
			foundStack = true
			break
		}
	}
	if !foundStack {
		t.Fatal("stored ERROR document did not contain the full stack (exception + frames + Caused by)")
	}
}
