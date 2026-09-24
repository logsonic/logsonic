import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { partitionFiles, useFileIntake } from '../useFileIntake';

import { useImportStore } from '@/stores/useImportStore';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

beforeEach(() => {
  useImportStore.getState().reset();
  toast.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function dispatchNativeFiles(detail: { paths: string[]; mtimes?: (string | null)[] }) {
  act(() => {
    window.dispatchEvent(new CustomEvent('logsonic-native-files', { detail }));
  });
}

describe('useFileIntake — native paths from the macOS shell (spec now-08 phase 5)', () => {
  it('adds native-path files on the logsonic-native-files event, no fetch of urls/names', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderHook(() => useFileIntake());

    dispatchNativeFiles({
      paths: ['/abs/app.log', '/abs/app.log.1'],
      mtimes: ['2024-01-01T00:00:00.000Z', null],
    });

    const files = useImportStore.getState().files;
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      nativePath: '/abs/app.log',
      fileName: 'app.log',
      sourceMTime: '2024-01-01T00:00:00.000Z',
      detectionStatus: 'pending',
    });
    expect(files[1]).toMatchObject({
      nativePath: '/abs/app.log.1',
      fileName: 'app.log.1',
      sourceMTime: null,
    });
    // The old bridge fetched logsonicfile:// URLs for bytes; the new one
    // hands over paths with no browser-side read at all.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useImportStore.getState().importSource).toBe('file');
  });

  it('dedups a repeated native-files event by full path, not just basename', () => {
    renderHook(() => useFileIntake());
    dispatchNativeFiles({ paths: ['/abs/app.log'] });
    dispatchNativeFiles({ paths: ['/abs/app.log', '/other/app.log'] });
    const paths = useImportStore.getState().files.map((f) => f.nativePath);
    expect(paths).toEqual(['/abs/app.log', '/other/app.log']);
  });

  it('consumes __logsonicPendingNativeFiles left by the shell before the page mounted', () => {
    const w = window as Window & { __logsonicPendingNativeFiles?: { paths: string[] } };
    w.__logsonicPendingNativeFiles = { paths: ['/abs/early.log'] };
    renderHook(() => useFileIntake());
    expect(useImportStore.getState().files.map((f) => f.nativePath)).toEqual(['/abs/early.log']);
    expect(w.__logsonicPendingNativeFiles).toBeUndefined();
  });
});

describe('useFileIntake — browser files', () => {
  it('adds accepted files and toasts once for the rejected ones', () => {
    const { result } = renderHook(() => useFileIntake());
    act(() => {
      result.current.addBrowserFiles([
        new File(['x'], 'ok.log', { type: 'text/plain' }),
        new File(['x'], 'bad.exe', { type: 'application/octet-stream' }),
        new File([], 'empty.log', { type: 'text/plain' }),
      ]);
    });
    expect(useImportStore.getState().files.map((f) => f.fileName)).toEqual(['ok.log']);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].description).toContain('bad.exe');
    expect(toast.mock.calls[0][0].description).toContain('empty.log');
  });

  it('silently ignores a file that is already staged', () => {
    const { result } = renderHook(() => useFileIntake());
    act(() => {
      result.current.addBrowserFiles([new File(['x'], 'a.log', { type: 'text/plain' })]);
      result.current.addBrowserFiles([new File(['y'], 'a.log', { type: 'text/plain' })]);
    });
    expect(useImportStore.getState().files).toHaveLength(1);
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('partitionFiles', () => {
  it('accepts by extension or MIME, rejects oversize and empty', () => {
    const big = new File(['x'], 'big.log', { type: 'text/plain' });
    Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 * 1024 });
    const { valid, errors } = partitionFiles(
      [
        new File(['x'], 'notes.txt', { type: '' }),
        new File(['x'], 'data.json', { type: '' }),
        new File(['x'], 'plain', { type: 'text/plain' }),
        big,
      ],
      new Set()
    );
    expect(valid.map((f) => f.name)).toEqual(['notes.txt', 'data.json', 'plain']);
    expect(errors).toEqual(['"big.log" exceeds the 5 GiB size limit']);
  });
});
