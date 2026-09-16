import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Watch } from '@/lib/api-types';

import { activeWatchCount, useWatchesStore } from '@/stores/useWatchesStore';

const api = vi.hoisted(() => ({
  listWatches: vi.fn(),
  createWatch: vi.fn(),
  deleteWatch: vi.fn(),
  pauseWatch: vi.fn(),
  resumeWatch: vi.fn(),
}));
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, ...api };
});

const watch = (id: string, paused = false): Watch => ({
  id,
  dir: `/logs/${id}`,
  glob: '*.log',
  paused,
  created_at: '2026-03-01T00:00:00Z',
  files: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  useWatchesStore.setState({ watches: [], loaded: false, isLoading: false, error: null });
});

describe('useWatchesStore', () => {
  it('fetches, counts only unpaused watches, and records errors', async () => {
    api.listWatches.mockResolvedValueOnce({ watches: [watch('a'), watch('b', true)] });
    await useWatchesStore.getState().fetchWatches();
    expect(useWatchesStore.getState().watches).toHaveLength(2);
    expect(activeWatchCount(useWatchesStore.getState())).toBe(1);
    api.listWatches.mockRejectedValueOnce(new Error('down'));
    await useWatchesStore.getState().fetchWatches();
    expect(useWatchesStore.getState().error).toBe('down');
  });

  it('create appends, pause/resume replace in place, delete removes', async () => {
    api.createWatch.mockResolvedValueOnce(watch('n'));
    await useWatchesStore.getState().createWatch({ dir: '/logs/n' });
    expect(useWatchesStore.getState().watches.map((w) => w.id)).toEqual(['n']);
    api.pauseWatch.mockResolvedValueOnce(watch('n', true));
    await useWatchesStore.getState().pauseWatch('n');
    expect(useWatchesStore.getState().watches[0].paused).toBe(true);
    api.resumeWatch.mockResolvedValueOnce(watch('n', false));
    await useWatchesStore.getState().resumeWatch('n');
    expect(useWatchesStore.getState().watches[0].paused).toBe(false);
    api.deleteWatch.mockResolvedValueOnce(undefined);
    await useWatchesStore.getState().deleteWatch('n');
    expect(useWatchesStore.getState().watches).toHaveLength(0);
  });
});
