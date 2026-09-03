package handlers

import (
	"testing"
	"time"
)

// TestPruneFinishedIngestJobsDropsOnlyOldTerminalJobs exercises
// pruneFinishedIngestJobs directly against the package-level registry: a
// still-running job (zero finishedAt) is never eligible regardless of age,
// a terminal job younger than the cutoff survives, and a terminal job older
// than the cutoff is removed.
func TestPruneFinishedIngestJobsDropsOnlyOldTerminalJobs(t *testing.T) {
	ingestJobsMu.Lock()
	ingestJobs = make(map[string]*ingestJob) // isolate from any other test's state
	running := &ingestJob{id: "running", state: ingestJobStateRunning}
	recent := &ingestJob{id: "recent", state: ingestJobStateDone, finishedAt: time.Now().Add(-1 * time.Minute)}
	stale := &ingestJob{id: "stale", state: ingestJobStateDone, finishedAt: time.Now().Add(-2 * time.Hour)}
	ingestJobs[running.id] = running
	ingestJobs[recent.id] = recent
	ingestJobs[stale.id] = stale
	ingestJobsMu.Unlock()

	pruneFinishedIngestJobs(time.Now().Add(-ingestJobRetention))

	ingestJobsMu.RLock()
	defer ingestJobsMu.RUnlock()
	if _, ok := ingestJobs["running"]; !ok {
		t.Error("running job was pruned despite never having finished")
	}
	if _, ok := ingestJobs["recent"]; !ok {
		t.Error("recently finished job was pruned before its retention window elapsed")
	}
	if _, ok := ingestJobs["stale"]; ok {
		t.Error("job finished well past the retention window was not pruned")
	}
}

// TestIngestJobSnapshotFreezesRateAfterFinish confirms rate_lines_per_s is
// computed against finishedAt once a job is terminal, not against
// time.Now() -- otherwise the rate would keep decaying the longer a
// finished job sits in the registry before a client reads it.
func TestIngestJobSnapshotFreezesRateAfterFinish(t *testing.T) {
	job := &ingestJob{
		id:         "rate-test",
		startedAt:  time.Now().Add(-10 * time.Second),
		lines:      100,
		state:      ingestJobStateDone,
		finishedAt: time.Now().Add(-9 * time.Second), // finished after 1s of work
	}
	first := job.snapshot()
	time.Sleep(20 * time.Millisecond)
	second := job.snapshot()
	if first.RateLinesPerS != second.RateLinesPerS {
		t.Fatalf("rate changed after finish: %v -> %v, want stable", first.RateLinesPerS, second.RateLinesPerS)
	}
	if first.RateLinesPerS < 90 || first.RateLinesPerS > 110 {
		t.Fatalf("rate = %v, want ~100 lines/s (100 lines over the 1s between startedAt and finishedAt)", first.RateLinesPerS)
	}
}
