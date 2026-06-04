import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLogStream } from '../useLogStream';
import { useLiveLogStore } from '@/stores/useLiveLogStore';

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
    vi.unstubAllGlobals();
  });

  it('opens an EventSource while enabled and closes it on unmount', () => {
    useLiveLogStore.getState().setEnabled(true);

    const { unmount } = renderHook(() => useLogStream());
    expect(MockEventSource.instances).toHaveLength(1);

    act(() => {
      MockEventSource.instances[0].emit('hello', {
        subscriber_id: 'sub-1',
        source_ids: [],
      });
    });

    expect(useLiveLogStore.getState().subscriberId).toBe('sub-1');
    expect(useLiveLogStore.getState().connected).toBe(true);

    unmount();
    expect(MockEventSource.instances[0].close).toHaveBeenCalledTimes(1);
    expect(useLiveLogStore.getState().subscriberId).toBeNull();
  });
});
