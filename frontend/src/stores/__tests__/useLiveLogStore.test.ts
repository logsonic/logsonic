import { describe, expect, it, beforeEach } from 'vitest';
import { LIVE_ROW_LIMIT, useLiveLogStore } from '../useLiveLogStore';

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

  it('records server skipped counts', () => {
    useLiveLogStore.getState().recordSkipped(3);
    useLiveLogStore.getState().recordSkipped(2);

    expect(useLiveLogStore.getState().skippedCount).toBe(5);
  });
});
