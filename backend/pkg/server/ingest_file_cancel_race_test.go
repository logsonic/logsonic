package server

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestIngestFileCancelThenImmediateEndRace reproduces the race TBD.md's
// now-08 phase 6 note flagged rather than fixed: the frontend's
// cancelUpload fires DELETE /ingest/jobs/{id} and, once the abort signal
// resolves waitForIngestJob's promise, calls /ingest/end in the same
// synchronous tick -- back-to-back on the client, not waiting for the job
// to actually reach a terminal state first. If the job's own goroutine is
// mid-flush when the session is ended, ingestBatch returns errInvalidSession
// (a bare error, not context.Canceled), so the job can land "error"
// ("invalid or missing session ID") instead of "cancelled" even though the
// user asked to cancel, not to fail.
//
// Off by default -- this is a frequency measurement, not a deterministic
// assertion (the race's window depends on machine speed and Go's own
// scheduler), so it can't safely gate go test ./.... Run explicitly:
//
//	LOGSONIC_RUN_RACE_REPRO=1 go test ./pkg/server -run TestIngestFileCancelThenImmediateEndRace -v
func TestIngestFileCancelThenImmediateEndRace(t *testing.T) {
	if os.Getenv("LOGSONIC_RUN_RACE_REPRO") == "" {
		t.Skip("set LOGSONIC_RUN_RACE_REPRO=1 to run (frequency repro for the cancel-vs-ingestEnd race, now-08 phase 8)")
	}

	const trials = 20
	var cancelled, errored, other, invalidSessionErrors int
	for i := 0; i < trials; i++ {
		_, ts := newTestServer(t, Config{Host: "localhost", Port: ":0"})
		dir := t.TempDir()
		raw, _ := fixtureLines(200_000)
		path := filepath.Join(dir, "big.log")
		if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
			t.Fatal(err)
		}

		sid := startSession(t, ts, fmt.Sprintf("race%d.log", i))
		status, accepted := ingestFile(t, ts, sid, path, false)
		if status != http.StatusAccepted {
			t.Fatalf("trial %d: ingest/file: %d %+v", i, status, accepted)
		}

		// The frontend's actual (buggy) sequence: DELETE then /ingest/end,
		// back-to-back with no wait in between.
		cancelIngestJob(t, ts, accepted.JobID)
		endSession(t, ts, sid)

		job := pollIngestJob(t, ts, accepted.JobID, 5*time.Second)
		switch job.State {
		case "cancelled":
			cancelled++
		case "error":
			errored++
			if job.Error == "invalid or missing session ID" {
				invalidSessionErrors++
			}
		default:
			other++
		}
	}

	t.Logf("repro (now-08 phase 8): %d/%d cancelled, %d/%d error (%d of those the invalid-session signature), %d other", cancelled, trials, errored, trials, invalidSessionErrors, other)
}
