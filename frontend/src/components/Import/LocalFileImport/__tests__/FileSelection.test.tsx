import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileSelection } from '../FileSelection';

import { useImportStore } from '@/stores/useImportStore';

beforeEach(() => {
  useImportStore.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function dispatchNativeFiles(detail: { paths: string[]; mtimes?: (string | null)[] }) {
  act(() => {
    window.dispatchEvent(new CustomEvent('logsonic-native-files', { detail }));
  });
}

describe('FileSelection — native paths from the macOS shell (spec now-08 phase 5)', () => {
  it('adds native-path files on the logsonic-native-files event, no fetch of urls/names', async () => {
    const onFileSelect = vi.fn();
    const onFilePreview = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    render(
      <FileSelection
        onFileSelect={onFileSelect}
        onFilePreview={onFilePreview}
        onBackToSourceSelection={vi.fn()}
      />
    );

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
    });
    expect(files[1]).toMatchObject({
      nativePath: '/abs/app.log.1',
      fileName: 'app.log.1',
      sourceMTime: null,
    });
    // The old bridge fetched logsonicfile:// URLs for bytes; the new one
    // hands over paths with no browser-side read at all.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onFileSelect).toHaveBeenCalledWith('app.log');
    expect(onFilePreview).toHaveBeenCalledWith([], 'app.log');
  });

  it('dedups a repeated native-files event by full path, not just basename', async () => {
    render(
      <FileSelection
        onFileSelect={vi.fn()}
        onFilePreview={vi.fn()}
        onBackToSourceSelection={vi.fn()}
      />
    );

    dispatchNativeFiles({ paths: ['/abs/app.log'] });
    dispatchNativeFiles({ paths: ['/abs/app.log', '/other/app.log'] });

    const paths = useImportStore.getState().files.map((f) => f.nativePath);
    // /abs/app.log is a true duplicate (same path); /other/app.log shares
    // only a basename with the first file and must still be added.
    expect(paths).toEqual(['/abs/app.log', '/other/app.log']);
  });
});
