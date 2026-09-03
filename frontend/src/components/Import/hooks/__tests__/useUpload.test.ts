import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUpload } from '../useUpload';

import type { ImportFile } from '../../types';
import type { IngestJob } from '@/lib/api-types';

import { useImportStore } from '@/stores/useImportStore';

const { ingestStart, ingestEnd, ingestLogs, ingestFile, listIngestJobs, cancelIngestJob } =
  vi.hoisted(() => ({
    ingestStart: vi.fn(),
    ingestEnd: vi.fn(),
    ingestLogs: vi.fn(),
    ingestFile: vi.fn(),
    listIngestJobs: vi.fn(),
    cancelIngestJob: vi.fn(),
  }));

vi.mock('@/lib/api-client', () => ({
  ingestStart,
  ingestEnd,
  ingestLogs,
  ingestFile,
  listIngestJobs,
  cancelIngestJob,
  liveEventsURL: () => 'http://localhost:8080/api/v1/live/events',
}));

// Same MockEventSource shape as useLogStream.test.tsx, so ingestJobEvents.ts
// (which opens its own EventSource against the same endpoint) is exercised
// against real event dispatch rather than a stubbed promise.
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
}

function makeImportFile(overrides: Partial<ImportFile>): ImportFile {
  return {
    id: 'file-1',
    fileName: 'app.log',
    fileSize: 0,
    previewLines: [],
    approxLines: 0,
    detectedPattern: null,
    selectedPattern: {
      name: 'Custom Pattern',
      pattern: '%{GREEDYDATA:message}',
      description: '',
      priority: 0,
    },
    isCustomPattern: false,
    customPattern: null,
    customPatternTokens: {},
    detectionStatus: 'detected',
    detectionError: null,
    parsedLogs: [],
    uploadStatus: 'pending',
    uploadProgress: 0,
    uploadError: null,
    totalLinesProcessed: 0,
    sessionOptions: { smartDecoder: true, timezone: '', year: '', month: '', day: '' },
    timestampInference: null,
    timestampOverrides: {},
    timestampConfirmed: false,
    sourceMTime: null,
    ...overrides,
  };
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

const noopFileService = { name: 'test', handleFileImport: vi.fn(), handleFilePreview: vi.fn() };

beforeEach(() => {
  useImportStore.getState().reset();
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  // resetAllMocks (not clearAllMocks): clearAllMocks only wipes call
  // history, not queued mockResolvedValueOnce values or a prior test's
  // mockResolvedValue -- either would leak into the next test.
  vi.resetAllMocks();
  ingestStart.mockResolvedValue({ status: 'success', session_id: 'sid-1' });
  ingestEnd.mockResolvedValue({ status: 'success' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useUpload — native-path files (spec now-08, SSE progress)', () => {
  it('starts a job, follows it to done over SSE, and never calls the chunk-upload API', async () => {
    ingestFile.mockResolvedValue({
      status: 'accepted',
      job_id: 'job-1',
      path: '/abs/app.log',
      members: ['/abs/app.log'],
    });

    const { result } = renderHook(() => useUpload());
    const importFile = makeImportFile({ nativePath: '/abs/app.log' });

    const uploadPromise = result.current.handleMultiFileUpload([importFile], noopFileService);
    await act(async () => {
      await Promise.resolve(); // let ingestStart/ingestFile settle before the EventSource exists
    });
    const es = MockEventSource.instances[0];
    act(() => {
      es.emit('ingest_progress', job({ state: 'running', bytes_read: 500, lines: 40 }));
      es.emit(
        'ingest_progress',
        job({ state: 'done', bytes_read: 1000, lines: 100, rows_stored: 100 })
      );
    });
    const uploadResult = await uploadPromise;

    expect(ingestFile).toHaveBeenCalledWith({ session_id: 'sid-1', path: '/abs/app.log' });
    expect(ingestLogs).not.toHaveBeenCalled();
    expect(ingestEnd).toHaveBeenCalledWith('sid-1');
    expect(es.close).toHaveBeenCalled();
    expect(uploadResult.files[0].uploadStatus).toBe('success');
    expect(uploadResult.files[0].totalLinesProcessed).toBe(100);
  });

  it('maps a running snapshot to store progress, rate, and rowsFailed before completion', async () => {
    ingestFile.mockResolvedValue({
      status: 'accepted',
      job_id: 'job-1',
      path: '/abs/app.log',
      members: ['/abs/app.log'],
    });

    const { result } = renderHook(() => useUpload());
    const importFile = makeImportFile({ nativePath: '/abs/app.log' });
    // updateFile (what the SSE handler calls) only updates a file already
    // in the store's files array by id -- seed it, the way the real
    // wizard's addNativePathFiles would.
    useImportStore.setState({ files: [importFile] });

    const uploadPromise = result.current.handleMultiFileUpload([importFile], noopFileService);
    await act(async () => {
      await Promise.resolve();
    });
    const es = MockEventSource.instances[0];
    act(() => {
      es.emit(
        'ingest_progress',
        job({
          state: 'running',
          bytes_read: 250,
          bytes_total: 1000,
          lines: 10,
          rows_failed: 1,
          rate_lines_per_s: 42,
        })
      );
    });

    const updated = () => useImportStore.getState().files.find((f) => f.id === importFile.id);
    expect(updated()?.uploadProgress).toBe(25);
    expect(updated()?.totalLinesProcessed).toBe(10);
    expect(updated()?.ingestRateLinesPerS).toBe(42);
    expect(updated()?.rowsFailed).toBe(1);

    act(() => {
      es.emit('ingest_progress', job({ state: 'done', bytes_read: 1000, lines: 100 }));
    });
    await uploadPromise;
  });

  it('reports the job error on job state "error"', async () => {
    ingestFile.mockResolvedValue({
      status: 'accepted',
      job_id: 'job-1',
      path: '/abs/app.log',
      members: ['/abs/app.log'],
    });

    const { result } = renderHook(() => useUpload());
    const importFile = makeImportFile({ nativePath: '/abs/app.log' });

    const uploadPromise = result.current.handleMultiFileUpload([importFile], noopFileService);
    await act(async () => {
      await Promise.resolve();
    });
    const es = MockEventSource.instances[0];
    act(() => {
      es.emit('ingest_progress', job({ state: 'error', error: 'disk read failed at line 42' }));
    });
    const uploadResult = await uploadPromise;

    expect(uploadResult.files[0].uploadStatus).toBe('failed');
    expect(uploadResult.files[0].uploadError).toBe('disk read failed at line 42');
  });

  it("cancelling calls cancelIngestJob and waits for the job's own cancelled snapshot before ending the session", async () => {
    ingestFile.mockResolvedValue({
      status: 'accepted',
      job_id: 'job-1',
      path: '/abs/app.log',
      members: ['/abs/app.log'],
    });
    cancelIngestJob.mockResolvedValue({ status: 'cancelling' });

    const { result } = renderHook(() => useUpload());
    const importFile = makeImportFile({ nativePath: '/abs/app.log' });

    const uploadPromise = result.current.handleMultiFileUpload([importFile], noopFileService);
    await act(async () => {
      await Promise.resolve();
    });
    const es = MockEventSource.instances[0];

    act(() => {
      result.current.cancelUpload();
    });
    // Aborting alone must not end the session before the job has actually
    // stopped (now-08 phase 8: ending mid-flush surfaces as job state
    // "error", not "cancelled") -- ingestEnd only fires once the job's own
    // terminal snapshot arrives below.
    await act(async () => {
      await Promise.resolve();
    });
    expect(ingestEnd).not.toHaveBeenCalled();

    act(() => {
      es.emit('ingest_progress', job({ state: 'cancelled' }));
    });
    const uploadResult = await uploadPromise;

    expect(cancelIngestJob).toHaveBeenCalledWith('job-1');
    expect(es.close).toHaveBeenCalled();
    expect(ingestEnd).toHaveBeenCalledWith('sid-1');
    expect(uploadResult.files[0].uploadStatus).toBe('failed');
    expect(uploadResult.files[0].uploadError).toBe('Import cancelled');
  });

  it('cancelling gives up after the fallback window if the job never reports a terminal state', async () => {
    vi.useFakeTimers();
    try {
      ingestFile.mockResolvedValue({
        status: 'accepted',
        job_id: 'job-1',
        path: '/abs/app.log',
        members: ['/abs/app.log'],
      });
      cancelIngestJob.mockResolvedValue({ status: 'cancelling' });

      const { result } = renderHook(() => useUpload());
      const importFile = makeImportFile({ nativePath: '/abs/app.log' });

      const uploadPromise = result.current.handleMultiFileUpload([importFile], noopFileService);
      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        result.current.cancelUpload();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      const uploadResult = await uploadPromise;

      expect(uploadResult.files[0].uploadStatus).toBe('failed');
      expect(uploadResult.files[0].uploadError).toBe('Import cancelled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles via GET /ingest/jobs on "hello", closing the race between the 202 and the SSE connect', async () => {
    ingestFile.mockResolvedValue({
      status: 'accepted',
      job_id: 'job-1',
      path: '/abs/app.log',
      members: ['/abs/app.log'],
    });
    listIngestJobs.mockResolvedValue({
      jobs: [job({ state: 'done', bytes_read: 1000, lines: 100 })],
    });

    const { result } = renderHook(() => useUpload());
    const importFile = makeImportFile({ nativePath: '/abs/app.log' });

    const uploadPromise = result.current.handleMultiFileUpload([importFile], noopFileService);
    await act(async () => {
      await Promise.resolve();
    });
    const es = MockEventSource.instances[0];

    // A job that already finished by the time the EventSource's first
    // "hello" arrives (a real race: the job can complete between the 202
    // response and this connection reaching the server) must still
    // resolve -- no ingest_progress event is required.
    act(() => {
      es.emit('hello', { subscriber_id: 'sub-1', source_ids: [] });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const uploadResult = await uploadPromise;

    expect(listIngestJobs).toHaveBeenCalledTimes(1);
    expect(uploadResult.files[0].uploadStatus).toBe('success');
  });
});

describe('useUpload — browser File files (unchanged)', () => {
  it('still streams chunks through the file service and never calls the path-ingest APIs', async () => {
    const fileService = {
      name: 'test',
      handleFileImport: vi.fn(
        async (
          _file: object,
          _chunkSize: number,
          callback: (chunk: {
            lines: string[];
            bytesRead: number;
            totalBytes: number;
          }) => Promise<void>
        ) => {
          await callback({ lines: ['a', 'b'], bytesRead: 100, totalBytes: 100 });
        }
      ),
      handleFilePreview: vi.fn(),
    };
    ingestLogs.mockResolvedValue({ status: 'success' });

    const { result } = renderHook(() => useUpload());
    const browserFile = new File(['a\nb\n'], 'browser.log');
    const importFile = makeImportFile({ id: 'file-2', fileName: 'browser.log', file: browserFile });

    const uploadResult = await result.current.handleMultiFileUpload([importFile], fileService);

    expect(fileService.handleFileImport).toHaveBeenCalled();
    expect(ingestFile).not.toHaveBeenCalled();
    expect(uploadResult.files[0].uploadStatus).toBe('success');
    expect(uploadResult.files[0].totalLinesProcessed).toBe(2);
  });
});
