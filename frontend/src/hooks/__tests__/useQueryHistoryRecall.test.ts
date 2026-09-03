import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useQueryHistoryRecall } from '../useQueryHistoryRecall';

import type { QueryHistoryEntry } from '@/stores/useQueryHistoryStore';

import { useQueryHistoryStore } from '@/stores/useQueryHistoryStore';

function useHarness(
  initial: string,
  onRecallContext: (entry: QueryHistoryEntry) => void,
  onSessionStart?: () => void,
  onSessionEnd?: () => void
) {
  const [value, setValue] = useState(initial);
  const recall = useQueryHistoryRecall(
    value,
    setValue,
    onRecallContext,
    onSessionStart,
    onSessionEnd
  );
  return { value, setValue, recall };
}

const key = (k: string) => ({ key: k, preventDefault: vi.fn() });

beforeEach(() => {
  useQueryHistoryStore.getState().clear();
  // Newest first, matching what the store's own push() produces.
  useQueryHistoryStore.setState({
    entries: [
      { query: 'level:error', at: '2026-01-03T00:00:00Z' },
      { query: 'level:warn', at: '2026-01-02T00:00:00Z' },
      { query: 'level:info', at: '2026-01-01T00:00:00Z' },
    ],
  });
});

describe('useQueryHistoryRecall', () => {
  // F3
  it('ArrowUp on an empty focused input fills the most recent query', () => {
    const onRecallContext = vi.fn();
    const { result } = renderHook(() => useHarness('', onRecallContext));

    act(() => result.current.recall.onKeyDown(key('ArrowUp')));

    expect(result.current.value).toBe('level:error');
    expect(onRecallContext).toHaveBeenCalledTimes(1);
  });

  // F4
  it('ArrowUp ArrowUp ArrowDown walks back two entries then forward one', () => {
    const { result } = renderHook(() => useHarness('', vi.fn()));

    act(() => result.current.recall.onKeyDown(key('ArrowUp')));
    expect(result.current.value).toBe('level:error');

    act(() => result.current.recall.onKeyDown(key('ArrowUp')));
    expect(result.current.value).toBe('level:warn');

    act(() => result.current.recall.onKeyDown(key('ArrowDown')));
    expect(result.current.value).toBe('level:error');
  });

  it('ArrowDown past the newest entry restores the original typed text', () => {
    const { result } = renderHook(() => useHarness('', vi.fn()));

    act(() => result.current.recall.onKeyDown(key('ArrowUp')));
    expect(result.current.value).toBe('level:error');

    act(() => result.current.recall.onKeyDown(key('ArrowDown')));
    expect(result.current.value).toBe('');
  });

  it('does not start a recall session on a non-empty, unedited input', () => {
    const { result } = renderHook(() => useHarness('status:500', vi.fn()));

    act(() => result.current.recall.onKeyDown(key('ArrowUp')));

    expect(result.current.value).toBe('status:500');
  });

  // F5
  it('edit after recall, then ArrowUp: cursor moves, history not triggered', () => {
    const { result } = renderHook(() => useHarness('', vi.fn()));

    act(() => result.current.recall.onKeyDown(key('ArrowUp')));
    expect(result.current.value).toBe('level:error');

    // The user edits the recalled text.
    act(() => result.current.setValue('level:error extra'));

    const upEvent = key('ArrowUp');
    act(() => result.current.recall.onKeyDown(upEvent));

    // Value is untouched by the hook, and it did not intercept the key
    // (preventDefault not called), so normal cursor movement applies.
    expect(result.current.value).toBe('level:error extra');
    expect(upEvent.preventDefault).not.toHaveBeenCalled();
  });

  // F6
  it('Esc during a recall session restores the original typed text', () => {
    const { result } = renderHook(() => useHarness('partial query', vi.fn()));

    // F3 only starts a session from an empty input -- seed an active
    // session the way a real recall would leave it (value matches the
    // recalled entry) to isolate Esc's own behavior.
    act(() => result.current.setValue(''));
    act(() => result.current.recall.onKeyDown(key('ArrowUp')));
    expect(result.current.value).toBe('level:error');

    act(() => result.current.recall.onKeyDown(key('Escape')));

    expect(result.current.value).toBe('');
  });

  it('Esc with no active recall session does not intercept the key', () => {
    const { result } = renderHook(() => useHarness('status:500', vi.fn()));

    const escEvent = key('Escape');
    act(() => result.current.recall.onKeyDown(escEvent));

    expect(escEvent.preventDefault).not.toHaveBeenCalled();
    expect(result.current.value).toBe('status:500');
  });

  it("recallAt applies the entry's time and sources via onRecallContext", () => {
    useQueryHistoryStore.setState({
      entries: [
        {
          query: 'status:>=500',
          time: { mode: 'relative', relative: 'last-1-hours' },
          sources: ['nginx.log'],
          at: '2026-01-03T00:00:00Z',
        },
      ],
    });
    const onRecallContext = vi.fn();
    const { result } = renderHook(() => useHarness('', onRecallContext));

    act(() => result.current.recall.onKeyDown(key('ArrowUp')));

    expect(onRecallContext).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'status:>=500', sources: ['nginx.log'] })
    );
  });

  describe('session start/end callbacks', () => {
    it('fires onSessionStart once when a recall session begins, not on further walking', () => {
      const onSessionStart = vi.fn();
      const { result } = renderHook(() => useHarness('', vi.fn(), onSessionStart, vi.fn()));

      act(() => result.current.recall.onKeyDown(key('ArrowUp')));
      act(() => result.current.recall.onKeyDown(key('ArrowUp')));

      expect(onSessionStart).toHaveBeenCalledTimes(1);
    });

    it('fires onSessionEnd on Esc', () => {
      const onSessionEnd = vi.fn();
      const { result } = renderHook(() => useHarness('', vi.fn(), vi.fn(), onSessionEnd));

      act(() => result.current.recall.onKeyDown(key('ArrowUp')));
      act(() => result.current.recall.onKeyDown(key('Escape')));

      expect(onSessionEnd).toHaveBeenCalledTimes(1);
    });

    it('fires onSessionEnd when ArrowDown walks past the newest entry', () => {
      const onSessionEnd = vi.fn();
      const { result } = renderHook(() => useHarness('', vi.fn(), vi.fn(), onSessionEnd));

      act(() => result.current.recall.onKeyDown(key('ArrowUp')));
      act(() => result.current.recall.onKeyDown(key('ArrowDown')));

      expect(onSessionEnd).toHaveBeenCalledTimes(1);
    });

    it('does not fire onSessionEnd when the recall is committed via reset() (Enter)', () => {
      const onSessionEnd = vi.fn();
      const { result } = renderHook(() => useHarness('', vi.fn(), vi.fn(), onSessionEnd));

      act(() => result.current.recall.onKeyDown(key('ArrowUp')));
      // Enter isn't handled by the hook itself -- the caller commits by
      // calling reset() directly, which must not restore text/context.
      act(() => result.current.recall.reset());

      expect(onSessionEnd).not.toHaveBeenCalled();
    });
  });
});
