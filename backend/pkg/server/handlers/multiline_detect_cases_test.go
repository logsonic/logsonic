package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"logsonic/pkg/types"

	l2g "github.com/logsonic/log2grok/pkg/log2grok"
)

func TestDetectMultilineConfig_Table(t *testing.T) {
	iso := testdataLines(t, "java-stacktrace.log")
	syslog := testdataLines(t, "syslog-multiline.log")

	cases := []struct {
		name       string
		lines      []string
		wantNil    bool
		wantMode   string
		wantHeader string // substring of header_pattern when mode=header
		wantMinRec int    // minimum folded records when detected
	}{
		{
			name:       "java stack uses iso8601 header",
			lines:      iso,
			wantMode:   "header",
			wantHeader: `\d{4}-\d{2}-\d{2}`,
			wantMinRec: 10,
		},
		{
			name:       "syslog stack uses syslog header",
			lines:      syslog,
			wantMode:   "header",
			wantHeader: `[A-Z][a-z]{2}`,
			wantMinRec: 8,
		},
		{
			name: "python traceback with iso timestamps",
			lines: []string{
				"2026-04-01 09:16:18 ERROR export failed",
				"Traceback (most recent call last):",
				`  File "/opt/logsonic/scripts/export.py", line 88, in <module>`,
				"    main()",
				"TypeError: 'NoneType' object is not iterable",
				"2026-04-01 09:16:19 INFO retry scheduled",
			},
			wantMode:   "header",
			wantHeader: `\d{4}-\d{2}-\d{2}`,
			wantMinRec: 2,
		},
		{
			name: "hadoop-style iso with comma millis",
			lines: []string{
				"2015-10-18 18:01:15,966 INFO org.apache.hadoop.hdfs.StateChange: Block * blk_1",
				"java.io.IOException: No space left on device",
				"\tat org.apache.hadoop.hdfs.server.datanode.BlockReceiver.flush(BlockReceiver.java:1)",
				"\tat org.apache.hadoop.hdfs.server.datanode.BlockReceiver.run(BlockReceiver.java:2)",
				"2015-10-18 18:01:16,001 INFO org.apache.hadoop.hdfs.StateChange: recovered",
			},
			wantMode:   "header",
			wantHeader: `\d{4}-\d{2}-\d{2}`,
			wantMinRec: 2,
		},
		{
			name: "pretty-printed json uses indent",
			lines: []string{
				`{"timestamp":"2026-04-01T09:00:00Z","level":"ERROR","message":"failed","detail":{`,
				`  "code": 503,`,
				`  "reason": "storage not ready"`,
				`}}`,
				`{"timestamp":"2026-04-01T09:00:01Z","level":"INFO","message":"ok"}`,
			},
			wantMode:   "indent",
			wantMinRec: 2,
		},
		{
			name: "nginx access stays single-line",
			lines: []string{
				`192.168.1.10 - - [01/Apr/2026:00:00:00 +0000] "GET /api HTTP/1.1" 200 1234`,
				`192.168.1.11 - - [01/Apr/2026:00:00:01 +0000] "GET /health HTTP/1.1" 200 12`,
				`192.168.1.12 - - [01/Apr/2026:00:00:02 +0000] "GET /logs HTTP/1.1" 200 88`,
			},
			wantNil: true,
		},
		{
			name: "too few lines",
			lines: []string{
				"2026-04-01 09:00:00 ERROR boom",
				"java.lang.RuntimeException: x",
			},
			wantNil: true,
		},
		{
			name: "spark short-year dates are not iso8601 headers",
			lines: []string{
				"15/10/17 15:26:18 INFO SparkContext: starting",
				"15/10/17 15:26:19 INFO SparkContext: registered",
				"15/10/17 15:26:20 INFO SparkContext: done",
			},
			wantNil: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := detectMultilineConfig(tc.lines)
			if tc.wantNil {
				if got != nil {
					t.Fatalf("expected no detection, got %#v", got)
				}
				return
			}
			if got == nil || !got.Enabled {
				t.Fatalf("expected detection, got %#v", got)
			}
			if got.Mode != tc.wantMode {
				t.Fatalf("mode=%q, want %q (pattern=%q)", got.Mode, tc.wantMode, got.HeaderPattern)
			}
			if tc.wantHeader != "" && !strings.Contains(got.HeaderPattern, tc.wantHeader) {
				t.Fatalf("header_pattern %q does not contain %q", got.HeaderPattern, tc.wantHeader)
			}
			cfg, err := buildMultilineConfig(got)
			if err != nil {
				t.Fatal(err)
			}
			folded, err := l2g.JoinMultilineStrings(tc.lines, *cfg)
			if err != nil {
				t.Fatal(err)
			}
			if len(folded) < tc.wantMinRec {
				t.Fatalf("folded into %d records, want at least %d: %#v", len(folded), tc.wantMinRec, folded)
			}
			if got.Mode == "header" && orphanJavaRecords(folded) != 0 {
				t.Fatalf("header fold leaked java continuations as records: %#v", folded)
			}
		})
	}
}

