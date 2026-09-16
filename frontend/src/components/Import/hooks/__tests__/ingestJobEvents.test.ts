import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForIngestJob } from '../ingestJobEvents';

import type { IngestJob } from '@/lib/api-types';

const { listIngestJobs } = vi.hoisted(() => ({ listIngestJobs: vi.fn() }));

vi.mock('@/lib/api-client', () => ({
  listIngestJobs,
  liveEventsURL: () => 'http://localhost:8080/api/v1/live/events',
}));

class MockEventSource {
  static instances: MockEventSource[] = [];
  onerror: (() => void) | null = null;
  close = vi.fn();
  listeners: Record<string, Array<(event: MessageEvent) => void>> = {};

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners[type] = [...(this.listeners[type] || []), listener];
  }

  emit(type: string, data: unknown) {
    for (const listener of this.listeners[type] || []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  emitRaw(type: string, data: string) {
    for (const listener of this.listeners[type] || []) {
      listener({ data } as MessageEvent);
    }
  }
}

function job(overrides: Partial<IngestJob>): IngestJob {
  return {
    job_id: 'job-1',
    session_id: 'sid-1',
    path: '/abs/app.log',
    members: ['/abs/app.log'],
    bytes_read: 0,
    bytes_total: 1000,
    lines: 0,
    rows_stored: 0,
    rows_failed: 0,
    rate_lines_per_s: 0,
    state: 'running',
    ...overrides,
  };
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('waitForIngestJob', () => {
  it('opens an EventSource against the source_id sentinel and closes it once the job is terminal', async () => {
    const onProgress = vi.fn();
    const promise = waitForIngestJob('job-1', onProgress, new AbortController().signal);
    const es = MockEventSource.instances[0];
    expect(es.url).toContain('source_id=');

    es.emit('ingest_progress', job({ state: 'done', lines: 100 }));
    const result = await promise;

    expect(result.state).toBe('done');
    expect(es.close).toHaveBeenCalledTimes(1);
  });

  it('calls onProgress for a running snapshot and ignores events for a different job_id', async () => {
    const onProgress = vi.fn();
    const promise = waitForIngestJob('job-1', onProgress, new AbortController().signal);
    const es = MockEventSource.instances[0];

    es.emit('ingest_progress', job({ job_id: 'job-other', state: 'running', lines: 999 }));
    es.emit('ingest_progress', job({ state: 'running', lines: 10 }));
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls[0][0].lines).toBe(10);

    es.emit('ingest_progress', job({ state: 'done', lines: 50 }));
    await promise;
  });

  it('ignores a malformed frame rather than rejecting', async () => {
    const promise = waitForIngestJob('job-1', vi.fn(), new AbortController().signal);
    const es = MockEventSource.instances[0];

    es.emitRaw('ingest_progress', 'not-json');
    es.emit('ingest_progress', job({ state: 'done' }));

    await expect(promise).resolves.toMatchObject({ state: 'done' });
  });

  it("does not reject immediately on abort once a job is running -- it waits for the terminal snapshot the caller's own DELETE should produce", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const promise = waitForIngestJob('job-1', vi.fn(), controller.signal);
      const es = MockEventSource.instances[0];

      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(es.close).not.toHaveBeenCalled();

      // The job's own "cancelled" broadcast (driven by the caller's DELETE,
      // independent of this signal) still resolves the wait normally.
      es.emit('ingest_progress', job({ state: 'cancelled' }));
      await expect(promise).resolves.toMatchObject({ state: 'cancelled' });
      expect(es.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up and rejects after the fallback window if no terminal snapshot ever arrives post-abort', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const promise = waitForIngestJob('job-1', vi.fn(), controller.signal);
      const es = MockEventSource.instances[0];

      controller.abort();
      // Attach the rejection handler before advancing the fake clock, so
      // there's no window where the rejection is briefly unhandled.
      const assertion = expect(promise).rejects.toThrow(
        'Import cancel timed out waiting for the job to stop'
      );
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(es.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still resolves via a "hello" reconcile after abort, if it lands before the fallback fires', async () => {
    listIngestJobs.mockResolvedValue({ jobs: [job({ state: 'cancelled' })] });
    const controller = new AbortController();
    const promise = waitForIngestJob('job-1', vi.fn(), controller.signal);
    const es = MockEventSource.instances[0];

    controller.abort();
    es.emit('hello', { subscriber_id: 'sub-1', source_ids: [] });

    await expect(promise).resolves.toMatchObject({ state: 'cancelled' });
    expect(es.close).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately without opening a connection if already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const promise = waitForIngestJob('job-1', vi.fn(), controller.signal);

    await expect(promise).rejects.toThrow('Import cancelled');
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('reconciles via GET /ingest/jobs on the very first "hello", closing the startup race', async () => {
    // The job can finish between the 202 response and this EventSource
    // actually reaching the server -- a small file can race this every
    // time. If a "done" is already sitting in the registry by the time
    // the first "hello" arrives, that must be enough to resolve; no
    // ingest_progress event is required at all.
    listIngestJobs.mockResolvedValue({ jobs: [job({ state: 'done', lines: 100 })] });

    const promise = waitForIngestJob('job-1', vi.fn(), new AbortController().signal);
    const es = MockEventSource.instances[0];

    es.emit('hello', { subscriber_id: 'sub-1', source_ids: [] });

    const result = await promise;
    expect(listIngestJobs).toHaveBeenCalledTimes(1);
    expect(result.lines).toBe(100);
  });

  it('rejects with the registry error when a "hello" reconcile finds the job gone', async () => {
    listIngestJobs.mockResolvedValue({ jobs: [] });

    const promise = waitForIngestJob('job-1', vi.fn(), new AbortController().signal);
    const es = MockEventSource.instances[0];
    es.emit('hello', { subscriber_id: 'sub-1', source_ids: [] });

    await expect(promise).rejects.toThrow('Ingest job disappeared from the registry');
    expect(es.close).toHaveBeenCalledTimes(1);
  });

  it('does not resolve from a reconcile fetch that finds only a still-running job', async () => {
    listIngestJobs.mockResolvedValue({ jobs: [job({ state: 'running', lines: 5 })] });
    const onProgress = vi.fn();

    const promise = waitForIngestJob('job-1', onProgress, new AbortController().signal);
    const es = MockEventSource.instances[0];

    es.emit('hello', { subscriber_id: 'sub-1', source_ids: [] });
    es.emit('hello', { subscriber_id: 'sub-2', source_ids: [] });
    await Promise.resolve();
    await Promise.resolve();

    expect(listIngestJobs).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ lines: 5 }));

    es.emit('ingest_progress', job({ state: 'done', lines: 100 }));
    await promise;
  });
});
