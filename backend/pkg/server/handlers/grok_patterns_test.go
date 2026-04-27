package handlers

import (
	"logsonic/pkg/tokenizer"
	"logsonic/pkg/types"
	"testing"
	"time"
)

// newTokenizerForPattern compiles a GrokPatternDefinition into a ready tokenizer.
func newTokenizerForPattern(t *testing.T, def types.GrokPatternDefinition) *tokenizer.Tokenizer {
	t.Helper()
	tok, err := tokenizer.NewTokenizer()
	if err != nil {
		t.Fatalf("NewTokenizer: %v", err)
	}
	for name, pat := range def.CustomPatterns {
		if err := tok.AddCustomPattern(name, pat); err != nil {
			t.Fatalf("AddCustomPattern(%s): %v", name, err)
		}
	}
	if err := tok.AddPattern(def.Pattern, def.Priority); err != nil {
		t.Fatalf("AddPattern: %v", err)
	}
	return tok
}

// findPattern returns the first GrokPatternDefinition with the given name.
func findPattern(t *testing.T, name string) types.GrokPatternDefinition {
	t.Helper()
	for _, p := range DefaultGrokPatterns() {
		if p.Name == name {
			return p
		}
	}
	t.Fatalf("pattern %q not found in DefaultGrokPatterns", name)
	return types.GrokPatternDefinition{}
}

// ---------------------------------------------------------------------------
// IBM BGL Supercomputer
// ---------------------------------------------------------------------------

func TestBGLPattern_NormalEntry(t *testing.T) {
	def := findPattern(t, "IBM BGL Supercomputer")
	tok := newTokenizerForPattern(t, def)

	line := "- 1117838570 2005.06.03 R02-M1-N0-C:J12-U11 2005-06-03-15.42.50.675872 R02-M1-N0-C:J12-U11 RAS KERNEL INFO instruction cache parity error corrected"
	logs := []string{line}
	results, success, failed, err := tok.ParseLogs(logs, types.IngestSessionOptions{})
	if err != nil {
		t.Fatalf("ParseLogs: %v", err)
	}
	if success != 1 || failed != 0 {
		t.Fatalf("expected 1 success, got success=%d failed=%d", success, failed)
	}

	r := results[0]
	if r["flag"] != "-" {
		t.Errorf("flag: want -, got %v", r["flag"])
	}
	if r["node_id"] != "R02-M1-N0-C:J12-U11" {
		t.Errorf("node_id: want R02-M1-N0-C:J12-U11, got %v", r["node_id"])
	}
	if r["component"] != "RAS" {
		t.Errorf("component: want RAS, got %v", r["component"])
	}
	if r["category"] != "KERNEL" {
		t.Errorf("category: want KERNEL, got %v", r["category"])
	}
	if r["severity"] != "INFO" {
		t.Errorf("severity: want INFO, got %v", r["severity"])
	}
	if r["message"] != "instruction cache parity error corrected" {
		t.Errorf("message: got %v", r["message"])
	}
	// datetime field captures the high-precision BGL timestamp
	if r["datetime"] != "2005-06-03-15.42.50.675872" {
		t.Errorf("datetime: got %v", r["datetime"])
	}
}

func TestBGLPattern_AppReadEntry(t *testing.T) {
	def := findPattern(t, "IBM BGL Supercomputer")
	tok := newTokenizerForPattern(t, def)

	line := "APPREAD 1117869872 2005.06.04 R04-M1-N4-I:J18-U11 2005-06-04-00.24.32.432192 R04-M1-N4-I:J18-U11 RAS APP FATAL ciod: failed to read message prefix on control stream"
	logs := []string{line}
	results, success, _, err := tok.ParseLogs(logs, types.IngestSessionOptions{})
	if err != nil {
		t.Fatalf("ParseLogs: %v", err)
	}
	if success != 1 {
		t.Fatalf("expected 1 success, got %d", success)
	}

	r := results[0]
	if r["flag"] != "APPREAD" {
		t.Errorf("flag: want APPREAD, got %v", r["flag"])
	}
	if r["category"] != "APP" {
		t.Errorf("category: want APP, got %v", r["category"])
	}
	if r["severity"] != "FATAL" {
		t.Errorf("severity: want FATAL, got %v", r["severity"])
	}
}