func TestDetectMultilineConfig_JavaDoesNotChooseSyslog(t *testing.T) {
	lines := testdataLines(t, "java-stacktrace.log")
	got := detectMultilineConfig(lines)
	if got == nil {
		t.Fatal("expected detection")
	}
	if strings.Contains(got.HeaderPattern, `[A-Z][a-z]{2}`) && !strings.Contains(got.HeaderPattern, `\d{4}`) {
		t.Fatalf("java sample must not use syslog header, got %q", got.HeaderPattern)
	}
	cfg, _ := buildMultilineConfig(got)
	folded, _ := l2g.JoinMultilineStrings(lines, *cfg)
	if len(folded) < 2 {
		t.Fatalf("syslog-style collapse of the whole file: %d records", len(folded))
	}
}

func TestDetectMultilineConfig_SyslogDoesNotChooseISO8601(t *testing.T) {
	lines := testdataLines(t, "syslog-multiline.log")
	got := detectMultilineConfig(lines)
	if got == nil || !strings.Contains(got.HeaderPattern, `[A-Z][a-z]{2}`) {
		t.Fatalf("expected syslog header, got %#v", got)
	}
}

func TestHasUnindentedJavaContinuation(t *testing.T) {
	if !hasUnindentedJavaContinuation([]string{
		"2026-04-01 09:00:00 ERROR boom",
		"java.lang.RuntimeException: x",
		"\tat Foo.bar(Foo.java:1)",
	}) {
		t.Fatal("unindented exception class should count")
	}
	if hasUnindentedJavaContinuation([]string{
		"2026-04-01 09:00:00 ERROR boom",
		"  at Foo.bar(Foo.java:1)",
		"  at Foo.baz(Foo.java:2)",
	}) {
		t.Fatal("purely indented frames should not skip indent mode")
	}
}

