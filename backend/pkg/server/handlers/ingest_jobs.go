package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"sync"
	"time"

	"logsonic/pkg/ingestfile"
	"logsonic/pkg/types"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

const (
	ingestJobStateRunning   = "running"
	ingestJobStateDone      = "done"
	ingestJobStateCancelled = "cancelled"
	ingestJobStateError     = "error"

	// ingestJobWallClock bounds a single job so a stuck read (a hung
	// network mount, a pathological file) can't run forever; see spec
	// now-08's "Bounds" decision.
	ingestJobWallClock = 6 * time.Hour

	// ingestProgressInterval is the minimum gap between "ingest_progress"
	// SSE broadcasts for one job (spec now-08 decision list).
	ingestProgressInterval = 250 * time.Millisecond

	// ingestProgressLineStride is how often (in physical lines) the job's
	// counters are updated and a broadcast is attempted, independent of
	// ingestFileBatchLines (the store-batch size). Decoupling the two
	// means progress on a single multi-million-line member doesn't wait a
	// full 10k-line batch, without adding a lock/publish call per line.
	ingestProgressLineStride = 1000
)

// ingestJob tracks one POST /ingest/file job. mu guards every field the
// runner goroutine and the HTTP handlers (snapshot, cancel) both touch.
type ingestJob struct {
	id          string
	sessionID   string
	path        string
	members     []string
	compression string
	bytesTotal  int64
	startedAt   time.Time

	cancel context.CancelFunc

	mu         sync.Mutex
	bytesRead  int64
	lines      int64
	rowsStored int64
	rowsFailed int64
	state      string
	errMsg     string
	// finishedAt is zero while running. Set once, by finish(); used both to
	// freeze rate_lines_per_s (otherwise it would keep decaying forever
	// after completion, since elapsed time keeps growing but lines does
	// not) and to age the job out of the registry (pruneFinishedIngestJobs).
	finishedAt time.Time
}

func (j *ingestJob) snapshot() types.IngestJob {
	j.mu.Lock()
	defer j.mu.Unlock()
	end := time.Now()
	if !j.finishedAt.IsZero() {
		end = j.finishedAt
	}
	elapsed := end.Sub(j.startedAt).Seconds()
	var rate float64
	if elapsed > 0 {
		rate = float64(j.lines) / elapsed
	}
	return types.IngestJob{
		JobID:         j.id,
		SessionID:     j.sessionID,
		Path:          j.path,
		Members:       j.members,
		Compression:   j.compression,
		BytesRead:     j.bytesRead,
		BytesTotal:    j.bytesTotal,
		Lines:         j.lines,
		RowsStored:    j.rowsStored,
		RowsFailed:    j.rowsFailed,
		RateLinesPerS: rate,
		State:         j.state,
		Error:         j.errMsg,
	}
}

func (j *ingestJob) updateProgress(bytesRead, lines int64) {
	j.mu.Lock()
	j.bytesRead = bytesRead
	j.lines = lines
	j.mu.Unlock()
}

func (j *ingestJob) addStored(processed, failed int) {
	j.mu.Lock()
	j.rowsStored += int64(processed)
	j.rowsFailed += int64(failed)
	j.mu.Unlock()
}

func (j *ingestJob) finish(state, errMsg string) {
	j.mu.Lock()
	j.state = state
	j.errMsg = errMsg
	j.finishedAt = time.Now()
	j.mu.Unlock()
}

func (j *ingestJob) currentState() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.state
}

// olderThan reports whether a finished job's finishedAt is before cutoff.
// A still-running job (zero finishedAt) is never eligible.
func (j *ingestJob) olderThan(cutoff time.Time) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return !j.finishedAt.IsZero() && j.finishedAt.Before(cutoff)
}

var (
	ingestJobsMu sync.RWMutex
	ingestJobs   = make(map[string]*ingestJob)
)

// ingestJobRetention is how long a finished job stays in GET /ingest/jobs
// after reaching a terminal state -- long enough for a UI that lost its SSE
// connection mid-job to reconnect and see the final state, short enough
// that a long-running server doesn't accumulate one entry per file ever
// imported. Mirrors sessionMap's SessionTimeout + StartSessionCleanup.
const ingestJobRetention = 1 * time.Hour

// pruneFinishedIngestJobs removes jobs that finished before cutoff.
func pruneFinishedIngestJobs(cutoff time.Time) {
	ingestJobsMu.Lock()
	defer ingestJobsMu.Unlock()
	for id, job := range ingestJobs {
		if job.olderThan(cutoff) {
			delete(ingestJobs, id)
		}
	}
}

// StartIngestJobCleanup launches a background goroutine that sweeps the job
// registry every 5 minutes (same cadence as StartSessionCleanup) and drops
// jobs that finished more than ingestJobRetention ago. Runs until ctx is
// cancelled.
func StartIngestJobCleanup(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				pruneFinishedIngestJobs(time.Now().Add(-ingestJobRetention))
			case <-ctx.Done():
				return
			}
		}
	}()
}

// statMembersTotal sums the on-disk size of every member so BytesTotal is
// known before the job starts reading (ingestfile.Reader only reports the
// size of the member it currently has open). A stat failure just leaves
// that member's contribution at 0 -- the job will still report accurate
// BytesRead, only the total (and therefore a UI's percentage) degrades.
func statMembersTotal(members []string) int64 {
	var total int64
	for _, m := range members {
		if st, err := os.Stat(m); err == nil {
			total += st.Size()
		}
	}
	return total
}

