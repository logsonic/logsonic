// Package main implements the now-11 §8 performance-budget bench harness.
// It is a standalone Go program (not testing.B) so it can control corpus
// size, warm-up discarding, and JSON output shape independently of `go test`.
//
// Usage: go run ./bench [-out path] [-storage-dir path]
// Env vars (all optional, defaults sized to finish in well under a minute so
// the harness is runnable in a normal dev loop; nightly.yml overrides them
// for the real §8-scale numbers):
//
//	LOGSONIC_BENCH_LINES              corpus size for import/search scenarios (default 100000)
//	LOGSONIC_BENCH_DAYS               days the corpus spreads over (default 1)
//	LOGSONIC_BENCH_STARTUP_DAYS       number of day-indices for the storage_open scenario (default 365)
//	LOGSONIC_BENCH_STARTUP_DOCS_PER_DAY docs per day-index for storage_open (default 50; the scenario
//	                                   measures per-index open overhead, not row count)
//	LOGSONIC_BENCH_ITERATIONS         search iterations kept per percentile (default 30)
//	LOGSONIC_BENCH_WARMUP             search iterations discarded as warm-up, run first (default 5)
package main

import (
	"fmt"
	"strconv"
	"time"

	"logsonic/pkg/storage"
)

// generateLine deterministically derives one Apache-style access log line
// and its indexed fields from seq alone, so the same seq always produces the
// same line (bench_test.go asserts this) and hit counts for known query
// terms are computable without running a query first.
func generateLine(seq int64) (raw string, fields map[string]interface{}) {
	statusCode := 200 + (seq%5)*100
	userID := seq % 10_000
	bytesOut := 512 + seq%65_536
	raw = fmt.Sprintf(
		`10.%d.%d.%d - user-%d [01/Jan/2025:00:00:00 +0000] "GET /api/v1/orders/%d?region=eu HTTP/1.1" %d %d "https://app.example.com/orders" "logsonic-bench/1.0" request_id=req-%012d`,
		seq%250, (seq/250)%250, (seq/62_500)%250,
		userID, seq, statusCode, bytesOut, seq,
	)
	fields = map[string]interface{}{
		"_raw":       raw,
		"_src":       "bench.access.log",
		"_seq":       seq,
		"status":     strconv.FormatInt(statusCode, 10),
		"user":       fmt.Sprintf("user-%d", userID),
		"method":     "GET",
		"url":        fmt.Sprintf("/api/v1/orders/%d?region=eu", seq),
		"bytes":      strconv.FormatInt(bytesOut, 10),
		"request_id": fmt.Sprintf("req-%012d", seq),
		// traceid is a single alphanumeric token (no "-", unlike user/request_id
		// above) so the standard analyzer indexes it as one term per document.
		// The point-lookup search scenario needs that: a hyphenated value like
		// "user-42" tokenizes to ["user","42"], and a match query on the "user"
		// token alone hits every document (every value shares that prefix
		// token) -- found by running the harness and seeing 100% hits on a
		// query meant to be rare. traceid sidesteps the whole quoting/analyzer
		// question rather than relying on phrase-query escaping.
		"traceid": fmt.Sprintf("traceid%012d", seq),
	}
	return raw, fields
}

// corpusTimestamp spreads seq across `days` calendar days starting at base,
// one second apart within a day (matching index_size_benchmark_test.go's
// existing spread convention for BenchmarkIndexSizeSpread).
func corpusTimestamp(base time.Time, seq int64, days int) time.Time {
	if days < 1 {
		days = 1
	}
	return base.AddDate(0, 0, int(seq%int64(days))).Add(time.Duration(seq%86_400) * time.Second)
}

const corpusBatchSize = 10_000

// buildCorpus stores `lines` deterministic documents spread over `days` days
// into a fresh Storage at dir, timing only the Store calls (index open is
// billed separately by the storage_open scenario).
func buildCorpus(dir string, lines int64, days int) (store *storage.Storage, importElapsed time.Duration, err error) {
	store, err = storage.NewStorage(dir)
	if err != nil {
		return nil, 0, fmt.Errorf("open storage: %w", err)
	}
	base := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)

	started := time.Now()
	var seq int64
	for seq < lines {
		batch := make([]map[string]interface{}, 0, corpusBatchSize)
		for len(batch) < corpusBatchSize && seq < lines {
			_, fields := generateLine(seq)
			fields["timestamp"] = corpusTimestamp(base, seq, days)
			batch = append(batch, fields)
			seq++
		}
		if err := store.Store(batch, "bench.access.log"); err != nil {
			_ = store.Close()
			return nil, 0, fmt.Errorf("store batch ending at seq %d: %w", seq, err)
		}
	}
	return store, time.Since(started), nil
}

// corpusRange returns the [start, end] timestamp bounds a search over the
// whole generated corpus must use to select every day-index buildCorpus wrote.
func corpusRange(days int) (start, end time.Time) {
	base := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	if days < 1 {
		days = 1
	}
	return base, base.AddDate(0, 0, days-1).Add(24*time.Hour - time.Second)
}
