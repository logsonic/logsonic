package main

import (
	"testing"
	"time"
)

func TestGenerateLineIsDeterministic(t *testing.T) {
	raw1, fields1 := generateLine(42)
	raw2, fields2 := generateLine(42)
	if raw1 != raw2 {
		t.Fatalf("generateLine(42) raw differs between calls:\n%s\nvs\n%s", raw1, raw2)
	}
	if fields1["status"] != fields2["status"] || fields1["user"] != fields2["user"] {
		t.Fatalf("generateLine(42) fields differ between calls: %v vs %v", fields1, fields2)
	}
}

func TestGenerateLineStatusCycles(t *testing.T) {
	// seq%5==3 -> 200+3*100 = 500, per generateLine's status formula.
	_, fields := generateLine(3)
	if fields["status"] != "500" {
		t.Fatalf("generateLine(3) status = %v, want 500", fields["status"])
	}
	_, fields = generateLine(8) // 8%5 == 3
	if fields["status"] != "500" {
		t.Fatalf("generateLine(8) status = %v, want 500", fields["status"])
	}
}

func TestGenerateLineUserCycles(t *testing.T) {
	_, fields := generateLine(42)
	if fields["user"] != "user-42" {
		t.Fatalf("generateLine(42) user = %v, want user-42", fields["user"])
	}
	_, fields = generateLine(10_042) // 10042 % 10000 == 42
	if fields["user"] != "user-42" {
		t.Fatalf("generateLine(10042) user = %v, want user-42", fields["user"])
	}
}

func TestGenerateLineTraceIDIsUniqueToken(t *testing.T) {
	_, fields := generateLine(42)
	if fields["traceid"] != "traceid000000000042" {
		t.Fatalf("generateLine(42) traceid = %v, want traceid000000000042", fields["traceid"])
	}
}

func TestPercentileEmpty(t *testing.T) {
	if got := percentile(nil, 0.5); got != 0 {
		t.Fatalf("percentile(nil) = %v, want 0", got)
	}
}

func TestPercentileNearestRank(t *testing.T) {
	durations := []time.Duration{
		10 * time.Millisecond, 20 * time.Millisecond, 30 * time.Millisecond,
		40 * time.Millisecond, 100 * time.Millisecond,
	}
	if got := percentile(durations, 0.50); got != 30*time.Millisecond {
		t.Fatalf("p50 = %v, want 30ms", got)
	}
	if got := percentile(durations, 0.95); got != 100*time.Millisecond {
		t.Fatalf("p95 = %v, want 100ms", got)
	}
}

func TestCorpusTimestampSpreadsAcrossDays(t *testing.T) {
	base := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	ts0 := corpusTimestamp(base, 0, 3)
	ts1 := corpusTimestamp(base, 1, 3)
	if ts0.Day() != 1 || ts1.Day() != 2 {
		t.Fatalf("expected seq 0 on day 1 and seq 1 on day 2, got %v and %v", ts0, ts1)
	}
}
