package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"

	"logsonic/pkg/types"
)

// writeFixtureFile writes plain-text log lines (matching startSession's
// "%{WORD:level} %{WORD:service} %{GREEDYDATA:message}" pattern) until the
// file reaches at least targetBytes, buffered so the write itself doesn't
// hold the whole payload in memory.
func writeFixtureFile(t *testing.T, path string, targetBytes int64) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	w := bufio.NewWriterSize(f, 1<<20)
	defer func() {
		if err := w.Flush(); err != nil {
			t.Fatal(err)
		}
	}()

	var written int64
	var seq int64
	for written < targetBytes {
		line := fmt.Sprintf(
			"INFO api req seq=%d client=10.%d.%d.%d status=200 duration_ms=%d message=upstream_call_completed_after_one_retry_attempt\n",
			seq, seq%250, (seq/250)%250, (seq/62_500)%250, seq%500,
		)
		n, werr := w.WriteString(line)
		if werr != nil {
			t.Fatal(werr)
		}
		written += int64(n)
		seq++
	}
}

// H5: a 200 MB file must not balloon heap usage past ingestfile's own batch
// bound (10k lines per StoreWithIDs call, the same batch size chunk-upload
// uses) -- see spec now-08's "Bounds" decision ("Memory stays bounded by the
// batch size"). Streaming + batching, not slurping the whole file, is the
// entire point of this endpoint; this test is the regression guard for that
// property.
//
// Off by default: writing and ingesting 200 MB takes tens of seconds, not
// the sub-second budget `go test ./...` needs to stay usable as a routine
// gate. Run explicitly:
//
//	LOGSONIC_RUN_MEMORY_TEST=1 go test ./pkg/server -run TestIngestFileMemoryBounded -v
func TestIngestFileMemoryBounded(t *testing.T) {
	if os.Getenv("LOGSONIC_RUN_MEMORY_TEST") == "" {
		t.Skip("set LOGSONIC_RUN_MEMORY_TEST=1 to run (writes+ingests a 200 MB fixture; tens of seconds)")
	}

	_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
	dir := t.TempDir()
	path := filepath.Join(dir, "big.log")

	// Overridable (spec says 200 MB; a smaller run is how -race, which slows
	// everything 5-10x, was verified race-free without hitting this test's
	// own 2-minute terminal-state deadline).
	targetBytes := int64(200 * 1024 * 1024)
	if raw := os.Getenv("LOGSONIC_MEM_TEST_MB"); raw != "" {
		mib, err := strconv.Atoi(raw)
		if err != nil || mib <= 0 {
			t.Fatalf("invalid LOGSONIC_MEM_TEST_MB %q", raw)
		}
		targetBytes = int64(mib) * 1024 * 1024
	}
	writeFixtureFile(t, path, targetBytes)

	// Baseline after fixture generation (which itself allocates nothing
	// long-lived past the buffered writer) but before the job starts, so the
	// measured delta is the job's own footprint, not this test's.
	runtime.GC()
	var base runtime.MemStats
	runtime.ReadMemStats(&base)

	sid := startSession(t, ts, "mem.log")
	status, accepted := ingestFile(t, ts, sid, path, false)
	if status != http.StatusAccepted {
		t.Fatalf("ingest/file: %d %+v", status, accepted)
	}

	// One goroutine both samples HeapInuse and polls for the terminal state,
	// at a 250 ms cadence -- polling this loop's own way (rather than the
	// shared pollIngestJob helper's 10 ms loop) keeps ~4,300 extra
	// chi-routed HTTP requests' own allocation out of the very number this
	// test asserts on (an earlier draft using pollIngestJob logged request
	// IDs past 004271 for one run). runtime.MemStats, not `ps` RSS: Bleve mmaps persisted
	// segments, and RSS counts file-backed pages the OS is free to drop for
	// reasons unrelated to what this job actually allocated.
	//
	// maxHeap/finalJob are written only by this goroutine and read only by
	// the test goroutine after <-stopped, which happens-after the writes
	// (channel close), so there is no data race despite no mutex.
	var maxHeap uint64
	var finalJob types.IngestJob
	var timedOut bool
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		deadline := time.Now().Add(2 * time.Minute)
		for range ticker.C {
			var m runtime.MemStats
			runtime.ReadMemStats(&m)
			if m.HeapInuse > maxHeap {
				maxHeap = m.HeapInuse
			}
			resp, err := http.Get(ts.URL + "/api/v1/ingest/jobs")
			if err == nil {
				var out types.IngestJobsListResponse
				json.NewDecoder(resp.Body).Decode(&out)
				resp.Body.Close()
				for _, j := range out.Jobs {
					if j.JobID == accepted.JobID && j.State != "running" {
						finalJob = j
						return
					}
				}
			}
			if time.Now().After(deadline) {
				timedOut = true
				return
			}
		}
	}()
	<-stopped
	endSession(t, ts, sid)

	if timedOut {
		t.Fatalf("job did not reach a terminal state within the test's 2-minute deadline (last known heap delta %.1f MB) -- likely just -race's 5-10x slowdown on a large fixture, not a hang; rerun with a smaller LOGSONIC_MEM_TEST_MB", float64(maxHeap-base.HeapInuse)/(1024*1024))
	}
	if finalJob.State != "done" {
		t.Fatalf("job state = %q, want done: %+v", finalJob.State, finalJob)
	}

	var deltaMB float64
	if maxHeap > base.HeapInuse {
		deltaMB = float64(maxHeap-base.HeapInuse) / (1024 * 1024)
	}
	t.Logf("H5: %d MB fixture, %d rows stored, peak heap delta %.1f MB (budget 150 MB at the spec's 200 MB size)", targetBytes/(1024*1024), finalJob.RowsStored, deltaMB)
	// The 150 MB budget is spec'd for a 200 MB fixture (H5); a smaller
	// LOGSONIC_MEM_TEST_MB override exists only to verify this test itself
	// (e.g. under -race) faster, and isn't held to that number.
	if targetBytes == 200*1024*1024 && deltaMB > 150 {
		t.Fatalf("heap delta %.1f MB exceeds the 150 MB budget (spec now-08 H5)", deltaMB)
	}
}
