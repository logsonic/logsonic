package handlers

import (
	"fmt"
	"testing"
)

// Timestamp-only lines: the broad rule is never cached, so every batch pays discovery.
func adaptiveTimestampOnlyBatch(n, offset int) []string {
	lines := make([]string, n)
	for i := range lines {
		s := offset + i
		lines[i] = fmt.Sprintf("2026-09-24T10:%02d:%02dZ opaque message number %d", (s/60)%60, s%60, s)
	}
	return lines
}

func BenchmarkAdaptiveDecodeTimestampOnlyStream(b *testing.B) {
	for _, size := range []int{100, 1000} {
		b.Run(fmt.Sprintf("batch%d", size), func(b *testing.B) {
			decoder := newAdaptiveDecoder(false)
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				got := decoder.Decode(adaptiveTimestampOnlyBatch(size, i*size))
				if !got[0].Matched {
					b.Fatal("timestamp lost")
				}
			}
		})
	}
}

func BenchmarkAdaptiveDecodeStructuredStream(b *testing.B) {
	decoder := newAdaptiveDecoder(false)
	lines := make([]string, 1000)
	for i := range lines {
		lines[i] = fmt.Sprintf(`10.0.%d.%d - - [23/Jan/2026:14:05:01 +0000] "GET /a%d HTTP/1.1" 200 %d "-" "ua"`, i%250, i%200, i, i)
	}
	decoder.Decode(lines)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		decoder.Decode(lines)
	}
}

// Concurrent /ingest/logs chunks on one auto session.
func BenchmarkAdaptiveDecodeStructuredParallel(b *testing.B) {
	decoder := newAdaptiveDecoder(false)
	lines := make([]string, 1000)
	for i := range lines {
		lines[i] = fmt.Sprintf(`10.0.%d.%d - - [23/Jan/2026:14:05:01 +0000] "GET /a%d HTTP/1.1" 200 %d "-" "ua"`, i%250, i%200, i, i)
	}
	decoder.Decode(lines)
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			decoder.Decode(lines)
		}
	})
}
