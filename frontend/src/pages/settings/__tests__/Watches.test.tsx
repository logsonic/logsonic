import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import WatchesSettings from '../Watches';

import type { Watch } from '@/lib/api-types';

import { ApiError } from '@/lib/api-client';
import { useWatchesStore } from '@/stores/useWatchesStore';

const toast = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const grok = vi.hoisted(() => ({
  getGrokPatterns: vi
    .fn()
    .mockResolvedValue({ status: 'success', patterns: [{ name: 'APACHE', pattern: 'x' }] }),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/stores/useSourcesStore', () => ({ refreshAfterMutation: refresh }));
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, ...grok };
});

const watch = (over: Partial<Watch> = {}): Watch => ({
  id: 'w1',
  dir: '/var/log/app',
  glob: '*.log',
  pattern: 'APACHE',
  paused: false,
  created_at: '2026-03-01T00:00:00Z',
  files: [
    {
      path: '/var/log/app/a.log',
      offset: 100,
      size: 2048,
      state: 'following',
      source: 'watch.app.a.log',
    },
    {
      path: '/var/log/app/b.log',
      offset: 0,
      size: 10,
      state: 'error',
      error: 'pattern: no pattern detected',
      source: 'watch.app.b.log',
    },
  ],
  ...over,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <WatchesSettings />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  useWatchesStore.setState({
    watches: [watch()],
    loaded: true,
    isLoading: false,
    error: null,
    fetchWatches: vi.fn().mockResolvedValue(undefined),
    createWatch: vi.fn(),
    deleteWatch: vi.fn().mockResolvedValue(undefined),
    pauseWatch: vi.fn().mockResolvedValue(watch({ paused: true })),
    resumeWatch: vi.fn().mockResolvedValue(watch()),
  });
});

describe('WatchesSettings', () => {
  it('lists watches with per-file states and the saved patterns in the select', async () => {
    renderPage();
    expect(screen.getByText('/var/log/app')).toBeTruthy();
    expect(screen.getAllByTestId('watch-file')).toHaveLength(2);
    expect(screen.getByText('following')).toBeTruthy();
    expect(screen.getByText(/error — pattern: no pattern detected/)).toBeTruthy();
    expect(screen.getByText('2 KB')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('option', { name: 'APACHE' })).toBeTruthy());
    expect(screen.getByRole('option', { name: 'Auto-detect per file' })).toBeTruthy();
  });

  it('the form previews the source name, requires an absolute path, and creates with "" for auto', async () => {
    const createWatch = vi.fn().mockResolvedValue(watch({ id: 'w2', dir: '/srv/logs' }));
    useWatchesStore.setState({ createWatch });
    renderPage();
    const submit = screen.getByRole('button', { name: 'Watch folder' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Folder to watch'), {
      target: { value: 'relative/logs' },
    });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Folder to watch'), { target: { value: '/srv/logs' } });
    expect(screen.getByText(/watch\.logs\.<file>/)).toBeTruthy();
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(createWatch).toHaveBeenCalledWith({
        dir: '/srv/logs',
        glob: '*.log',
        pattern: undefined,
        recursive: undefined,
      })
    );
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Watching logs' }));
  });

  it('shows the 409 copy inline when the folder is already watched', async () => {
    useWatchesStore.setState({
      createWatch: vi
        .fn()
        .mockRejectedValue(new ApiError('Directory already watched', 409, 'WATCH_EXISTS')),
    });
    renderPage();
    fireEvent.change(screen.getByLabelText('Folder to watch'), {
      target: { value: '/var/log/app' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Watch folder' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('That folder is already watched.')).toBeTruthy();
  });

  it('pause and resume go through the store with a toast', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Pause/ }));
    await waitFor(() => expect(useWatchesStore.getState().pauseWatch).toHaveBeenCalledWith('w1'));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Paused app' }));
  });

  it('delete asks for confirmation that says what stops and what stays', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Stop watching app?')).toBeTruthy();
    expect(screen.getByText(/1 file will stop being followed/)).toBeTruthy();
    expect(screen.getByText(/Rows already indexed stay/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop watching' }));
    await waitFor(() => expect(useWatchesStore.getState().deleteWatch).toHaveBeenCalledWith('w1'));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Stopped watching app' }));
  });

  it('refreshes the app once when a file finishes its first read', async () => {
    useWatchesStore.setState({
      watches: [
        watch({
          files: [
            { path: '/var/log/app/a.log', offset: 0, size: 1, state: 'ingesting', source: 's' },
          ],
        }),
      ],
    });
    renderPage();
    expect(refresh).not.toHaveBeenCalled();
    useWatchesStore.setState({ watches: [watch()] }); // a.log → following
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('a freshly created watch refreshes the app when its first file settles', async () => {
    const created = watch({ id: 'w9', dir: '/srv/fresh', files: [] });
    useWatchesStore.setState({
      watches: [],
      createWatch: vi.fn().mockImplementation(async () => {
        useWatchesStore.setState((s) => ({ watches: [...s.watches, created] }));
        return created;
      }),
    });
    renderPage();
    fireEvent.change(screen.getByLabelText('Folder to watch'), { target: { value: '/srv/fresh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Watch folder' }));
    await waitFor(() => expect(screen.getByText('/srv/fresh')).toBeTruthy());
    expect(refresh).not.toHaveBeenCalled();
    useWatchesStore.setState({
      watches: [
        watch({
          id: 'w9',
          dir: '/srv/fresh',
          files: [
            { path: '/srv/fresh/a.log', offset: 5, size: 5, state: 'following', source: 's' },
          ],
        }),
      ],
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('empty state', () => {
    useWatchesStore.setState({ watches: [] });
    renderPage();
    expect(screen.getByText('No folders watched yet.')).toBeTruthy();
  });
});
