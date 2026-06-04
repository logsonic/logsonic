package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

const defaultSizeBenchmarkMiB = 32

// BenchmarkIndexSizeDense measures storage amplification for a large log file
// whose events fall on one day. Run with -benchtime=1x; LOGSONIC_SIZE_BENCH_MB
// can override the default 32 MiB raw payload.
func BenchmarkIndexSizeDense(b *testing.B) {
	benchmarkIndexSize(b, 1)
}

// BenchmarkIndexSizeSpread measures the fixed cost of date sharding by
// spreading the same raw payload over a year.
func BenchmarkIndexSizeSpread(b *testing.B) {
	benchmarkIndexSize(b, 365)
}

func benchmarkIndexSize(b *testing.B, days int) {
	targetBytes := int64(defaultSizeBenchmarkMiB * 1024 * 1024)
	if raw := os.Getenv("LOGSONIC_SIZE_BENCH_MB"); raw != "" {
		mib, err := strconv.Atoi(raw)
		if err != nil || mib <= 0 {
			b.Fatalf("invalid LOGSONIC_SIZE_BENCH_MB %q", raw)
		}
		targetBytes = int64(mib) * 1024 * 1024
	}

	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		dir := filepath.Join(b.TempDir(), "index")
		store, err := NewStorage(dir)
		if err != nil {
			b.Fatal(err)
		}

		const batchSize = 10_000
		base := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
		var rawBytes int64
		var seq int64
		for rawBytes < targetBytes {
			logs := make([]map[string]interface{}, 0, batchSize)
			for len(logs) < batchSize && rawBytes < targetBytes {
				seq++
				raw := fmt.Sprintf(
					`10.%d.%d.%d - user-%d [01/Jan/2025:00:00:00 +0000] "GET /api/v1/orders/%d?region=eu HTTP/1.1" %d %d "https://app.example.com/orders" "logsonic-size-benchmark/1.0" request_id=req-%012d upstream=orders-api message="upstream connection timeout after 1500ms"`,
					seq%250,
					(seq/250)%250,
					(seq/62_500)%250,
					seq%10_000,
					seq,
					200+(seq%5)*100,
					512+seq%65_536,
					seq,
				)
				rawBytes += int64(len(raw) + 1)
				ts := base.AddDate(0, 0, int(seq%int64(days))).Add(time.Duration(seq%86_400) * time.Second)
				logs = append(logs, map[string]interface{}{
					"timestamp":  ts,
					"_raw":       raw,
					"_src":       "file.access.log",
					"_seq":       seq,
					"client_ip":  fmt.Sprintf("10.%d.%d.%d", seq%250, (seq/250)%250, (seq/62_500)%250),
					"user":       fmt.Sprintf("user-%d", seq%10_000),
					"method":     "GET",
					"url":        fmt.Sprintf("/api/v1/orders/%d?region=eu", seq),
					"status":     strconv.FormatInt(200+(seq%5)*100, 10),
					"bytes":      strconv.FormatInt(512+seq%65_536, 10),
					"referrer":   "https://app.example.com/orders",
					"user_agent": "logsonic-size-benchmark/1.0",
					"request_id": fmt.Sprintf("req-%012d", seq),
					"upstream":   "orders-api",
					"message":    "upstream connection timeout after 1500ms",
					"level":      "error",
				})
			}
			if err := store.Store(logs, "access.log"); err != nil {
				store.Close()
				b.Fatal(err)
			}
		}

		if err := store.Close(); err != nil {
			b.Fatal(err)
		}
		indexBytes, err := directorySize(dir)
		if err != nil {
			b.Fatal(err)
		}

		b.ReportMetric(float64(rawBytes)/(1024*1024), "raw-MiB")
		b.ReportMetric(float64(indexBytes)/(1024*1024), "index-MiB")
		b.ReportMetric(float64(indexBytes)/float64(rawBytes), "index/raw")
		b.ReportMetric(float64(seq), "docs")
	}
}

func directorySize(root string) (int64, error) {
	var total int64
	err := filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total, err
}
