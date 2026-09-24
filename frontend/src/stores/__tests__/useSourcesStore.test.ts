import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SourceEntry } from '@/lib/api-types';

import { ApiError } from '@/lib/api-client';
import { useFacetStore } from '@/stores/useFacetStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { sourceErrorMessage, useSourcesStore } from '@/stores/useSourcesStore';
import { useSystemInfoStore } from '@/stores/useSystemInfoStore';

const api = vi.hoisted(() => ({
  listSources: vi.fn(),
  deleteSource: vi.fn(),
  renameSource: vi.fn(),
  reimportSource: vi.fn(),
  getSystemInfo: vi.fn(),
}));
const jobs = vi.hoisted(() => ({ waitForIngestJob: vi.fn() }));
const metadata = vi.hoisted(() => ({
  refreshSearchMetadata: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return { ...actual, ...api };
});
vi.mock('@/components/Import/hooks/ingestJobEvents', () => jobs);
vi.mock('@/hooks/useSearchLogs', () => metadata);

const entry = (name: string, rows = 10): SourceEntry => ({
  name,
  aliases: [],
  origin: { kind: 'file', path: `/tmp/${name}` },
  rows,
  bytes_raw: rows * 40,
  days: ['2026-03-01'],
  day_rows: { '2026-03-01': rows },
  created_at: '2026-03-01T00:00:00Z',
  updated_at: '2026-03-01T00:00:00Z',
  imports: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  useSourcesStore.setState({
    sources: [],
    isLoading: false,
    loaded: false,
    error: null,
    expanded: null,
    deleting: new Set(),
    reimports: {},
  });
  useFacetStore.setState({ facets: null, fingerprint: null, panelOpen: false });
  useSystemInfoStore.setState({ systemInfo: null });
  api.getSystemInfo.mockResolvedValue({ status: 'success', storage_info: { source_names: [] } });
});

describe('useSourcesStore', () => {
  it('fetches and records loaded even on failure', async () => {
    api.listSources.mockResolvedValueOnce({ sources: [entry('a.log'), entry('b.log')] });
    await useSourcesStore.getState().fetchSources();
    expect(useSourcesStore.getState().sources.map((s) => s.name)).toEqual(['a.log', 'b.log']);
    expect(useSourcesStore.getState().loaded).toBe(true);

    api.listSources.mockRejectedValueOnce(new Error('boom'));
    await useSourcesStore.getState().fetchSources();
    expect(useSourcesStore.getState().error).toBe('boom');
    expect(useSourcesStore.getState().loaded).toBe(true);
  });

  it('delete removes the row, refreshes /info, invalidates facets, and re-runs the search', async () => {
    useSourcesStore.setState({ sources: [entry('a.log'), entry('b.log')], expanded: 'a.log' });
    useFacetStore.setState({
      facets: { computed_over: 1, sampled: false, fields: [] },
      fingerprint: 'x',
    });
    api.deleteSource.mockResolvedValueOnce({
      status: 'success',
      name: 'a.log',
      rows_deleted: 10,
      days_touched: [],
      days_removed: [],
    });
    api.getSystemInfo.mockResolvedValueOnce({
      status: 'success',
      storage_info: { source_names: ['b.log'] },
    });
    const trigger = vi.spyOn(useSearchQueryParamsStore.getState(), 'triggerSearch');

    const result = await useSourcesStore.getState().deleteSource('a.log');

    expect(result.rowsDeleted).toBe(10);
    expect(useSourcesStore.getState().sources.map((s) => s.name)).toEqual(['b.log']);
    expect(useSourcesStore.getState().expanded).toBeNull();
    expect(useSourcesStore.getState().deleting.has('a.log')).toBe(false);
    expect(api.getSystemInfo).toHaveBeenCalledWith(true);
    expect(useSystemInfoStore.getState().systemInfo?.storage_info?.source_names).toEqual(['b.log']);
    // Panel closed → facets dropped so the next open refetches; the
    // fingerprint alone would not have noticed the deletion.
    expect(useFacetStore.getState().facets).toBeNull();
    expect(trigger).toHaveBeenCalled();
  });

  it('delete refetches facets directly when the Fields panel is open', async () => {
    useSourcesStore.setState({ sources: [entry('a.log')] });
    useFacetStore.setState({ panelOpen: true });
    api.deleteSource.mockResolvedValueOnce({
      status: 'success',
      name: 'a.log',
      rows_deleted: 1,
      days_touched: [],
      days_removed: [],
    });
    await useSourcesStore.getState().deleteSource('a.log');
    expect(metadata.refreshSearchMetadata).toHaveBeenCalledWith({ includeFacets: true });
  });

  it('delete failure keeps the row and clears the deleting flag', async () => {
    useSourcesStore.setState({ sources: [entry('a.log')] });
    api.deleteSource.mockRejectedValueOnce(
      new ApiError('Source is in use', 409, 'SOURCE_IN_USE', 'a live tail is writing…')
    );
    await expect(useSourcesStore.getState().deleteSource('a.log')).rejects.toBeInstanceOf(ApiError);
    expect(useSourcesStore.getState().sources).toHaveLength(1);
    expect(useSourcesStore.getState().deleting.size).toBe(0);
  });

  it('re-import keeps a synthetic row until the job finishes, then refetches', async () => {
    useSourcesStore.setState({ sources: [entry('a.log')] });
    api.reimportSource.mockResolvedValueOnce({
      status: 'accepted',
      job_id: 'j1',
      session_id: 's',
      path: '/tmp/a.log',
      rows_deleted: 10,
    });
    let progress: ((j: { rows_stored: number }) => void) | undefined;
    jobs.waitForIngestJob.mockImplementationOnce((_id: string, onProgress: typeof progress) => {
      progress = onProgress;
      return new Promise((resolve) => {
        setTimeout(() => {
          progress?.({ rows_stored: 5 });
          resolve({ state: 'done', rows_stored: 12 });
        }, 0);
      });
    });
    // First refetch (right after the 202): the server keeps the entry at zero
    // rows; second (after the job): refilled.
    api.listSources.mockResolvedValueOnce({ sources: [entry('a.log', 0)] });
    api.listSources.mockResolvedValueOnce({ sources: [entry('a.log', 12)] });

    await useSourcesStore.getState().reimportSource('a.log');

    const state = useSourcesStore.getState();
    expect(state.reimports['a.log']).toMatchObject({ jobId: 'j1', state: 'done', rowsStored: 12 });
    expect(state.sources[0].rows).toBe(12);
    useSourcesStore.getState().clearReimport('a.log');
    expect(useSourcesStore.getState().reimports['a.log']).toBeUndefined();
  });

  it('maps API error codes to user copy and falls back to the message', () => {
    expect(
      sourceErrorMessage(new ApiError('x', 409, 'SOURCE_IN_USE', 'a live tail is…'), 'f')
    ).toMatch(/live tail/);
    expect(
      sourceErrorMessage(new ApiError('x', 409, 'SOURCE_IN_USE', 'a path import…'), 'f')
    ).toMatch(/import is still running/);
    expect(sourceErrorMessage(new ApiError('x', 400, 'SOURCE_NOT_REIMPORTABLE'), 'f')).toMatch(
      /uploaded from the browser/
    );
    expect(sourceErrorMessage(new ApiError('x', 400, 'INVALID_PATH'), 'f')).toMatch(
      /Nothing was deleted/
    );
    expect(sourceErrorMessage(new ApiError('Server said', 500, 'UNKNOWN'), 'f')).toBe(
      'Server said'
    );
    expect(sourceErrorMessage(new Error('plain'), 'f')).toBe('plain');
    expect(sourceErrorMessage('nope', 'fallback')).toBe('fallback');
  });
});
