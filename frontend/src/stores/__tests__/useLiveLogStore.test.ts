import { describe, expect, it, beforeEach } from 'vitest';
import {
  LIVE_ROW_LIMIT,
  LIVE_SOURCE_STATUS_LIMIT,
  isLiveDataAvailable,
  liveActiveSourceCount,
  useLiveLogStore,
} from '../useLiveLogStore';

describe('useLiveLogStore', () => {
  beforeEach(() => {
    useLiveLogStore.getState().reset();
  });

  it('prepends newest live rows and caps the ring buffer', () => {
    const rows = Array.from({ length: LIVE_ROW_LIMIT + 2 }, (_, index) => ({
      _id: String(index),
      timestamp: `2026-06-05T00:00:${String(index % 60).padStart(2, '0')}Z`,
      message: `row ${index}`,
    }));

    useLiveLogStore.getState().appendRows(rows);

    const state = useLiveLogStore.getState();
    expect(state.rows).toHaveLength(LIVE_ROW_LIMIT);
    expect(state.rows[0]._id).toBe(String(LIVE_ROW_LIMIT + 1));
    expect(state.skippedCount).toBe(2);
  });

  it('trims oversized incoming batches before retaining current rows', () => {
    useLiveLogStore.getState().appendRows([{ _id: 'old', message: 'old row' }]);

    const rows = Array.from({ length: LIVE_ROW_LIMIT + 3 }, (_, index) => ({
      _id: `new-${index}`,
      message: `row ${index}`,
    }));

    useLiveLogStore.getState().appendRows(rows);

    const state = useLiveLogStore.getState();
    expect(state.rows).toHaveLength(LIVE_ROW_LIMIT);
    expect(state.rows[0]._id).toBe(`new-${LIVE_ROW_LIMIT + 2}`);
    expect(state.rows[state.rows.length - 1]._id).toBe('new-3');
    expect(state.rows.some(row => row._id === 'old')).toBe(false);
    expect(state.skippedCount).toBe(4);
  });

  it('records server skipped counts', () => {
    useLiveLogStore.getState().recordSkipped(3);
    useLiveLogStore.getState().recordSkipped(2);

    expect(useLiveLogStore.getState().skippedCount).toBe(5);
  });

  it('ignores invalid skipped counts', () => {
    useLiveLogStore.getState().recordSkipped(Number.NaN);
    useLiveLogStore.getState().recordSkipped(-2);

    expect(useLiveLogStore.getState().skippedCount).toBe(0);
  });

  it('caps retained stopped source statuses', () => {
    for (let index = 0; index < LIVE_SOURCE_STATUS_LIMIT + 5; index++) {
      useLiveLogStore.getState().setSourceStatus({
        source_id: `source-${index}`,
        status: 'stopped',
        message: 'done',
      });
    }

    const statuses = useLiveLogStore.getState().sourceStatuses;
    expect(Object.keys(statuses)).toHaveLength(LIVE_SOURCE_STATUS_LIMIT);
    expect(statuses['source-0']).toBeUndefined();
    expect(statuses[`source-${LIVE_SOURCE_STATUS_LIMIT + 4}`]?.status).toBe('stopped');
  });

  it('caps source statuses even when all retained statuses are active', () => {
    for (let index = 0; index < LIVE_SOURCE_STATUS_LIMIT + 5; index++) {
      useLiveLogStore.getState().setSourceStatus({
        source_id: `source-${index}`,
        status: 'started',
        message: 'active',
      });
    }

    const statuses = useLiveLogStore.getState().sourceStatuses;
    expect(Object.keys(statuses)).toHaveLength(LIVE_SOURCE_STATUS_LIMIT);
    expect(statuses['source-0']).toBeUndefined();
    expect(statuses[`source-${LIVE_SOURCE_STATUS_LIMIT + 4}`]?.status).toBe('started');
    expect(liveActiveSourceCount(useLiveLogStore.getState())).toBe(LIVE_SOURCE_STATUS_LIMIT);
    expect(isLiveDataAvailable(useLiveLogStore.getState())).toBe(true);
  });
});
