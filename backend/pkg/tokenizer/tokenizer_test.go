package tokenizer

import (
	"logsonic/pkg/types"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// SmartDecodeLog
// ---------------------------------------------------------------------------

func TestSmartDecodeLog_ExtractsIPv4(t *testing.T) {
	result := SmartDecodeLog("Connection from 192.168.1.100 established")
	ips, ok := result["ipv4_addr"]
	if !ok || len(ips) == 0 {
		t.Fatal("expected ipv4_addr to be extracted")
	}
	if ips[0] != "192.168.1.100" {
		t.Errorf("expected 192.168.1.100, got %s", ips[0])
	}
}

func TestSmartDecodeLog_ExtractsMultipleIPs(t *testing.T) {
	result := SmartDecodeLog("src=10.0.0.1 dst=10.0.0.2")
	ips := result["ipv4_addr"]
	if len(ips) != 2 {
		t.Errorf("expected 2 IPs, got %d", len(ips))
	}
}

func TestSmartDecodeLog_ExtractsEmail(t *testing.T) {
	result := SmartDecodeLog("User user@example.com logged in")
	emails, ok := result["email_addr"]
	if !ok || len(emails) == 0 {
		t.Fatal("expected email_addr to be extracted")
	}
	if emails[0] != "user@example.com" {
		t.Errorf("expected user@example.com, got %s", emails[0])
	}
}

func TestSmartDecodeLog_ExtractsURL(t *testing.T) {
	result := SmartDecodeLog("Fetching https://api.example.com/v1/data")
	urls, ok := result["urls"]
	if !ok || len(urls) == 0 {
		t.Fatal("expected urls to be extracted")
	}
	if urls[0] != "https://api.example.com/v1/data" {
		t.Errorf("expected https://api.example.com/v1/data, got %s", urls[0])
	}
}

func TestSmartDecodeLog_ExtractsUUID(t *testing.T) {
	result := SmartDecodeLog("Request 550e8400-e29b-41d4-a716-446655440000 completed")
	uuids, ok := result["uuids"]
	if !ok || len(uuids) == 0 {
		t.Fatal("expected uuids to be extracted")
	}
	if uuids[0] != "550e8400-e29b-41d4-a716-446655440000" {
		t.Errorf("unexpected UUID: %s", uuids[0])
	}
}

func TestSmartDecodeLog_ExtractsMACAddress(t *testing.T) {
	result := SmartDecodeLog("Device MAC: 00:1A:2B:3C:4D:5E")
	macs, ok := result["mac_addr"]
	if !ok || len(macs) == 0 {
		t.Fatal("expected mac_addr to be extracted")
	}
}

func TestSmartDecodeLog_EmptyLine(t *testing.T) {
	result := SmartDecodeLog("")
	if len(result) != 0 {
		t.Errorf("expected empty result for empty line, got %d keys", len(result))
	}
}

func TestSmartDecodeLog_NoMatches(t *testing.T) {
	result := SmartDecodeLog("just a plain log line with no patterns")
	if len(result) != 0 {
		t.Errorf("expected no matches, got %d keys", len(result))
	}
}

// ---------------------------------------------------------------------------
// updateTimestamp
// ---------------------------------------------------------------------------

func TestUpdateTimestamp_RFC3339(t *testing.T) {
	opts := types.IngestSessionOptions{}
	ts := updateTimestamp("2024-01-15T10:30:00Z", opts)
	if ts.Year() != 2024 || ts.Month() != time.January || ts.Day() != 15 {
		t.Errorf("unexpected parsed date: %v", ts)
	}
	if ts.Hour() != 10 || ts.Minute() != 30 {
		t.Errorf("unexpected parsed time: %v", ts)
	}
}

func TestUpdateTimestamp_SyslogFormat(t *testing.T) {
	opts := types.IngestSessionOptions{}
	ts := updateTimestamp("Jan 15 10:30:00", opts)
	// Year should be set to current year since syslog doesn't include year
	if ts.Month() != time.January || ts.Day() != 15 {
		t.Errorf("unexpected parsed date: %v", ts)
	}
}

func TestUpdateTimestamp_AndroidFormat(t *testing.T) {
	opts := types.IngestSessionOptions{}
	ts := updateTimestamp("03-17 16:16:08.538", opts)
	if ts.Month() != time.March || ts.Day() != 17 {
		t.Errorf("unexpected parsed date: %v", ts)
	}
	if ts.Hour() != 16 || ts.Minute() != 16 {
		t.Errorf("unexpected parsed time: %v", ts)
	}
}

func TestUpdateTimestamp_EmptyString(t *testing.T) {
	opts := types.IngestSessionOptions{}
	ts := updateTimestamp("", opts)
	// Should return approximately "now"
	if time.Since(ts) > 2*time.Second {
		t.Errorf("empty timestamp should return ~now, got %v", ts)
	}
}

func TestUpdateTimestamp_ForceYear(t *testing.T) {
	opts := types.IngestSessionOptions{
		ForceStartYear: "2020",
	}
	ts := updateTimestamp("2024-06-15T12:00:00Z", opts)
	if ts.Year() != 2020 {
		t.Errorf("expected forced year 2020, got %d", ts.Year())
	}
}

func TestUpdateTimestamp_ForceMonth(t *testing.T) {
	opts := types.IngestSessionOptions{
		ForceStartMonth: "3",
	}
	ts := updateTimestamp("2024-06-15T12:00:00Z", opts)
	if ts.Month() != time.March {
		t.Errorf("expected forced month March, got %v", ts.Month())
	}
}

func TestUpdateTimestamp_ForceDay(t *testing.T) {
	opts := types.IngestSessionOptions{
		ForceStartDay: "25",
	}
	ts := updateTimestamp("2024-06-15T12:00:00Z", opts)
	if ts.Day() != 25 {
		t.Errorf("expected forced day 25, got %d", ts.Day())
	}
}

func TestUpdateTimestamp_ForceTimezone(t *testing.T) {
	opts := types.IngestSessionOptions{
		ForceTimezone: "America/New_York",
	}
	ts := updateTimestamp("2024-06-15T12:00:00Z", opts)
	loc := ts.Location()
	if loc.String() != "America/New_York" {
		t.Errorf("expected America/New_York timezone, got %s", loc.String())
	}
}

func TestUpdateTimestamp_InvalidForceMonth(t *testing.T) {
	opts := types.IngestSessionOptions{
		ForceStartMonth: "13", // invalid, should be ignored
	}
	ts := updateTimestamp("2024-06-15T12:00:00Z", opts)
	if ts.Month() != time.June {
		t.Errorf("invalid month should be ignored, got %v", ts.Month())
	}
}

func TestUpdateTimestamp_UnparseableGarbage(t *testing.T) {
	opts := types.IngestSessionOptions{}
	ts := updateTimestamp("not-a-date-at-all", opts)
	// Should fall back to approximately "now"
	if time.Since(ts) > 2*time.Second {
		t.Errorf("garbage input should return ~now, got %v", ts)
	}
}

// ---------------------------------------------------------------------------
// Tokenizer: Pattern Management
// ---------------------------------------------------------------------------

func TestNewTokenizer(t *testing.T) {
	tok, err := NewTokenizer()
	if err != nil {
		t.Fatalf("NewTokenizer() failed: %v", err)
	}
	if tok == nil {
		t.Fatal("NewTokenizer() returned nil")
	}
	if len(tok.GetPatterns()) != 0 {
		t.Errorf("new tokenizer should have no patterns, got %d", len(tok.GetPatterns()))
	}
}

func TestAddPattern_Valid(t *testing.T) {
	tok, _ := NewTokenizer()
	err := tok.AddPattern("%{GREEDYDATA:message}")
	if err != nil {
		t.Fatalf("AddPattern failed: %v", err)
	}
	if len(tok.GetPatterns()) != 1 {
		t.Errorf("expected 1 pattern, got %d", len(tok.GetPatterns()))
	}
}

func TestAddPattern_Invalid(t *testing.T) {
	tok, _ := NewTokenizer()
	err := tok.AddPattern("%{INVALID_NONEXISTENT_PATTERN:test}")
	if err == nil {
		t.Error("expected error for invalid pattern, got nil")
	}
}

func TestAddPattern_WithPriority(t *testing.T) {
	tok, _ := NewTokenizer()
	err := tok.AddPattern("%{GREEDYDATA:message}", 10)
	if err != nil {
		t.Fatalf("AddPattern with priority failed: %v", err)
	}
}

func TestAddCustomPattern(t *testing.T) {
	tok, _ := NewTokenizer()
	err := tok.AddCustomPattern("MYTOKEN", "[A-Z]{3}-\\d+")
	if err != nil {
		t.Fatalf("AddCustomPattern failed: %v", err)
	}
	cp := tok.GetCustomPatterns()
	if cp["MYTOKEN"] != "[A-Z]{3}-\\d+" {
		t.Errorf("custom pattern not stored correctly")
	}
}

func TestAddCustomPattern_RetrievesCorrectly(t *testing.T) {
	tok, _ := NewTokenizer()
	err := tok.AddCustomPattern("STATUSCODE", "[1-5]\\d{2}")
	if err != nil {
		t.Fatalf("AddCustomPattern failed: %v", err)
	}
	cp := tok.GetCustomPatterns()
	if val, ok := cp["STATUSCODE"]; !ok || val != "[1-5]\\d{2}" {
		t.Errorf("expected STATUSCODE pattern, got %v", cp)
	}
}

func TestClearPatterns(t *testing.T) {
	tok, _ := NewTokenizer()
	_ = tok.AddPattern("%{GREEDYDATA:message}")
	_ = tok.AddCustomPattern("TEST", "\\d+")
	err := tok.ClearPatterns()
	if err != nil {
		t.Fatalf("ClearPatterns failed: %v", err)
	}
	if len(tok.GetPatterns()) != 0 {
		t.Errorf("expected 0 patterns after clear, got %d", len(tok.GetPatterns()))
	}
	if len(tok.GetCustomPatterns()) != 0 {
		t.Errorf("expected 0 custom patterns after clear, got %d", len(tok.GetCustomPatterns()))
	}
}

func TestPersistentPatterns(t *testing.T) {
	tok, _ := NewTokenizer()
	err := tok.AddPersistentPattern("%{GREEDYDATA:message}")
	if err != nil {
		t.Fatalf("AddPersistentPattern failed: %v", err)
	}

	// Add non-persistent pattern
	_ = tok.AddPattern("%{IP:client}")

	// Clear request patterns (should keep persistent ones)
	tok.ClearRequestPatterns()

	patterns := tok.GetPatterns()
	if len(patterns) != 1 {
		t.Errorf("expected 1 persistent pattern after clear, got %d", len(patterns))
	}

	persistentPatterns := tok.GetPersistentPatterns()
	if len(persistentPatterns) != 1 {
		t.Errorf("expected 1 persistent pattern, got %d", len(persistentPatterns))
	}
}

// ---------------------------------------------------------------------------
// Tokenizer: ParseLogs
// ---------------------------------------------------------------------------

func TestParseLogs_SimpleGreedydata(t *testing.T) {
	tok, _ := NewTokenizer()
	_ = tok.AddPattern("%{GREEDYDATA:message}")

	opts := types.IngestSessionOptions{Source: "test.log"}
	logs := []string{"hello world", "foo bar"}

	result, success, failed, err := tok.ParseLogs(logs, opts)
	if err != nil {
		t.Fatalf("ParseLogs failed: %v", err)
	}
	if success != 2 {
		t.Errorf("expected 2 successes, got %d", success)
	}
	if failed != 0 {
		t.Errorf("expected 0 failures, got %d", failed)
	}
	if len(result) != 2 {
		t.Errorf("expected 2 results, got %d", len(result))
	}

	// Verify _raw field
	if raw, ok := result[0]["_raw"].(string); !ok || raw != "hello world" {
		t.Errorf("expected _raw='hello world', got '%v'", result[0]["_raw"])
	}

	// Verify _src field
	if src, ok := result[0]["_src"].(string); !ok || src != "test.log" {
		t.Errorf("expected _src='test.log', got '%v'", result[0]["_src"])
	}
}

func TestParseLogs_SyslogPattern(t *testing.T) {
	tok, _ := NewTokenizer()
	// Standard syslog pattern
	_ = tok.AddCustomPattern("SYSLOGTIMESTAMP", "%{MONTH} +%{MONTHDAY} %{TIME}")
	_ = tok.AddPattern("%{SYSLOGTIMESTAMP:timestamp} %{HOSTNAME:hostname} %{GREEDYDATA:message}")

	opts := types.IngestSessionOptions{Source: "syslog"}
	logs := []string{"Jan 15 10:30:00 myhost Something happened here"}

	result, success, _, err := tok.ParseLogs(logs, opts)
	if err != nil {
		t.Fatalf("ParseLogs failed: %v", err)
	}
	if success != 1 {
		t.Errorf("expected 1 success, got %d", success)
	}

	// Verify hostname was extracted
	if hostname, ok := result[0]["hostname"].(string); !ok || hostname != "myhost" {
		t.Errorf("expected hostname='myhost', got '%v'", result[0]["hostname"])
	}
}

func TestParseLogs_NoPatterns(t *testing.T) {
	tok, _ := NewTokenizer()
	// Don't add any patterns

	opts := types.IngestSessionOptions{}
	logs := []string{"test line"}

	_, _, failed, err := tok.ParseLogs(logs, opts)
	// With no patterns, ParseLogs should return an error
	if err == nil {
		t.Fatal("expected error when no patterns loaded, got nil")
	}
	if failed != 1 {
		t.Errorf("expected failed count = len(logLines) = 1, got %d", failed)
	}
}

func TestParseLogs_EmptyInput(t *testing.T) {
	tok, _ := NewTokenizer()
	_ = tok.AddPattern("%{GREEDYDATA:message}")

	opts := types.IngestSessionOptions{}
	result, success, failed, err := tok.ParseLogs([]string{}, opts)
	if err != nil {
		t.Fatalf("ParseLogs failed: %v", err)
	}
	if success != 0 || failed != 0 || len(result) != 0 {
		t.Errorf("expected empty results for empty input, got success=%d, failed=%d, results=%d", success, failed, len(result))
	}
}

func TestParseLogs_MetadataInjection(t *testing.T) {
	tok, _ := NewTokenizer()
	_ = tok.AddPattern("%{GREEDYDATA:message}")

	opts := types.IngestSessionOptions{
		Source: "test",
		Meta: map[string]interface{}{
			"aws_region": "us-west-2",
			"log_group":  "my-group",
		},
	}
	logs := []string{"test line"}

	result, _, _, err := tok.ParseLogs(logs, opts)
	if err != nil {
		t.Fatalf("ParseLogs failed: %v", err)
	}

	if result[0]["aws_region"] != "us-west-2" {
		t.Errorf("expected metadata aws_region='us-west-2', got '%v'", result[0]["aws_region"])
	}
	if result[0]["log_group"] != "my-group" {
		t.Errorf("expected metadata log_group='my-group', got '%v'", result[0]["log_group"])
	}
}

func TestParseLogs_SmartDecoder(t *testing.T) {
	tok, _ := NewTokenizer()
	_ = tok.AddPattern("%{GREEDYDATA:message}")

	opts := types.IngestSessionOptions{
		Source:       "test",
		SmartDecoder: true,
	}
	logs := []string{"Connection from 192.168.1.100 to user@example.com"}

	result, _, _, err := tok.ParseLogs(logs, opts)
	if err != nil {
		t.Fatalf("ParseLogs failed: %v", err)
	}

	// Smart decoder should extract IP
	ipField, ok := result[0]["_ipv4_addr"]
	if !ok {
		t.Error("expected _ipv4_addr field from smart decoder")
	}
	if ipStr, ok := ipField.(string); ok {
		if !strings.Contains(ipStr, "192.168.1.100") {
			t.Errorf("expected IP in _ipv4_addr, got '%s'", ipStr)
		}
	}

	// Smart decoder should extract email
	emailField, ok := result[0]["_email_addr"]
	if !ok {
		t.Error("expected _email_addr field from smart decoder")
	}
	if emailStr, ok := emailField.(string); ok {
		if !strings.Contains(emailStr, "user@example.com") {
			t.Errorf("expected email in _email_addr, got '%s'", emailStr)
		}
	}
}

func TestParseLogs_AllLinesMatchWithTimestamp(t *testing.T) {
	tok, _ := NewTokenizer()
	// Use GREEDYDATA which matches everything — verify timestamp is assigned
	_ = tok.AddPattern("%{GREEDYDATA:message}")

	opts := types.IngestSessionOptions{Source: "test"}
	logs := []string{
		"first line without timestamp",
		"second line without timestamp",
	}

	result, success, _, err := tok.ParseLogs(logs, opts)
	if err != nil {
		t.Fatalf("ParseLogs failed: %v", err)
	}
	if success != 2 {
		t.Errorf("expected 2 successes, got %d", success)
	}

	// All lines should have timestamps assigned (current time fallback)
	for i, r := range result {
		if _, ok := r["timestamp"]; !ok {
			t.Errorf("log %d should have a timestamp", i)
		}
	}
}

// ---------------------------------------------------------------------------
// Tokenizer: Thread Safety Smoke Test
// ---------------------------------------------------------------------------

func TestTokenizer_ConcurrentParseLogs(t *testing.T) {
	tok, _ := NewTokenizer()
	_ = tok.AddPattern("%{GREEDYDATA:message}")

	opts := types.IngestSessionOptions{Source: "concurrent-test"}
	logs := []string{"line 1", "line 2", "line 3"}

	done := make(chan bool, 10)
	for i := 0; i < 10; i++ {
		go func() {
			_, _, _, err := tok.ParseLogs(logs, opts)
			if err != nil {
				t.Errorf("concurrent ParseLogs failed: %v", err)
			}
			done <- true
		}()
	}

	for i := 0; i < 10; i++ {
		<-done
	}
}