func TestMultilineFolder_JavaStackSplitOnExceptionClass(t *testing.T) {
	common := l2g.CommonMultilineConfigs()["iso8601"]
	f := newMultilineFolder(common)

	out1, err := f.Feed([]string{
		"2026-04-01 09:15:01 ERROR failed to store log batch",
		"java.lang.IllegalStateException: index writer is closed",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(out1) != 0 {
		t.Fatalf("record still open after exception class, got %#v", out1)
	}

	out2, err := f.Feed([]string{
		"\tat com.logsonic.storage.BleveStore.store(BleveStore.java:214)",
		"Caused by: java.io.IOException: No space left on device",
		"\tat java.base/sun.nio.ch.FileDispatcherImpl.write0(Native Method)",
		"2026-04-01 09:15:02 WARN retrying",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(out2) != 1 {
		t.Fatalf("expected 1 completed stack record, got %d %#v", len(out2), out2)
	}
	rec := out2[0]
	for _, needle := range []string{
		"failed to store log batch",
		"IllegalStateException",
		"BleveStore.store",
		"Caused by: java.io.IOException",
	} {
		if !strings.Contains(rec, needle) {
			t.Errorf("cross-chunk stack missing %q\nrecord=%q", needle, rec)
		}
	}
	final := f.Flush()
	if len(final) != 1 || !strings.Contains(final[0], "retrying") {
		t.Fatalf("expected flushed WARN, got %#v", final)
	}
}

func TestParse_KeepsRawFoldedRecord(t *testing.T) {
	h, _ := setupHandler(t)
	lines := []string{
		"2026-04-01 09:15:01 ERROR failed to store log batch",
		"java.lang.IllegalStateException: index writer is closed",
		"\tat com.logsonic.storage.BleveStore.store(BleveStore.java:214)",
		"2026-04-01 09:15:02 INFO recovered",
	}
	body, _ := json.Marshal(types.ParseRequest{
		Logs:        lines,
		GrokPattern: "%{GREEDYDATA:message}",
		IngestSessionOptions: types.IngestSessionOptions{
			Multiline: &types.MultilineConfig{
				Enabled:       true,
				Mode:          "header",
				HeaderPattern: `^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}`,
			},
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/parse", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleParse(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("parse: %d %s", w.Code, w.Body.String())
	}
	var resp types.ParseResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.Processed != 2 {
		t.Fatalf("processed=%d want 2", resp.Processed)
	}
	raw, _ := resp.Logs[0]["_raw"].(string)
	if raw == "" {
		t.Fatal("expected _raw on folded parse preview so the wizard can show one row per record")
	}
	if !strings.Contains(raw, "IllegalStateException") || !strings.Contains(raw, "BleveStore.store") {
		t.Fatalf("_raw missing stack: %q", raw)
	}
	if _, ok := resp.Logs[0]["_seq"]; ok {
		t.Fatal("preview should still drop _seq")
	}
}

func TestParse_ExplicitMultilineNotOverridden(t *testing.T) {
	h, _ := setupHandler(t)
	lines := testdataLines(t, "java-stacktrace.log")
	indent := &types.MultilineConfig{Enabled: true, Mode: "indent"}
	body, _ := json.Marshal(types.ParseRequest{
		Logs:                 lines,
		IngestSessionOptions: types.IngestSessionOptions{Multiline: indent},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/parse", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.HandleParse(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("parse: %d %s", w.Code, w.Body.String())
	}
	var resp types.SuggestResponse
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Multiline == nil || resp.Multiline.Mode != "indent" {
		t.Fatalf("caller indent config should be honoured, got %#v", resp.Multiline)
	}
}

func TestLiveTail_JavaStackSpansBatches(t *testing.T) {
	h, store := setupHandler(t)
	source, err := h.Live.newSource(types.IngestSessionOptions{
		Name:    DefaultPatternName,
		Pattern: DefaultPattern,
		Source:  "app.log",
		Multiline: &types.MultilineConfig{
			Enabled:       true,
			Mode:          "header",
			HeaderPattern: `^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}`,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Live.addSource(source); err != nil {
		t.Fatal(err)
	}
	defer h.Live.removeSource(source.id)

	if err := source.processLines([]string{
		"2026-04-01 09:15:01 ERROR failed to store log batch",
		"java.lang.IllegalStateException: closed",
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.logs) != 0 {
		t.Fatalf("stack still open, stored %d", len(store.logs))
	}
	if err := source.processLines([]string{
		"\tat com.example.Foo.bar(Foo.java:1)",
		"2026-04-01 09:15:02 INFO recovered",
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.logs) != 1 {
		t.Fatalf("expected 1 stored stack record, got %d", len(store.logs))
	}
	msg, _ := store.logs[0]["message"].(string)
	if !strings.Contains(msg, "IllegalStateException") || !strings.Contains(msg, "Foo.bar") {
		t.Fatalf("live row missing stack: %q", msg)
	}
	source.flushMultiline()
	if len(store.logs) != 2 {
		t.Fatalf("expected flushed INFO, got %d", len(store.logs))
	}
}
