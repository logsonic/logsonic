import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NATIVE_JOB_POLL_INTERVAL_MS, useUpload } from '../useUpload';

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
}));

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
  // resetAllMocks (not clearAllMocks): clearAllMocks only wipes call
  // history, not queued mockResolvedValueOnce values or a prior test's
  // mockResolvedValue -- either would leak into the next test and was
  // caught here (tests passed in isolation, failed as a suite).
  vi.resetAllMocks();
  ingestStart.mockResolvedValue({ status: 'success', session_id: 'sid-1' });
  ingestEnd.mockResolvedValue({ status: 'success' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useUpload — native-path files (spec now-08)', () => {
  it('starts a job, polls to done, and never calls the chunk-upload API', async () => {
    vi.useFakeTimers();
    ingestFile.mockResolvedValue({
      status: 'accepted',
      job_id: 'job-1',
      path: '/abs/app.log',
      members: ['/abs/app.log'],
    });
    listIngestJobs
      .mockResolvedValueOnce({
        jobs: [job({ state: 'running', bytes_read: 500, rows_stored: 40 })],
      })
      .mockResolvedValueOnce({
        jobs: [job({ state: 'done', bytes_read: 1000, rows_stored: 100 })],
      });

    const { result } = renderHook(() => useUpload());
    const importFile = makeImportFile({ nativePath: '/abs/app.log' });

    const uploadPromise = result.current.handleMultiFileUpload([importFile], noopFileService);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NATIVE_JOB_POLL_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(NATIVE_JOB_POLL_INTERVAL_MS);
    });
    const uploadResult = await uploadPromise;

    expect(ingestFile).toHaveBeenCalledWith({ session_id: 'sid-1', path: '/abs/app.log' });
    expect(ingestLogs).not.toHaveBeenCalled();
    expect(ingestEnd).toHaveBeenCalledWith('sid-1');
    expect(uploadResult.files[0].uploadStatus).toBe('success');
    expect(uploadResult.files[0].totalLinesProcessed).toBe(100);
  });

  it('maps in-progress job snapshots to store progress before completion', async () => {
    vi.useFakeTimers();
    ingestFile.mockResolvedValue({
      status: 'accepted',
      job_id: 'job-1',
      path: '/abs/app.log',
      members: ['/abs/app.log'],
    });
    listIngestJobs
      .mockResolvedValueOnce({
        jobs: [job({ state: 'running', bytes_read: 250, bytes_total: 1000, rows_stored: 10 })],
      })
      .mockResolvedValueOnce({
        jobs: [job({ state: 'done', bytes_read: 1000, rows_stored: 100 })],
      });

    const { result } = renderHook(() => useUpload());
    const importFile = makeImportFile({ nativePath: '/abs/app.log' });
    // updateFile (what the poll loop calls) only updates a file already
    // in the store's files array by id -- seed it, the way the real
    // wizard's addNativePathFiles would.
    useImportStore.setState({ files: [importFile] });

    const uploadPromise = result.current.handleMultiFileUpload([importFile], noopFileService);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NATIVE_JOB_POLL_INTERVAL_MS);
    });
    // After exactly one poll, the store should reflect the "running"
    // snapshot's progress (250/1000 = 25%), not 0 and not 100 yet.
    expect(
      useImportStore.getState().files.find((f) => f.id === importFile.id)?.uploadProgress
    ).toBe(25);
    expect(
      useImportStore.getState().files.find((f) => f.id === importFile.id)?.totalLinesProcessed
    ).toBe(10);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(NATIVE_JOB_POLL_INTERVAL_MS);
    });
    await uploadPromise;
  });

  it('reports the job error on job state "error"', async () => {
    vi.useFakeTimers();
    ingestFile.mockResolvedValue({
      status: 'accepted',
      job_id: 'job-1',
      path: '/abs/app.log',
      members: ['/abs/app.log'],
    });
    listIngestJobs.mockResolvedValueOnce({
      jobs: [job({ state: 'error', error: 'disk read failed at line 42' })],
    });

    const { result } = renderHook(() => useUpload());
    const importFile = makeImportFile({ nativePath: '/abs/app.log' });

    const uploadPromise = result.current.handleMultiFileUpload([importFile], noopFileService);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NATIVE_JOB_POLL_INTERVAL_MS);
    });
    const uploadResult = await uploadPromise;

    expect(uploadResult.files[0].uploadStatus).toBe('failed');
    expect(uploadResult.files[0].uploadError).toBe('disk read failed at line 42');
  });

  it('cancelling calls cancelIngestJob for the in-flight job and marks the file failed', async () => {
    vi.useFakeTimers();
    ingestFile.mockResolvedValue({
      status: 'accepted',
      job_id: 'job-1',
      path: '/abs/app.log',
      members: ['/abs/app.log'],
    });
    cancelIngestJob.mockResolvedValue({ status: 'cancelling' });
    // The job never reports "done" in this test -- cancellation is what
    // ends the loop, via the abort signal the poll loop checks each
    // iteration, not via a "cancelled" state from the server.
    listIngestJobs.mockResolvedValue({
      jobs: [job({ state: 'running', bytes_read: 100, rows_stored: 5 })],
    });

    const { result } = renderHook(() => useUpload());
    const importFile = makeImportFile({ nativePath: '/abs/app.log' });

    const uploadPromise = result.current.handleMultiFileUpload([importFile], noopFileService);
    // Let the job start and one poll happen so activeJobIdRef is set.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NATIVE_JOB_POLL_INTERVAL_MS);
    });

    act(() => {
      result.current.cancelUpload();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(NATIVE_JOB_POLL_INTERVAL_MS);
    });
    const uploadResult = await uploadPromise;

    expect(cancelIngestJob).toHaveBeenCalledWith('job-1');
    expect(uploadResult.files[0].uploadStatus).toBe('failed');
    expect(uploadResult.files[0].uploadError).toBe('Import cancelled');
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
    expect(listIngestJobs).not.toHaveBeenCalled();
    expect(uploadResult.files[0].uploadStatus).toBe('success');
    expect(uploadResult.files[0].totalLinesProcessed).toBe(2);
  });
});