// startIngestFileJob registers a new job and runs it on its own goroutine.
// It returns immediately with the job so the caller can respond 202 without
// waiting for any of the file to be read. The job's context (and therefore
// job.cancel) is created here, before the goroutine starts, so a DELETE
// that lands the instant after this call returns is never racing an unset
// job.cancel.
func (h *Services) startIngestFileJob(sessionID, canonicalPath string, members []string, compression string) *ingestJob {
	ctx, cancel := context.WithTimeout(h.ingestJobsCtx, ingestJobWallClock)
	job := &ingestJob{
		id:          uuid.New().String(),
		sessionID:   sessionID,
		path:        canonicalPath,
		members:     members,
		compression: compression,
		bytesTotal:  statMembersTotal(members),
		startedAt:   time.Now(),
		state:       ingestJobStateRunning,
		cancel:      cancel,
	}

	ingestJobsMu.Lock()
	ingestJobs[job.id] = job
	ingestJobsMu.Unlock()

	go h.runIngestFileJob(ctx, job)
	return job
}

// runIngestFileJob reads every member in order, storing lines through the
// same ingestBatch the chunk-upload and phase-1 synchronous paths use, and
// broadcasts "ingest_progress" as it goes. It is the only writer of a job's
// mutable fields after creation. ctx is job.cancel's context, created by the
// caller before this goroutine started (see startIngestFileJob).
func (h *Services) runIngestFileJob(ctx context.Context, job *ingestJob) {
	defer job.cancel()

	lastPublish := time.Now()
	publish := func(force bool) {
		if !force && time.Since(lastPublish) < ingestProgressInterval {
			return
		}
		lastPublish = time.Now()
		if h.Live != nil {
			h.Live.publishBroadcast("ingest_progress", job.snapshot())
		}
	}

	var bytesBase, linesBase int64
	var finalErr error

memberLoop:
	for _, member := range job.members {
		reader, openErr := ingestfile.Open(ctx, member)
		if openErr != nil {
			finalErr = fmt.Errorf("cannot open %s: %w", member, openErr)
			break
		}

		batch := make([]string, 0, ingestFileBatchLines)
		flush := func() error {
			if len(batch) == 0 {
				return nil
			}
			processed, failed, ingestErr := h.ingestBatch(job.sessionID, batch)
			batch = batch[:0]
			if ingestErr != nil {
				return ingestErr
			}
			job.addStored(processed, failed)
			return nil
		}

		var readErr error
		for {
			line, ok, nextErr := reader.Next()
			if nextErr != nil {
				readErr = nextErr
				break
			}
			if !ok {
				break
			}
			batch = append(batch, line)
			if len(batch) == ingestFileBatchLines {
				if err := flush(); err != nil {
					readErr = err
					break
				}
			}
			if reader.Lines()%ingestProgressLineStride == 0 {
				job.updateProgress(bytesBase+reader.BytesRead(), linesBase+int64(reader.Lines()))
				publish(false)
			}
		}
		if readErr == nil {
			readErr = flush()
		}

		bytesBase += reader.BytesRead()
		linesBase += int64(reader.Lines())
		job.updateProgress(bytesBase, linesBase)
		reader.Close()

		if readErr != nil {
			finalErr = fmt.Errorf("%s: %w", member, readErr)
			break memberLoop
		}
		publish(true)
	}

	switch {
	case finalErr != nil && errors.Is(finalErr, context.Canceled):
		job.finish(ingestJobStateCancelled, "")
	case finalErr != nil && errors.Is(finalErr, context.DeadlineExceeded):
		job.finish(ingestJobStateError, fmt.Sprintf("ingest exceeded the %s wall-clock limit", ingestJobWallClock))
	case finalErr != nil:
		job.finish(ingestJobStateError, finalErr.Error())
	default:
		job.finish(ingestJobStateDone, "")
	}
	publish(true)
}

// @Summary List path-ingest jobs
// @Description List every path-based ingest job started this server run (running or finished), for a UI reconnecting to a job it lost SSE contact with.
// @Tags ingest
// @Produce json
// @Success 200 {object} types.IngestJobsListResponse
// @Router /ingest/jobs [get]
func (h *Services) HandleListIngestJobs(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	ingestJobsMu.RLock()
	jobs := make([]types.IngestJob, 0, len(ingestJobs))
	for _, job := range ingestJobs {
		jobs = append(jobs, job.snapshot())
	}
	ingestJobsMu.RUnlock()

	sort.Slice(jobs, func(i, k int) bool { return jobs[i].JobID < jobs[k].JobID })
	json.NewEncoder(w).Encode(types.IngestJobsListResponse{Jobs: jobs})
}

// @Summary Cancel a path-ingest job
// @Description Cancel a running path-based ingest job. A no-op (200, the job's own terminal state) if it already finished.
// @Tags ingest
// @Produce json
// @Param id path string true "Job ID"
// @Success 200 {object} types.IngestJobActionResponse
// @Failure 404 {object} types.ErrorResponse
// @Router /ingest/jobs/{id} [delete]
func (h *Services) HandleCancelIngestJob(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	id := chi.URLParam(r, "id")
	ingestJobsMu.RLock()
	job, ok := ingestJobs[id]
	ingestJobsMu.RUnlock()
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(types.ErrorResponse{
			Status: "error", Error: "no such ingest job", Code: "NOT_FOUND", Details: id,
		})
		return
	}

	if job.currentState() != ingestJobStateRunning {
		json.NewEncoder(w).Encode(types.IngestJobActionResponse{Status: job.currentState()})
		return
	}

	job.mu.Lock()
	cancel := job.cancel
	job.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	json.NewEncoder(w).Encode(types.IngestJobActionResponse{Status: "cancelling"})
}
