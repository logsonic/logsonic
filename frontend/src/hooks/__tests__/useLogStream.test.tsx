import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLogStream } from '../useLogStream';
import { LIVE_ROW_LIMIT, useLiveLogStore } from '@/stores/useLiveLogStore';

class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  listeners: Record<string, Array<(event: MessageEvent) => void>> = {};

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners[type] = [...(this.listeners[type] || []), listener];
  }

  emit(type: string, data: unknown) {
    for (const listener of this.listeners[type] || []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  emitRaw(type: string, data: string) {
    for (const listener of this.listeners[type] || []) {
      listener({ data } as MessageEvent);
    }
  }
}

describe('useLogStream', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    useLiveLogStore.getState().reset();
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens an EventSource on mount and closes it on unmount', () => {
    const { unmount } = renderHook(() => useLogStream());
    expect(MockEventSource.instances).toHaveLength(1);

    act(() => {
      MockEventSource.instances[0].emit('hello', {
        subscriber_id: 'sub-1',
        source_ids: ['source-1'],
      });
    });

    expect(useLiveLogStore.getState().subscriberId).toBe('sub-1');
    expect(useLiveLogStore.getState().connected).toBe(true);
    expect(useLiveLogStore.getState().sourceStatuses['source-1'].status).toBe('started');

    unmount();
    expect(MockEventSource.instances[0].close).toHaveBeenCalledTimes(1);
    expect(useLiveLogStore.getState().subscriberId).toBeNull();
  });

  it('records stream errors without throwing on malformed events', () => {
    renderHook(() => useLogStream());

    act(() => {
      MockEventSource.instances[0].emitRaw('rows', 'not-json');
    });

    expect(useLiveLogStore.getState().error).toMatch(/Invalid live rows event/);
    expect(useLiveLogStore.getState().rows).toHaveLength(0);
  });

  it('caps pending rows before flushing oversized live batches', () => {
    vi.useFakeTimers();
    renderHook(() => useLogStream());
    const rows = Array.from({ length: LIVE_ROW_LIMIT + 5 }, (_, index) => ({
      _id: `row-${index}`,
      message: `row ${index}`,
    }));

    act(() => {
      MockEventSource.instances[0].emit('rows', {
        source_id: 'source-1',
        rows,
      });
      vi.advanceTimersByTime(300);
    });

    const state = useLiveLogStore.getState();
    expect(state.rows).toHaveLength(LIVE_ROW_LIMIT);
    expect(state.rows[0]._id).toBe(`row-${LIVE_ROW_LIMIT + 4}`);
    expect(state.rows[state.rows.length - 1]._id).toBe('row-5');
    expect(state.skippedCount).toBe(5);
  });
});
