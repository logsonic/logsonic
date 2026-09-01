import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLogResultStore } from '@/stores/useLogResultStore';
import { useSearchQueryParamsStore } from '@/stores/useSearchQueryParams';
import { useSearchLogs } from '../useSearchLogs';

const { getLogsMock } = vi.hoisted(() => ({ getLogsMock: vi.fn() }));

vi.mock('@/lib/api-client', () => ({
  getLogs: getLogsMock,
}));

describe('useSearchLogs', () => {
  beforeEach(() => {
    getLogsMock.mockReset();
    useLogResultStore.getState().reset();
    useSearchQueryParamsStore.getState().resetStore();
    useSearchQueryParamsStore.setState({
      searchQuery: 'status',
      sources: ['app.log'],
      sourcesInitialized: true,
      selectedColumns: ['timestamp', 'message'],
      isRelative: false,
      UTCTimeSince: new Date('2024-01-01T00:00:00Z'),
      UTCTimeTo: new Date('2024-01-02T00:00:00Z'),
      UTCTimeSinceMs: Date.parse('2024-01-01T00:00:00Z'),
      UTCTimeToMs: Date.parse('2024-01-02T00:00:00Z'),
    });
  });

  it('renders rows before loading chart distribution metadata', async () => {
    const firstPage = {
      status: 'success',
      total_count: 2,
      count: 2,
      logs: [{ timestamp: '2024-01-01T01:00:00Z', message: 'ready' }],
      available_columns: ['timestamp', 'message'],
      log_distribution: [],
    };
    const metadata = {
      ...firstPage,
      count: 1,
      logs: [],
      log_distribution: [{
        start_time: '2024-01-01T00:00:00Z',
        end_time: '2024-01-02T00:00:00Z',
        count: 2,
        source_counts: { 'app.log': 2 },
      }],
    };
    let resolveMetadata!: (value: typeof metadata) => void;
    getLogsMock
      .mockResolvedValueOnce(firstPage)
      .mockImplementationOnce(() => new Promise(resolve => { resolveMetadata = resolve; }));

    const { result } = renderHook(() => useSearchLogs());
    await act(async () => {
      await result.current.searchLogs();
    });

    expect(getLogsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ include_distribution: false, limit: 100 }),
      expect.any(AbortSignal),
    );
    expect(useLogResultStore.getState().logData?.logs).toEqual(firstPage.logs);
    expect(useLogResultStore.getState().logData?.log_distribution).toEqual([]);

    await act(async () => {
      resolveMetadata(metadata);
      await Promise.resolve();
    });

    expect(getLogsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        include_distribution: true,
        limit: 1,
        fields: 'timestamp,_src',
        sort_by: 'timestamp',
        sort_order: 'desc',
      }),
      expect.any(AbortSignal),
    );
    expect(useLogResultStore.getState().logData?.logs).toEqual(firstPage.logs);
    expect(useLogResultStore.getState().logData?.log_distribution).toEqual(metadata.log_distribution);
  });
});
