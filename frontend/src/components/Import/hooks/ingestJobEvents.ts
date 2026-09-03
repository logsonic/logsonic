import { liveEventsURL, listIngestJobs } from '@/lib/api-client';
import { IngestJob } from '@/lib/api-types';

// A source_id that no real live-tail source will ever be registered under
// (TailManager.Subscribe does a bare string compare against a source's own
// ID, no allow-list) filters every "rows"/"source_status" frame out of this
// connection, while "ingest_progress" still arrives -- publishBroadcast
// ignores sourceFilter entirely (backend/pkg/server/handlers/live.go). That
// keeps a native-path import's own SSE connection from parsing an unrelated
// live tail's row stream on the same page.
const INGEST_ONLY_SOURCE_FILTER = '__ingest_jobs_only__';

// How long to keep waiting, past an abort, for the job's own terminal
// broadcast before giving up. DELETE /ingest/jobs/{id} cancels the job's
// context and the reader checks it on every line (pkg/ingestfile.Reader.Next),
// so "cancelled" normally arrives within milliseconds -- this bounds the
// wait for the rare case the DELETE request itself failed or its broadcast
// was lost (an EventSource gap; the "hello" reconcile below still covers a
// reconnect).
const ABORT_FALLBACK_MS = 5000;

/**
 * Waits for one ingest job to reach a terminal state (done|cancelled|error)
 * over the live SSE stream, calling onProgress for every "running" snapshot
 * along the way. Resolves/rejects and closes its own EventSource; never
 * left open past that point.
 *
 * "ingest_progress" is a one-shot broadcast -- nothing replays it -- so a
 * terminal event landing during a gap has no other way to reach us. Two
 * such gaps are real, not just theoretical: (1) the job can finish between
 * the 202 response and this EventSource's connection actually reaching the
 * server -- a small/already-cached file can race this every time; (2) an
 * EventSource reconnect (network blip, a server restart mid-import) can
 * miss a broadcast that fired while disconnected. "hello" fires on every
 * (re)connect, including the first, so reconciling via one
 * GET /ingest/jobs call on *every* hello -- not just reconnects -- closes
 * both gaps at the cost of one extra request per import. If the job isn't
 * in that list at all, it's gone from the registry (past its 1h
 * post-completion retention, or the server restarted and lost it) --
 * reject rather than hang, the same as the poll loop this replaced did.
 *
 * Aborting `signal` before a job ever started rejects immediately (nothing
 * to wait for). Aborting once a job is running does NOT reject immediately:
 * the caller is expected to have already told the server to stop (a DELETE
 * on the job, e.g. useUpload's cancelUpload) independently of this signal,
 * and this still waits for that job's own terminal snapshot -- normally
 * "cancelled" within milliseconds -- so the caller doesn't end its session
 * before the job has actually stopped reading it (see TBD.md's now-08 row,
 * phase 8). Only after ABORT_FALLBACK_MS with nothing does it give up and
 * reject with its own distinct message, covering a failed DELETE or a lost
 * broadcast -- distinct because the caller (useUpload.ts) currently
 * flattens every rejection here to "Import cancelled" once its own abort
 * signal fired, which would misreport this specific case as a normal
 * cancel when the job may still be running; recorded as a phase 9 item,
 * not fixed here.
 */
export function waitForIngestJob(
  jobId: string,
  onProgress: (job: IngestJob) => void,
  signal: AbortSignal
): Promise<IngestJob> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Import cancelled'));
      return;
    }

    const es = new EventSource(`${liveEventsURL()}?source_id=${INGEST_ONLY_SOURCE_FILTER}`);
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      settled = true;
      es.close();
      signal.removeEventListener('abort', onAbort);
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    };

    const settle = (job: IngestJob) => {
      if (settled) return;
      cleanup();
      resolve(job);
    };

    // Cancelling the caller's own operation (useUpload's cancelUpload)
    // already sends DELETE /ingest/jobs/{id} independently of this signal --
    // rejecting instantly here, before the job has actually stopped, is
    // what let a still-running goroutine's session get ended out from under
    // it (flagged in TBD.md's now-08 phase 6 note and confirmed by code
    // reading: runIngestFileJob's flush() has no ctx check around its
    // ingestBatch call, so a session ended mid-flush surfaces as job state
    // "error" instead of "cancelled"). So: don't settle on abort. Let the
    // job's own terminal snapshot (from the DELETE-driven cancellation)
    // resolve normally through handleSnapshot below; only give up after
    // ABORT_FALLBACK_MS with nothing.
    const onAbort = () => {
      if (settled || fallbackTimer !== null) return;
      fallbackTimer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error('Import cancel timed out waiting for the job to stop'));
      }, ABORT_FALLBACK_MS);
    };
    signal.addEventListener('abort', onAbort);

    const handleSnapshot = (job: IngestJob) => {
      if (job.job_id !== jobId) return;
      if (job.state === 'running') {
        onProgress(job);
        return;
      }
      settle(job);
    };

    es.addEventListener('ingest_progress', (event) => {
      try {
        handleSnapshot(JSON.parse((event as MessageEvent).data) as IngestJob);
      } catch {
        // Malformed frame: ignore it and keep waiting. A well-formed
        // terminal event, or the reconnect reconcile below, still arrives.
      }
    });

    es.addEventListener('hello', () => {
      listIngestJobs()
        .then((response) => {
          if (settled) return;
          const job = response.jobs.find((j) => j.job_id === jobId);
          if (job) {
            handleSnapshot(job);
            return;
          }
          // Not in the registry at all: it was already terminal and swept
          // past its 1h retention window before this reconcile ran, or the
          // server restarted and lost it. Either way there is nothing left
          // to wait for.
          cleanup();
          reject(new Error('Ingest job disappeared from the registry'));
        })
        .catch(() => {
          // Best-effort reconcile; a later hello or ingest_progress event
          // gets another chance.
        });
    });

    // EventSource retries on its own; there is nothing to do here except
    // wait for the next "hello" once it reconnects.
    es.onerror = () => {};
  });
}