func TestBGLPattern_NetworkEngineNode(t *testing.T) {
	def := findPattern(t, "IBM BGL Supercomputer")
	tok := newTokenizerForPattern(t, def)

	// NE (Network Engine) node variant
	line := "- 1117842440 2005.06.03 R23-M0-NE-C:J05-U01 2005-06-03-16.47.20.730545 R23-M0-NE-C:J05-U01 RAS KERNEL INFO 63543 double-hummer alignment exceptions"
	logs := []string{line}
	_, success, _, err := tok.ParseLogs(logs, types.IngestSessionOptions{})
	if err != nil {
		t.Fatalf("ParseLogs: %v", err)
	}
	if success != 1 {
		t.Fatalf("NE node variant: expected 1 success, got %d", success)
	}
}

func TestBGLPattern_TimestampParsedFromUnixEpoch(t *testing.T) {
	def := findPattern(t, "IBM BGL Supercomputer")
	tok := newTokenizerForPattern(t, def)

	// Unix epoch 1117838570 = 2005-06-03 15:42:50 UTC
	line := "- 1117838570 2005.06.03 R02-M1-N0-C:J12-U11 2005-06-03-15.42.50.675872 R02-M1-N0-C:J12-U11 RAS KERNEL INFO test"
	results, success, _, err := tok.ParseLogs([]string{line}, types.IngestSessionOptions{})
	if err != nil || success != 1 {
		t.Fatalf("ParseLogs: err=%v success=%d", err, success)
	}

	ts, ok := results[0]["timestamp"].(time.Time)
	if !ok {
		t.Fatalf("timestamp not a time.Time: %T %v", results[0]["timestamp"], results[0]["timestamp"])
	}
	// 2005-06-03 15:42:50 UTC — allow ±2s for timezone edge cases
	want := time.Unix(1117838570, 0).UTC()
	diff := ts.UTC().Sub(want)
	if diff < -2*time.Second || diff > 2*time.Second {
		t.Errorf("timestamp: want ~%v, got %v (diff %v)", want, ts.UTC(), diff)
	}
}

func TestBGLPattern_MultipleLines(t *testing.T) {
	def := findPattern(t, "IBM BGL Supercomputer")
	tok := newTokenizerForPattern(t, def)

	lines := []string{
		"- 1117838570 2005.06.03 R02-M1-N0-C:J12-U11 2005-06-03-15.42.50.675872 R02-M1-N0-C:J12-U11 RAS KERNEL INFO instruction cache parity error corrected",
		"- 1117838573 2005.06.03 R02-M1-N0-C:J12-U11 2005-06-03-15.42.53.276129 R02-M1-N0-C:J12-U11 RAS KERNEL INFO instruction cache parity error corrected",
		"APPREAD 1117869872 2005.06.04 R04-M1-N4-I:J18-U11 2005-06-04-00.24.32.432192 R04-M1-N4-I:J18-U11 RAS APP FATAL ciod: failed to read message prefix on control stream",
		"- 1117942120 2005.06.04 R30-M0-N7-C:J08-U01 2005-06-04-20.28.40.767551 R30-M0-N7-C:J08-U01 RAS KERNEL INFO CE sym 20, at 0x1438f9e0, mask 0x40",
	}
	_, success, failed, err := tok.ParseLogs(lines, types.IngestSessionOptions{})
	if err != nil {
		t.Fatalf("ParseLogs: %v", err)
	}
	if success != 4 || failed != 0 {
		t.Errorf("expected 4/0, got success=%d failed=%d", success, failed)
	}
}

func TestBGLPattern_InDefaultPatternList(t *testing.T) {
	found := false
	for _, p := range DefaultGrokPatterns() {
		if p.Name == "IBM BGL Supercomputer" {
			found = true
			if p.Pattern == "" {
				t.Error("BGL pattern string is empty")
			}
			if p.CustomPatterns["BGL_TIMESTAMP"] == "" {
				t.Error("BGL_TIMESTAMP custom pattern not defined")
			}
			break
		}
	}
	if !found {
		t.Error("IBM BGL Supercomputer not in DefaultGrokPatterns")
	}
}
