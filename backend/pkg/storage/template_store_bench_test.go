package storage

import (
	"fmt"
	"testing"
	"time"
)

func templateBenchRows(n, offset int) []map[string]interface{} {
	rows := make([]map[string]interface{}, n)
	for i := range rows {
		s := offset + i
		rows[i] = map[string]interface{}{
			"timestamp": time.Date(2026, 9, 24, 10, (s/60)%60, s%60, s, time.UTC),
			"_src":      "app.log", "_seq": int64(s), "_raw": fmt.Sprintf("INFO user=u%d took=%dms", s%50, s%900),
			"message": fmt.Sprintf("request %d done", s), "level": "INFO",
		}
	}
	return rows
}

// Live tailing commits many tiny segments; startup replays every one.
func BenchmarkTemplateReplayManySegments(b *testing.B) {
	dir := b.TempDir()
	s, err := NewTemplateStorage(dir)
	if err != nil {
		b.Fatal(err)
	}
	const segments = 300
	for i := 0; i < segments; i++ {
		if _, err = s.StoreWithIDs(templateBenchRows(10, i*10), "file"); err != nil {
			b.Fatal(err)
		}
	}
	if err = s.Close(); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		s, err = NewTemplateStorage(dir)
		if err != nil {
			b.Fatal(err)
		}
		b.StopTimer()
		if n, _ := s.GetDocCount("2026-09-24"); n != segments*10 {
			b.Fatalf("replayed %d docs", n)
		}
		_ = s.Close()
		b.StartTimer()
	}
}

// One small live-tail flush: encode, write, fsync, rename, index.
func BenchmarkTemplateCommitSmallBatch(b *testing.B) {
	s, err := NewTemplateStorage(b.TempDir())
	if err != nil {
		b.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err = s.StoreWithIDs(templateBenchRows(10, i*10), "file"); err != nil {
			b.Fatal(err)
		}
	}
}
