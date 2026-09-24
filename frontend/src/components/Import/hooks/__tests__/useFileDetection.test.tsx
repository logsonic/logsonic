import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { matchRateOf, NO_PATTERN_DETECTED, useFileDetection } from '../useFileDetection';

import { DEFAULT_PATTERN, useImportStore } from '@/stores/useImportStore';

const { previewFile, suggestPatterns, parseLogs } = vi.hoisted(() => ({
  previewFile: vi.fn(),
  suggestPatterns: vi.fn(),
  parseLogs: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({ previewFile, suggestPatterns, parseLogs }));

beforeEach(() => {
  useImportStore.getState().reset();
  // resetAllMocks, not clearAllMocks: a queued mockResolvedValueOnce or a
  // prior test's mockResolvedValue must not leak into the next test.
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const suggestion = {
  results: [
    {
      pattern: '%{GREEDYDATA:message}',
      pattern_name: 'Generic',
      pattern_description: 'desc',
      custom_patterns: {},
    },
  ],
  multiline: { enabled: false },
};

describe('useFileDetection — native-path files (spec now-08 phase 5)', () => {
  it('detects a pattern via POST /parse/preview-file, using the server approx_lines and sourceMTime', async () => {
    previewFile.mockResolvedValue({
      lines: ['a', 'b', 'c'],
      approx_lines: 5000,
      compressed: '',
      size_bytes: 123456,
    });
    suggestPatterns.mockResolvedValue(suggestion);
    parseLogs.mockResolvedValue({
      logs: [{ message: 'a' }, { message: 'b' }, { message: 'c' }],
      timestamp_inference: null,
    });

    useImportStore.getState().addNativePathFiles(['/abs/app.log'], ['2024-01-01T00:00:00.000Z']);
    const fileId = useImportStore.getState().files[0].id;

    renderHook(() => useFileDetection());

    await waitFor(() => {
      expect(useImportStore.getState().files.find((f) => f.id === fileId)?.detectionStatus).toBe(
        'detected'
      );
    });

    expect(previewFile).toHaveBeenCalledWith({ path: '/abs/app.log' });
    // approx_lines from the server (5000), not previewLines.length (3).
    const updated = useImportStore.getState().files.find((f) => f.id === fileId)!;
    expect(updated.approxLines).toBe(5000);
    expect(updated.selectedPattern?.name).toBe('Generic');
    expect(updated.isCustomPattern).toBe(false);
    expect(parseLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        session_options: expect.objectContaining({ source_mtime: '2024-01-01T00:00:00.000Z' }),
      })
    );
  });

  it('reports a failed detection with the preview-file error, not a hardcoded "not implemented" message', async () => {
    previewFile.mockRejectedValue(new Error('READ_ERROR: cannot read file'));
    useImportStore.getState().addNativePathFiles(['/abs/bad.log']);
    const fileId = useImportStore.getState().files[0].id;

    renderHook(() => useFileDetection());

    await waitFor(() => {
      expect(useImportStore.getState().files.find((f) => f.id === fileId)?.detectionStatus).toBe(
        'failed'
      );
    });
    const updated = useImportStore.getState().files.find((f) => f.id === fileId)!;
    expect(updated.detectionError).toBe('READ_ERROR: cannot read file');
    expect(updated.selectedPattern).toEqual(DEFAULT_PATTERN);
    expect(updated.isCustomPattern).toBe(true);
  });

  it('falls back to the custom pattern when nothing is suggested', async () => {
    previewFile.mockResolvedValue({ lines: ['x'], approx_lines: 1 });
    suggestPatterns.mockResolvedValue({ results: [] });
    useImportStore.getState().addNativePathFiles(['/abs/odd.log']);
    const fileId = useImportStore.getState().files[0].id;

    renderHook(() => useFileDetection());

    await waitFor(() => {
      expect(useImportStore.getState().files.find((f) => f.id === fileId)?.detectionStatus).toBe(
        'failed'
      );
    });
    const updated = useImportStore.getState().files.find((f) => f.id === fileId)!;
    expect(updated.detectionError).toBe(NO_PATTERN_DETECTED);
    expect(updated.previewLines).toEqual(['x']);
  });
});

describe('useFileDetection — detection starts on drop, for every pending file', () => {
  it('runs detection for files added after mount without any step transition', async () => {
    previewFile.mockResolvedValue({ lines: ['a'], approx_lines: 10 });
    suggestPatterns.mockResolvedValue(suggestion);
    parseLogs.mockResolvedValue({ logs: [{ message: 'a' }], timestamp_inference: null });

    renderHook(() => useFileDetection());
    act(() => {
      useImportStore.getState().addNativePathFiles(['/abs/one.log', '/abs/two.log']);
    });

    await waitFor(() => {
      expect(useImportStore.getState().files.every((f) => f.detectionStatus === 'detected')).toBe(
        true
      );
    });
    expect(suggestPatterns).toHaveBeenCalledTimes(2);
  });

  it('stores a suggester-detected multiline config on that file only', async () => {
    previewFile.mockResolvedValue({ lines: ['a', ' b'], approx_lines: 2 });
    // The stack-trace file's suggestion carries a multiline layout; the
    // syslog file's does not.
    suggestPatterns
      .mockResolvedValueOnce({ ...suggestion, multiline: { enabled: true, mode: 'indent' } })
      .mockResolvedValueOnce(suggestion);
    parseLogs.mockResolvedValue({ logs: [{ message: 'a b' }], timestamp_inference: null });

    useImportStore.getState().addNativePathFiles(['/abs/stack.log', '/abs/syslog.log']);
    renderHook(() => useFileDetection());

    await waitFor(() => {
      expect(useImportStore.getState().files.every((f) => f.detectionStatus === 'detected')).toBe(
        true
      );
    });
    const [stack, syslog] = useImportStore.getState().files;
    expect(stack.sessionOptions.multiline).toEqual({
      enabled: true,
      mode: 'indent',
      headerPattern: '',
    });
    expect(syslog.sessionOptions.multiline.enabled).toBe(false);
    // The global (legacy) triple is untouched: it is not what the upload
    // sends any more, and flipping it would have folded every file.
    expect(useImportStore.getState().sessionOptionsMultilineEnabled).toBe(false);
    // The stack file's own parse ran under its folding, the syslog file's
    // with none specified (so the server could auto-detect one).
    const parseCalls = parseLogs.mock.calls.map((c) => c[0].session_options?.multiline);
    expect(parseCalls).toContainEqual({ enabled: true, mode: 'indent', header_pattern: undefined });
    expect(parseCalls).toContainEqual(undefined);
    // Nothing re-fires detection against the batch.
    await new Promise((r) => setTimeout(r, 500));
    expect(suggestPatterns).toHaveBeenCalledTimes(2);
  });
});

describe('useFileDetection — reparseFile', () => {
  it('re-parses a detected file under its own folding without re-running the suggester', async () => {
    previewFile.mockResolvedValue({ lines: ['a', ' b'], approx_lines: 2 });
    suggestPatterns.mockResolvedValue(suggestion);
    parseLogs.mockResolvedValue({
      logs: [{ message: 'a' }, { message: ' b' }],
      timestamp_inference: null,
    });
    useImportStore.getState().addNativePathFiles(['/abs/app.log']);
    const fileId = useImportStore.getState().files[0].id;
    const { result } = renderHook(() => useFileDetection());
    await waitFor(() => {
      expect(useImportStore.getState().files[0].detectionStatus).toBe('detected');
    });
    expect(suggestPatterns).toHaveBeenCalledTimes(1);

    useImportStore.getState().updateFileSessionOptions(fileId, {
      multiline: { enabled: true, mode: 'indent', headerPattern: '' },
    });
    parseLogs.mockResolvedValue({ logs: [{ message: 'a b' }], timestamp_inference: null });
    await act(async () => {
      await result.current.reparseFile(fileId);
    });

    const f = useImportStore.getState().files[0];
    expect(f.parsedLogs).toEqual([{ message: 'a b' }]);
    expect(f.selectedPattern?.name).toBe('Generic');
    expect(parseLogs).toHaveBeenLastCalledWith(
      expect.objectContaining({
        session_options: expect.objectContaining({
          multiline: { enabled: true, mode: 'indent', header_pattern: undefined },
        }),
      })
    );
    expect(suggestPatterns).toHaveBeenCalledTimes(1);
  });
});

describe('useFileDetection — changePattern', () => {
  it('re-parses the preview with the chosen pattern and updates the timestamp inference', async () => {
    previewFile.mockResolvedValue({ lines: ['a'], approx_lines: 1 });
    suggestPatterns.mockResolvedValue(suggestion);
    parseLogs.mockResolvedValue({ logs: [{ message: 'a' }], timestamp_inference: null });
    useImportStore.getState().addNativePathFiles(['/abs/app.log']);
    const fileId = useImportStore.getState().files[0].id;
    const { result } = renderHook(() => useFileDetection());
    await waitFor(() => {
      expect(useImportStore.getState().files[0].detectionStatus).toBe('detected');
    });

    const inference = { status: 'exact', layout: {}, resolution: {}, preview: [] };
    parseLogs.mockResolvedValue({ logs: [{ level: 'INFO' }], timestamp_inference: inference });
    await act(async () => {
      await result.current.changePattern(fileId, {
        name: 'Other',
        pattern: '%{LOGLEVEL:level}',
        description: '',
        custom_patterns: {},
      });
    });
    const f = useImportStore.getState().files[0];
    expect(f.selectedPattern?.name).toBe('Other');
    expect(f.parsedLogs).toEqual([{ level: 'INFO' }]);
    expect(f.timestampInference).toEqual(inference);
    expect(f.timestampConfirmed).toBe(true);
  });
});

describe('matchRateOf', () => {
  it('counts lines without an error key', () => {
    expect(matchRateOf([{ a: 1 }, { error: 'x' }, { a: 2 }, { a: 3 }], ['1', '2', '3', '4'])).toBe(
      75
    );
    expect(matchRateOf([], [])).toBe(0);
    expect(matchRateOf([], ['1'])).toBe(0);
  });
});
