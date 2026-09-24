import { beforeEach, describe, expect, it } from 'vitest';

import { useQueryHistoryStore } from '../useQueryHistoryStore';

beforeEach(() => {
  useQueryHistoryStore.getState().clear();
});

describe('useQueryHistoryStore', () => {
  // F1
  it('caps at 50 entries, newest first', () => {
    for (let i = 0; i < 60; i++) {
      useQueryHistoryStore.getState().push({ query: `query-${i}` });
    }
    const { entries } = useQueryHistoryStore.getState();
    expect(entries).toHaveLength(50);
    expect(entries[0].query).toBe('query-59');
    expect(entries[49].query).toBe('query-10');
  });

  // F2
  it('moves a duplicate query+sources push to the front instead of adding a second entry', () => {
    useQueryHistoryStore.getState().push({ query: 'level:error', sources: ['app.log'] });
    useQueryHistoryStore.getState().push({ query: 'level:info' });
    useQueryHistoryStore.getState().push({ query: 'level:error', sources: ['app.log'] });

    const { entries } = useQueryHistoryStore.getState();
    expect(entries).toHaveLength(2);
    expect(entries[0].query).toBe('level:error');
    expect(entries[1].query).toBe('level:info');
  });

  it('treats the same query with different sources as distinct entries', () => {
    useQueryHistoryStore.getState().push({ query: 'level:error', sources: ['app.log'] });
    useQueryHistoryStore.getState().push({ query: 'level:error', sources: ['db.log'] });

    expect(useQueryHistoryStore.getState().entries).toHaveLength(2);
  });

  it('replaces a duplicate with the new time range rather than keeping the old one', () => {
    useQueryHistoryStore.getState().push({
      query: 'level:error',
      time: { mode: 'relative', relative: 'last-1-hours' },
    });
    useQueryHistoryStore.getState().push({
      query: 'level:error',
      time: { mode: 'relative', relative: 'last-24-hours' },
    });

    const { entries } = useQueryHistoryStore.getState();
    expect(entries).toHaveLength(1);
    expect(entries[0].time?.relative).toBe('last-24-hours');
  });

  it('clear empties the history', () => {
    useQueryHistoryStore.getState().push({ query: 'level:error' });
    useQueryHistoryStore.getState().clear();
    expect(useQueryHistoryStore.getState().entries).toHaveLength(0);
  });
});
