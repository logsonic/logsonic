import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileAnalyzingStep } from '../FileAnalyzingStep';

import { useImportStore } from '@/stores/useImportStore';

const { previewFile, suggestPatterns, parseLogs } = vi.hoisted(() => ({
  previewFile: vi.fn(),
  suggestPatterns: vi.fn(),
  parseLogs: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  previewFile,
  suggestPatterns,
  parseLogs,
}));

beforeEach(() => {
  useImportStore.getState().reset();
  // resetAllMocks, not clearAllMocks: a queued mockResolvedValueOnce or a
  // prior test's mockResolvedValue must not leak into the next test.
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FileAnalyzingStep — native-path files (spec now-08 phase 5)', () => {
  it('detects a pattern via POST /parse/preview-file, using the server approx_lines and sourceMTime', async () => {
    previewFile.mockResolvedValue({
      lines: ['a', 'b', 'c'],
      approx_lines: 5000,
      compressed: '',
      size_bytes: 123456,
    });
    suggestPatterns.mockResolvedValue({
      results: [
        {
          pattern: '%{GREEDYDATA:message}',
          pattern_name: 'Generic',
          pattern_description: 'desc',
          custom_patterns: {},
        },
      ],
      multiline: { enabled: false },
    });
    parseLogs.mockResolvedValue({
      logs: [{ message: 'a' }, { message: 'b' }, { message: 'c' }],
      timestamp_inference: null,
    });

    useImportStore.getState().addNativePathFiles(['/abs/app.log'], ['2024-01-01T00:00:00.000Z']);
    useImportStore.getState().setImportSource('file');
    const fileId = useImportStore.getState().files[0].id;

    render(<FileAnalyzingStep onDetectionComplete={() => {}} />);

    await waitFor(() => {
      expect(useImportStore.getState().files.find((f) => f.id === fileId)?.detectionStatus).toBe(
        'detected'
      );
    });

    expect(previewFile).toHaveBeenCalledWith({ path: '/abs/app.log' });
    // approx_lines from the server (5000), not previewLines.length (3) --
    // the whole point of using previewFile's estimate for native paths.
    const updated = useImportStore.getState().files.find((f) => f.id === fileId)!;
    expect(updated.approxLines).toBe(5000);
    expect(parseLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        session_options: expect.objectContaining({ source_mtime: '2024-01-01T00:00:00.000Z' }),
      })
    );
  });

  it('reports a failed detection with the preview-file error, not a hardcoded "not implemented" message', async () => {
    previewFile.mockRejectedValue(new Error('READ_ERROR: cannot read file'));

    useImportStore.getState().addNativePathFiles(['/abs/bad.log']);
    useImportStore.getState().setImportSource('file');
    const fileId = useImportStore.getState().files[0].id;

    render(<FileAnalyzingStep onDetectionComplete={() => {}} />);

    await waitFor(() => {
      expect(useImportStore.getState().files.find((f) => f.id === fileId)?.detectionStatus).toBe(
        'failed'
      );
    });

    const updated = useImportStore.getState().files.find((f) => f.id === fileId)!;
    expect(updated.detectionError).toBe('READ_ERROR: cannot read file');
  });
});
